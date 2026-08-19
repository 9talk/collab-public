import { describe, test, expect } from "bun:test";
import {
  DEFAULT_IGNORE_PATTERNS,
  filterIgnorePatterns,
} from "./ignore-patterns";

describe("DEFAULT_IGNORE_PATTERNS", () => {
  test("includes baseline ignore entries", () => {
    for (const p of [".git", "node_modules", "dist", "Logs", ".DS_Store"]) {
      expect(DEFAULT_IGNORE_PATTERNS).toContain(p);
    }
  });

  test("includes entries inherited from the settings UI defaults", () => {
    for (const p of ["*.log", ".idea", ".vscode", ".collaborator"]) {
      expect(DEFAULT_IGNORE_PATTERNS).toContain(p);
    }
  });

  test("includes compiled artifact and binary entries", () => {
    for (const p of ["*.min.js", "*.lock", "*.pyc", "*.zip", "*.dylib"]) {
      expect(DEFAULT_IGNORE_PATTERNS).toContain(p);
    }
  });

  test("has no duplicate entries", () => {
    expect(new Set(DEFAULT_IGNORE_PATTERNS).size).toBe(
      DEFAULT_IGNORE_PATTERNS.length,
    );
  });
});

describe("filterIgnorePatterns", () => {
  const patterns = ["node_modules", "Logs", "*.log", "dist"];

  test("empty query returns everything", () => {
    expect(filterIgnorePatterns(patterns, "")).toEqual(patterns);
    expect(filterIgnorePatterns(patterns, "   ")).toEqual(patterns);
  });

  test("matches case-insensitively", () => {
    expect(filterIgnorePatterns(patterns, "logs")).toEqual(["Logs"]);
  });

  test("matches substring", () => {
    expect(filterIgnorePatterns(patterns, "log")).toEqual(["Logs", "*.log"]);
  });

  test("returns empty when nothing matches", () => {
    expect(filterIgnorePatterns(patterns, "zzz")).toEqual([]);
  });

  test("trims the query", () => {
    expect(filterIgnorePatterns(patterns, "  dist  ")).toEqual(["dist"]);
  });
});
