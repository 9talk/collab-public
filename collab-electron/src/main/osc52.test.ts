import { describe, expect, test } from "bun:test";
import { extractOsc52 } from "./osc52";

const osc52 = (text: string, terminator = "\x07") =>
  `\x1b]52;c;${Buffer.from(text, "utf-8").toString("base64")}${terminator}`;

describe("extractOsc52", () => {
  test("普通文本原样透传", () => {
    const r = extractOsc52("", "hello world\n");
    expect(r).toEqual({ rest: "hello world\n", copies: [], pending: "" });
  });

  test("完整 OSC 52 序列被剥离并解码", () => {
    const seq = osc52("const x = 1;");
    const r = extractOsc52("", `before${seq}after`);
    expect(r.copies).toEqual(["const x = 1;"]);
    expect(r.rest).toBe("beforeafter");
    expect(r.pending).toBe("");
  });

  test("ST 终止符(ESC \\) 同样支持", () => {
    const seq = osc52("multi\nline", "\x1b\\");
    const r = extractOsc52("", seq);
    expect(r.copies).toEqual(["multi\nline"]);
    expect(r.rest).toBe("");
  });

  test("同一 chunk 内多个序列按序解码", () => {
    const r = extractOsc52("", `${osc52("a")}${osc52("b")}`);
    expect(r.copies).toEqual(["a", "b"]);
    expect(r.rest).toBe("");
  });

  test("序列被 chunk 切分: 跨两次调用重组", () => {
    const seq = osc52("跨 chunk 的文本");
    const cut = 5; // 切在 \x1b]52;c; 内部
    const first = extractOsc52("", seq.slice(0, cut));
    expect(first.copies).toEqual([]);
    expect(first.rest).toBe("");
    expect(first.pending).toBe(seq.slice(0, cut));

    const second = extractOsc52(first.pending, seq.slice(cut));
    expect(second.copies).toEqual(["跨 chunk 的文本"]);
    expect(second.rest).toBe("");
    expect(second.pending).toBe("");
  });

  test("前缀在上一 chunk 已开始、本 chunk 同时含后续普通文本", () => {
    const seq = osc52("xy");
    const cut = 7; // "\x1b]52;c;eH" — base64 padding 之前
    const first = extractOsc52("", seq.slice(0, cut));
    expect(first.pending).toBe(seq.slice(0, cut));
    const second = extractOsc52(first.pending, `${seq.slice(cut)} and then some`);
    expect(second.copies).toEqual(["xy"]);
    expect(second.rest).toBe(" and then some");
  });

  test("悬挂前缀超限: 丢弃等待、原样透传", () => {
    const junk = `\x1b]52;c;${"A".repeat(2 << 20)}`; // > 1MiB, 非 base64 也超限
    const r = extractOsc52("", junk);
    expect(r.copies).toEqual([]);
    expect(r.pending).toBe("");
    expect(r.rest).toBe(junk);
  });

  test("以 \x1b]52 开头的垃圾但未超限: 等待补齐", () => {
    const junk = "\x1b]52;c;not-base64!!";
    const r = extractOsc52("", junk);
    expect(r.pending).toBe(junk);
    expect(r.rest).toBe("");
  });

  test("非 52 的 OSC 序列(OSC 7/8)不受影响", () => {
    const r = extractOsc52("", "\x1b]7;file:///tmp\x07\x1b]8;;http://x\x07normal");
    expect(r.rest).toBe("\x1b]7;file:///tmp\x07\x1b]8;;http://x\x07normal");
    expect(r.copies).toEqual([]);
  });

  test("参数为 p(primary)的序列同样解码", () => {
    const seq = `\x1b]52;p;${Buffer.from("sel", "utf-8").toString("base64")}\x07`;
    const r = extractOsc52("", seq);
    expect(r.copies).toEqual(["sel"]);
  });

  test("base64 解码为空(空选区)不产生复制", () => {
    const r = extractOsc52("", `\x1b]52;c;\x07`);
    expect(r.copies).toEqual([]);
    expect(r.rest).toBe("");
  });

  test("序列后紧跟下一个 \x1b]52 半截前缀: 缓存的是最后一个", () => {
    const r = extractOsc52("", `${osc52("done")}\x1b]52;c;`);
    expect(r.copies).toEqual(["done"]);
    expect(r.rest).toBe("");
    expect(r.pending).toBe("\x1b]52;c;");
  });
});
