import { describe, test, expect } from "bun:test";
import {
  orderWorkspacePaths,
  buildWorkspaceItems,
  filterWorkspaceItems,
  moveSelection,
  type WorkspaceItem,
} from "./recent-popup.js";

// -- orderWorkspacePaths --

describe("orderWorkspacePaths", () => {
  test("puts recently used first, then the rest in config order", () => {
    expect(
      orderWorkspacePaths(["/ws/a", "/ws/b", "/ws/c"], ["/ws/c", "/ws/a"]),
    ).toEqual(["/ws/c", "/ws/a", "/ws/b"]);
  });

  test("returns config order when nothing was used", () => {
    expect(orderWorkspacePaths(["/ws/a", "/ws/b"], [])).toEqual([
      "/ws/a",
      "/ws/b",
    ]);
  });

  test("drops recent entries that are no longer configured", () => {
    expect(orderWorkspacePaths(["/ws/a"], ["/ws/gone", "/ws/a"])).toEqual([
      "/ws/a",
    ]);
  });

  test("dedupes recent entries", () => {
    expect(orderWorkspacePaths(["/ws/a", "/ws/b"], ["/ws/b", "/ws/b"])).toEqual(
      ["/ws/b", "/ws/a"],
    );
  });

  test("handles a missing recent list", () => {
    expect(orderWorkspacePaths(["/ws/a"], undefined)).toEqual(["/ws/a"]);
  });
});

// -- buildWorkspaceItems --

describe("buildWorkspaceItems", () => {
  test("uses the alias as name when present, basename otherwise", () => {
    const items = buildWorkspaceItems(
      ["/code/proj-a", "/code/proj-b"],
      { "/code/proj-a": "Alpha" },
      [],
    );
    expect(items).toEqual([
      { path: "/code/proj-a", name: "Alpha", subtitle: "/code/proj-a" },
      { path: "/code/proj-b", name: "proj-b", subtitle: "/code/proj-b" },
    ]);
  });

  test("orders items by recency", () => {
    const items = buildWorkspaceItems(["/ws/a", "/ws/b"], {}, ["/ws/b"]);
    expect(items.map((i) => i.path)).toEqual(["/ws/b", "/ws/a"]);
  });
});

// -- filterWorkspaceItems --

describe("filterWorkspaceItems", () => {
  const items: WorkspaceItem[] = [
    { path: "/code/alpha", name: "Alpha", subtitle: "/code/alpha" },
    { path: "/code/beta", name: "Beta", subtitle: "/code/beta" },
    { path: "/other/gamma", name: "Gamma", subtitle: "/other/gamma" },
  ];

  test("returns all items for an empty query", () => {
    expect(filterWorkspaceItems(items, "")).toEqual(items);
    expect(filterWorkspaceItems(items, "   ")).toEqual(items);
  });

  test("matches the name case-insensitively", () => {
    expect(filterWorkspaceItems(items, "ALP")).toEqual([items[0]]);
  });

  test("matches the path case-insensitively", () => {
    expect(filterWorkspaceItems(items, "other/")).toEqual([items[2]]);
  });

  test("returns an empty list when nothing matches", () => {
    expect(filterWorkspaceItems(items, "zzz")).toEqual([]);
  });

  test("trims surrounding whitespace in the query", () => {
    expect(filterWorkspaceItems(items, " beta ")).toEqual([items[1]]);
  });
});

// -- moveSelection --

describe("moveSelection", () => {
  test("moves down and up within range", () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  test("wraps from the bottom to the top", () => {
    expect(moveSelection(2, 1, 3)).toBe(0);
  });

  test("wraps from the top to the bottom", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  test("enters the list from no selection", () => {
    expect(moveSelection(-1, 1, 3)).toBe(0);
    expect(moveSelection(-1, -1, 3)).toBe(2);
  });

  test("returns -1 for an empty list", () => {
    expect(moveSelection(0, 1, 0)).toBe(-1);
    expect(moveSelection(-1, 1, 0)).toBe(-1);
  });
});
