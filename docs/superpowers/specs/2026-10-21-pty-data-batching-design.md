# 主进程统一 PTY 数据批处理 · 设计

日期：2026-10-21
状态：已评审（用户确认）
分支：feat/remote-relay-serialize
关联：xterm.js WriteBuffer、VS Code TerminalDataBufferer、kitty input_delay、Alacritty event loop 等业界做法

## 1. 背景与现状

当前 PTY 数据链路：

```text
sidecar (node-pty onData, 每个 chunk)
  → data socket
  → 主进程 forwardPtyData (src/main/pty.ts:247)
      ├─ UTF-8 尾字节拼接 + 解码
      ├─ 宿主代答查询 / OSC 9;4 进度 / 文件路径超链接富化
      ├─ 本地 IPC: sendToSenders("pty:data")
      └─ 远程: remotePtyConsumers.onData → relay WebSocket 二进制帧
  → renderer handleData
      └─ 再合并 5ms 后 term.write()
```

现状的三个问题：

1. **每个 PTY chunk 都会触发一次 IPC 和一次 relay 帧。** 高频小输出（构建日志、TUI 刷新）下消息数远高于实际需要的解析批次数。
2. **合并在链路末端。** renderer 的 5ms 合并只对本地绘制有益，主进程到 renderer 的 IPC、主进程到 relay 的 WebSocket 消息数没有下降。
3. **preload 的订阅前缓冲有限。** `MAX_BUFFERED_PTY_EVENTS = 32`，消息越碎，webview 重建时越容易在监听建立前丢掉早期输出。

业界做法（详见讨论记录）：

- VS Code 在 pty host（数据源头侧）用 `TerminalDataBufferer` 做 5ms 固定窗口合并，再发 IPC。
- xterm.js 内部 `WriteBuffer` 用 `setTimeout(0)` 合并同轮事件循环写入，单宏任务解析预算 12ms。
- kitty 用 `input_delay 3ms` 合并程序输出，小输出可跳过延迟但最多每 3ms 一次。
- Alacritty 不做时间窗口合并，靠事件循环一次排空 + 帧同步绘制。

结论：把合并上移到主进程 `forwardPtyData` 入口，让本地 IPC 与远端 relay 同时受益；渲染端只保留 WebGL 重建期间的缓冲。

## 2. 目标与非目标

### 目标

- 主进程按会话统一批处理 PTY 原始字节，减少本地 IPC 与远端 WS 帧数。
- 默认 5ms 节流窗口，Windows PowerShell 保持 16ms。
- 单批字节上限 32KB，达到上限立即 flush，限制延迟与内存。
- 用户输入后的首次输出走快速路径，不等待批处理窗口。
- 保证清屏、退出、重连等时序点不出现旧数据重放或尾部数据丢失。
- 渲染端收到即写，去掉多余的 5ms 定时合并；保留 WebGL 重建期间的 pending 缓冲。

### 非目标（阶段一）

- 阶段一不引入 ack 流控、sidecar `pause()` / `resume()` 或水位线背压；这些在阶段二实现（见第 10 节）。
- 不修改 relay 协议；relay 继续透明转发，只是帧数变少。
- 不修改 sidecar 的 `reconnectQueue`、`SessionEmulator` 与 serialize 语义。
- 不做 relay 侧二次合并。

## 3. 数据流

```text
sidecar onData
  → 主进程 forwardPtyData(raw Buffer)
  → PtyDataBatcher.push(sessionId, raw)
      │
      ├─ flush 触发：5ms 定时 / 16ms (PowerShell) / ≥32KB / 输入快路径 / 显式 flush
      ▼
  合并 Buffer
  → UTF-8 尾字节拼接 + 一次解码
  → respondToHostQueries / trackTerminalProgress / hyperlinkFilePaths / U+FFFD 诊断
  → 本地 sendToSenders("pty:data") + 远程 remotePtyConsumers.onData
  → scheduleForegroundCheck
```

一个批次只做一次解码、一次富化、一次扇出。多观众（本地 UI + 远端镜像）共享同一个批次。

## 4. 模块设计

新增 `collab-electron/src/main/pty-data-batcher.ts`，纯逻辑模块，不依赖 Electron。

```ts
export interface PtyDataBatcherOptions {
  flushMs?: number;       // 默认 5
  maxBytes?: number;      // 默认 32 * 1024
  onFlush: (sessionId: string, data: Buffer) => void;
  schedule?: typeof setTimeout;   // 测试注入假定时器
  cancel?: typeof clearTimeout;
}

export class PtyDataBatcher {
  push(sessionId: string, chunk: Buffer, flushMs?: number): void;
  flush(sessionId: string): void;
  clear(sessionId: string): void;
  markFastPath(sessionId: string): void;
  flushAll(): void;
  dispose(): void;
}
```

行为约定：

- **push**：队列为空时启动定时器；每次追加 chunk 并累计字节数；累计 ≥ `maxBytes` 立即同步 flush。第二次及之后的 push 不重置定时器（throttle，不是 debounce），持续输出不会饿死 flush。
- **flushMs 覆盖**：按批次首块的参数生效；PowerShell 会话调用 `push(..., 16)`，其余使用默认 5ms。
- **flush**：取消定时器，合并队列，调用 `onFlush`，清空状态；队列为空时 no-op。
- **markFastPath**：设置一次性标记，下一次 push 立即同步 flush；用于用户输入后的回显。
- **clear**：取消定时器并丢弃队列，不调用 `onFlush`。
- **flushAll**：对全部会话执行 flush。
- **dispose**：取消所有定时器、丢弃队列。
- **重入安全**：flush 期间再次调用 flush 直接返回，避免宿主代答查询触发递归。

内部每个会话维护：

```ts
{
  chunks: Buffer[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  fastPath: boolean;
  flushing: boolean;
}
```

## 5. 时序与边界

### 必须 flush 的点

| 位置 | 原因 |
| --- | --- |
| `writeToSession`（用户输入，src/main/pty.ts:806） | 先交付输入前已产生的输出，再 `markFastPath`，让回显立即 flush |
| `clearBuffer`（src/main/pty.ts:984） | 先 flush 旧输出，再发清屏 RPC，避免清屏后旧批次重放 |
| `session.exited` 通知处理（src/main/pty.ts:426） | 先交付尾部输出，再清理状态并发送 `pty:exit` |
| 显式调用 | 测试与关闭路径使用 `flushAll` |

### 必须丢弃的点

| 位置 | 原因 |
| --- | --- |
| `reconnectSession` 附着新数据通道前（src/main/pty.ts:778） | serialize 快照已覆盖附着前的状态；主进程旧批次若在快照后送达会重复或错位 |
| `killSession`（src/main/pty.ts:837） | 会话正在销毁，尾部输出不再需要 |
| 应用关闭 / `killAll` | 清空定时器，避免退出阶段回调 |

### 边界情况

- 单个 chunk 大于 32KB：push 时立即 flush，不等待定时器。
- 定时器回调与显式 flush 竞争：flush 成功后定时器已取消；回调内再次 flush 为 no-op。
- 宿主代答查询：flush 回调内调用 `writeToSession` 会标记快路径，但 flush 的重入保护保证不会递归。
- 多观众：一个批次分别发往本地各 sender 和远端 consumer；远程 OSC 52 跨 chunk 提取逻辑继续工作（批次变大只会减少拆分概率）。
- 远程 `remotePtyConsumers.onData` 与本地 `sendToSenders` 仍按同一批次顺序调用，不改变相对顺序。
- preload 的 `MAX_BUFFERED_PTY_EVENTS = 32` 不修改；批处理减少了事件数，等于提高了订阅前可覆盖的时间窗口。

## 6. 渲染端改动

文件：`collab-electron/packages/components/src/Terminal/TerminalTab.tsx`

- 删除 `DATA_BUFFER_FLUSH_MS`、`dataBufferRef`、`flushTimerRef` 及其定时调度。
- `handleData`：
  - `refreshingRef.current === true`：继续写入 `pendingDuringRefreshRef`。
  - 否则直接 `term.write(payload.data)`。
- 保留纯合并函数，仅用于 WebGL 重建结束后一次性写回 pending 数据；不再经过 5ms 定时器。
- `onTerminalRefresh`（:1066）中不再清理 flush 定时器，pending 数据直接写一次。
- 保留 U+FFFD 诊断与 alt 屏节流重绘逻辑（`renderer-lifecycle.ts` 不动）。
- 依赖 xterm 自身的 `WriteBuffer` 与 `RenderDebouncer` 做解析与绘制合并；应用层不再重复合并。

## 7. 测试计划

新增 `collab-electron/src/main/pty-data-batcher.test.ts`，使用 `bun:test` 与注入的假 `schedule` / `cancel`：

1. 同一窗口内多个 chunk 合并为一次 `onFlush`，数据按序拼接。
2. 持续输出按窗口节流：每个窗口一次 flush，不因新数据顺延。
3. 累计达到 32KB 立即 flush，不等定时器。
4. 单 chunk 超过 32KB 立即 flush。
5. `markFastPath` 后下一次 push 立即 flush，后续恢复定时窗口。
6. 显式 `flush` 排空并取消定时器；重复调用不产生第二次回调。
7. `clear` 丢弃数据且取消定时器，不触发回调。
8. 多会话互不影响。
9. `flushAll` / `dispose` 清空全部。
10. flush 回调内再次调用 flush 不会递归（重入保护）。
11. PowerShell 的 16ms 覆盖生效。

现有测试与构建：

- `cd collab-electron && bun test`
- `cd collab-electron && bun format`

手动验证：

- 本地终端执行高频输出命令，观察输入回显无明显延迟。
- 远端镜像连接后观察 relay 日志 `[relay] pty-data ... bytes=` 的帧数是否下降。
- 依次验证清屏、`exit`、webview 重建/重连，确认无旧数据重放、无尾部输出丢失。
- 镜像端滚动与 alt 屏（Claude Code）画面正常。

## 8. 风险与权衡

- **增加最多 5ms 输出延迟**：交互回显由输入快路径绕过；普通输出 5ms 不可感知。
- **时序错误风险**：clear/exit/reconnect 的 flush/clear 点必须成对覆盖；上述表格作为实现与测试清单。
- **内存**：每会话最多约 32KB 未 flush 数据，远低于原 ring buffer 量级；`maxBytes` 可调。
- **参数需实测**：32KB 是初始值，若 relay 帧开销仍高或单帧过大，可调整到 16KB/64KB。
- **渲染端去掉定时合并**：依赖主进程批处理避免碎片写入；WebGL 重建期间仍有 pending 缓冲，风险可控。

## 9. 阶段一验收标准

- 高频输出下，本地 `pty:data` IPC 消息数与 relay 二进制帧数明显下降。
- 打字回显不慢于现状，连续输出无额外卡顿。
- 清屏、退出、重连、镜像 attach 均无旧数据重放或尾部丢失。
- 新增单测全部通过，现有测试不回归。

## 10. 阶段二（自动推进）：端到端背压

阶段一解决消息碎片，不解决慢消费者导致的内存堆积。阶段二补 ack 流控，目标与业界实现对齐：消费者按「已解析」确认，生产者按水位线暂停/恢复 PTY。

### 10.1 机制

```text
renderer term.write(data, cb)
  cb → pty:ack(sessionId, charCount)
      → 主进程 FlowController
          ├─ 本地 consumer: webContentsId
          └─ 远程 consumer: relay event → remote-server
      → 每会话未确认字符数
          > HIGH(100,000) → sidecar session.pause → node-pty pause()
          < LOW(5,000)    → sidecar session.resume → node-pty resume()
```

- 水位线沿用 VS Code：`HighWatermarkChars = 100000`、`LowWatermarkChars = 5000`；ack 可每批发送，无需按 5000 字符聚合（阶段二先直接逐批 ack，必要时再合并）。
- 以字符数计（与 xterm write 的 `data.length` 一致）。
- **多观众策略**：每个 consumer 独立累计未确认字符数；`max(unacked) > HIGH` 时暂停，`max(unacked) < LOW` 时恢复。最慢的观众决定节奏，避免任一观众内存无界增长。
- **ack 时机**：`term.write` 回调（解析完成），不是收到 IPC 时。远程端同样在解析完成后经 relay 回传 ack。
- **detach 清理**：consumer 断开（webview 销毁、远端断线）立即移除计数并重新评估暂停状态；ack 减法用 `max(0, n)` 钳制，旧 ack 不会产生负数。
- **重连**：附着新数据通道时重置该 consumer 计数；旧连接滞后的 ack 由钳制与 consumer 身份隔离兜住。
- **防死锁**：暂停后若某 consumer 长时间无 ack，仅记录日志并保持暂停，直到 detach 或 ack；不为「恢复」而丢弃数据。应用退出时直接销毁，不等待 ack。

### 10.2 子阶段

**2a：本地闭环**

- 新增 IPC `pty:ack`（renderer → 主进程），preload 暴露 `ptyAck(sessionId, charCount)`。
- `TerminalTab` 的实时 `term.write(data, cb)` 回调里发送 ack；scrollback/快照回放不 ack。
- 主进程新增 `pty-flow-control.ts`：consumer 注册/注销、未确认计数、水位线回调。
- sidecar 新增 RPC `session.pause` / `session.resume`，调用 node-pty `pause()` / `resume()`（node-pty ^1.1.0 已提供）。
- 单测覆盖：高水位暂停、低水位恢复、多 consumer 取最大、detach 重算、ack 钳制、重入与重复 RPC 抑制。

**2b：远程闭环**

- 远端 renderer 同样走 `ptyAck`；**复用现有 IPC 转发框架**：把 `pty:ack`、`pty:detach` 加入 `markForward` 白名单。客户端镜像 webview 的调用在远程模式下发为 relay RPC，直达 host 的 remote method table；不新增协议帧类型，也不需要 remote-client 手写事件通道。
- host 端 `remote-server` 新增 `pty:ack`（喂 FlowController）与 `pty:detach`（摘除该会话的 remote consumer）方法；`pty:create` / `pty:reconnect` 成功且客户端支持 `ptyAck` 时注册 remote consumer，`pty:kill`、`session.exited`、relay 断线时摘除。
- **能力协商**：客户端在 `peer-auth-response` 中携带可选 `features: ["ptyAck"]`（向后兼容）。未声明该能力的旧客户端不注册 remote consumer，不参与水位线计算——避免旧端永不 ack 导致 PTY 永久暂停；代价是旧客户端自身的内存无界增长风险不受本机制保护。
- 镜像 TerminalTab 卸载时调用 `ptyDetach`，host 据此摘除该会话的 remote consumer，避免「无观众但仍计数」造成永久暂停。同一会话在远端存在多个镜像时按单 consumer 处理（已知边界）。
- 多观众（本地 + 远程）同时参与水位线；远程慢时本地输出也会被暂停，这是「不丢弃数据」语义下的预期取舍。
- 单测覆盖：远程 ack 路由、断线/卸载 detach、能力缺失回退、本地+远程混合水位线；手动验证慢镜像端触发 pause/resume。

### 10.3 阶段二风险

- **ack 丢失**：页面冻结或 relay 抖动会长期暂停；依赖 detach/重连恢复，配合日志观测。
- **远程暂停影响本地**：最慢消费者决定全局节奏；若体验不可接受，后续可改为按 consumer 丢弃/降级策略（不在本阶段）。
- **协议面扩大**：新增 IPC 与 sidecar RPC；远程 ack/detach 复用现有 relay RPC 转发，只扩展方法表，不新增帧类型。旧客户端通过 `peer-auth-response.features` 能力协商排除在流控之外。
- **与批处理的交互**：ack 按批次字符数计，批次大小不影响正确性，只影响计数粒度。

### 10.4 阶段二验收

- 人为阻塞渲染端/镜像端时，主进程未确认字符数达到高水位并触发 PTY 暂停；恢复后从低水位继续。
- 暂停期间内存不再无界增长，数据不丢失、顺序不变。
- 本地/远程 detach、重连后不会永久卡在暂停态。
- 现有阶段一测试与新增流控测试全部通过。
