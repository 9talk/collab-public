import { describe, test, expect } from "bun:test";
import { noteWorkspaceUse, getRecentOrder } from "./workspace-recent";
import type { AppConfig } from "./config";

function makeConfig(workspaces: string[]): AppConfig {
  return {
    workspaces,
    expanded_workspaces: [],
    window_state: null,
    ui: {},
  };
}

describe("noteWorkspaceUse", () => {
  test("records a workspace as most recent", () => {
    const config = makeConfig(["/ws/a", "/ws/b"]);
    noteWorkspaceUse(config, "/ws/b");
    expect(getRecentOrder(config)).toEqual(["/ws/b"]);
  });

  test("moves an already recorded workspace to the front without duplicating", () => {
    const config = makeConfig(["/ws/a", "/ws/b"]);
    noteWorkspaceUse(config, "/ws/a");
    noteWorkspaceUse(config, "/ws/b");
    noteWorkspaceUse(config, "/ws/a");
    expect(getRecentOrder(config)).toEqual(["/ws/a", "/ws/b"]);
  });

  test("ignores paths that are not configured workspaces", () => {
    const config = makeConfig(["/ws/a"]);
    noteWorkspaceUse(config, "/somewhere/else");
    expect(getRecentOrder(config)).toEqual([]);
  });

  test("ignores empty and nullish paths", () => {
    const config = makeConfig(["/ws/a"]);
    noteWorkspaceUse(config, "");
    noteWorkspaceUse(config, null);
    noteWorkspaceUse(config, undefined);
    expect(getRecentOrder(config)).toEqual([]);
  });

  test("returns true when the order changed", () => {
    const config = makeConfig(["/ws/a", "/ws/b"]);
    expect(noteWorkspaceUse(config, "/ws/a")).toBe(true);
    expect(noteWorkspaceUse(config, "/ws/b")).toBe(true);
  });

  test("returns false when the workspace is already first", () => {
    const config = makeConfig(["/ws/a"]);
    noteWorkspaceUse(config, "/ws/a");
    expect(noteWorkspaceUse(config, "/ws/a")).toBe(false);
  });

  test("returns false for ignored paths", () => {
    const config = makeConfig(["/ws/a"]);
    expect(noteWorkspaceUse(config, "/elsewhere")).toBe(false);
  });

  test("caps the list at 20 entries, dropping the oldest", () => {
    const workspaces = Array.from({ length: 25 }, (_, i) => `/ws/${i}`);
    const config = makeConfig(workspaces);
    for (const ws of workspaces) {
      noteWorkspaceUse(config, ws);
    }
    const recent = getRecentOrder(config);
    expect(recent.length).toBe(20);
    expect(recent[0]).toBe("/ws/24");
    expect(recent).not.toContain("/ws/0");
  });

  test("drops stale entries for removed workspaces while bumping", () => {
    const config = makeConfig(["/ws/a", "/ws/b", "/ws/c"]);
    noteWorkspaceUse(config, "/ws/a");
    noteWorkspaceUse(config, "/ws/b");
    noteWorkspaceUse(config, "/ws/c");

    config.workspaces = ["/ws/a", "/ws/c"];
    noteWorkspaceUse(config, "/ws/c");

    expect(getRecentOrder(config)).toEqual(["/ws/c", "/ws/a"]);
  });

  test("leaves other ui preferences untouched", () => {
    const config = makeConfig(["/ws/a"]);
    config.ui.terminalTarget = "shell";
    noteWorkspaceUse(config, "/ws/a");
    expect(config.ui.terminalTarget).toBe("shell");
  });
});

describe("getRecentOrder", () => {
  test("returns an empty list when nothing was recorded", () => {
    const config = makeConfig(["/ws/a"]);
    expect(getRecentOrder(config)).toEqual([]);
  });

  test("filters out paths that are no longer configured", () => {
    const config = makeConfig(["/ws/a", "/ws/b"]);
    config.ui.recentWorkspaces = ["/ws/gone", "/ws/b", "/ws/a"];
    expect(getRecentOrder(config)).toEqual(["/ws/b", "/ws/a"]);
  });

  test("dedupes stored duplicates", () => {
    const config = makeConfig(["/ws/a"]);
    config.ui.recentWorkspaces = ["/ws/a", "/ws/a"];
    expect(getRecentOrder(config)).toEqual(["/ws/a"]);
  });

  test("tolerates a garbage stored value", () => {
    const config = makeConfig(["/ws/a"]);
    config.ui.recentWorkspaces = "not-an-array";
    expect(getRecentOrder(config)).toEqual([]);

    config.ui.recentWorkspaces = [1, null, "/ws/a", {}];
    expect(getRecentOrder(config)).toEqual(["/ws/a"]);
  });
});
