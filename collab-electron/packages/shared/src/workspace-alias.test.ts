import { describe, test, expect } from "bun:test";
import { matchWorkspaceAlias } from "./workspace-alias";

describe("matchWorkspaceAlias", () => {
  const aliases = { "/ws/proj": "proj-alias", "/ws": "ws-alias" };
  const paths = ["/ws", "/ws/proj"];

  test("matches the exact workspace path", () => {
    expect(matchWorkspaceAlias("/ws/proj", aliases, paths)).toEqual({
      workspacePath: "/ws/proj",
      alias: "proj-alias",
    });
  });

  test("matches a nested path with the longest workspace prefix", () => {
    expect(matchWorkspaceAlias("/ws/proj/src/deep", aliases, paths)).toEqual({
      workspacePath: "/ws/proj",
      alias: "proj-alias",
    });
  });

  test("falls back to the shorter workspace when only it is a prefix", () => {
    expect(matchWorkspaceAlias("/ws/other/x", aliases, paths)).toEqual({
      workspacePath: "/ws",
      alias: "ws-alias",
    });
  });

  test("does not match a sibling sharing the prefix string", () => {
    expect(matchWorkspaceAlias("/ws-proj", aliases, paths)).toBeNull();
  });

  test("returns null when no workspace matches", () => {
    expect(matchWorkspaceAlias("/elsewhere/x", aliases, paths)).toBeNull();
  });

  test("returns null when the matched workspace has no alias", () => {
    expect(
      matchWorkspaceAlias("/ws/proj", { "/ws": "ws-alias" }, paths),
    ).toBeNull();
  });

  test("normalizes backslashes before matching", () => {
    expect(matchWorkspaceAlias("\\ws\\proj\\x", aliases, paths)).toEqual({
      workspacePath: "/ws/proj",
      alias: "proj-alias",
    });
  });

  test("handles empty inputs", () => {
    expect(matchWorkspaceAlias(undefined, aliases, paths)).toBeNull();
    expect(matchWorkspaceAlias("/ws", aliases, [])).toBeNull();
    expect(matchWorkspaceAlias("/ws", undefined, paths)).toBeNull();
  });
});
