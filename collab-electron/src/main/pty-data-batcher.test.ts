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
