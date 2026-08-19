import {
  tiles,
  addTile,
  removeTile,
  getTile,
  bringToFront,
  generateId,
  defaultSize,
  snapToGrid,
  selectTile,
  deselectTile,
  toggleTileSelection,
  clearSelection,
  isSelected,
  getSelectedTiles,
  findAutoPlacementForTerminal,
} from "./canvas-state.js";
import {
  createTileDOM,
  positionTile,
  updateTileTitle,
  getTileLabel,
  startInlineRename,
  updateLockButton,
  updateTileStatus,
} from "./tile-renderer.js";
import {
  attachDrag,
  attachResize,
  updateResizeHandles,
} from "./tile-interactions.js";
import { findAutoPlacement } from "./canvas-rpc.js";

/**
 * Tile lifecycle manager: creation, deletion, persistence, webview
 * spawning, focus, selection visuals, and canvas save/restore.
 */
export function createTileManager({
  tileLayer,
  viewportState,
  configs,
  getAllWebviews,
  isSpaceHeld,
  onSaveDebounced,
  onSaveImmediate,
  onNoteSurfaceFocus,
  onFocusSurface,
  onTerminalSessionCreated,
  onTerminalCwdChanged,
  onTerminalTileClosed,
  onTerminalTileResized,
  onTileFocused,
  onTileDblClick,
  onTermScreenshot,
  onLocate,
  onRefreshCooldown,
  onReposition,
  onPanToTile,
  onTileUserInput,
  getAliases = () => ({}),
}) {
  /** @type {Map<string, {container: HTMLElement, contentArea: HTMLElement, titleText: HTMLElement, webview?: HTMLElement}>} */
  const tileDOMs = new Map();
  let saveTimer = null;
  let focusedTileId = null;

  // -- Save memory mode state --
  let saveMemMode = true;
  let saveMemMaxTiles = 2;
  let saveMemDestroyDelay = 5;
  /** @type {string[]} — tile ids, most recently focused at the end */
  const terminalFocusOrder = [];
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const destroyTimers = new Map();

  // Viewport read-only accessor for tile-interactions
  const viewport = {
    get panX() {
      return viewportState.panX;
    },
    get panY() {
      return viewportState.panY;
    },
    get zoom() {
      return viewportState.zoom;
    },
  };

  // -- Coordinate validation --

  function safeCoord(v) {
    return Number.isFinite(v) ? v : 0;
  }

  // -- Canvas persistence --

  function getCanvasStateForSave() {
    return {
      version: 1,
      tiles: tiles.map((t) => ({
        id: t.id,
        type: t.type,
        x: safeCoord(t.x),
        y: safeCoord(t.y),
        width: t.width,
        height: t.height,
        filePath: t.filePath,
        folderPath: t.folderPath,
        workspacePath: t.workspacePath,
        ptySessionId: t.ptySessionId,
        cwd: t.cwd,
        url: t.url,
        zIndex: t.zIndex,
        userTitle: t.userTitle,
        autoTitle: t.autoTitle,
      })),
      viewport: {
        panX: viewportState.panX,
        panY: viewportState.panY,
        zoom: viewportState.zoom,
      },
    };
  }

  function saveCanvasDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      onSaveDebounced(getCanvasStateForSave());
    }, 500);
  }

  function saveCanvasImmediate() {
    clearTimeout(saveTimer);
    onSaveImmediate(getCanvasStateForSave());
  }

  // -- Tile positioning --

  function repositionAllTiles() {
    for (const tile of tiles) {
      const dom = tileDOMs.get(tile.id);
      if (!dom) continue;
      positionTile(
        dom.container,
        tile,
        viewportState.panX,
        viewportState.panY,
        viewportState.zoom,
      );
    }
    onReposition?.();
  }

  // -- Selection visuals --

  function syncSelectionVisuals() {
    for (const [id, dom] of tileDOMs) {
      dom.container.classList.toggle("tile-selected", isSelected(id));
    }
  }

  // -- Save memory mode helpers --

  function updateSaveMemConfig({ mode, maxTiles, destroyDelay } = {}) {
    if (typeof mode === "boolean") saveMemMode = mode;
    if (typeof maxTiles === "number") saveMemMaxTiles = maxTiles;
    if (typeof destroyDelay === "number") saveMemDestroyDelay = destroyDelay;
    if (saveMemMode) {
      enforceLimit();
    } else {
      cancelAllDestroyTimers();
    }
  }

  function cancelAllDestroyTimers() {
    for (const timer of destroyTimers.values()) clearTimeout(timer);
    destroyTimers.clear();
  }

  function showTilePlaceholder(dom, tileId, text) {
    if (!dom._placeholder) {
      dom._placeholder = document.createElement("div");
      dom._placeholder.className = "tile-placeholder";
      dom._placeholder.addEventListener("click", () => focusCanvasTile(tileId));
      dom.contentArea.appendChild(dom._placeholder);
    }
    dom._placeholder.textContent = text;
  }

  function destroyTerminalWebview(tileId, placeholderText = "Click to focus") {
    const dom = tileDOMs.get(tileId);
    if (!dom?.webview) return;
    dom.contentArea.removeChild(dom.webview);
    dom.webview = null;
    destroyTimers.delete(tileId);
    // Add placeholder so the user knows the tile is still alive
    showTilePlaceholder(dom, tileId, placeholderText);
  }

  // 聚焦 tile 崩溃后自动重建的次数上限；连续崩溃说明重建条件未消除
  // （如引擎级 bug 持续触发），超限后退回手动点击重建，避免崩溃循环。
  const MAX_CRASH_AUTO_REBUILD = 3;

  // 渲染进程崩溃后 webview 无法自愈。聚焦的 tile 自动重建以尽快恢复
  // 会话（sidecar ring buffer 容量有限，拖得越久内容丢失越多）；
  // 非聚焦 tile 显示重建入口，等待用户点击。
  function recoverCrashedTerminalWebview(tileId) {
    const dom = tileDOMs.get(tileId);
    if (!dom?.webview) return;
    dom.contentArea.removeChild(dom.webview);
    dom.webview = null;
    destroyTimers.delete(tileId);

    const tile = getTile(tileId);
    const wasFocused = focusedTileId === tileId;
    if (wasFocused) focusedTileId = null;

    if (wasFocused && tile?.type === "term") {
      if (!tile._crashCount) tile._crashCount = 0;
      tile._crashCount++;
      if (tile._crashCount <= MAX_CRASH_AUTO_REBUILD) {
        dom._pendingFocus = true;
        spawnTerminalWebview(tile);
        return;
      }
      tile._crashCount = 0;
    }

    showTilePlaceholder(dom, tileId, "界面已崩溃, 请点击重建");
  }

  function enforceLimit() {
    if (!saveMemMode) return;
    const activeTermIds = terminalFocusOrder.filter((id) => {
      const dom = tileDOMs.get(id);
      return dom?.webview != null;
    });
    const excess = activeTermIds.slice(
      0,
      activeTermIds.length - saveMemMaxTiles,
    );
    for (const id of excess) {
      if (!destroyTimers.has(id)) {
        destroyTimers.set(
          id,
          setTimeout(() => {
            destroyTerminalWebview(id);
          }, saveMemDestroyDelay * 1000),
        );
      }
    }
  }

  function trackTerminalFocus(tileId) {
    const idx = terminalFocusOrder.indexOf(tileId);
    if (idx !== -1) terminalFocusOrder.splice(idx, 1);
    terminalFocusOrder.push(tileId);
    const timer = destroyTimers.get(tileId);
    if (timer) {
      clearTimeout(timer);
      destroyTimers.delete(tileId);
    }
    enforceLimit();
  }

  // -- Focus management --

  function clearTileFocusRing() {
    for (const [, d] of tileDOMs) {
      d.container.classList.remove("tile-focused");
    }
  }

  function blurCanvasTileGuest(id = focusedTileId) {
    if (!id) return;
    const dom = tileDOMs.get(id);
    if (!dom?.webview) return;
    try {
      dom.webview.send("shell-blur");
    } catch {
      /* noop */
    }
    try {
      dom.webview.blur();
    } catch {
      /* noop */
    }
  }

  function forwardClickToWebview(webview, mouseEvent) {
    if (!webview.isConnected) return;
    // isLoading() throws when the guest hasn't attached or emitted dom-ready
    // yet (e.g. a save-memory rebuild in progress); treat that as still
    // loading and skip the click forward.
    let loading = true;
    try {
      if (typeof webview.isLoading === "function") {
        loading = webview.isLoading();
      }
    } catch {
      /* not attached or dom-ready not emitted yet */
    }
    if (loading) return;
    const rect = webview.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.round(
      (mouseEvent.clientX - rect.left) * (webview.offsetWidth / rect.width),
    );
    const y = Math.round(
      (mouseEvent.clientY - rect.top) * (webview.offsetHeight / rect.height),
    );
    if (x < 0 || y < 0) return;
    if (x > webview.offsetWidth || y > webview.offsetHeight) return;
    webview.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    webview.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  function focusCanvasTile(id, mouseEvent) {
    const tile = getTile(id);
    if (tile) {
      bringToFront(tile);
      repositionAllTiles();
    }
    const dom = tileDOMs.get(id);
    if (dom) {
      // Rebuild webview if save memory mode destroyed it
      const wasRebuilt = !dom.webview && tile?.type === "term";
      if (wasRebuilt) {
        if (dom._placeholder) {
          dom.contentArea.removeChild(dom._placeholder);
          dom._placeholder = null;
        }
        dom._pendingFocus = true;
        spawnTerminalWebview(tile);
      }
      if (dom.webview) {
        if (focusedTileId && focusedTileId !== id) {
          blurCanvasTileGuest(focusedTileId);
        }
        focusedTileId = id;
        window.shellApi.navigationPush(id);
        if (onTileFocused) {
          onTileFocused(tile);
        }
        clearTileFocusRing();
        dom.container.classList.add("tile-focused");
        // Electron forbids webview.focus() before dom-ready; _pendingFocus
        // handles the actual focus transfer once the webview has loaded.
        if (!wasRebuilt) {
          dom.webview.focus();
        }
        onNoteSurfaceFocus("canvas-tile");

        if (onPanToTile && tile) onPanToTile(tile);

        if (mouseEvent && mouseEvent.button === 0) {
          forwardClickToWebview(dom.webview, mouseEvent);
        }
      }
    }
    // Track terminal tile focus for LRU
    if (tile?.type === "term") {
      trackTerminalFocus(id);
    }
  }

  // -- Webview spawning --

  function spawnTerminalWebview(tile, autoFocus = false) {
    const dom = tileDOMs.get(tile.id);
    if (!dom) return;

    const wv = document.createElement("webview");
    const termConfig = configs.terminalTile;
    const params = new URLSearchParams();
    params.set("tileId", tile.id);
    if (tile.ptySessionId) {
      params.set("sessionId", tile.ptySessionId);
      params.set("restored", "1");
      if (tile.cwd) {
        params.set("cwd", tile.cwd);
      }
    } else if (tile.cwd) {
      params.set("cwd", tile.cwd);
    }
    const qs = params.toString();
    wv.setAttribute("src", qs ? `${termConfig.src}?${qs}` : termConfig.src);
    wv.setAttribute("preload", termConfig.preload);
    wv.setAttribute("webpreferences", "contextIsolation=yes, sandbox=yes");
    wv.style.width = "100%";
    wv.style.height = "100%";
    wv.style.border = "none";
    // Hide until the terminal has fitted to its container size, so the
    // first visible frame is already correctly sized (no visual jump).
    wv.style.visibility = "hidden";

    dom.contentArea.appendChild(wv);
    dom.webview = wv;

    wv.addEventListener("dom-ready", () => {
      // 重建成功后归零崩溃计数
      tile._crashCount = 0;
      window.shellApi.registerWebviewName("终端 Tile", wv.getWebContentsId());
      if (autoFocus) focusCanvasTile(tile.id);
      if (dom._pendingFocus) {
        dom._pendingFocus = false;
        if (dom.webview) dom.webview.focus();
        // Re-establish canvas-focused and tile-focused in case window
        // focus events cleared them while the webview was loading.
        dom.container.classList.add("tile-focused");
        onNoteSurfaceFocus("canvas-tile");
      }
      // Double-rAF to let xterm FitAddon finish sizing before revealing
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          wv.style.visibility = "";
        });
      });
      wv.addEventListener("before-input-event", (event) => {
        if (
          event.input.type === "keyDown" &&
          (event.input.meta || event.input.control) &&
          (event.input.code === "KeyR" || event.input.key === "r")
        ) {
          event.preventDefault();
        }
      });
    });

    wv.addEventListener("ipc-message", (event) => {
      if (event.channel === "open-external") {
        window.shellApi.openExternal(event.args[0]);
        return;
      }
      if (event.channel === "pty-session-id") {
        tile.ptySessionId = event.args[0];
        saveCanvasDebounced();
        if (onTerminalSessionCreated) {
          onTerminalSessionCreated(tile);
        }
      }
      if (event.channel === "term:request-screenshot") {
        if (onTermScreenshot) {
          onTermScreenshot(tile.id);
        }
      }
      if (event.channel === "pty-cwd-changed") {
        const cwd = event.args[1];
        if (cwd && cwd !== tile.autoTitle) {
          tile.cwd = cwd;
          tile.autoTitle = cwd;
          updateTileTitle(tileDOMs.get(tile.id), tile);
          saveCanvasDebounced();
          if (onTerminalCwdChanged) {
            onTerminalCwdChanged(cwd);
          }
        }
      }
      if (event.channel === "term:status-changed") {
        const sessionId = event.args[0];
        const status = event.args[1];
        const command = event.args[2] || "";
        const t = tiles.find((t) => t.ptySessionId === sessionId);
        if (t) {
          t.running = status === "running";
          t.runningCommand = status === "running" ? command : "";
          updateTileStatus(tileDOMs.get(t.id), t);
        }
      }
      if (event.channel === "term:refreshed") {
        clearRefreshMask(tileDOMs.get(tile.id), tile);
        focusCanvasTile(tile.id);
      }
      if (event.channel === "term:user-input") {
        const sessionId = event.args[0];
        if (sessionId && tile.ptySessionId === sessionId) {
          onTileUserInput?.(tile.id);
        }
      }
    });

    // Webview 崩溃时回收坏 webview，显示重建入口，避免永久黑屏
    wv.addEventListener("render-process-gone", () => {
      clearRefreshMask(tileDOMs.get(tile.id), tile);
      recoverCrashedTerminalWebview(tile.id);
    });

    // Forward console messages to the main-process log file (electron-log),
    // tagged with the terminal-tile panel so OSC 8 / PTY diagnostics are
    // captured in ~/.collab/logs/main-YYYY-MM-DD.log.
    wv.addEventListener("console-message", (event) => {
      window.shellApi.logFromWebview(
        "terminalTile",
        event.level,
        event.message,
        event.sourceId,
      );
    });
  }

  // -- Tile CRUD --

  function createCanvasTile(type, cx, cy, extra = {}) {
    const size = defaultSize(type);
    const tile = addTile({
      id: extra.id || generateId(),
      type,
      x: cx,
      y: cy,
      width: extra.width || size.width,
      height: extra.height || size.height,
      locked: true,
      ...extra,
    });
    snapToGrid(tile);
    window.shellApi.trackEvent("tile_created", { type });

    const dom = createTileDOM(tile, {
      onClose: (id) => closeCanvasTile(id),
      onFocus: (id, e) => {
        if (e && e.shiftKey) {
          toggleTileSelection(id);
          syncSelectionVisuals();
          return;
        }
        clearSelection();
        syncSelectionVisuals();
        focusCanvasTile(id, e);
      },
      onDuplicate: (id) => {
        const t = getTile(id);
        if (!t) return;
        const size = defaultSize("term");
        const pos = findAutoPlacementForTerminal(t.cwd, size);
        const newTile = createCanvasTile("term", pos.x, pos.y, {
          cwd: t.cwd,
          width: size.width,
          height: size.height,
        });
        spawnTerminalWebview(newTile, true);
        saveCanvasImmediate();
      },
      onRename: (id) => {
        const t = getTile(id);
        const d = tileDOMs.get(id);
        if (!t || !d) return;
        startInlineRename(d, t, (newTitle) => {
          if (newTitle === "") {
            delete t.userTitle;
          } else {
            t.userTitle = newTitle;
          }
          updateTileTitle(d, t);
          saveCanvasImmediate();
        });
      },
      onRefresh: (id) => {
        refreshTerminalTile(id);
      },
      onLocate: onLocate
        ? (id) => {
            const t = getTile(id);
            if (t?.type === "term" && t.cwd) {
              onLocate(t.cwd);
            }
          }
        : undefined,
      onToggleLock: (id) => {
        const t = getTile(id);
        const d = tileDOMs.get(id);
        if (!t || !d) return;
        t.locked = !t.locked;
        updateLockButton(d.lockBtn, t.locked);
        updateResizeHandles(d.container, t.locked);
        saveCanvasImmediate();
      },
    });

    // Double-click title bar → center tile in viewport
    dom.titleBar.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (onTileDblClick) onTileDblClick(tile);
    });

    attachDrag(dom.titleBar, tile, {
      viewport,
      onUpdate: repositionAllTiles,
      disablePointerEvents: (wvs) => {
        for (const w of wvs) {
          w.webview.style.pointerEvents = "none";
        }
      },
      enablePointerEvents: (wvs) => {
        for (const w of wvs) {
          w.webview.style.pointerEvents = "";
        }
      },
      getAllWebviews,
      getGroupDragContext: () => {
        if (!isSelected(tile.id) || getSelectedTiles().length <= 1) {
          return null;
        }
        return getSelectedTiles().map((t) => ({
          tile: t,
          container: tileDOMs.get(t.id)?.container,
          startX: t.x,
          startY: t.y,
        }));
      },
      onShiftClick: (id) => {
        toggleTileSelection(id);
        syncSelectionVisuals();
      },
      onFocus: (id, e) => focusCanvasTile(id, e),
      isSpaceHeld,
      contentOverlay: dom.contentOverlay,
    });
    attachResize(
      dom.container,
      tile,
      viewport,
      repositionAllTiles,
      getAllWebviews,
      () => focusCanvasTile(tile.id),
      (t) => {
        if (t.type === "term" && onTerminalTileResized) {
          onTerminalTileResized(t.width, t.height);
        }
      },
    );

    if (tile.locked !== false) {
      updateResizeHandles(dom.container, true);
    }

    tileLayer.appendChild(dom.container);
    tileDOMs.set(tile.id, dom);
    positionTile(
      dom.container,
      tile,
      viewportState.panX,
      viewportState.panY,
      viewportState.zoom,
    );

    return tile;
  }

  function clearRefreshMask(d, tile) {
    if (!d) return;
    console.log("[refreshTile] clearing mask");
    if (tile) tile._refreshing = false;
    const btn = d.container.querySelector(".tile-refresh-btn");
    if (btn) btn.classList.remove("spinning");
    const overlay = d.contentArea.querySelector(".tile-refresh-overlay");
    if (overlay) {
      overlay.classList.remove("visible");
      setTimeout(() => overlay.remove(), 600);
    }
  }

  function refreshTerminalTile(id) {
    const d = tileDOMs.get(id);
    if (!d) return;
    const tile = getTile(id);
    if (!tile || tile.type !== "term") return;

    // If save memory mode destroyed the webview, rebuild it.
    // The new webview starts fresh, so no terminal:refresh needed.
    if (!d.webview) {
      if (d._placeholder) {
        d.contentArea.removeChild(d._placeholder);
        d._placeholder = null;
      }
      spawnTerminalWebview(tile);
      return;
    }

    // 5 秒冷却限制
    if (tile._lastRefreshAt && Date.now() - tile._lastRefreshAt < 5000) {
      console.log("[refreshTile] cooldown, too frequent", id);
      onRefreshCooldown?.(id);
      return;
    }

    // _refreshing 标记守卫：刷新进行中忽略重复请求
    // 与 cooldown 双重保护：请求进行中拒，刚完成但还在 5s 内也拒
    if (tile._refreshing) {
      console.log("[refreshTile] blocked by _refreshing flag", id);
      return;
    }
    tile._refreshing = true;
    tile._lastRefreshAt = Date.now();

    console.log("[refreshTile] proceeding with refresh", id);
    const refreshBtn = d.container.querySelector(".tile-refresh-btn");
    if (refreshBtn) refreshBtn.classList.add("spinning");
    const overlay = document.createElement("div");
    overlay.className = "tile-refresh-overlay";
    overlay.innerHTML = refreshBtn?.innerHTML ?? "";
    d.contentArea.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("visible"));
    // 10s 安全兜底：清理视觉 + 释放标记
    setTimeout(() => clearRefreshMask(d, tile), 10000);

    d.webview.send("terminal:refresh");
  }

  function closeCanvasTile(id) {
    const dom = tileDOMs.get(id);
    if (dom) {
      dom.container.remove();
      tileDOMs.delete(id);
    }
    deselectTile(id);
    const tile = getTile(id);
    if (tile) {
      window.shellApi.trackEvent("tile_closed", { type: tile.type });
      if (tile.type === "term" && tile.ptySessionId) {
        window.shellApi.ptyKillSession(tile.ptySessionId);
        if (onTerminalTileClosed) {
          onTerminalTileClosed(tile.ptySessionId);
        }
      }
    }
    removeTile(id);
    onReposition?.();
    saveCanvasImmediate();
  }

  function clearCanvas(viewportObj) {
    const tileIds = tiles.map((t) => t.id);
    for (const id of tileIds) {
      closeCanvasTile(id);
    }
    viewportState.panX = 0;
    viewportState.panY = 0;
    viewportState.zoom = 1;
    viewportObj.updateCanvas();
    saveCanvasImmediate();
  }

  // -- Canvas state restore --

  function restoreCanvasState(savedTiles) {
    for (const saved of savedTiles) {
      let cx = saved.x;
      let cy = saved.y;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        const size = defaultSize(saved.type);
        const pos = findAutoPlacement(tiles, size.width, size.height);
        cx = pos.x;
        cy = pos.y;
      }

      if (saved.type === "term") {
        const tile = createCanvasTile("term", cx, cy, {
          id: saved.id,
          width: saved.width,
          height: saved.height,
          zIndex: saved.zIndex,
          ptySessionId: saved.ptySessionId,
          cwd: saved.cwd,
          userTitle: saved.userTitle,
          autoTitle: saved.autoTitle,
        });
        if (!saveMemMode) {
          spawnTerminalWebview(tile);
        }
      }
    }
  }

  // -- Tile updates for external events --

  function broadcastToTileWebviews(channel, ...args) {
    for (const [, dom] of tileDOMs) {
      if (!dom.webview) continue;
      try {
        dom.webview.send(channel, ...args);
      } catch {
        // 崩溃/回收窗口期的 webview 不可 send，跳过
      }
    }
  }

  function renameTile(id, newTitle) {
    const t = getTile(id);
    if (!t) return;
    if (newTitle === "") {
      delete t.userTitle;
    } else {
      t.userTitle = newTitle;
    }
    const d = tileDOMs.get(id);
    if (d) updateTileTitle(d, t);
    saveCanvasImmediate();
  }

  return {
    createCanvasTile,
    closeCanvasTile,
    focusCanvasTile,
    blurCanvasTileGuest,
    clearTileFocusRing,
    repositionAllTiles,
    syncSelectionVisuals,
    spawnTerminalWebview,
    clearCanvas,
    getCanvasStateForSave,
    restoreCanvasState,
    getTileDOMs: () => tileDOMs,
    getTile,
    getFocusedTileId: () => focusedTileId,
    setFocusedTileId: (id) => {
      focusedTileId = id;
    },
    refreshTerminalTile,
    renameTile,
    broadcastToTileWebviews,
    saveCanvasDebounced,
    saveCanvasImmediate,
    updateSaveMemConfig,
  };
}
