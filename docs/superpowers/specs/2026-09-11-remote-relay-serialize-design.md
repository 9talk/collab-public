# 远端中继序列化恢复（@xterm/headless 快照接管本地重建与镜像）· 设计

日期：2026-09-11
状态：待评审
分支：feat/remote-relay-serialize（基于 feat/remote-relay）
关联：终端查询应答泄漏修复（30e3f3e 导出点剥离 / 2c67644 写入口剥离 + carry）；远端中继（collab-relay）

## 1. 背景与问题

终端画面恢复（本地 tile 省内存回收后重建、远端 Client 镜像 attach / 重建）目前统一走**回放字节历史**：host 端 `pty.reconnectSession`（src/main/pty.ts:773）从 sidecar ring buffer 拉尾部 500 行文本（RPC `session.capture`），本地经 IPC、远端经 relay 送到对端，`TerminalTab` 以 `term.write()` 回放（packages/components/src/Terminal/TerminalTab.tsx:369）。

三个痛点：

1. **全屏应用回放成本 O(全部帧)**。claude code 等全屏 TUI 每次更新整屏重绘，字节历史等价于"逐帧录像"；回放必须把每一帧重新解析渲染一遍才能收敛到终帧。`visibility:hidden` 只藏住了视觉跳变，藏不住解析耗时，也推迟 `term:ready`。
2. **历史查询的应答泄漏**。历史里的 DSR/DA/DECRQM 等查询被全新 xterm 自动应答写回 pty，被空闲 shell 回显成 `24;3R` / `1;2c` 等可见文本。已用两层剥离防住（见关联提交），但剥离是"防"——若恢复内容从构造上不含历史查询，此类泄漏不复存在。
3. **远端镜像 attach 传输量大**。恢复负载是尾部 500 行原始字节（含大量全屏重绘帧），全部经 relay 中转。

## 2. 方案选型

- **A（采用）：sidecar 常驻 @xterm/headless，实时解析会话状态，恢复时输出 serialize 终态快照。**
  生产者位于数据源头（全部 pty 输出必经 sidecar，server.ts:443），渲染进程崩溃 / webview 回收不影响快照；本地重建与远端镜像在 host 端共用 `pty.reconnectSession` 一个受料点，改一处两条路径同时切换。
- B（排除）：渲染端在 webview 销毁前从活 xterm 序列化。省双倍解析，但渲染进程崩溃时无快照；**镜像 attach 场景 host 端未必有活着的 webview**（省内存回收销毁的正是它）。硬伤。
- C（排除）：headless 放主进程。数据全部经 sidecar，主进程再解析一遍属重复；且让 UI 宿主进程承担解析 CPU。

数据流总览：

```text
sidecar: pty 输出 ──┬─→ RingBuffer（现状不动；capture 保留给 canvas-rpc 等消费者与回退）
                    └─→ SessionEmulator（@xterm/headless + addon-serialize，新）
                              │  RPC session.serialize → { snapshot, cols, rows }
pty.reconnectSession ─────────┘  优先 serialize，失败回退 capture(500)
    │ scrollback 字段（沿用）+ 快照 dims（本地 IPC / 镜像 relay 共同经此）
    ▼
TerminalTab：按快照 dims 校准网格 → term.write(snapshot)
```

关键性质：解析器把查询序列消化为控制事件、不落屏面，**快照只含画面与模式，不含历史查询**——泄漏按构造消除；快照 = 终帧 + `?1049h` + alt 内容 + 模式 + 滚动区域，解析渲染量从 O(全部帧) 降到 O(1 帧)。

## 3. 范围

### In scope

- sidecar 每会话 `SessionEmulator`：实时喂入、几何同步、解析排空、serialize
- 新 RPC `session.serialize`（protocol + client）
- `pty.reconnectSession` 切换：优先快照、失败回退 `capture(500)`
- 渲染端快照维度校准（terminal-tile App.tsx / TerminalTab）
- 两条路径同时生效：本地 tile 重建、远端镜像 attach / 重建

### Out of scope（明确不做）

- ring buffer 与 `session.capture` 的移除——保留（canvas-rpc `ptyCapture`、`pty:capture` 等消费者照旧；同时作为 serialize 失败的回退路径）
- 数据通道 attach 时的 ring buffer 推式快照路径不动（与快照路径并存，互不影响）
- 设置开关：本分支默认全量启用；是否加配置、ring buffer 容量再评估留后续
- 按省内存设置裁剪 emulator（所有存活会话统一养）
- 镜像端（Client）本地快照缓存——不做

## 4. 详细设计

### 4.1 sidecar：SessionEmulator（新模块 src/main/sidecar/session-emulator.ts）

```ts
class SessionEmulator {
  constructor(cols: number, rows: number);
  write(data: Buffer): void;   // 原始 chunk（剥离之前），入队异步解析
  resize(cols: number, rows: number): void;
  reset(): void;               // clearBuffer 语义
  serialize(): Promise<{ snapshot: string; cols: number; rows: number }>;
}
```

- 内部：`@xterm/headless` Terminal + `@xterm/addon-serialize`；`scrollback` 上限常量 1000 行（≥ 现状实际恢复的 500 行；渲染端 200000 行配置不适合 sidecar 常驻内存，见风险节）。
- 序列化默认选项：含 alt 缓冲（`?1049h` + alt 内容）与模式、滚动区域；不设 `excludeAltBuffer` / `excludeModes`。
- **不挂 onData**：解析器对查询的自动应答无去向、自然丢弃；查询不会进入快照。
- **解析排空**：headless 的 write 为异步分片解析，以 write 回调跟踪未完成队列；`serialize()` 前等待排空，防止快照丢最后一段。
- 版本：`@xterm/headless@6.0.0`，与渲染端 `@xterm/xterm@^6.0.0` 同源，解析行为一致性有保证。
- 构建：纯 JS 依赖由 electron-vite 打进 pty-sidecar bundle（未列入 main 构建的 external 清单）。

### 4.2 server.ts 接入点

| 位置 | 改动 |
| --- | --- |
| Session 结构（:35） | + `emulator: SessionEmulator` |
| 会话创建（~:433） | 以 node-pty 实际 cols/rows 初始化（从 session.pty 读值，防入参归一化差异） |
| onData（:443） | `ringBuffer.write(...)` 并列 `emulator.write(原始 chunk)`；**不经** reconnectQueue，状态恒随最新输出 |
| handleResize（:565） | + `emulator.resize`（与 pty 同步） |
| scheduleRepaintNudge（:595） | ±1 行抖动与还原两次 resize 同步到 emulator（emulator 与 pty 几何永远一致） |
| handleClearBuffer（:729） | + `emulator.reset()` |
| 新增 handleSerialize | RPC `session.serialize` → `await emulator.serialize()` → `{ snapshot, cols, rows }`（异步回包） |

### 4.3 protocol / client

- protocol：`SessionSerializeResult { snapshot: string; cols: number; rows: number }`
- client：`serializeSession(sessionId): Promise<SessionSerializeResult>`，映射 `rpc("session.serialize")`

### 4.4 pty.ts：reconnectSession 切换与回退

- :773 处改为：优先 `client.serializeSession(sessionId)`；任何失败回退 `client.captureSession(sessionId, 500)`（现有逻辑原样保留）。
- 返回对象：`scrollback` 字段沿用（消费端最小改动）；新增可选 `snapshotCols` / `snapshotRows`（仅快照路径有值）。
- 时点语义：调用位于 `attachDataSocket` 之后，覆盖 attach 前全部输出，与现有 capture 时点一致。
- 回退覆盖场景：旧版 sidecar（detached 残留进程，无该方法）、serialize 内部异常。
- 兼容：新 sidecar + 老调用方无影响（新 RPC 纯增量）。

### 4.5 渲染端几何校准

- `terminal-tile` App.tsx（:144-148 / :174-177）：把快照 dims 传给 TerminalTab（新增可选 props）。
- TerminalTab（:369）：`restored && scrollbackData` 写入前，若快照 dims 与当前网格不同 → `term.resize(快照 dims)`（纯本地 resize，不碰 pty），再 `write`；挂载后既有的 settle 推流 / nudge 把几何最终收敛到视口。
- 镜像端本就按会话 dims 渲染（`applyMirrorWinsize` + `ptyDiscover` 初始化网格，:1113-1134），天然一致；discover 未归的竞态由预校准兜底。
- `replayingRef` 回放守卫保留（兜底）。

### 4.6 远端中继

- remote-server / remote-client **零改动**：`pty:reconnect` 透传 `reconnectSession` 结果，快照与 dims 随 JSON-RPC 结果自动过 relay。
- 效果：镜像 attach 的恢复负载从"尾部 500 行含重绘帧的字节文本"降到"一帧快照"，全屏场景体量显著下降。

## 5. 边界情况

**几何一致性**

- 快照按 pty 当前 dims 序列化，结果携带 `{cols, rows}`；消费端写入前校准（alt screen 内容不可 reflow，几何一致是画面保真的前提）。
- 本地重建常见情况：tile 尺寸未变 → fit dims == 会话 dims，校准为 no-op。tile 在 placeholder 期间被改尺寸（罕见）→ 先按快照 dims 画对，settle 推流把 pty 收敛到新 dims → SIGWINCH → 程序整帧重绘自愈。
- nudge 瞬态：serialize 恰落 ±1 行抖动窗口时 dims 为瞬态值；消费端校准 + nudge 还原的 SIGWINCH 重绘收敛，自愈。

**时序与排空**

- emulator 喂入不经 reconnectQueue，直接并列在 onData——serialize 取"此刻"状态，与 capture 同时点语义（代码位置同在 attach 之后）。
- serialize 前必须等解析排空（见 4.1）；极端洪峰下未解析队列短暂驻留，属双倍解析成本的同一笔账。

**回退与兼容**

- 快照为空（新会话无输出）→ 等同现状无 scrollback。
- sidecar 是 detached 进程，App 崩溃重启后 `doEnsureSidecar` 可能连到旧版残留 sidecar → serialize RPC 未知 → 回退 capture。

**语义边界**

- 滚动位置落在底部、OSC 类流事件不重放（cwd 有独立机制）——均与现状回放等价。
- `clearBuffer` → `reset()`（连同模式重置）："忘记历史"语义与 ring buffer 一致；模式被清属已知边界。

## 6. 测试计划

单元（src/main/sidecar/server.test.ts，node:test）：

1. 基本：写普通输出 → `session.serialize` → 快照含文本、dims 正确。
2. 全屏：写 `?1049h` + 绘制 + 光标定位 → 快照含 `?1049h` 与终帧内容。
3. 往返保真：把快照写入全新 headless → 屏面文本与源 terminal 一致。
4. 查询不入快照：写 DSR/DA/DECRQM 查询 → 快照不含查询字节。
5. resize 跟随：resize 后 serialize 的 dims 更新。
6. clearBuffer：reset 后 serialize 近空。
7. 排空：快速多段写入（含异步解析尾）→ serialize 含最后一段。

E2E（安装后，CDP / ptyDiscover 辅助）：

- 本地：claude tile 省内存回收 → 重建，全屏直出、无泄漏字符、`term:ready` 提前。
- 镜像：Client attach / 重建画面直出；reconnect 恢复负载显著下降（relay 日志观测）。

## 7. 风险与已知边界

- **双倍解析 CPU**：每个字节多解析一遍（纯解析无渲染）。接受（sidecar 独立进程；方案 A 的既定代价）。
- **内存**：每会话约 1-2MB（scrollback 1000 行量级），与现 8MB ring buffer 同量级；渲染端 200000 行配置不引入。
- **nudge 瞬态**：serialize 落 ±1 行窗口时 dims 为瞬态值——消费端校准 + SIGWINCH 重绘自愈（见第 5 节）。
- **reset() 连带重置模式**（clearBuffer 场景）：记已知边界。
- **洪峰**：解析队列短暂驻留，极端输出下 sidecar 内存瞬时抬升。
- 两处 raw 回放路径（数据通道推式快照）保留原剥离逻辑，与快照路径并存、互不影响。
