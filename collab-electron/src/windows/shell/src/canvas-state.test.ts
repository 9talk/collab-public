import { describe, test, expect, beforeEach } from "bun:test";
import {
  tiles,
  addTile,
  removeTile,
  getTile,
  bringToFront,
  generateId,
  defaultSize,
  inferTileType,
  tileAtPoint,
  snapToGrid,
  selectTile,
  deselectTile,
  toggleTileSelection,
  clearSelection,
  isSelected,
  getSelectedTiles,
} from "./canvas-state.js";

// Reset tiles array between tests by splicing out all entries.
// The module uses a shared mutable array, so we need to drain it.
beforeEach(() => {
  tiles.splice(0, tiles.length);
  clearSelection();
});

// -- defaultSize --

describe("defaultSize", () => {
  test("returns correct size for each tile type", () => {
    expect(defaultSize("term")).toEqual({ width: 400, height: 500 });
    expect(defaultSize("note")).toEqual({ width: 440, height: 540 });
    expect(defaultSize("code")).toEqual({ width: 440, height: 540 });
    expect(defaultSize("image")).toEqual({ width: 280, height: 280 });
    expect(defaultSize("graph")).toEqual({ width: 600, height: 500 });
    expect(defaultSize("browser")).toEqual({ width: 800, height: 650 });
  });

  test("returns a copy, not the original object", () => {
    const a = defaultSize("term");
    const b = defaultSize("term");
    expect(a).toEqual(b);
    a.width = 999;
    expect(defaultSize("term").width).toBe(400);
  });
});

// -- generateId --

describe("generateId", () => {
  test("returns a string starting with 'tile-'", () => {
    expect(generateId()).toMatch(/^tile-/);
  });

  test("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// -- addTile / getTile / removeTile --

describe("tile CRUD", () => {
  test("addTile appends to tiles array and returns the tile", () => {
    const tile = addTile({
      id: "t1", type: "term", x: 0, y: 0,
      width: 400, height: 500, zIndex: 0,
    });
    expect(tiles).toHaveLength(1);
    expect(tile.id).toBe("t1");
  });

  test("addTile assigns zIndex when not provided", () => {
    const tile = addTile({
      id: "t1", type: "term", x: 0, y: 0,
      width: 400, height: 500,
    });
    expect(tile.zIndex).toBeGreaterThan(0);
  });

  test("addTile preserves existing zIndex", () => {
    const tile = addTile({
      id: "t1", type: "term", x: 0, y: 0,
      width: 400, height: 500, zIndex: 42,
    });
    expect(tile.zIndex).toBe(42);
  });

  test("getTile returns the tile by id", () => {
    addTile({
      id: "t1", type: "term", x: 10, y: 20,
      width: 400, height: 500, zIndex: 1,
    });
    const found = getTile("t1");
    expect(found).not.toBeNull();
    expect(found!.x).toBe(10);
  });

  test("getTile returns null for unknown id", () => {
    expect(getTile("nonexistent")).toBeNull();
  });

  test("removeTile removes the tile by id", () => {
    addTile({
      id: "t1", type: "term", x: 0, y: 0,
      width: 400, height: 500, zIndex: 1,
    });
    removeTile("t1");
    expect(tiles).toHaveLength(0);
    expect(getTile("t1")).toBeNull();
  });

  test("removeTile is a no-op for unknown id", () => {
    addTile({
      id: "t1", type: "term", x: 0, y: 0,
      width: 400, height: 500, zIndex: 1,
    });
    removeTile("unknown");
    expect(tiles).toHaveLength(1);
  });

  test("multiple tiles are stored in insertion order", () => {
    addTile({ id: "a", type: "term", x: 0, y: 0, width: 1, height: 1, zIndex: 1 });
    addTile({ id: "b", type: "note", x: 0, y: 0, width: 1, height: 1, zIndex: 2 });
    addTile({ id: "c", type: "code", x: 0, y: 0, width: 1, height: 1, zIndex: 3 });
    expect(tiles.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

// -- bringToFront --

describe("bringToFront", () => {
  test("assigns a higher zIndex than previous tiles", () => {
    const t1 = addTile({
      id: "t1", type: "term", x: 0, y: 0,
      width: 400, height: 500, zIndex: 1,
    });
    const t2 = addTile({
      id: "t2", type: "term", x: 0, y: 0,
      width: 400, height: 500, zIndex: 2,
    });
    bringToFront(t1);
    expect(t1.zIndex).toBeGreaterThan(t2.zIndex);
  });

  test("successive calls produce increasing zIndex", () => {
    const t1 = addTile({
      id: "t1", type: "term", x: 0, y: 0,
      width: 400, height: 500, zIndex: 1,
    });
    bringToFront(t1);
    const z1 = t1.zIndex;
    bringToFront(t1);
    expect(t1.zIndex).toBeGreaterThan(z1);
  });
});

// -- snapToGrid --

describe("snapToGrid", () => {
  test("snaps position to 20px grid", () => {
    const tile = { x: 13, y: 27, width: 405, height: 510 };
    snapToGrid(tile);
    expect(tile.x).toBe(20);
    expect(tile.y).toBe(20);
  });

  test("snaps size to 20px grid", () => {
    const tile = { x: 0, y: 0, width: 405, height: 513 };
    snapToGrid(tile);
    expect(tile.width).toBe(400);
    expect(tile.height).toBe(520);
  });

  test("values exactly on grid remain unchanged", () => {
    const tile = { x: 40, y: 60, width: 400, height: 500 };
    snapToGrid(tile);
    expect(tile.x).toBe(40);
    expect(tile.y).toBe(60);
    expect(tile.width).toBe(400);
    expect(tile.height).toBe(500);
  });

  test("rounds to nearest grid line (not always down)", () => {
    const tile = { x: 11, y: 9, width: 100, height: 100 };
    snapToGrid(tile);
    // 11 rounds to 20, 9 rounds to 0
    expect(tile.x).toBe(20);
    expect(tile.y).toBe(0);
  });

  test("handles zero position", () => {
    const tile = { x: 0, y: 0, width: 20, height: 20 };
    snapToGrid(tile);
    expect(tile.x).toBe(0);
    expect(tile.y).toBe(0);
  });

  test("handles negative coordinates", () => {
    const tile = { x: -13, y: -27, width: 100, height: 100 };
    snapToGrid(tile);
    expect(tile.x).toBe(-20);
    expect(tile.y).toBe(-20);
  });
});

// -- inferTileType --

describe("inferTileType", () => {
  test("returns 'note' for .md files", () => {
    expect(inferTileType("/path/to/file.md")).toBe("note");
  });

  test("returns 'image' for image extensions", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]) {
      expect(inferTileType(`/path/to/file${ext}`)).toBe("image");
    }
  });

  test("returns 'code' for other extensions", () => {
    expect(inferTileType("/path/to/file.ts")).toBe("code");
    expect(inferTileType("/path/to/file.js")).toBe("code");
    expect(inferTileType("/path/to/file.py")).toBe("code");
    expect(inferTileType("/path/to/file.txt")).toBe("code");
  });

  test("handles uppercase extensions", () => {
    expect(inferTileType("/path/file.MD")).toBe("note");
    expect(inferTileType("/path/file.PNG")).toBe("image");
    expect(inferTileType("/path/file.JPG")).toBe("image");
  });

  test("handles paths with dots in directories", () => {
    expect(inferTileType("/path/.hidden/file.md")).toBe("note");
  });
});

// -- tileAtPoint --

describe("tileAtPoint", () => {
  test("returns tile when point is inside", () => {
    addTile({ id: "t1", type: "term", x: 100, y: 100, width: 200, height: 200, zIndex: 1 });
    expect(tileAtPoint(150, 150)?.id).toBe("t1");
  });

  test("returns null when point is outside all tiles", () => {
    addTile({ id: "t1", type: "term", x: 100, y: 100, width: 200, height: 200, zIndex: 1 });
    expect(tileAtPoint(50, 50)).toBeNull();
  });

  test("returns topmost tile when overlapping", () => {
    addTile({ id: "t1", type: "term", x: 0, y: 0, width: 200, height: 200, zIndex: 1 });
    addTile({ id: "t2", type: "note", x: 50, y: 50, width: 200, height: 200, zIndex: 5 });
    expect(tileAtPoint(100, 100)?.id).toBe("t2");
  });

  test("returns null for empty tiles array", () => {
    expect(tileAtPoint(0, 0)).toBeNull();
  });

  test("point on left/top boundary is inside", () => {
    addTile({ id: "t1", type: "term", x: 100, y: 100, width: 200, height: 200, zIndex: 1 });
    expect(tileAtPoint(100, 100)?.id).toBe("t1");
  });

  test("point on right/bottom boundary is outside", () => {
    addTile({ id: "t1", type: "term", x: 100, y: 100, width: 200, height: 200, zIndex: 1 });
    expect(tileAtPoint(300, 300)).toBeNull();
  });
});

// -- Selection state --

describe("selection", () => {
  beforeEach(() => {
    addTile({ id: "t1", type: "term", x: 0, y: 0, width: 1, height: 1, zIndex: 1 });
    addTile({ id: "t2", type: "note", x: 0, y: 0, width: 1, height: 1, zIndex: 2 });
    addTile({ id: "t3", type: "code", x: 0, y: 0, width: 1, height: 1, zIndex: 3 });
  });

  test("selectTile marks a tile as selected", () => {
    selectTile("t1");
    expect(isSelected("t1")).toBe(true);
    expect(isSelected("t2")).toBe(false);
  });

  test("deselectTile unmarks a tile", () => {
    selectTile("t1");
    deselectTile("t1");
    expect(isSelected("t1")).toBe(false);
  });

  test("deselectTile is a no-op for unselected tile", () => {
    deselectTile("t1");
    expect(isSelected("t1")).toBe(false);
  });

  test("toggleTileSelection toggles selection state", () => {
    toggleTileSelection("t1");
    expect(isSelected("t1")).toBe(true);
    toggleTileSelection("t1");
    expect(isSelected("t1")).toBe(false);
  });

  test("clearSelection deselects all", () => {
    selectTile("t1");
    selectTile("t2");
    selectTile("t3");
    clearSelection();
    expect(isSelected("t1")).toBe(false);
    expect(isSelected("t2")).toBe(false);
    expect(isSelected("t3")).toBe(false);
  });

  test("getSelectedTiles returns only selected tiles", () => {
    selectTile("t1");
    selectTile("t3");
    const selected = getSelectedTiles();
    expect(selected).toHaveLength(2);
    expect(selected.map((t) => t.id).sort()).toEqual(["t1", "t3"]);
  });

  test("getSelectedTiles returns empty array when none selected", () => {
    expect(getSelectedTiles()).toHaveLength(0);
  });

  test("selecting a removed tile does not appear in getSelectedTiles", () => {
    selectTile("t1");
    removeTile("t1");
    expect(getSelectedTiles()).toHaveLength(0);
  });
});

import {
  findNearestAdjacentTile,
} from "./canvas-state.js";

describe("findNearestAdjacentTile", () => {
  beforeEach(() => {
    while (tiles.length > 0) removeTile(tiles[0].id);
  });

  test("returns null when no tiles exist", () => {
    expect(findNearestAdjacentTile(100, 100)).toBeNull();
  });

  test("finds tile to the left when clicking to its right", () => {
    addTile({ id: "t1", type: "term", x: 0, y: 0, width: 400, height: 500, cwd: "/project", zIndex: 1 });
    // click at x=450 (40px right of tile, within 60px influence), y=250 (vertically aligned)
    const result = findNearestAdjacentTile(450, 250);
    expect(result).not.toBeNull();
    expect(result!.tile.id).toBe("t1");
    expect(result!.direction).toBe("right");
  });

  test("finds tile above when clicking below it", () => {
    addTile({ id: "t1", type: "term", x: 0, y: 0, width: 400, height: 500, cwd: "/project", zIndex: 1 });
    // click at x=200 (horizontally aligned), y=550 (below tile)
    const result = findNearestAdjacentTile(200, 550);
    expect(result).not.toBeNull();
    expect(result!.tile.id).toBe("t1");
    expect(result!.direction).toBe("down");
  });

  test("picks closest tile when multiple are adjacent", () => {
    addTile({ id: "t1", type: "term", x: 0, y: 0, width: 400, height: 500, cwd: "/a", zIndex: 1 });
    addTile({ id: "t2", type: "term", x: 500, y: 0, width: 400, height: 500, cwd: "/b", zIndex: 1 });
    // click between them, closer to t1
    const result = findNearestAdjacentTile(420, 250);
    expect(result).not.toBeNull();
    expect(result!.tile.id).toBe("t1");
    expect(result!.direction).toBe("right");
  });

  test("respects perpendicular influence tolerance", () => {
    addTile({ id: "t1", type: "term", x: 0, y: 0, width: 400, height: 500, cwd: "/project", zIndex: 1 });
    // click to the right AND far above — outside both influence axes
    const result = findNearestAdjacentTile(500, -70);
    expect(result).toBeNull();
  });
});
