import { describe, test, expect } from "bun:test";
import { DEFAULT_IGNORE_PATTERNS } from "@collab/shared/ignore-patterns";
import {
  createFileFilter,
  hasTextBom,
  isBinarySample,
  resolveIgnoreCase,
  resolveIgnorePatterns,
} from "./file-filter";

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

describe("createFileFilter", () => {
  test("ignores only the patterns passed in", () => {
    const filter = createFileFilter(["node_modules"]);
    expect(filter.isIgnored("node_modules/")).toBe(true);
    expect(filter.isIgnored("src/node_modules/")).toBe(true);
    expect(filter.isIgnored("src/logs/")).toBe(false);
    expect(filter.isIgnored("docs/")).toBe(false);
  });

  test("empty pattern list ignores nothing", () => {
    const filter = createFileFilter([]);
    expect(filter.isIgnored("src/anything/")).toBe(false);
    expect(filter.isIgnored("node_modules/")).toBe(false);
  });

  test("no patterns means nothing is ignored", () => {
    const filter = createFileFilter();
    expect(filter.isIgnored("logs/")).toBe(false);
  });

  test("case-insensitive matching follows ignore library defaults", () => {
    const filter = createFileFilter(["Logs"]);
    expect(filter.isIgnored("logs/")).toBe(true);
    expect(filter.isIgnored("Logs/")).toBe(true);
  });

  test("honors ignorecase: false for exact matching", () => {
    const filter = createFileFilter(["Logs"], { ignorecase: false });
    expect(filter.isIgnored("Logs/")).toBe(true);
    expect(filter.isIgnored("logs/")).toBe(false);
  });

  test("honors ignorecase: true explicitly", () => {
    const filter = createFileFilter(["Logs"], { ignorecase: true });
    expect(filter.isIgnored("logs/")).toBe(true);
  });
});

describe("resolveIgnoreCase", () => {
  test("defaults to true when config has no value", () => {
    expect(resolveIgnoreCase({})).toBe(true);
  });

  test("returns false when explicitly disabled", () => {
    expect(resolveIgnoreCase({ ignoreCase: false })).toBe(false);
  });

  test("returns true when enabled", () => {
    expect(resolveIgnoreCase({ ignoreCase: true })).toBe(true);
  });

  test("treats non-boolean values as the default", () => {
    expect(resolveIgnoreCase({ ignoreCase: "yes" })).toBe(true);
  });
});

describe("resolveIgnorePatterns", () => {
  test("falls back to shared defaults when config has no ignoredFiles", () => {
    expect(resolveIgnorePatterns({})).toEqual(DEFAULT_IGNORE_PATTERNS);
  });

  test("uses configured patterns when present", () => {
    const patterns = ["node_modules", "*.log"];
    expect(resolveIgnorePatterns({ ignoredFiles: patterns })).toEqual(patterns);
  });

  test("returns a fresh copy, not the shared default array", () => {
    const a = resolveIgnorePatterns({});
    a.push("extra");
    expect(resolveIgnorePatterns({})).not.toContain("extra");
  });

  test("falls back when ignoredFiles is not an array", () => {
    expect(resolveIgnorePatterns({ ignoredFiles: "node_modules" })).toEqual(
      DEFAULT_IGNORE_PATTERNS,
    );
  });
});
