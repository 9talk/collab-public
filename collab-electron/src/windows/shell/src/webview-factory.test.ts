import { describe, test, expect } from "bun:test";
import {
  normalizeShortcutKey,
  isFocusSearchShortcut,
} from "./webview-factory.js";

// -- normalizeShortcutKey --

describe("normalizeShortcutKey", () => {
  test("lowercases single character keys", () => {
    expect(normalizeShortcutKey("K")).toBe("k");
    expect(normalizeShortcutKey("A")).toBe("a");
  });

  test("preserves already lowercase single characters", () => {
    expect(normalizeShortcutKey("k")).toBe("k");
  });

  test("does not lowercase multi-character keys", () => {
    expect(normalizeShortcutKey("Enter")).toBe("Enter");
    expect(normalizeShortcutKey("Shift")).toBe("Shift");
    expect(normalizeShortcutKey("ArrowUp")).toBe("ArrowUp");
  });

  test("returns null for null/undefined/empty", () => {
    expect(normalizeShortcutKey(null)).toBeNull();
    expect(normalizeShortcutKey(undefined)).toBeNull();
    expect(normalizeShortcutKey("")).toBeNull();
  });
});

// -- isFocusSearchShortcut --

describe("isFocusSearchShortcut", () => {
  test("returns true for Cmd+K (keyDown)", () => {
    expect(
      isFocusSearchShortcut({
        type: "keyDown",
        key: "k",
        code: "KeyK",
        meta: true,
      }),
    ).toBe(true);
  });

  test("returns true for Ctrl+K (keydown)", () => {
    expect(
      isFocusSearchShortcut({
        type: "keydown",
        key: "k",
        code: "KeyK",
        ctrlKey: true,
      }),
    ).toBe(true);
  });

  test("returns true for Cmd+K with uppercase key", () => {
    expect(
      isFocusSearchShortcut({
        type: "keyDown",
        key: "K",
        code: "KeyK",
        metaKey: true,
      }),
    ).toBe(true);
  });

  test("returns false without command modifier", () => {
    expect(
      isFocusSearchShortcut({
        type: "keyDown",
        key: "k",
        code: "KeyK",
      }),
    ).toBe(false);
  });

  test("returns false for wrong key", () => {
    expect(
      isFocusSearchShortcut({
        type: "keyDown",
        key: "l",
        code: "KeyL",
        meta: true,
      }),
    ).toBe(false);
  });

  test("returns false for keyUp events", () => {
    expect(
      isFocusSearchShortcut({
        type: "keyUp",
        key: "k",
        code: "KeyK",
        meta: true,
      }),
    ).toBe(false);
  });

  test("returns false for auto-repeat", () => {
    expect(
      isFocusSearchShortcut({
        type: "keyDown",
        key: "k",
        code: "KeyK",
        meta: true,
        isAutoRepeat: true,
      }),
    ).toBe(false);
  });

  test("returns false for repeat", () => {
    expect(
      isFocusSearchShortcut({
        type: "keydown",
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        repeat: true,
      }),
    ).toBe(false);
  });

  test("returns false for null input", () => {
    expect(isFocusSearchShortcut(null)).toBe(false);
  });

  test("returns false for undefined input", () => {
    expect(isFocusSearchShortcut(undefined)).toBe(false);
  });

  test("matches by code even if key differs", () => {
    // On some layouts, key might differ but code is KeyK
    expect(
      isFocusSearchShortcut({
        type: "keyDown",
        key: "x",
        code: "KeyK",
        meta: true,
      }),
    ).toBe(true);
  });

  test("matches by key even if code differs", () => {
    // On some layouts, code might differ but key is "k"
    expect(
      isFocusSearchShortcut({
        type: "keyDown",
        key: "k",
        code: "SomeOtherCode",
        meta: true,
      }),
    ).toBe(true);
  });
});
