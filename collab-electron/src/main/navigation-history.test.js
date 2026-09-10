import { describe, test, expect, beforeEach } from "bun:test";
import {
  pushToHistory,
  goBack,
  goForward,
  getCurrent,
  getSnapshot,
  restoreSnapshot,
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

describe("getCurrent", () => {
  test("returns null when history is empty", () => {
    expect(getCurrent()).toBeNull();
  });

  test("returns the most recent tile", () => {
    pushToHistory("a");
    pushToHistory("b");
    expect(getCurrent()).toBe("b");
  });

  test("follows goBack", () => {
    pushToHistory("a");
    pushToHistory("b");
    goBack();
    expect(getCurrent()).toBe("a");
  });
});

describe("getSnapshot", () => {
  test("returns a copy of the stack", () => {
    pushToHistory("a");
    const snap = getSnapshot();
    expect(snap).toEqual({ history: ["a"], currentIndex: 0 });
    snap.history.push("b");
    expect(getSnapshot()).toEqual({ history: ["a"], currentIndex: 0 });
  });
});

describe("restoreSnapshot", () => {
  test("restores stack and position", () => {
    restoreSnapshot({ history: ["a", "b", "c"], currentIndex: 1 });
    expect(getCurrent()).toBe("b");
    expect(goBack()).toBe("a");
    expect(goForward()).toBe("b");
  });

  test("ignores invalid input", () => {
    restoreSnapshot(null);
    restoreSnapshot({ history: "nope" });
    restoreSnapshot({ history: [1, 2], currentIndex: 0 });
    expect(getSnapshot()).toEqual({ history: [], currentIndex: -1 });
  });

  test("trims oversized stacks keeping newest and remaps index", () => {
    const ids = Array.from({ length: 130 }, (_, i) => `tile-${i}`);
    restoreSnapshot({ history: ids, currentIndex: 129 });
    expect(getSnapshot()).toEqual({
      history: ids.slice(30),
      currentIndex: 99,
    });
  });

  test("clamps out-of-range currentIndex", () => {
    restoreSnapshot({ history: ["a"], currentIndex: 5 });
    expect(getCurrent()).toBe("a");
    restoreSnapshot({ history: [], currentIndex: 3 });
    expect(getSnapshot()).toEqual({ history: [], currentIndex: -1 });
  });
});
