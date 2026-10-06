import { describe, test, expect } from "bun:test";
import {
  orderWorkspacePaths,
  buildWorkspaceItems,
  buildTileItems,
  filterPopupItems,
  moveSelection,
  type PopupItem,
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
      {
        kind: "workspace",
        path: "/code/proj-a",
        name: "Alpha",
        subtitle: "/code/proj-a",
      },
      {
        kind: "workspace",
        path: "/code/proj-b",
        name: "proj-b",
        subtitle: "/code/proj-b",
      },
    ]);
  });

  test("orders items by recency", () => {
    const items = buildWorkspaceItems(["/ws/a", "/ws/b"], {}, ["/ws/b"]);
    expect(items.map((i) => i.path)).toEqual(["/ws/b", "/ws/a"]);
  });
});

// -- buildTileItems --

describe("buildTileItems", () => {
  test("lists terminal tiles in canvas order with userTitle priority", () => {
    const items = buildTileItems([
      { id: "t-low", type: "term", x: 0, y: 100, cwd: "/proj/api" },
      {
        id: "t-top",
        type: "term",
        x: 5,
        y: 0,
        cwd: "/proj/web",
        userTitle: "my-server",
      },
      { id: "t-note", type: "note", x: 0, y: 0 },
    ]);
    expect(items).toEqual([
      {
        kind: "tile",
        tileId: "t-top",
        name: "my-server",
        subtitle: "/proj/web",
      },
      {
        kind: "tile",
        tileId: "t-low",
        name: "api",
        subtitle: "/proj/api",
      },
    ]);
  });

  test("sorts same-row tiles by x", () => {
    const items = buildTileItems([
      { id: "t-right", type: "term", x: 300, y: 0, cwd: "/a/right" },
      { id: "t-left", type: "term", x: 10, y: 0, cwd: "/a/left" },
    ]);
    expect(items.map((i) => i.tileId)).toEqual(["t-left", "t-right"]);
  });

  test("workspace alias ranks between userTitle and basename", () => {
    const items = buildTileItems(
      [
        { id: "t1", type: "term", x: 0, y: 0, cwd: "/ws/proj" },
        { id: "t2", type: "term", x: 0, y: 10, cwd: "/ws/proj/sub" },
        {
          id: "t3",
          type: "term",
          x: 0,
          y: 20,
          cwd: "/ws/proj",
          userTitle: "my-server",
        },
        { id: "t4", type: "term", x: 0, y: 30, cwd: "/other/x" },
      ],
      { "/ws/proj": "proj-alias" },
      ["/ws/proj"],
    );
    expect(items.map((i) => i.name)).toEqual([
      "proj-alias",
      "proj-alias",
      "my-server",
      "x",
    ]);
  });

  test("falls back to basename when the workspace has no alias", () => {
    const items = buildTileItems(
      [{ id: "t1", type: "term", x: 0, y: 0, cwd: "/ws/proj" }],
      {},
      ["/ws/proj"],
    );
    expect(items[0]?.name).toBe("proj");
  });

  test("orders focused tiles by MRU (most recent first)", () => {
    const items = buildTileItems(
      [
        { id: "t1", type: "term", x: 0, y: 0, cwd: "/a/one" },
        { id: "t2", type: "term", x: 0, y: 10, cwd: "/a/two" },
        { id: "t3", type: "term", x: 0, y: 20, cwd: "/a/three" },
      ],
      {},
      [],
      ["t1", "t3"], // 旧→新:t3 最近(与位置序相反,排除巧合)
    );
    expect(items.map((i) => i.tileId)).toEqual(["t3", "t1", "t2"]);
  });

  test("unfocused tiles keep canvas order after focused ones", () => {
    const items = buildTileItems(
      [
        { id: "t1", type: "term", x: 0, y: 0, cwd: "/a/one" },
        { id: "t2", type: "term", x: 0, y: 10, cwd: "/a/two" },
        { id: "t3", type: "term", x: 0, y: 20, cwd: "/a/three" },
      ],
      {},
      [],
      ["t3"],
    );
    expect(items.map((i) => i.tileId)).toEqual(["t3", "t1", "t2"]);
  });

  test("empty userTitle falls back to cwd basename", () => {
    const items = buildTileItems([
      { id: "t1", type: "term", x: 0, y: 0, cwd: "/proj/web", userTitle: "" },
    ]);
    expect(items[0]?.name).toBe("web");
  });

  test("terminal without cwd shows Terminal with empty subtitle", () => {
    const items = buildTileItems([{ id: "t1", type: "term", x: 0, y: 0 }]);
    expect(items).toEqual([
      { kind: "tile", tileId: "t1", name: "Terminal", subtitle: "" },
    ]);
  });

  test("handles empty input", () => {
    expect(buildTileItems([])).toEqual([]);
    expect(buildTileItems(undefined as never)).toEqual([]);
  });
});

// -- filterPopupItems --

describe("filterPopupItems", () => {
  const items: PopupItem[] = [
    {
      kind: "workspace",
      path: "/code/alpha",
      name: "Alpha",
      subtitle: "/code/alpha",
    },
    {
      kind: "workspace",
      path: "/code/beta",
      name: "Beta",
      subtitle: "/code/beta",
    },
    { kind: "tile", tileId: "t1", name: "my-server", subtitle: "/proj/web" },
    { kind: "tile", tileId: "t2", name: "api", subtitle: "/code/beta/api" },
  ];

  test("returns all items for an empty query", () => {
    expect(filterPopupItems(items, "")).toEqual(items);
    expect(filterPopupItems(items, "   ")).toEqual(items);
  });

  test("matches the name case-insensitively", () => {
    expect(filterPopupItems(items, "ALP")).toEqual([items[0]]);
    expect(filterPopupItems(items, "my-SERVER")).toEqual([items[2]]);
  });

  test("matches the subtitle (workspace path / tile cwd)", () => {
    expect(filterPopupItems(items, "other/")).toEqual([]);
    expect(filterPopupItems(items, "/proj/web")).toEqual([items[2]]);
    expect(filterPopupItems(items, "beta")).toEqual([items[1], items[3]]);
  });

  test("returns an empty list when nothing matches", () => {
    expect(filterPopupItems(items, "zzz")).toEqual([]);
  });

  test("trims surrounding whitespace in the query", () => {
    expect(filterPopupItems(items, " alpha ")).toEqual([items[0]]);
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
