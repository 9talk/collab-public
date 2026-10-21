# PTY 数据批处理与背压 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主进程统一批处理 PTY 原始字节（5ms / 32KB / 输入快路径），渲染端收到即写；阶段二用 ack 水位线 + node-pty pause/resume 约束慢消费者内存。

**Architecture:** 新增两个纯逻辑模块 `PtyDataBatcher` 与 `PtyFlowController`，由 `src/main/pty.ts` 接线。批处理位于 sidecar 数据 socket 与本地 IPC / 远程 relay 之间；渲染端只保留 WebGL 重建期间的 pending 缓冲。背压由 renderer 的 `term.write` 回调发 ack，主进程按每 consumer 未确认字符数控制 sidecar 暂停/恢复。

**Tech Stack:** Electron 主进程 / preload / webview、TypeScript、Bun test、node:test、@xterm/xterm 6、node-pty 1.1、relay WebSocket JSON-RPC。

**约束:** 不运行 `collab-electron/scripts/install-local.sh`；本地安装自检由用户完成。所有文件缩进使用空格，不使用 Tab。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `collab-electron/src/main/pty-data-batcher.ts` (新建) | 每会话时间/字节/快速路径批处理，纯逻辑 |
| `collab-electron/src/main/pty-data-batcher.test.ts` (新建) | 批处理单测（注入假定时器） |
| `collab-electron/src/main/pty-flow-control.ts` (新建) | 每 consumer 未确认字符计数与水位线，纯逻辑 |
| `collab-electron/src/main/pty-flow-control.test.ts` (新建) | 流控单测 |
| `collab-electron/src/main/pty.ts` (修改) | 接入 batcher、流控、ack/detach 导出、pause/resume RPC 调用 |
| `collab-electron/src/main/index.ts` (修改) | 新增 `pty:ack` / `pty:detach` IPC；远程转发白名单 |
| `collab-electron/src/preload/universal.ts` (修改) | 暴露 `ptyAck` / `ptyDetach` |
| `collab-electron/packages/shared/src/window-api.d.ts` (修改) | 窗口 API 类型 |
| `collab-electron/packages/components/src/Terminal/TerminalTab.tsx` (修改) | 收到即写、refresh pending、ack、卸载 detach |
| `collab-electron/src/main/sidecar/client.ts` (修改) | `pauseSession` / `resumeSession` |
| `collab-electron/src/main/sidecar/server.ts` (修改) | `session.pause` / `session.resume` 处理 |
| `collab-electron/src/main/sidecar/server.test.ts` (修改) | pause/resume RPC 集成测试 |
| `collab-electron/src/main/remote-client.ts` (修改) | 握手声明 `ptyAck` 能力 |
| `collab-electron/src/main/remote-server.ts` (修改) | 解析 features、注册 remote consumer、ack/detach 方法 |

---

# 阶段一：主进程统一批处理

## Task 1: PtyDataBatcher 模块

**Files:**
- Create: `collab-electron/src/main/pty-data-batcher.ts`
- Test: `collab-electron/src/main/pty-data-batcher.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `collab-electron/src/main/pty-data-batcher.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  PtyDataBatcher,
  type PtyDataBatcherScheduler,
} from "./pty-data-batcher";

class FakeScheduler implements PtyDataBatcherScheduler {
  private nextId = 1;
  private readonly tasks = new Map<number, () => void>();
  public lastDelay: number | undefined;

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.lastDelay = ms;
    this.tasks.set(id, handler);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  get pending(): number {
    return this.tasks.size;
  }

  runAll(): void {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task();
  }
}

function setup(options?: { maxBytes?: number }) {
  const flushes: Array<{ sessionId: string; text: string }> = [];
  const scheduler = new FakeScheduler();
  const batcher = new PtyDataBatcher({
    flushMs: 5,
    maxBytes: options?.maxBytes,
    scheduler,
    onFlush: (sessionId, data) =>
      flushes.push({ sessionId, text: data.toString() }),
  });
  return { batcher, scheduler, flushes };
}

describe("PtyDataBatcher", () => {
  test("同一窗口内的 chunk 合并为一次 flush", () => {
    const { batcher, scheduler, flushes } = setup();
    batcher.push("s1", Buffer.from("a"));
    batcher.push("s1", Buffer.from("b"));
    expect(flushes).toHaveLength(0);
    scheduler.runAll();
    expect(flushes).toEqual([{ sessionId: "s1", text: "ab" }]);
  });

  test("持续输出按窗口节流，不因新 chunk 顺延", () => {
    const { batcher, scheduler, flushes } = setup();
    batcher.push("s1", Buffer.from("a"));
    batcher.push("s1", Buffer.from("b"));
    expect(scheduler.pending).toBe(1);
    scheduler.runAll();
    expect(flushes.map((f) => f.text)).toEqual(["ab"]);

    batcher.push("s1", Buffer.from("c"));
    batcher.push("s1", Buffer.from("d"));
    expect(scheduler.pending).toBe(1);
    scheduler.runAll();
    expect(flushes.map((f) => f.text)).toEqual(["ab", "cd"]);
  });

  test("累计达到字节上限立即 flush", () => {
    const { batcher, scheduler, flushes } = setup({ maxBytes: 4 });
    batcher.push("s1", Buffer.from("abc"));
    expect(flushes).toHaveLength(0);
    batcher.push("s1", Buffer.from("de"));
    expect(flushes.map((f) => f.text)).toEqual(["abcde"]);
    expect(scheduler.pending).toBe(0);
  });

  test("单个 chunk 超过上限立即 flush", () => {
    const { batcher, flushes } = setup({ maxBytes: 4 });
    batcher.push("s1", Buffer.from("abcdef"));
    expect(flushes.map((f) => f.text)).toEqual(["abcdef"]);
  });

  test("markFastPath 后下一次 push 立即 flush", () => {
    const { batcher, scheduler, flushes } = setup();
    batcher.push("s1", Buffer.from("a"));
    batcher.markFastPath("s1");
    batcher.push("s1", Buffer.from("b"));
    expect(flushes.map((f) => f.text)).toEqual(["ab"]);
    expect(scheduler.pending).toBe(0);
  });

  test("显式 flush 排空且重复调用不重复回调", () => {
    const { batcher, flushes } = setup();
    batcher.push("s1", Buffer.from("a"));
    batcher.flush("s1");
    batcher.flush("s1");
    expect(flushes.map((f) => f.text)).toEqual(["a"]);
  });

  test("clear 丢弃数据并取消定时器", () => {
    const { batcher, scheduler, flushes } = setup();
    batcher.push("s1", Buffer.from("a"));
    batcher.clear("s1");
    expect(scheduler.pending).toBe(0);
    scheduler.runAll();
    expect(flushes).toHaveLength(0);
  });

  test("多会话互不影响", () => {
    const { batcher, scheduler, flushes } = setup();
    batcher.push("s1", Buffer.from("a"));
    batcher.push("s2", Buffer.from("b"));
    expect(scheduler.pending).toBe(2);
    scheduler.runAll();
    expect(flushes).toEqual([
      { sessionId: "s1", text: "a" },
      { sessionId: "s2", text: "b" },
    ]);
  });

  test("flushAll 与 dispose 清理全部会话", () => {
    const { batcher, scheduler, flushes } = setup();
    batcher.push("s1", Buffer.from("a"));
    batcher.push("s2", Buffer.from("b"));
    batcher.flushAll();
    expect(flushes.map((f) => f.text)).toEqual(["a", "b"]);
    expect(scheduler.pending).toBe(0);

    batcher.push("s3", Buffer.from("c"));
    batcher.dispose();
    expect(scheduler.pending).toBe(0);
    batcher.push("s4", Buffer.from("d"));
    scheduler.runAll();
    expect(flushes.map((f) => f.text)).toEqual(["a", "b"]);
  });

  test("flush 回调内再次 push 会被排空且不递归重复", () => {
    const flushes: string[] = [];
    let pushedSecond = false;
    const scheduler = new FakeScheduler();
    const batcher = new PtyDataBatcher({
      flushMs: 5,
      scheduler,
      onFlush: (_sessionId, data) => {
        const text = data.toString();
        flushes.push(text);
        if (text === "a" && !pushedSecond) {
          pushedSecond = true;
          batcher.push("s1", Buffer.from("b"));
        }
      },
    });
    batcher.push("s1", Buffer.from("a"));
    batcher.flush("s1");
    expect(flushes).toEqual(["a", "b"]);
  });

  test("per-push flushMs 覆盖默认值", () => {
    const { batcher, scheduler } = setup();
    batcher.push("s1", Buffer.from("a"), 16);
    expect(scheduler.lastDelay).toBe(16);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd /Users/dingxin/collab-public/collab-electron
bun test src/main/pty-data-batcher.test.ts
```

Expected: FAIL，`Cannot find module "./pty-data-batcher"`。

- [ ] **Step 3: 实现模块**

创建 `collab-electron/src/main/pty-data-batcher.ts`：

```ts
/**
 * 每会话 PTY 数据批处理。定时器从首块开始计时，后续 chunk 不重置
 * （throttle 而非 debounce），持续输出不会饿死 flush。
 */

export interface PtyDataBatcherScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PtyDataBatcherOptions {
  flushMs?: number;
  maxBytes?: number;
  onFlush: (sessionId: string, data: Buffer) => void;
  scheduler?: PtyDataBatcherScheduler;
}

interface Batch {
  chunks: Buffer[];
  bytes: number;
  timer: unknown;
  flushing: boolean;
}

const DEFAULT_FLUSH_MS = 5;
const DEFAULT_MAX_BYTES = 32 * 1024;

const defaultScheduler: PtyDataBatcherScheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PtyDataBatcher {
  private readonly flushMs: number;
  private readonly maxBytes: number;
  private readonly onFlush: (sessionId: string, data: Buffer) => void;
  private readonly scheduler: PtyDataBatcherScheduler;
  private readonly batches = new Map<string, Batch>();
  private readonly fastPath = new Set<string>();
  private disposed = false;

  constructor(options: PtyDataBatcherOptions) {
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onFlush = options.onFlush;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  push(sessionId: string, chunk: Buffer, flushMs?: number): void {
    if (this.disposed || chunk.length === 0) return;

    let batch = this.batches.get(sessionId);
    if (!batch) {
      batch = { chunks: [], bytes: 0, timer: null, flushing: false };
      this.batches.set(sessionId, batch);
    }

    batch.chunks.push(chunk);
    batch.bytes += chunk.length;

    if (this.fastPath.delete(sessionId) || batch.bytes >= this.maxBytes) {
      this.flush(sessionId);
      return;
    }

    if (batch.timer === null) {
      const timer = this.scheduler.setTimeout(() => {
        if (batch!.timer === timer) batch!.timer = null;
        this.flush(sessionId);
      }, flushMs ?? this.flushMs);
      batch.timer = timer;
    }
  }

  flush(sessionId: string): void {
    const batch = this.batches.get(sessionId);
    if (!batch || batch.flushing) return;

    batch.flushing = true;
    try {
      while (batch.chunks.length > 0) {
        if (batch.timer !== null) {
          this.scheduler.clearTimeout(batch.timer);
          batch.timer = null;
        }
        const data =
          batch.chunks.length === 1
            ? batch.chunks[0]!
            : Buffer.concat(batch.chunks, batch.bytes);
        batch.chunks = [];
        batch.bytes = 0;
        this.onFlush(sessionId, data);
      }
    } finally {
      batch.flushing = false;
      if (
        batch.chunks.length === 0 &&
        batch.timer === null &&
        this.batches.get(sessionId) === batch
      ) {
        this.batches.delete(sessionId);
      }
    }
  }

  clear(sessionId: string): void {
    const batch = this.batches.get(sessionId);
    if (batch && batch.timer !== null) {
      this.scheduler.clearTimeout(batch.timer);
    }
    this.batches.delete(sessionId);
    this.fastPath.delete(sessionId);
  }

  markFastPath(sessionId: string): void {
    if (this.disposed) return;
    this.fastPath.add(sessionId);
  }

  flushAll(): void {
    for (const sessionId of [...this.batches.keys()]) {
      this.flush(sessionId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const batch of this.batches.values()) {
      if (batch.timer !== null) this.scheduler.clearTimeout(batch.timer);
    }
    this.batches.clear();
    this.fastPath.clear();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
cd /Users/dingxin/collab-public/collab-electron
bun test src/main/pty-data-batcher.test.ts
```

Expected: 11 tests pass。

- [ ] **Step 5: 提交**

```bash
cd /Users/dingxin/collab-public
git add collab-electron/src/main/pty-data-batcher.ts collab-electron/src/main/pty-data-batcher.test.ts
git commit -m "feat(terminal): 新增 PTY 数据批处理模块"
```

---

## Task 2: 接入 forwardPtyData

**Files:**
- Modify: `collab-electron/src/main/pty.ts`

- [ ] **Step 1: 引入模块与常量**

在 `pty.ts` 顶部的 `import { countTrailingIncompleteUtf8Bytes } from "./utf8";` 后加：

```ts
import { PtyDataBatcher } from "./pty-data-batcher";
```

把：

```ts
const pendingPtyData = new Map<string, Buffer[]>();
const pendingPtyDataTimers = new Map<string, ReturnType<typeof setTimeout>>();
const WINDOWS_POWERSHELL_PTY_BATCH_MS = 16;
```

替换为：

```ts
const PTY_DATA_FLUSH_MS = 5;
const PTY_DATA_MAX_BATCH_BYTES = 32 * 1024;
const WINDOWS_POWERSHELL_PTY_BATCH_MS = 16;
```

在 `remotePtyConsumers` 声明附近（`let remotePtyConsumers` 之后）加入：

```ts
const ptyDataBatcher = new PtyDataBatcher({
  flushMs: PTY_DATA_FLUSH_MS,
  maxBytes: PTY_DATA_MAX_BATCH_BYTES,
  onFlush: processPtyData,
});
```

- [ ] **Step 2: 删除旧的 PowerShell 队列清理与 flush**

把 `clearPendingPtyData`：

```ts
function clearPendingPtyData(sessionId: string): void {
  const timer = pendingPtyDataTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingPtyDataTimers.delete(sessionId);
  }
  pendingPtyData.delete(sessionId);
  trailingUtf8Bytes.delete(sessionId);
  queryScanBuffers.delete(sessionId);
  progressScanPending.delete(sessionId);
  sessionRunningState.delete(sessionId);
}
```

替换为：

```ts
function clearPendingPtyData(sessionId: string): void {
  ptyDataBatcher.clear(sessionId);
  trailingUtf8Bytes.delete(sessionId);
  queryScanBuffers.delete(sessionId);
  progressScanPending.delete(sessionId);
  sessionRunningState.delete(sessionId);
}
```

删除整个 `flushPendingPtyData` 函数（原位于 `clearPendingPtyData` 之后）。

- [ ] **Step 3: 拆分 processPtyData 与 forwardPtyData**

把原 `forwardPtyData(sessionId, senderWebContentsId, data)` 的签名与结尾 PowerShell 分支改为：

```ts
function processPtyData(sessionId: string, data: Buffer): void {
  // Prepend any incomplete UTF-8 bytes leftover from the previous chunk.
  const leftover = trailingUtf8Bytes.get(sessionId);
  const full = leftover ? Buffer.concat([leftover, data]) : data;

  // Detect trailing incomplete UTF-8 bytes and save them for the next chunk.
  // Slice them off BEFORE decoding so Node.js doesn't replace them with .
  const tail = countTrailingIncompleteUtf8Bytes(full);
  if (tail > 0) {
    trailingUtf8Bytes.set(sessionId, full.slice(-tail));
  } else {
    trailingUtf8Bytes.delete(sessionId);
  }

  const safeLen = tail > 0 ? full.length - tail : full.length;
  const text = full.subarray(0, safeLen).toString("utf-8");

  respondToHostQueries(sessionId, text);
  trackTerminalProgress(sessionId, text);

  // Enrich PTY output: colorize URLs and wrap file paths with OSC 8 hyperlinks
  const enriched = hyperlinkFilePaths(text);

  // Diagnostic: detect U+FFFD indicating invalid UTF-8 bytes
  if (text.includes("�")) {
    const idx = text.indexOf("�");
    const ctxStart = Math.max(0, idx - 20);
    const ctx = text.substring(ctxStart, idx + 20);
    const rawStart = Math.max(0, safeLen - 30);
    const rawBytes = Array.from(
      full.subarray(rawStart, Math.min(full.length, safeLen + 10)),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.error(
      "[pty:utf8] session=" +
        sessionId +
        " U+FFFD at char " +
        idx +
        ' ctx="' +
        ctx +
        '" rawBytes=' +
        rawBytes,
    );
  }

  remotePtyConsumers?.onData(sessionId, enriched);
  sendToSenders(sessionId, "pty:data", {
    sessionId,
    data: enriched,
  });
  scheduleForegroundCheck(sessionId);
}
```

在 `processPtyData` 之前或之后新增：

```ts
function forwardPtyData(sessionId: string, data: Buffer): void {
  ptyDataBatcher.push(
    sessionId,
    data,
    shouldBatchWindowsPowerShellOutput(sessionId)
      ? WINDOWS_POWERSHELL_PTY_BATCH_MS
      : undefined,
  );
}

export function flushPtyData(sessionId: string): void {
  ptyDataBatcher.flush(sessionId);
}
```

- [ ] **Step 4: 更新调用点**

把两处 `attachDataSocket` 回调：

```ts
const dataSock = await client.attachDataSocket(socketPath, (data) => {
  forwardPtyData(sessionId, senderWebContentsId, data);
});
```

改为：

```ts
const dataSock = await client.attachDataSocket(socketPath, (data) => {
  forwardPtyData(sessionId, data);
});
```

- [ ] **Step 5: 时序点接入**

在 `session.exited` 通知处理里，`clearPendingPtyData(sessionId);` 之前加：

```ts
flushPtyData(sessionId);
```

在 `reconnectSession` 的 `const dataSock = await client.attachDataSocket(...)` 之前加：

```ts
ptyDataBatcher.clear(sessionId);
```

在 `clearBuffer` 函数中：

```ts
export async function clearBuffer(sessionId: string): Promise<void> {
  const client = getSidecarClient();
  await client.clearBuffer(sessionId);
}
```

改为：

```ts
export async function clearBuffer(sessionId: string): Promise<void> {
  const client = getSidecarClient();
  flushPtyData(sessionId);
  await client.clearBuffer(sessionId);
}
```

在 `killAll` 中，把：

```ts
for (const sessionId of pendingPtyDataTimers.keys()) {
  clearPendingPtyData(sessionId);
}
```

改为：

```ts
ptyDataBatcher.dispose();
```

- [ ] **Step 6: 构建验证**

Run:

```bash
cd /Users/dingxin/collab-public/collab-electron
bun run build
```

Expected: 构建成功，无 TypeScript 报错。

- [ ] **Step 7: 提交**

```bash
cd /Users/dingxin/collab-public
git add collab-electron/src/main/pty.ts
git commit -m "feat(terminal): 主进程统一批处理 PTY 输出"
```

---

## Task 3: 渲染端收到即写

**Files:**
- Modify: `collab-electron/packages/components/src/Terminal/TerminalTab.tsx`

- [ ] **Step 1: 删除 5ms 常量与旧 refs**

删除：

```ts
// Matches VS Code's TerminalDataBufferer throttle interval.
// Coalesces rapid PTY data events into a single term.write()
// call, preventing partial-render artifacts from the renderer
// processing many small sequential writes.
const DATA_BUFFER_FLUSH_MS = 5;
```

删除以下 refs：

```ts
const dataBufferRef = useRef<Uint8Array[]>([]);
const flushTimerRef = useRef<number | undefined>(undefined);
const flushDataRef = useRef<(() => void) | null>(null);
```

把：

```ts
const pendingDuringRefreshRef = useRef<Uint8Array[]>([]);
```

改为：

```ts
const writePtyTextRef = useRef<((text: string) => void) | null>(null);
const pendingDuringRefreshRef = useRef<string[]>([]);
```

- [ ] **Step 2: 用 writePtyText 替代 flushData**

把整个 `flushData` 定义（从 `const flushData = () => {` 到 `flushDataRef.current = flushData;`）替换为：

```ts
const writePtyText = (text: string) => {
  if (text.length === 0) return;

  if (text.includes("�")) {
    const idx = text.indexOf("�");
    console.error(
      "[term:utf8] session=" +
        sessionId +
        " U+FFFD at char " +
        idx +
        ' ctx="' +
        text.substring(Math.max(0, idx - 20), idx + 20) +
        '"',
    );
  }

  term.write(text);

  // Claude Code 全屏(alternate screen)时跳过立即重绘:其滚动由 Claude Code
  // 的 DECSTBM 补丁驱动,走 WebGL 增量渲染即可;滚动高峰重绘会放大卡顿。
  // normal 主屏立即标脏全视口重绘以防高刷屏 ghosting。
  const isAlt = term.buffer.active === term.buffer.alternate;
  if (lastAltScreenRef.current !== isAlt) {
    lastAltScreenRef.current = isAlt;
    console.log(`[alt-debug] alternate screen=${isAlt ? "ON" : "OFF"}`);
  }
  repaintAfterData(term, isAlt, scheduleAltRepaint);
};
writePtyTextRef.current = writePtyText;
```

- [ ] **Step 3: handleData 改为立即写**

把整个 `handleData` 定义替换为：

```ts
    const handleData = (payload: { sessionId: string; data: Uint8Array }) => {
      if (payload.sessionId !== sessionId) return;

      let chunk: string;
      try {
        chunk =
          typeof payload.data === "string"
            ? payload.data
            : new TextDecoder().decode(payload.data);
      } catch {
        return;
      }

      if (chunk.includes("\x1b[?1000l")) {
        resetHostSel();
      }

      if (refreshingRef.current) {
        pendingDuringRefreshRef.current.push(chunk);
        return;
      }
      writePtyText(chunk);
    };
```

- [ ] **Step 4: 清理卸载与 refresh effect**

在卸载 cleanup 中删除：

```ts
      if (flushTimerRef.current !== undefined) {
        clearTimeout(flushTimerRef.current);
        flushData();
      }
```

并在 `window.api.offPtyData(sessionId, handleData);` 之前加：

```ts
      writePtyTextRef.current = null;
```

在 `onTerminalRefresh` 中删除：

```ts
      if (flushTimerRef.current !== undefined) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = undefined;
      }
      dataBufferRef.current = [];
```

并把 replay 代码：

```ts
        const pending = pendingDuringRefreshRef.current;
        pendingDuringRefreshRef.current = [];
        if (pending.length > 0) {
          dataBufferRef.current.push(...pending);
          flushTimerRef.current = window.setTimeout(
            flushDataRef.current,
            DATA_BUFFER_FLUSH_MS,
          );
        }
        refreshingRef.current = false;
```

改为：

```ts
        const pending = pendingDuringRefreshRef.current;
        pendingDuringRefreshRef.current = [];
        refreshingRef.current = false;
        if (pending.length > 0) {
          writePtyTextRef.current?.(pending.join(""));
        }
```

- [ ] **Step 5: 构建验证**

Run:

```bash
cd /Users/dingxin/collab-public/collab-electron
bun run build
```

Expected: 构建成功。

- [ ] **Step 6: 提交**

```bash
cd /Users/dingxin/collab-public
git add collab-electron/packages/components/src/Terminal/TerminalTab.tsx
git commit -m "refactor(terminal): 渲染端收到即写，移除重复 5ms 合并"
```

---

## Task 4: 阶段一回归

- [ ] **Step 1: 运行全部 bun 测试**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun test
```

Expected: 全部通过；若失败，修复后重跑。

- [ ] **Step 2: 格式与构建**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun format
bun run build
```

Expected: 构建成功。

- [ ] **Step 3: 提交格式修复（如有）**

```bash
cd /Users/dingxin/collab-public
git status --short
git add collab-electron
git commit -m "chore(terminal): 阶段一格式与构建修复"
```

若无改动则跳过。

---

# 阶段二：ack 背压

## Task 5: PtyFlowController 模块

**Files:**
- Create: `collab-electron/src/main/pty-flow-control.ts`
- Test: `collab-electron/src/main/pty-flow-control.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `collab-electron/src/main/pty-flow-control.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { PtyFlowController } from "./pty-flow-control";

function setup(high = 10, low = 4) {
  const events: string[] = [];
  const flow = new PtyFlowController({
    highWatermark: high,
    lowWatermark: low,
    pause: (sessionId) => events.push(`pause:${sessionId}`),
    resume: (sessionId) => events.push(`resume:${sessionId}`),
  });
  return { flow, events };
}

describe("PtyFlowController", () => {
  test("未注册的 consumer 不计入水位线", () => {
    const { flow, events } = setup();
    flow.noteSent("s1", "local", 100);
    expect(events).toEqual([]);
  });

  test("超过高水位暂停，低于低水位恢复", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 10);
    expect(events).toEqual([]);
    flow.noteSent("s1", "local", 1);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "local", 7);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "local", 1);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("多 consumer 取最大未确认数", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.attachConsumer("s1", "remote");
    flow.noteSent("s1", "remote", 11);
    flow.noteSent("s1", "local", 11);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "local", 11);
    expect(events).toEqual(["pause:s1"]);
    flow.ack("s1", "remote", 8);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("detach 最慢 consumer 后重新评估", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.attachConsumer("s1", "remote");
    flow.noteSent("s1", "remote", 11);
    expect(events).toEqual(["pause:s1"]);
    flow.detachConsumer("s1", "remote");
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("ack 钳制到 0，未知 consumer 忽略", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 11);
    flow.ack("s1", "local", 100);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
    flow.ack("s1", "ghost", 100);
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("最后一个 consumer 移除时恢复", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 11);
    flow.detachConsumer("s1", "local");
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });

  test("clearSession 不触发 resume", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "local");
    flow.noteSent("s1", "local", 11);
    flow.clearSession("s1");
    expect(events).toEqual(["pause:s1"]);
  });

  test("detachConsumerFromAllSessions 移除远程 consumer", () => {
    const { flow, events } = setup();
    flow.attachConsumer("s1", "remote");
    flow.attachConsumer("s2", "remote");
    flow.noteSent("s1", "remote", 11);
    flow.detachConsumerFromAllSessions("remote");
    expect(events).toEqual(["pause:s1", "resume:s1"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun test src/main/pty-flow-control.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现模块**

创建 `collab-electron/src/main/pty-flow-control.ts`：

```ts
/**
 * 每 consumer 未确认字符计数。以最慢 consumer 为准：
 * max(unacked) > high 暂停 PTY，max(unacked) < low 恢复。
 */

export interface PtyFlowControllerOptions {
  highWatermark?: number;
  lowWatermark?: number;
  pause: (sessionId: string) => void;
  resume: (sessionId: string) => void;
}

interface SessionFlowState {
  consumers: Map<string, number>;
  paused: boolean;
}

export const FLOW_CONTROL_HIGH_WATERMARK = 100_000;
export const FLOW_CONTROL_LOW_WATERMARK = 5_000;

export class PtyFlowController {
  private readonly high: number;
  private readonly low: number;
  private readonly pauseFn: (sessionId: string) => void;
  private readonly resumeFn: (sessionId: string) => void;
  private readonly sessions = new Map<string, SessionFlowState>();

  constructor(options: PtyFlowControllerOptions) {
    this.high = options.highWatermark ?? FLOW_CONTROL_HIGH_WATERMARK;
    this.low = options.lowWatermark ?? FLOW_CONTROL_LOW_WATERMARK;
    this.pauseFn = options.pause;
    this.resumeFn = options.resume;
  }

  attachConsumer(sessionId: string, consumerId: string): void {
    const state = this.ensure(sessionId);
    if (!state.consumers.has(consumerId)) {
      state.consumers.set(consumerId, 0);
    }
  }

  detachConsumer(sessionId: string, consumerId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (!state.consumers.delete(consumerId)) return;
    if (state.consumers.size === 0) {
      this.resumeIfPaused(sessionId, state);
      this.sessions.delete(sessionId);
      return;
    }
    this.evaluate(sessionId, state);
  }

  detachConsumerFromAllSessions(consumerId: string): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.detachConsumer(sessionId, consumerId);
    }
  }

  noteSent(sessionId: string, consumerId: string, charCount: number): void {
    if (!Number.isFinite(charCount) || charCount <= 0) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const current = state.consumers.get(consumerId);
    if (current === undefined) return;
    state.consumers.set(consumerId, current + charCount);
    this.evaluate(sessionId, state);
  }

  ack(sessionId: string, consumerId: string, charCount: number): void {
    if (!Number.isFinite(charCount) || charCount <= 0) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const current = state.consumers.get(consumerId);
    if (current === undefined) return;
    state.consumers.set(consumerId, Math.max(0, current - charCount));
    this.evaluate(sessionId, state);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    this.sessions.clear();
  }

  private ensure(sessionId: string): SessionFlowState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { consumers: new Map(), paused: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private evaluate(sessionId: string, state: SessionFlowState): void {
    let max = 0;
    for (const count of state.consumers.values()) {
      if (count > max) max = count;
    }
    if (!state.paused && max > this.high) {
      state.paused = true;
      this.pauseFn(sessionId);
    } else if (state.paused && max < this.low) {
      state.paused = false;
      this.resumeFn(sessionId);
    }
  }

  private resumeIfPaused(sessionId: string, state: SessionFlowState): void {
    if (!state.paused) return;
    state.paused = false;
    this.resumeFn(sessionId);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun test src/main/pty-flow-control.test.ts
```

Expected: 8 tests pass。

- [ ] **Step 5: 提交**

```bash
cd /Users/dingxin/collab-public
git add collab-electron/src/main/pty-flow-control.ts collab-electron/src/main/pty-flow-control.test.ts
git commit -m "feat(terminal): 新增 PTY 流控水位线模块"
```

---

## Task 6: sidecar pause/resume

**Files:**
- Modify: `collab-electron/src/main/sidecar/client.ts`
- Modify: `collab-electron/src/main/sidecar/server.ts`
- Test: `collab-electron/src/main/sidecar/server.test.ts`

- [ ] **Step 1: 先加失败测试**

在 `server.test.ts` 的 `describe("session.resize works", ...)` 之后加入：

```ts
describe("session.pause/resume works", () => {
  it("returns { ok: true } and keeps the session listed", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId } = await createSession(ctrl, 1);

    const pause = await rpcCall(ctrl, 2, "session.pause", { sessionId });
    assert.deepEqual(pause.result, { ok: true });

    const resume = await rpcCall(ctrl, 3, "session.resume", { sessionId });
    assert.deepEqual(resume.result, { ok: true });

    const list = await rpcCall(ctrl, 4, "session.list");
    const sessions = (list.result as { sessions: SessionInfo[] }).sessions;
    assert.equal(sessions.length, 1);

    ctrl.destroy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/dingxin/collab-public/collab-electron
npx tsx --test src/main/sidecar/server.test.ts
```

Expected: 新用例失败，`Unknown method: session.pause`。

- [ ] **Step 3: 客户端方法**

在 `client.ts` 的 `resizeSession` 之后加：

```ts
async pauseSession(sessionId: string): Promise<void> {
  await this.rpc("session.pause", { sessionId });
}

async resumeSession(sessionId: string): Promise<void> {
  await this.rpc("session.resume", { sessionId });
}
```

- [ ] **Step 4: 服务端处理**

在 `server.ts` 的 `switch (method)` 中，`case "session.resize"` 之后加：

```ts
case "session.pause":
  return this.handlePause(sock, id, params as Record<string, unknown>);
case "session.resume":
  return this.handleResume(sock, id, params as Record<string, unknown>);
```

在 `handleResize` 之后加：

```ts
private handlePause(
  sock: net.Socket,
  id: number,
  params: Record<string, unknown>,
): void {
  const session = this.sessions.get(params.sessionId as string);
  if (!session) {
    sock.write(makeError(id, -32000, "Session not found"));
    return;
  }
  session.pty.pause();
  sock.write(makeResponse(id, { ok: true }));
}

private handleResume(
  sock: net.Socket,
  id: number,
  params: Record<string, unknown>,
): void {
  const session = this.sessions.get(params.sessionId as string);
  if (!session) {
    sock.write(makeError(id, -32000, "Session not found"));
    return;
  }
  session.pty.resume();
  sock.write(makeResponse(id, { ok: true }));
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/dingxin/collab-public/collab-electron
npx tsx --test src/main/sidecar/server.test.ts
```

Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
cd /Users/dingxin/collab-public
git add collab-electron/src/main/sidecar/client.ts collab-electron/src/main/sidecar/server.ts collab-electron/src/main/sidecar/server.test.ts
git commit -m "feat(sidecar): 支持 session.pause/resume"
```

---

## Task 7: 本地 ack / detach 闭环

**Files:**
- Modify: `collab-electron/src/main/pty.ts`
- Modify: `collab-electron/src/main/index.ts`
- Modify: `collab-electron/src/preload/universal.ts`
- Modify: `collab-electron/packages/shared/src/window-api.d.ts`
- Modify: `collab-electron/packages/components/src/Terminal/TerminalTab.tsx`

- [ ] **Step 1: pty.ts 引入流控并实例化**

顶部加：

```ts
import { PtyFlowController } from "./pty-flow-control";
```

在 `let remotePtyConsumers` 之后加：

```ts
const REMOTE_PTY_CONSUMER = "remote";

function localPtyConsumer(webContentsId: number): string {
  return `local:${webContentsId}`;
}

const ptyFlowController = new PtyFlowController({
  pause: (sessionId) => {
    console.log(`[pty:flow] pause ${sessionId.slice(0, 8)}`);
    void getSidecarClient()
      .pauseSession(sessionId)
      .catch((err) => {
        console.log(`[pty:flow] pause failed: ${String(err)}`);
      });
  },
  resume: (sessionId) => {
    console.log(`[pty:flow] resume ${sessionId.slice(0, 8)}`);
    void getSidecarClient()
      .resumeSession(sessionId)
      .catch((err) => {
        console.log(`[pty:flow] resume failed: ${String(err)}`);
      });
  },
});
```

- [ ] **Step 2: sender 生命周期接入流控**

把 `addSessionSender` 改为：

```ts
function addSessionSender(
  sessionId: string,
  senderId: number | undefined,
): void {
  if (senderId == null) return;
  let set = sessionSenders.get(sessionId);
  if (!set) {
    set = new Set();
    sessionSenders.set(sessionId, set);
  }
  if (set.has(senderId)) return;
  set.add(senderId);
  ptyFlowController.attachConsumer(sessionId, localPtyConsumer(senderId));
  const wc = getWebContents()?.fromId(senderId);
  wc?.once("destroyed", () => {
    removeSessionSender(sessionId, senderId);
  });
}
```

把 `removeSessionSender` 改为：

```ts
function removeSessionSender(
  sessionId: string,
  senderId: number | undefined,
): void {
  if (senderId == null) return;
  const set = sessionSenders.get(sessionId);
  if (!set) return;
  if (set.delete(senderId)) {
    ptyFlowController.detachConsumer(sessionId, localPtyConsumer(senderId));
  }
  if (set.size === 0) sessionSenders.delete(sessionId);
}
```

把 `clearSessionSenders` 改为：

```ts
function clearSessionSenders(sessionId: string): void {
  ptyFlowController.clearSession(sessionId);
  sessionSenders.delete(sessionId);
}
```

- [ ] **Step 3: send 返回值与计数**

把 `sendToSender` 的返回类型改为 `boolean`，并在成功 `sender.send` 后 `return true`，在 `senderWebContentsId == null` / 无 `wc` / 已销毁 / 异常分支 `return false`：

```ts
function sendToSender(
  senderWebContentsId: number | undefined,
  channel: string,
  payload: unknown,
): boolean {
  if (senderWebContentsId == null) return false;
  const wc = getWebContents();
  if (!wc) return false;
  const sender = wc.fromId(senderWebContentsId);
  if (!sender || sender.isDestroyed()) return false;
  try {
    sender.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}
```

把 `sendToSenders` 改为：

```ts
function sendToSenders(
  sessionId: string,
  channel: string,
  payload: unknown,
): number[] {
  const sent: number[] = [];
  const set = sessionSenders.get(sessionId);
  if (!set) return sent;
  for (const id of [...set]) {
    if (sendToSender(id, channel, payload)) sent.push(id);
  }
  return sent;
}
```

在 `processPtyData` 中，把：

```ts
  remotePtyConsumers?.onData(sessionId, enriched);
  sendToSenders(sessionId, "pty:data", {
    sessionId,
    data: enriched,
  });
  scheduleForegroundCheck(sessionId);
```

改为：

```ts
  remotePtyConsumers?.onData(sessionId, enriched);
  const sentTo = sendToSenders(sessionId, "pty:data", {
    sessionId,
    data: enriched,
  });
  for (const senderId of sentTo) {
    ptyFlowController.noteSent(
      sessionId,
      localPtyConsumer(senderId),
      enriched.length,
    );
  }
  scheduleForegroundCheck(sessionId);
```

- [ ] **Step 4: 导出 ack / detach**

在 `pty.ts` 的 `writeToSession` 之后加：

```ts
export function ackLocalPty(
  sessionId: string,
  senderWebContentsId: number,
  charCount: number,
): void {
  ptyFlowController.ack(
    sessionId,
    localPtyConsumer(senderWebContentsId),
    charCount,
  );
}

export function detachSessionSender(
  sessionId: string,
  senderWebContentsId: number,
): void {
  removeSessionSender(sessionId, senderWebContentsId);
}
```

在 `writeToSession` 中，写入前 flush 并标记快路径：

```ts
export function writeToSession(sessionId: string, data: string): void {
  ptyDataBatcher.flush(sessionId);
  ptyDataBatcher.markFastPath(sessionId);
  const dataSock = dataSockets.get(sessionId);
  if (dataSock && !dataSock.destroyed) {
    dataSock.write(data);
  }
}
```

- [ ] **Step 5: 主进程 IPC**

在 `index.ts` 的 `pty:write` 绑定之后加：

```ts
bindIpc(
  "pty:ack",
  "on",
  (
    event,
    { sessionId, charCount }: { sessionId: string; charCount: number },
  ) => {
    pty.ackLocalPty(sessionId, event.sender.id, charCount);
  },
);

bindIpc(
  "pty:detach",
  "on",
  (event, { sessionId }: { sessionId: string }) => {
    pty.detachSessionSender(sessionId, event.sender.id);
  },
);
```

注意：`pty:detach` 暂不加入 `markForward` 白名单；远程转发在阶段 2b 再加。

- [ ] **Step 6: preload 与类型**

在 `universal.ts` 的 `ptyWrite` 之后加：

```ts
ptyAck: (sessionId: string, charCount: number) => {
  ipcRenderer.send("pty:ack", { sessionId, charCount });
},
ptyDetach: (sessionId: string) => {
  ipcRenderer.send("pty:detach", { sessionId });
},
```

在 `window-api.d.ts` 的 `ptyWrite` 声明之后加：

```ts
ptyAck: (sessionId: string, charCount: number) => void;
ptyDetach: (sessionId: string) => void;
```

- [ ] **Step 7: 渲染端 ack 与卸载 detach**

在 `TerminalTab.tsx` 的 `writePtyText` 中，把：

```ts
  term.write(text);
```

改为：

```ts
  term.write(text, () => {
    window.api.ptyAck(sessionId, text.length);
  });
```

在卸载 cleanup 中，`window.api.offPtyData(sessionId, handleData);` 之前加：

```ts
      window.api.ptyDetach(sessionId);
```

- [ ] **Step 8: 构建验证**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun run build
```

Expected: 构建成功。

- [ ] **Step 9: 提交**

```bash
cd /Users/dingxin/collab-public
git add collab-electron/src/main/pty.ts collab-electron/src/main/index.ts collab-electron/src/preload/universal.ts collab-electron/packages/shared/src/window-api.d.ts collab-electron/packages/components/src/Terminal/TerminalTab.tsx
git commit -m "feat(terminal): 本地 ack 流控与 detach 闭环"
```

---

## Task 8: 阶段 2a 回归

- [ ] **Step 1: bun 测试**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun test
```

- [ ] **Step 2: sidecar 测试**

```bash
cd /Users/dingxin/collab-public/collab-electron
npx tsx --test src/main/sidecar/server.test.ts
```

- [ ] **Step 3: 格式与构建**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun format
bun run build
```

- [ ] **Step 4: 提交修复（如有）**

```bash
cd /Users/dingxin/collab-public
git status --short
git add collab-electron
git commit -m "chore(terminal): 阶段 2a 回归修复"
```

---

# 阶段 2b：远程 ack

## Task 9: 远程能力协商、ack 与 detach

**Files:**
- Modify: `collab-electron/src/main/remote-client.ts`
- Modify: `collab-electron/src/main/remote-server.ts`
- Modify: `collab-electron/src/main/pty.ts`
- Modify: `collab-electron/src/main/index.ts`

- [ ] **Step 1: 客户端声明能力**

在 `remote-client.ts` 的 `peer-auth-response` 发送对象中加入：

```ts
features: ["ptyAck"],
```

即：

```ts
      ws?.send(
        JSON.stringify({
          v: 1,
          type: "peer-auth-response",
          nonce,
          clientNonce,
          signature,
          features: ["ptyAck"],
        }),
      );
```

- [ ] **Step 2: pty.ts 远程 consumer 接口改为返回字符数**

把：

```ts
  onData: (sessionId: string, data: string) => void;
```

改为：

```ts
  /** 返回实际发给远端的字符数；未发送/未认证返回 0 */
  onData: (sessionId: string, data: string) => number;
```

在 `processPtyData` 中，把：

```ts
  remotePtyConsumers?.onData(sessionId, enriched);
```

改为：

```ts
  const remoteChars = remotePtyConsumers?.onData(sessionId, enriched) ?? 0;
  if (remoteChars > 0) {
    ptyFlowController.noteSent(sessionId, REMOTE_PTY_CONSUMER, remoteChars);
  }
```

在 `ackLocalPty` 之后加：

```ts
export function attachRemotePtyConsumer(sessionId: string): void {
  ptyFlowController.attachConsumer(sessionId, REMOTE_PTY_CONSUMER);
}

export function detachRemotePtyConsumer(sessionId: string): void {
  ptyFlowController.detachConsumer(sessionId, REMOTE_PTY_CONSUMER);
}

export function detachRemotePtyConsumers(): void {
  ptyFlowController.detachConsumerFromAllSessions(REMOTE_PTY_CONSUMER);
}

export function ackRemotePty(sessionId: string, charCount: number): void {
  ptyFlowController.ack(sessionId, REMOTE_PTY_CONSUMER, charCount);
}
```

- [ ] **Step 3: remote-server 解析 features**

在 `remote-server.ts` 的状态变量区域加：

```ts
let peerFeatures = new Set<string>();
```

在 `beginPeerAuth` 开头加：

```ts
  peerFeatures = new Set();
```

在 `peer-auth-response` 验签成功后的 `peerVerified = true;` 之前加：

```ts
      const features = frame.features;
      peerFeatures = new Set(
        Array.isArray(features)
          ? features.filter((f): f is string => typeof f === "string")
          : [],
      );
```

在 `peer-disconnected`、`peer-auth-error`、`rejectPeerAuth` 与 ws `close` 处理器中加：

```ts
      peerFeatures = new Set();
```

（`rejectPeerAuth` 内加一次即可覆盖错误路径。）

- [ ] **Step 4: pushPtyData 返回字符数**

把 `pushPtyData` 改为：

```ts
function pushPtyData(sessionId: string, data: string): number {
  if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
  if (!peerVerified) return 0; // 握手完成前不泄漏任何业务数据
  const prev = osc52Pending.get(sessionId) ?? "";
  const { rest, copies, pending } = extractOsc52(prev, data);
  if (pending) osc52Pending.set(sessionId, pending);
  else osc52Pending.delete(sessionId);
  for (const text of copies) {
    if (text.length > 0) pushEvent("clipboard:copy", [text], "host");
  }
  if (rest.length === 0) return 0;
  ws.send(encodePtyBinary(sessionId, Buffer.from(rest, "utf-8")));
  return rest.length;
}
```

- [ ] **Step 5: 远程方法表接入 ack/detach/attach**

在 `remote-server.ts` 的 `pty:create` 成功分支（`if (result?.sessionId)`）里加：

```ts
      if (peerFeatures.has("ptyAck")) {
        pty.attachRemotePtyConsumer(result.sessionId);
      }
```

把 `pty:kill` 改为：

```ts
  t.register("pty:kill", (params) => {
    const [{ sessionId }] = params as [{ sessionId: string }];
    pty.detachRemotePtyConsumer(sessionId);
    return pty.killSession(sessionId);
  });
```

把 `pty:reconnect` 改为：

```ts
  t.register("pty:reconnect", async (params) => {
    const [{ sessionId, cols, rows }] = params as [
      { sessionId: string; cols: number; rows: number },
    ];
    const result = await pty.reconnectSession(
      sessionId,
      cols,
      rows,
      undefined,
    );
    if (peerFeatures.has("ptyAck")) {
      pty.attachRemotePtyConsumer(sessionId);
    }
    return result;
  });
```

在 `pty:reconnect` 之后加：

```ts
  t.register("pty:ack", (params) => {
    const [{ sessionId, charCount }] = params as [
      { sessionId: string; charCount: number },
    ];
    pty.ackRemotePty(sessionId, charCount);
    return true;
  });
  t.register("pty:detach", (params) => {
    const [{ sessionId }] = params as [{ sessionId: string }];
    pty.detachRemotePtyConsumer(sessionId);
    return true;
  });
```

把 `attachHooks` 中的 `onExit` 改为：

```ts
    onExit: (payload) => {
      pty.detachRemotePtyConsumer(payload.sessionId);
      pushEvent("pty:exit", [payload]);
    },
```

在 ws `close` 处理器与 `peer-disconnected` 分支中加：

```ts
    pty.detachRemotePtyConsumers();
```

- [ ] **Step 6: 远程转发白名单**

在 `index.ts` 的 `markForward` 白名单数组中，`"pty:send-raw-keys"` 之后加：

```ts
  "pty:ack",
  "pty:detach",
```

- [ ] **Step 7: 构建验证**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun run build
```

Expected: 构建成功。

- [ ] **Step 8: 提交**

```bash
cd /Users/dingxin/collab-public
git add collab-electron/src/main/remote-client.ts collab-electron/src/main/remote-server.ts collab-electron/src/main/pty.ts collab-electron/src/main/index.ts
git commit -m "feat(remote): 远程终端 ack 背压与 consumer 生命周期"
```

---

## Task 10: 全量回归与交付

- [ ] **Step 1: 全部 bun 测试**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun test
```

Expected: 全部通过。

- [ ] **Step 2: sidecar 测试**

```bash
cd /Users/dingxin/collab-public/collab-electron
npx tsx --test src/main/sidecar/client.test.ts src/main/sidecar/server.test.ts src/main/sidecar/session-emulator.test.ts
```

Expected: 全部通过。

- [ ] **Step 3: 格式检查与构建**

```bash
cd /Users/dingxin/collab-public/collab-electron
bun format
bun run build
```

Expected: 构建成功。**不要运行 `./scripts/install-local.sh`。**

- [ ] **Step 4: 提交回归修复（如有）**

```bash
cd /Users/dingxin/collab-public
git status --short
git add collab-electron
git commit -m "chore(terminal): 批处理与背压全量回归"
```

- [ ] **Step 5: 输出手动验证清单**

交付时向用户列出：

1. 本地高频输出（如 `yes | head -n 100000`）无卡顿，输入回显正常。
2. 清屏、`exit`、webview 重建、远端重连无旧数据重放或尾部丢失。
3. 远端镜像日志中 `[relay] pty-data` 帧数相比改造前下降。
4. 人为阻塞镜像端（断点/暂停渲染）时出现 `[pty:flow] pause`，恢复后出现 `resume`。
5. 关闭镜像 tile 后 remote consumer 被摘除，不再出现永久暂停。

---

## 自查记录

- 规格覆盖：阶段一（合并模块、5ms/32KB/快速路径、clear/exit/reconnect 时序、渲染端收到即写）→ Task 1-4；阶段二本地（FlowController、sidecar pause/resume、ack/detach）→ Task 5-8；远程（features、remote consumer、ack/detach、多观众）→ Task 9-10。
- 类型一致性：`PtyDataBatcher` 的 `push/flush/clear/markFastPath/flushAll/dispose`、`PtyFlowController` 的 `attachConsumer/detachConsumer/detachConsumerFromAllSessions/noteSent/ack/clearSession` 在各 Task 中命名一致。
- 无 TBD/TODO 占位；所有新文件给出完整代码，所有修改给出完整替换片段。
