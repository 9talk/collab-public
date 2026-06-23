import { describe, test, expect } from "bun:test";
import { hasTextBom, isBinarySample, getDefaultPatterns } from "./file-filter";

describe("hasTextBom", () => {
  test("detects UTF-8 BOM", () => {
    expect(hasTextBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe(true);
  });

  test("detects UTF-16 LE BOM", () => {
    expect(hasTextBom(new Uint8Array([0xff, 0xfe]))).toBe(true);
  });

  test("detects UTF-16 BE BOM", () => {
    expect(hasTextBom(new Uint8Array([0xfe, 0xff]))).toBe(true);
  });

  test("returns false for plain ASCII", () => {
    expect(hasTextBom(new Uint8Array([0x41, 0x42, 0x43]))).toBe(false);
  });

  test("returns false for empty buffer", () => {
    expect(hasTextBom(new Uint8Array([]))).toBe(false);
  });

  test("returns false for single byte", () => {
    expect(hasTextBom(new Uint8Array([0xef]))).toBe(false);
  });
});

describe("isBinarySample", () => {
  test("returns false for empty buffer", () => {
    expect(isBinarySample(new Uint8Array([]))).toBe(false);
  });

  test("returns false for plain text", () => {
    const text = new TextEncoder().encode("Hello, world!\n");
    expect(isBinarySample(text)).toBe(false);
  });

  test("returns true when null byte present", () => {
    expect(isBinarySample(new Uint8Array([0x48, 0x00, 0x49]))).toBe(true);
  });

  test("returns false for UTF-8 BOM file", () => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, 0x00]);
    expect(isBinarySample(data)).toBe(false);
  });

  test("returns true for high ratio of control characters", () => {
    const buf = new Uint8Array(100);
    buf.fill(0x41);
    for (let i = 0; i < 15; i++) buf[i] = 0x01;
    expect(isBinarySample(buf)).toBe(true);
  });

  test("returns false for low ratio of control characters", () => {
    const buf = new Uint8Array(100);
    buf.fill(0x41);
    for (let i = 0; i < 5; i++) buf[i] = 0x01;
    expect(isBinarySample(buf)).toBe(false);
  });
});

describe("getDefaultPatterns", () => {
  test("returns a copy (not the original array)", () => {
    const a = getDefaultPatterns();
    const b = getDefaultPatterns();
    expect(a).toEqual(b);
    a.push("extra");
    expect(getDefaultPatterns()).not.toContain("extra");
  });

  test("includes common ignore patterns", () => {
    const patterns = getDefaultPatterns();
    expect(patterns).toContain(".git");
    expect(patterns).toContain("node_modules");
    expect(patterns).toContain(".DS_Store");
  });
});
