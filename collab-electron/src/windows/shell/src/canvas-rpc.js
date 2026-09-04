import {
  tiles,
  getTile,
  defaultSize,
  snapToGrid,
  findAutoPlacementForTerminal,
  swapTerminalPositions,
} from "./canvas-state.js";

/**
 * Find a non-overlapping position on the canvas for a tile of the
 * given size. Scans on a 20 px grid within a 4000x3000 region.
 */
export function findAutoPlacement(existingTiles, width, height) {
  const CANVAS_W = 4000;
  const CANVAS_H = 3000;
  const STEP = 20;

  for (let y = 0; y <= CANVAS_H - height; y += STEP) {
    for (let x = 0; x <= CANVAS_W - width; x += STEP) {
      const overlaps = existingTiles.some(
        (t) =>
          x < t.x + t.width &&
          x + width > t.x &&
          y < t.y + t.height &&
          y + height > t.y,
      );
      if (!overlaps) return { x, y };
    }
  }

  const last = existingTiles[existingTiles.length - 1];
  if (last) return { x: last.x + 40, y: last.y + 40 };
  return { x: 40, y: 40 };
}

/**
 * Create the canvas RPC request handler.
 *
 * Methods: tileList, tileCreate, tileRemove, tileMove, tileResize,
 *          viewportGet, viewportSet, terminalWrite, terminalRead,
 *          terminalWriteFocused, terminalClear, tileFocus, tileNotify,
 *          tileReorder.
 */
export function createCanvasRpc({
  tileManager,
  viewportState,
  viewport,
  edgeIndicators,
  notifications,
  relayoutTerminalTiles,
}) {
  function respond(requestId, result) {
    window.shellApi.canvasRpcResponse({ requestId, result });
  }

  function respondError(requestId, code, message) {
    window.shellApi.canvasRpcResponse({
      requestId,
      error: { code, message },
    });
  }

  function requireTile(requestId, tileId) {
    const tile = getTile(tileId);
    if (!tile) {
      respondError(requestId, 3, "Tile not found");
      return null;
    }
    return tile;
  }

  return async function handleCanvasRpc(request) {
    const { requestId, method, params } = request;

    try {
      let result;
      switch (method) {
        case "tileList": {
          result = {
            tiles: tiles.map((t) => ({
              id: t.id,
              type: t.type,
              filePath: t.filePath,
              folderPath: t.folderPath,
              url: t.url,
              cwd: t.cwd,
              ptySessionId: t.ptySessionId,
              userTitle: t.userTitle,
              autoTitle: t.autoTitle,
              position: { x: t.x, y: t.y },
              size: { width: t.width, height: t.height },
              zIndex: t.zIndex,
            })),
          };
          break;
        }
        case "tileCreate": {
          const tileType = params.tileType || "term";
          if (tileType !== "term") {
            respondError(requestId, 4, `Unsupported tile type: ${tileType}`);
            return;
          }
          const size = defaultSize("term");
          let pos;
          if (params.position) {
            pos = { x: params.position.x, y: params.position.y };
          } else {
            const cwd = params.cwd || "";
            pos = findAutoPlacementForTerminal(cwd, size);
          }

          const tile = tileManager.createCanvasTile("term", pos.x, pos.y);
          tileManager.spawnTerminalWebview(tile);
          tileManager.saveCanvasImmediate();
          result = { tileId: tile.id };
          break;
        }
        case "tileRemove": {
          if (!requireTile(requestId, params.tileId)) return;
          tileManager.closeCanvasTile(params.tileId);
          result = {};
          break;
        }
        case "tileMove": {
          const tile = requireTile(requestId, params.tileId);
          if (!tile) return;
          const mx = params.position?.x;
          const my = params.position?.y;
          if (!Number.isFinite(mx) || !Number.isFinite(my)) {
            respondError(requestId, 4, "Invalid position");
            return;
          }
          tile.x = mx;
          tile.y = my;
          snapToGrid(tile);
          tileManager.repositionAllTiles();
          tileManager.saveCanvasImmediate();
          result = {};
          break;
        }
        case "tileResize": {
          const tile = requireTile(requestId, params.tileId);
          if (!tile) return;
          const rw = params.size?.width;
          const rh = params.size?.height;
          if (!Number.isFinite(rw) || !Number.isFinite(rh)) {
            respondError(requestId, 4, "Invalid size");
            return;
          }
          tile.width = rw;
          tile.height = rh;
          snapToGrid(tile);
          tileManager.repositionAllTiles();
          tileManager.saveCanvasImmediate();
          result = {};
          break;
        }
        case "tileSetGeometry": {
          // 镜像几何同步专用：一次提交位置+尺寸（Host rpc canvas:update-tile-geometry 的落点）。
          const tile = requireTile(requestId, params.tileId);
          if (!tile) return;
          const { x, y, width, height } = params;
          if (![x, y, width, height].every(Number.isFinite)) {
            respondError(requestId, 4, "Invalid geometry");
            return;
          }
          tile.x = x;
          tile.y = y;
          tile.width = width;
          tile.height = height;
          snapToGrid(tile);
          tileManager.repositionAllTiles();
          tileManager.saveCanvasImmediate();
          result = {};
          break;
        }
        case "viewportGet": {
          result = {
            pan: {
              x: viewportState.panX,
              y: viewportState.panY,
            },
            zoom: viewportState.zoom,
          };
          break;
        }
        case "viewportSet": {
          if (params.pan) {
            viewportState.panX = params.pan.x;
            viewportState.panY = params.pan.y;
          }
          if (params.zoom !== undefined) {
            viewportState.zoom = params.zoom;
          }
          viewport.updateCanvas();
          tileManager.saveCanvasDebounced();
          result = {};
          break;
        }
        case "terminalWrite": {
          const tile = requireTile(requestId, params.tileId);
          if (!tile) return;
          if (tile.type !== "term") {
            respondError(requestId, 4, "Tile is not a terminal");
            return;
          }
          if (!tile.ptySessionId) {
            respondError(requestId, 4, "Terminal has no session");
            return;
          }
          window.shellApi.ptyWrite(tile.ptySessionId, params.input);
          result = {};
          break;
        }
        case "terminalWriteFocused": {
          const focusedId = tileManager.getFocusedTileId();
          if (!focusedId) {
            respondError(requestId, 4, "No focused tile");
            return;
          }
          const ft = getTile(focusedId);
          if (!ft || ft.type !== "term") {
            respondError(requestId, 4, "Focused tile is not a terminal");
            return;
          }
          if (!ft.ptySessionId) {
            respondError(requestId, 4, "Terminal has no session");
            return;
          }
          window.shellApi.ptyWrite(ft.ptySessionId, params.input);
          result = {};
          break;
        }
        case "terminalRead": {
          const tile = requireTile(requestId, params.tileId);
          if (!tile) return;
          if (tile.type !== "term") {
            respondError(requestId, 4, "Tile is not a terminal");
            return;
          }
          if (!tile.ptySessionId) {
            respondError(requestId, 4, "Terminal has no session");
            return;
          }
          const lines = params.lines ?? 50;
          const output = await window.shellApi.ptyCapture(
            tile.ptySessionId,
            lines,
          );
          result = { output };
          break;
        }
        case "terminalClear": {
          const tile = requireTile(requestId, params.tileId);
          if (!tile) return;
          if (tile.type !== "term") {
            respondError(requestId, 4, "Tile is not a terminal");
            return;
          }
          const dom = tileManager.getTileDOMs().get(tile.id);
          if (dom?.webview) {
            dom.webview.send("terminal:clear");
          }
          // Also clear the sidecar RingBuffer so reconnects / capture
          // don't return the old output.
          if (tile.ptySessionId) {
            window.shellApi.ptyClearBuffer(tile.ptySessionId);
          }
          result = {};
          break;
        }
        case "tileFocus": {
          const ids = params.tileIds;
          if (!Array.isArray(ids) || ids.length === 0) {
            respondError(requestId, 4, "tileIds must be a non-empty array");
            return;
          }
          const focusTiles = [];
          for (const id of ids) {
            const t = getTile(id);
            if (!t) {
              respondError(requestId, 3, `Tile not found: ${id}`);
              return;
            }
            focusTiles.push(t);
          }
          // Set focus on the first tile (like keyboard shortcuts do)
          tileManager.focusCanvasTile(focusTiles[0].id, null);
          edgeIndicators.panToTiles(focusTiles);
          result = {};
          break;
        }
        case "refreshTile": {
          // Client Cmd+R 对称委托落点：与 Host 本地 Cmd+R 一致 ——
          // 刷新会话 + 终端重排(几何经上报广播回 Client) + 聚焦(镜像回 Client)。
          const tile = requireTile(requestId, params.tileId);
          if (!tile) return;
          if (tile.type !== "term") {
            respondError(requestId, 4, "Tile is not a terminal");
            return;
          }
          tileManager.refreshTerminalTile(tile.id);
          relayoutTerminalTiles?.();
          tileManager.focusCanvasTile(tile.id);
          result = {};
          break;
        }
        case "relayoutTiles": {
          if (typeof relayoutTerminalTiles !== "function") {
            respondError(requestId, -32601, "relayout not available");
            return;
          }
          relayoutTerminalTiles();
          result = {};
          break;
        }
        case "tileNotify": {
          if (!params.tileId) {
            respondError(requestId, 4, "tileId is required");
            return;
          }
          if (!getTile(params.tileId)) {
            respondError(requestId, 3, `Tile not found: ${params.tileId}`);
            return;
          }
          if (notifications) {
            notifications.show(params.tileId, params.message);
          }
          result = {};
          break;
        }
        case "tileReorder": {
          if (!requireTile(requestId, params.tileIdA)) return;
          if (!requireTile(requestId, params.tileIdB)) return;
          swapTerminalPositions(params.tileIdA, params.tileIdB);
          tileManager.repositionAllTiles();
          tileManager.saveCanvasImmediate();
          result = {};
          break;
        }
        default: {
          respondError(requestId, -32601, `Unknown method: ${method}`);
          return;
        }
      }
      respond(requestId, result);
    } catch (err) {
      respondError(requestId, -32603, err.message || "Internal error");
    }
  };
}
