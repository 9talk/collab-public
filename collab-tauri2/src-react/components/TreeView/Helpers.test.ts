import { describe, test, expect } from "bun:test";
import {
  displayFileName,
  getDateKey,
  formatDateLabel,
} from "./Helpers";

describe("displayFileName", () => {
  test("splits name into stem and extension", () => {
    expect(displayFileName("hello.md")).toEqual({
      stem: "hello",
      ext: ".md",
    });
  });

  test("handles multiple dots", () => {
    expect(displayFileName("my.test.ts")).toEqual({
      stem: "my.test",
      ext: ".ts",
    });
  });

  test("returns empty ext for no extension", () => {
    expect(displayFileName("Makefile")).toEqual({
      stem: "Makefile",
      ext: "",
    });
  });

  test("returns full name as stem for dotfile", () => {
    expect(displayFileName(".gitignore")).toEqual({
      stem: ".gitignore",
      ext: "",
    });
  });

  test("handles empty string", () => {
    expect(displayFileName("")).toEqual({ stem: "", ext: "" });
  });
});

describe("getDateKey", () => {
  test("converts ISO timestamp to YYYY-MM-DD", () => {
    expect(getDateKey("2026-03-13T15:30:00Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("returns empty string for undefined", () => {
    expect(getDateKey(undefined)).toBe("");
  });

  test("returns empty string for invalid date", () => {
    expect(getDateKey("not-a-date")).toBe("");
  });
});

describe("formatDateLabel", () => {
  test("returns 'Today' for today's date", () => {
    const now = new Date().toISOString();
    expect(formatDateLabel(now)).toBe("Today");
  });

  test("returns 'Yesterday' for yesterday", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(formatDateLabel(yesterday.toISOString())).toBe("Yesterday");
  });

  test("returns empty string for undefined", () => {
    expect(formatDateLabel(undefined)).toBe("");
  });

  test("returns empty string for invalid date", () => {
    expect(formatDateLabel("garbage")).toBe("");
  });

  test("returns formatted date for older dates", () => {
    const old = new Date("2020-06-15T12:00:00Z").toISOString();
    const label = formatDateLabel(old);
    // Should contain a month abbreviation and day number
    expect(label).toMatch(/\w+, \w+ \d+/);
  });
});
