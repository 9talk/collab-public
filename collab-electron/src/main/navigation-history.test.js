import { describe, test, expect, beforeEach } from "bun:test";
import {
  pushToHistory,
  goBack,
  goForward,
  resetHistory,
} from "./navigation-history";

beforeEach(() => {
  resetHistory();
});

describe("pushToHistory", () => {
  test("adds first tile to history", () => {
    pushToHistory("tile-a");
    expect(goBack()).toBeNull(); // no previous
  });

  test("tracks currentIndex correctly", () => {
    pushToHistory("a");
    pushToHistory("b");
    pushToHistory("c");
    expect(goBack()).toBe("b");
  });

  test("truncates forward history on new push", () => {
    pushToHistory("a");
    pushToHistory("b");
    pushToHistory("c");
    goBack(); // now at b
    pushToHistory("d"); // truncates c
    expect(goForward()).toBeNull();
  });

  test("deduplicates consecutive same tile", () => {
    pushToHistory("a");
    pushToHistory("a");
    expect(goBack()).toBeNull();
  });

  test("caps history at 100 entries", () => {
    for (let i = 0; i < 105; i++) {
      pushToHistory(`tile-${i}`);
    }
    // After 105 pushes, only last 100 should remain.
    // tile-5 is the oldest surviving entry (indices 5..104 = 100 entries)
    let back = goBack();
    while (goBack() !== null) {
      back = goBack();
    }
    expect(back).toBe("tile-5");
  });
});

describe("goBack", () => {
  test("returns null when history is empty", () => {
    expect(goBack()).toBeNull();
  });

  test("returns previous tile and moves currentIndex back", () => {
    pushToHistory("a");
    pushToHistory("b");
    expect(goBack()).toBe("a");
  });

  test("returns null when at start of history", () => {
    pushToHistory("a");
    pushToHistory("b");
    goBack();
    expect(goBack()).toBeNull();
  });
});

describe("goForward", () => {
  test("returns null when at end of history", () => {
    pushToHistory("a");
    pushToHistory("b");
    expect(goForward()).toBeNull();
  });

  test("returns next tile after goBack", () => {
    pushToHistory("a");
    pushToHistory("b");
    pushToHistory("c");
    goBack();
    expect(goForward()).toBe("c");
  });
});
