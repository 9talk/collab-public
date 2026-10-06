import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { findAutoPlacement, createCanvasRpc } from "./canvas-rpc.js";
import { addTile, removeTile } from "./canvas-state.js";

// handleCanvasRpc 经 window.shellApi.canvasRpcResponse 回包, 需要 DOM 环境。
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe("findAutoPlacement", () => {
  test("places first tile at origin with no existing tiles", () => {
    const pos = findAutoPlacement([], 400, 500);
    expect(pos).toEqual({ x: 0, y: 0 });
  });

  test("avoids overlapping an existing tile", () => {
    const existing: Tile[] = [{ x: 0, y: 0, width: 400, height: 500 }];
    const pos = findAutoPlacement(existing, 400, 500);
    // Should not overlap the existing tile
    const overlaps =
      pos.x < 400 && pos.x + 400 > 0 && pos.y < 500 && pos.y + 500 > 0;
    expect(overlaps).toBe(false);
  });

  test("places tile adjacent to existing tile", () => {
    const existing: Tile[] = [{ x: 0, y: 0, width: 400, height: 500 }];
    const pos = findAutoPlacement(existing, 200, 200);
    // Should find a spot — first available is at x=400, y=0
    // (or x=0, y=0 if it fits, but it overlaps)
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
  });

  test("result snaps to 20px grid", () => {
    const existing: Tile[] = [{ x: 0, y: 0, width: 100, height: 100 }];
    const pos = findAutoPlacement(existing, 100, 100);
    expect(pos.x % 20).toBe(0);
    expect(pos.y % 20).toBe(0);
  });

  test("handles many tiles without overlapping any", () => {
    const existing: Tile[] = [];
    // Place tiles in a row
    for (let i = 0; i < 5; i++) {
      existing.push({
        x: i * 200,
        y: 0,
        width: 200,
        height: 200,
      });
    }
    const pos = findAutoPlacement(existing, 200, 200);
    // Should not overlap any existing tile
    for (const tile of existing) {
      const overlaps =
        pos.x < tile.x + tile.width &&
        pos.x + 200 > tile.x &&
        pos.y < tile.y + tile.height &&
        pos.y + 200 > tile.y;
      expect(overlaps).toBe(false);
    }
  });

  test("falls back to offset from last tile when canvas is full", () => {
    // Fill the canvas area with one giant tile
    const existing: Tile[] = [{ x: 0, y: 0, width: 4000, height: 3000 }];
    const pos = findAutoPlacement(existing, 400, 500);
    expect(pos).toEqual({ x: 40, y: 40 });
  });

  test("fallback with no tiles returns {40, 40}", () => {
    // Edge case: canvas "full" but no tiles at all shouldn't happen,
    // but if tiles is empty and no spot found, returns {40, 40}
    // Actually with empty tiles, first spot at (0,0) always works
    // So test the last-tile fallback explicitly
    const existing: Tile[] = [{ x: 0, y: 0, width: 4000, height: 3000 }];
    const pos = findAutoPlacement(existing, 100, 100);
    // Giant tile covers canvas, so fallback: last.x+40, last.y+40
    expect(pos).toEqual({ x: 40, y: 40 });
  });
});

// -- tileSetTitle (远端 rename 同步落点) --

describe("tileSetTitle", () => {
  type Response = {
    requestId: string;
    result?: unknown;
    error?: { code: number; message?: string };
  };
  let responses: Response[] = [];
  let applied: [string, string][] = [];
  let prevShellApi: unknown;

  const handle = createCanvasRpc({
    tileManager: /** @type {any} */ {
      applyTileTitle: (id: string, title: string) => {
        applied.push([id, title]);
      },
    },
    viewportState: /** @type {any} */ {},
  });

  function seedTile(id: string, type = "term"): void {
    addTile(
      /** @type {any} */ {
        id,
        type,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
    );
  }

  beforeEach(() => {
    responses = [];
    applied = [];
    prevShellApi = /** @type {any} */ window.shellApi;
    /** @type {any} */ window.shellApi = {
      canvasRpcResponse: (r: Response) => {
        responses.push(r);
      },
    };
  });

  // 测试进程内 window 全局共享，stub 必须还原，避免污染其他测试文件
  // （如 canvas-viewport.js 顶层读 shellApi.getPlatform）。
  afterEach(() => {
    if (prevShellApi === undefined) {
      delete (/** @type {any} */ window.shellApi);
    } else {
      /** @type {any} */ window.shellApi = prevShellApi;
    }
  });

  test("applies userTitle via tileManager.applyTileTitle", async () => {
    seedTile("tt-set");
    await handle({
      requestId: "r1",
      method: "tileSetTitle",
      params: { tileId: "tt-set", userTitle: "My Server" },
    });
    removeTile("tt-set");
    expect(applied).toEqual([["tt-set", "My Server"]]);
    expect(responses[0]).toEqual({ requestId: "r1", result: {} });
  });

  test("empty userTitle (reset) is forwarded as-is", async () => {
    seedTile("tt-reset");
    await handle({
      requestId: "r2",
      method: "tileSetTitle",
      params: { tileId: "tt-reset", userTitle: "" },
    });
    removeTile("tt-reset");
    expect(applied).toEqual([["tt-reset", ""]]);
    expect(responses[0].error).toBeUndefined();
  });

  test("rejects non-string userTitle", async () => {
    seedTile("tt-bad");
    await handle({
      requestId: "r3",
      method: "tileSetTitle",
      params: { tileId: "tt-bad", userTitle: 42 },
    });
    removeTile("tt-bad");
    expect(applied).toEqual([]);
    expect(responses[0].error?.code).toBe(4);
  });

  test("unknown tile → not found error", async () => {
    await handle({
      requestId: "r4",
      method: "tileSetTitle",
      params: { tileId: "tt-nope", userTitle: "x" },
    });
    expect(responses[0].error?.code).toBe(3);
  });

  test("non-term tile → rejected", async () => {
    seedTile("tt-view", "viewer");
    await handle({
      requestId: "r5",
      method: "tileSetTitle",
      params: { tileId: "tt-view", userTitle: "x" },
    });
    removeTile("tt-view");
    expect(applied).toEqual([]);
    expect(responses[0].error?.code).toBe(4);
  });
});
