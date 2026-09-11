import { describe, test, expect } from "bun:test";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  test("write and snapshot returns written data", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from("hello world"));
    const snap = buf.snapshot();
    expect(snap.toString()).toBe("hello world");
  });

  test("snapshot returns empty buffer when nothing written", () => {
    const buf = new RingBuffer(1024);
    const snap = buf.snapshot();
    expect(snap.length).toBe(0);
  });

  test("wraps around when capacity exceeded", () => {
    const buf = new RingBuffer(10);
    buf.write(Buffer.from("abcdefgh")); // 8 bytes
    buf.write(Buffer.from("12345")); // 5 bytes, total 13 > 10
    const snap = buf.snapshot();
    // 13 bytes into 10-byte ring: oldest 3 bytes (abc) lost
    // Remaining: defgh12345
    expect(snap.length).toBe(10);
    expect(snap.toString()).toBe("defgh12345");
  });

  test("handles write exactly at capacity", () => {
    const buf = new RingBuffer(5);
    buf.write(Buffer.from("abcde"));
    const snap = buf.snapshot();
    expect(snap.toString()).toBe("abcde");
  });

  test("handles write larger than capacity", () => {
    const buf = new RingBuffer(5);
    buf.write(Buffer.from("abcdefghij"));
    const snap = buf.snapshot();
    // Only last 5 bytes survive
    expect(snap.toString()).toBe("fghij");
  });

  test("multiple small writes accumulate", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from("aaa"));
    buf.write(Buffer.from("bbb"));
    buf.write(Buffer.from("ccc"));
    const snap = buf.snapshot();
    expect(snap.toString()).toBe("aaabbbccc");
  });

  test("clear resets buffer", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from("data"));
    buf.clear();
    const snap = buf.snapshot();
    expect(snap.length).toBe(0);
  });

  test("bytesWritten tracks total", () => {
    const buf = new RingBuffer(10);
    buf.write(Buffer.from("abc"));
    buf.write(Buffer.from("def"));
    expect(buf.bytesWritten).toBe(6);
  });

  test("write after clear produces correct output", () => {
    const buf = new RingBuffer(10);
    buf.write(Buffer.from("old data"));
    buf.clear();
    buf.write(Buffer.from("new"));
    const snap = buf.snapshot();
    expect(snap.toString()).toBe("new");
  });

  test("multiple wraps", () => {
    const buf = new RingBuffer(5);
    buf.write(Buffer.from("abc")); // head=3, filled=3
    buf.write(Buffer.from("def")); // head=1, filled=5
    buf.write(Buffer.from("ghi")); // head=4, filled=5
    buf.write(Buffer.from("jkl")); // head=2, filled=5
    // 12 bytes total into 5-byte buffer: last 5 = "hijkl"
    const snap = buf.snapshot();
    expect(snap.length).toBe(5);
    expect(snap.toString()).toBe("hijkl");
  });

  test("zero-length write is a no-op", () => {
    const buf = new RingBuffer(10);
    buf.write(Buffer.alloc(0));
    expect(buf.bytesWritten).toBe(0);
    expect(buf.snapshot().length).toBe(0);
  });

  test("single-byte buffer", () => {
    const buf = new RingBuffer(1);
    buf.write(Buffer.from("a"));
    expect(buf.snapshot().toString()).toBe("a");
    buf.write(Buffer.from("b"));
    expect(buf.snapshot().toString()).toBe("b");
    buf.write(Buffer.from("c"));
    expect(buf.snapshot().toString()).toBe("c");
  });

  test("bytesWritten tracks total across wraps", () => {
    const buf = new RingBuffer(4);
    buf.write(Buffer.from("abcdef")); // 6 bytes
    buf.write(Buffer.from("gh")); // 2 bytes
    expect(buf.bytesWritten).toBe(8);
    expect(buf.snapshot().length).toBe(4);
  });

  test("snapshot is a copy, not a view", () => {
    const buf = new RingBuffer(10);
    buf.write(Buffer.from("hello"));
    const first = buf.snapshot();
    buf.write(Buffer.from("world"));
    expect(first.toString()).toBe("hello");
  });
});

describe("RingBuffer 查询剥离(写入口)", () => {
  const ESC = "\x1b";

  test("完整查询序列不进入历史", () => {
    const buf = new RingBuffer(1024);
    buf.write(
      Buffer.from(`A${ESC}[6nB${ESC}[?2026$pC${ESC}[?1;2cD${ESC}[>0qE`),
    );
    expect(buf.snapshot().toString()).toBe("ABCDE");
  });

  test("跨 chunk 查询: 前缀扣在 carry, 拼齐后整体剥离", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from(`A${ESC}[?20`));
    // 半截前缀不落历史(回放无意义)
    expect(buf.snapshot().toString()).toBe("A");
    buf.write(Buffer.from("26$pB"));
    expect(buf.snapshot().toString()).toBe("AB");
  });

  test("跨 chunk 的 DSR 查询", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from(`${ESC}[6`));
    expect(buf.snapshot().length).toBe(0);
    buf.write(Buffer.from("nZ"));
    expect(buf.snapshot().toString()).toBe("Z");
  });

  test("普通转义序列不受影响(不误扣不误剥)", () => {
    const buf = new RingBuffer(1024);
    const seq = `${ESC}[?2004h${ESC}[H${ESC}[1;32mhi${ESC}[0m`;
    buf.write(Buffer.from(seq));
    expect(buf.snapshot().toString()).toBe(seq);
  });

  test("被切断的普通序列拼齐后原样补回", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from(`A${ESC}[`));
    expect(buf.snapshot().toString()).toBe("A");
    buf.write(Buffer.from("H"));
    expect(buf.snapshot().toString()).toBe(`A${ESC}[H`);
  });

  test("多字节 UTF-8 字节无损(latin1 往返)", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from(`中文${ESC}[6n🎉`));
    expect(buf.snapshot().toString("utf-8")).toBe("中文🎉");
  });

  test("clear 复位 carry", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from(`${ESC}[?`));
    buf.clear();
    buf.write(Buffer.from("x"));
    expect(buf.snapshot().toString()).toBe("x");
  });

  test("超长前缀放弃扣留, 按普通数据放行(导出点剥离兜底)", () => {
    const buf = new RingBuffer(1024);
    const long = `${ESC}[${"1".repeat(40)}`;
    buf.write(Buffer.from(long));
    expect(buf.snapshot().toString()).toBe(long);
  });
});
