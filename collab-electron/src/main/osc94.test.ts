import { describe, expect, test } from "bun:test";
import { scanOsc94 } from "./osc94";

const osc94 = (state: number, pct = "", terminator = "\x07") =>
  `\x1b]9;4;${state};${pct}${terminator}`;

describe("scanOsc94", () => {
  test("普通文本无序列: 无状态无悬挂", () => {
    const r = scanOsc94("", "hello world\n");
    expect(r).toEqual({ states: [], pending: "" });
  });

  test("Claude Code 实际的 CLEAR 形态(9;4;0;) → idle", () => {
    const r = scanOsc94("", `before${osc94(0)}after`);
    expect(r.states).toEqual(["idle"]);
    expect(r.pending).toBe("");
  });

  test("INDETERMINATE(3) → running", () => {
    const r = scanOsc94("", osc94(3));
    expect(r.states).toEqual(["running"]);
  });

  test("SET(1, 带百分比) → running", () => {
    const r = scanOsc94("", osc94(1, "50"));
    expect(r.states).toEqual(["running"]);
  });

  test("ERROR(2) → idle", () => {
    const r = scanOsc94("", osc94(2));
    expect(r.states).toEqual(["idle"]);
  });

  test("无百分比、无尾分号的 9;4;3 形态同样识别", () => {
    const r = scanOsc94("", "\x1b]9;4;3\x07");
    expect(r.states).toEqual(["running"]);
  });

  test("ST 终止符(ESC \\) 同样支持", () => {
    const r = scanOsc94("", osc94(1, "", "\x1b\\"));
    expect(r.states).toEqual(["running"]);
  });

  test("同一 chunk 内多个序列按序产出", () => {
    const r = scanOsc94("", `${osc94(3)}${osc94(0)}`);
    expect(r.states).toEqual(["running", "idle"]);
    expect(r.pending).toBe("");
  });

  test("未知状态值不产出也不悬挂", () => {
    const r = scanOsc94("", osc94(7));
    expect(r.states).toEqual([]);
    expect(r.pending).toBe("");
  });

  test("序列被 chunk 切分: 跨两次调用重组", () => {
    const seq = osc94(0);
    const cut = 6; // 切在 "\x1b]9;4;" 内部
    const first = scanOsc94("", seq.slice(0, cut));
    expect(first.states).toEqual([]);
    expect(first.pending).toBe(seq.slice(0, cut));

    const second = scanOsc94(first.pending, seq.slice(cut));
    expect(second.states).toEqual(["idle"]);
    expect(second.pending).toBe("");
  });

  test("切在状态数字与终止符之间: 前缀补齐后不重复产出", () => {
    const seq = osc94(3);
    const cut = seq.length - 1; // 只差终止符
    const first = scanOsc94("", seq.slice(0, cut));
    expect(first.states).toEqual([]);
    expect(first.pending).toBe(seq.slice(0, cut));

    const second = scanOsc94(first.pending, seq.slice(cut));
    expect(second.states).toEqual(["running"]);
  });

  test("完整序列后紧跟半截前缀: 产出状态且缓存前缀", () => {
    const r = scanOsc94("", `${osc94(0)}\x1b]9;4;`);
    expect(r.states).toEqual(["idle"]);
    expect(r.pending).toBe("\x1b]9;4;");
  });

  test("悬挂前缀超限: 丢弃等待、不产出", () => {
    const junk = `\x1b]9;4;${"1".repeat(40)}`;
    const r = scanOsc94("", junk);
    expect(r.states).toEqual([]);
    expect(r.pending).toBe("");
  });

  test("非 9;4 的 OSC 序列(7/8/52)不受影响", () => {
    const data =
      "\x1b]7;file:///tmp\x07\x1b]8;;http://x\x07\x1b]52;c;aGk=\x07normal";
    const r = scanOsc94("", data);
    expect(r.states).toEqual([]);
    expect(r.pending).toBe("");
  });

  test("普通文本中的 \\x1b]9 不误判为悬挂", () => {
    const r = scanOsc94("", "\x1b]9;title\x07text");
    expect(r.states).toEqual([]);
    expect(r.pending).toBe("");
  });
});
