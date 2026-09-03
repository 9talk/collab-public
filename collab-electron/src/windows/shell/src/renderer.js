import "./shell.css";
import "./tooltip.js";
import {
  tiles,
  getTile,
  defaultSize,
  pickCanvasTileSize,
  tileAtPoint,
  selectTile,
  clearSelection,
  getSelectedTiles,
  getNearestTileInDirection,
  findAutoPlacementForTerminal,
  findNearestAdjacentTile,
  findNearestTerminalTile,
  computeTerminalLayout,
  snapToGrid,
  TERM_GAP,
} from "./canvas-state.js";
import { attachMarquee } from "./tile-interactions.js";
import { initDarkMode, applyCanvasOpacity } from "./dark-mode.js";
import { createWebview, isFocusSearchShortcut } from "./webview-factory.js";
import { createViewport } from "./canvas-viewport.js";
import { computeFitZoom } from "./fit-zoom.js";
import { createEdgeIndicators } from "./edge-indicators.js";
import { createMinimap } from "./canvas-minimap.js";
import { createPanel } from "./panel-manager.js";
import { createWorkspaceManager } from "./workspace-manager.js";
import { createCanvasRpc } from "./canvas-rpc.js";
import { createCanvasNotifications } from "./canvas-notification.tsx";
import { createTileManager } from "./tile-manager.js";
import { updateTileTitle, getTileLabel } from "./tile-renderer.js";

const CANVAS_DBLCLICK_SUPPRESS_MS = 500;
const IS_WINDOWS = window.shellApi.getPlatform() === "win32";

const viewportState = { panX: 0, panY: 0, zoom: 1 };

// 适配视图模式（remote 镜像）：fitActive 时窗口 resize 自动重算等比 zoom；
// 用户手动 zoom/pan 即退出，指示器菜单可重新进入。
let fitActive = false;
let fitHost = null; // { w, h, centerX, centerY, hostZoom }

function viewportManualChanged() {
  if (fitActive) fitActive = false;
}

const canvasEl = document.getElementById("panel-viewer");
const gridCanvas = document.getElementById("grid-canvas");
canvasEl.tabIndex = -1;

document.documentElement.classList.toggle("platform-win", IS_WINDOWS);
document.body.classList.toggle("platform-win", IS_WINDOWS);

// -- Dark mode --

initDarkMode(() => viewport.updateCanvas());

let broadcastCanvasOpacity = () => {};
const DEFAULT_CANVAS_OPACITY = 50;
let lastCanvasOpacity = DEFAULT_CANVAS_OPACITY;
let updateSaveMemConfig = null;
let filesNavTileSize = null;
let tileManager = null;

window.shellApi.getPref("canvasOpacity").then((v) => {
  lastCanvasOpacity = v != null ? v : DEFAULT_CANVAS_OPACITY;
  applyCanvasOpacity(lastCanvasOpacity);
  broadcastCanvasOpacity();
});

window.shellApi.onPrefChanged((key, value) => {
  if (key === "canvasOpacity") {
    lastCanvasOpacity = value;
    applyCanvasOpacity(value);
    broadcastCanvasOpacity();
  } else if (key === "workspace_aliases") {
    if (value && typeof value === "object") {
      window.__tileAliases = value;
      // Refresh all existing tile titles
      if (window.__refreshTileTitles) {
        window.__refreshTileTitles();
      }
    }
  } else if (key === "saveMemMode") {
    updateSaveMemConfig?.({ mode: !!value });
  } else if (key === "saveMemMaxTiles") {
    updateSaveMemConfig?.({ maxTiles: Number(value) || 2 });
  } else if (key === "saveMemDestroyDelay") {
    updateSaveMemConfig?.({ destroyDelay: Number(value) || 5 });
  } else if (key === "tileSize") {
    if (value && typeof value === "object") {
      const val = /** @type {{ width?: number; height?: number }} */ (value);
      if (typeof val.width === "number") filesNavTileSize = val;
    } else {
      filesNavTileSize = null;
    }
  } else if (key === "terminalScrollback") {
    // 实时转发给所有 terminal tile，让 xterm 立即调整滚动缓冲区
    if (typeof value === "number") {
      tileManager?.broadcastToTileWebviews(
        "pref-changed",
        "terminalScrollback",
        value,
      );
    }
  }
});

// -- Viewport --

const viewport = createViewport(
  canvasEl,
  gridCanvas,
  tiles,
  viewportManualChanged,
);

/** Convert in-memory panX/panY state to a center-point for persistence. */
function toCenterPointState(state) {
  const { panX, panY, zoom } = state.viewport;
  const w = canvasEl.clientWidth;
  const h = canvasEl.clientHeight;
  return {
    ...state,
    viewport: {
      centerX: (w / 2 - panX) / zoom,
      centerY: (h / 2 - panY) / zoom,
      zoom,
    },
  };
}

// -- Init --

async function init() {
  const [
    configs,
    workspaceData,
    prefNavWidth,
    prefSidebarMode,
    prefLastTerminalCwd,
    prefWorkspaceAliases,
  ] = await Promise.all([
    window.shellApi.getViewConfig(),
    window.shellApi.workspaceList(),
    window.shellApi.getPref("panel-width-nav"),
    window.shellApi.getPref("sidebar-mode"),
    window.shellApi.getPref("lastTerminalCwd"),
    window.shellApi.getPref("workspace_aliases"),
  ]);

  let lastTerminalCwd = prefLastTerminalCwd || null;
  let workspaceAliases =
    prefWorkspaceAliases && typeof prefWorkspaceAliases === "object"
      ? prefWorkspaceAliases
      : {};
  // Merge per-workspace config aliases as well
  if (workspaceData?.aliases) {
    workspaceAliases = { ...workspaceAliases, ...workspaceData.aliases };
  }

  // Store as module-level variable for tile-renderer access
  window.__tileAliases = workspaceAliases;

  window.shellApi.getPref("tileSize").then((v) => {
    if (v && typeof v === "object") {
      const val = /** @type {{ width?: number; height?: number }} */ (v);
      if (typeof val.width === "number") filesNavTileSize = val;
    }
  });

  function getTerminalCwd() {
    const focusedId = tileManager.getFocusedTileId();
    const focusedTile = tileManager.getTile(focusedId);
    if (focusedTile?.type === "term" && focusedTile.cwd) {
      return focusedTile.cwd;
    }
    return lastTerminalCwd || workspaceData.workspaces[0];
  }

  function setLastTerminalCwd(cwd) {
    lastTerminalCwd = cwd;
    window.shellApi.setPref("lastTerminalCwd", cwd);
  }

  // DOM elements
  const panelNav = document.getElementById("panel-nav");
  const panelViewer = document.getElementById("panel-viewer");
  const navResizeHandle = document.getElementById("nav-resize");
  const navToggle = document.getElementById("nav-toggle");
  const settingsOverlay = document.getElementById("settings-overlay");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const settingsModal = document.getElementById("settings-modal");
  const newTileBtn = document.getElementById("new-tile-btn");
  const relayoutBtn = document.getElementById("relayout-btn");
  const settingsBtn = document.getElementById("settings-btn");
  const dragDropOverlay = document.getElementById("drag-drop-overlay");
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingStatusEl = document.getElementById("loading-status");
  const tileLayer = document.getElementById("tile-layer");

  // -- State --

  let dragCounter = 0;
  let settingsModalOpen = false;
  let activeSurface = "canvas";
  let lastNonModalSurface = "canvas";
  let shiftHeld = false;
  let spaceHeld = false;
  let isPanning = false;
  let suppressCanvasDblClickUntil = 0;

  // -- Drag-and-drop handler (shared with webviews) --

  function handleDndMessage(channel) {
    if (channel === "dnd:dragenter") {
      dragCounter++;
      if (dragCounter === 1 && dragDropOverlay) {
        dragDropOverlay.classList.add("visible");
        for (const h of getAllWebviews()) {
          h.webview.style.pointerEvents = "none";
        }
      }
    } else if (channel === "dnd:dragleave") {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0 && dragDropOverlay) {
        dragDropOverlay.classList.remove("visible");
      }
    } else if (channel === "dnd:drop") {
      dragCounter = 0;
      if (dragDropOverlay) {
        dragDropOverlay.classList.remove("visible");
      }
      for (const h of getAllWebviews()) {
        h.webview.style.pointerEvents = "";
      }
    }
  }

  // -- Lazy viewer webview (created on first file selection) --

  let viewerInstance = null;

  function ensureViewer() {
    if (viewerInstance) return viewerInstance;
    viewerInstance = createWebview(
      "文件阅读器",
      configs.viewer,
      panelViewer,
      handleDndMessage,
      "viewer",
    );
    viewerInstance.webview.style.display = "none";
    viewerInstance.webview.addEventListener("focus", () => {
      noteSurfaceFocus("viewer");
    });
    viewerInstance.setBeforeInput((event, detail) => {
      if (!isFocusSearchShortcut(detail)) return;
      event.preventDefault();
      handleShortcut("focus-file-search");
    });
    return viewerInstance;
  }

  function getViewerIfExists() {
    return viewerInstance;
  }

  function destroyViewer() {
    if (!viewerInstance) return;
    viewerInstance.webview.blur();
    viewerInstance.webview.remove();
    viewerInstance = null;
  }

  // -- Singleton webviews (settings only; lazily created by onSettingsToggle) --

  const singletonWebviews = {};
  singletonWebviews.settings = null;

  // -- Panel manager --

  const panelManager = createPanel("nav", {
    panel: panelNav,
    resizeHandle: navResizeHandle,
    toggle: navToggle,
    label: "Navigator",
    defaultWidth: 280,
    direction: 1,
    validModes: ["closed", "files", "tiles"],
    prefKey: "sidebar-mode",
    getAllWebviews,
    onVisibilityChanged(visible) {
      panelViewer.classList.toggle("nav-open", visible);
      if (visible) {
        requestAnimationFrame(() => {
          getViewerIfExists()?.send("nav-visibility", true);
        });
      } else {
        getViewerIfExists()?.send("nav-visibility", false);
        canvasEl.focus();
      }
    },
    onModeChanged(mode) {
      updateSidebarContent(mode);
      updateSegmentedControl(mode);
    },
  });
  panelManager.initPrefs(prefNavWidth, prefSidebarMode);

  function syncTerminalTileMeta(tile, meta) {
    if (!meta) return;
    tile.cwd = meta.cwdHostPath || meta.cwd || tile.cwd;
    tile.autoTitle = meta.cwdHostPath || meta.cwd || tile.autoTitle;
    const dom = tileManager.getTileDOMs().get(tile.id);
    if (dom) {
      updateTileTitle(dom, tile);
    }
  }

  function buildTileListEntry(tile) {
    let title = tile.id;
    let description = "";
    let status = null;

    if (tile.type === "term") {
      const label = getTileLabel(tile, window.__tileAliases);
      title = label.parent ? label.parent + label.name : label.name;
      description = tile.cwd || "~";
      status = tile.ptySessionId ? "running" : "idle";
    }

    return {
      id: tile.id,
      type: tile.type,
      title,
      description,
      status,
      x: tile.x,
      y: tile.y,
    };
  }

  // -- File tree webview --

  const fileTreeContainer = document.createElement("div");
  fileTreeContainer.id = "file-tree-container";
  fileTreeContainer.style.display = "flex";
  fileTreeContainer.style.flex = "1";
  fileTreeContainer.style.minHeight = "0";
  panelNav.appendChild(fileTreeContainer);
  const navWebview = createWebview(
    "文件导航",
    configs.nav,
    fileTreeContainer,
    handleDndMessage,
    "nav",
  );
  navWebview.webview.addEventListener("focus", () => {
    noteSurfaceFocus("nav");
  });

  const tileListContainer = document.createElement("div");
  tileListContainer.id = "tile-list-container";
  tileListContainer.style.display = "none";
  tileListContainer.style.flex = "1";
  tileListContainer.style.minHeight = "0";
  panelNav.appendChild(tileListContainer);

  let tileListWebview = null;

  const todosContainer = document.createElement("div");
  todosContainer.id = "todos-container";
  todosContainer.style.display = "none";
  todosContainer.style.flex = "1";
  todosContainer.style.minHeight = "0";
  panelNav.appendChild(todosContainer);

  let todosWebview = null;

  function updateSidebarContent(mode) {
    fileTreeContainer.style.display = mode === "files" ? "flex" : "none";
    tileListContainer.style.display = mode === "tiles" ? "flex" : "none";
    todosContainer.style.display = mode === "todos" ? "flex" : "none";
    if (mode === "tiles") {
      ensureTileListWebview();
    } else if (tileListWebview) {
      tileListWebview.webview.remove();
      tileListWebview = null;
      lastTileSnapshot = new Map();
    }
    if (mode === "todos" && !todosWebview) {
      todosWebview = createWebview(
        "待办事项",
        configs.todos,
        todosContainer,
        undefined,
        "todos",
      );
    } else if (mode !== "todos" && todosWebview) {
      todosWebview.webview.remove();
      todosWebview = null;
    }
  }
  updateSidebarContent(panelManager.getMode());

  const modeButtons = document.querySelectorAll(".mode-btn");

  function updateSegmentedControl(mode) {
    for (const btn of modeButtons) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
  }

  for (const btn of modeButtons) {
    btn.addEventListener("click", () => {
      const targetMode = btn.dataset.mode;
      if (
        targetMode === "files" ||
        targetMode === "tiles" ||
        targetMode === "todos"
      ) {
        panelManager.setMode(targetMode);
      }
    });
  }

  updateSegmentedControl(panelManager.getMode());

  const workspaceManager = createWorkspaceManager({
    navWebview,
  });

  // Forward canvas opacity to nav webview
  broadcastCanvasOpacity = () => {
    if (lastCanvasOpacity == null) return;
    const opacity =
      Math.max(0, Math.min(100, Number(lastCanvasOpacity) || 0)) / 100;
    workspaceManager.getNavWebview().send("canvas-opacity", opacity);
    tileListWebview?.send("canvas-opacity", opacity);
  };
  broadcastCanvasOpacity();

  // -- Tile list sync --

  let lastTileSnapshot = new Map();

  function syncTileList() {
    const currentIds = new Set();
    // Sort by y (top-to-bottom) then x (left-to-right) to match canvas layout
    const domMap = tileManager.getTileDOMs();
    const sorted = [...tiles]
      .filter((t) => domMap.has(t.id))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    for (const tile of sorted) {
      currentIds.add(tile.id);
      const entry = buildTileListEntry(tile);
      const prev = lastTileSnapshot.get(tile.id);
      if (
        !prev ||
        prev.title !== entry.title ||
        prev.description !== entry.description ||
        prev.status !== entry.status
      ) {
        tileListWebview?.send(
          prev ? "tile-list:update" : "tile-list:add",
          entry,
        );
      }
      lastTileSnapshot.set(tile.id, entry);
    }
    for (const id of lastTileSnapshot.keys()) {
      if (!currentIds.has(id)) {
        tileListWebview?.send("tile-list:remove", id);
        lastTileSnapshot.delete(id);
      }
    }
  }

  // -- Tile geometry sync (remote 镜像, 双向) --
  //
  // 拖拽/缩放落定后把单 tile 几何上报主进程：
  //   - Full 版(Host)：主进程在 Host 激活时镜像给控制端 Client
  //   - Remote 版(Client)：经转发层走 Host rpc canvas:update-tile-geometry，
  //     由 Host 应用并保存（会话权威在 Host）
  // 上报只发自用户交互提交点；应用对端几何不经过提交点 → 无回声。

  /** @param {import("./canvas-state.js").Tile} tile */
  function reportTileGeometry(tile) {
    window.shellApi
      .updateTileGeometry({
        tileId: tile.id,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
      })
      .catch((err) => {
        console.log("[tile-geometry] report failed:", err?.message ?? err);
      });
  }

  /**
   * 应用对端提交的几何（Host 主进程 mirror 推送）。网格与对端一致，
   * snap 幂等；不触发上报、不本地存档（对端应用时已存档）。
   * @param {import("./canvas-state.js").Tile} tile
   */
  function applyRemoteTileGeometry(tile, payload) {
    const { x, y, width, height } = payload;
    if (![x, y, width, height].every(Number.isFinite)) return;
    tile.x = x;
    tile.y = y;
    tile.width = width;
    tile.height = height;
    snapToGrid(tile);
    tileManager.repositionAllTiles();
  }

  // -- Tile manager --

  let minimapRef = null;
  tileManager = createTileManager({
    tileLayer,
    viewportState,
    configs,
    getAllWebviews,
    isSpaceHeld: () => spaceHeld,
    onReposition: () => {
      viewport.redrawGrid();
      minimapRef?.update();
    },
    onSaveDebounced(state) {
      window.shellApi.canvasSaveState(toCenterPointState(state));
      syncTileList();
    },
    onSaveImmediate(state) {
      window.shellApi.canvasSaveState(toCenterPointState(state));
      syncTileList();
    },
    onNoteSurfaceFocus: noteSurfaceFocus,
    onFocusSurface: focusSurface,
    async onTerminalSessionCreated(tile) {
      const discovered = (await window.shellApi.ptyDiscover?.()) ?? [];
      const session = discovered.find(
        (entry) => entry.sessionId === tile.ptySessionId,
      );
      syncTerminalTileMeta(tile, session?.meta);
      tileManager.saveCanvasDebounced();
      syncTileList();
    },
    onTerminalCwdChanged(cwd) {
      setLastTerminalCwd(cwd);
    },
    onTerminalTileResized() {},
    onTileGeometryCommitted(tile) {
      reportTileGeometry(tile);
    },
    onLocate(cwd) {
      if (panelManager.getMode() !== "files") {
        panelManager.setMode("files");
      }
      // Send directly to nav webview to avoid viewer trying to readFile a directory path.
      workspaceManager.getNavWebview().send("file-selected", cwd);
    },
    onTerminalTileClosed() {
      syncTileList();
    },
    onTileFocused(tile) {
      tileListWebview?.send("tile-list:focus", tile?.id || null);
      if (tile) notifications.dismissByTileId(tile.id);
    },
    onTileUserInput(tileId) {
      notifications.dismissByTileId(tileId);
    },
    onTileDblClick(tile) {
      edgeIndicators.panToTile(tile);
    },
    onPanToTile(tile) {
      edgeIndicators.panToTile(tile);
    },
    onRefreshCooldown(tileId) {
      notifications.show(tileId, "请不要频繁刷新");
      setTimeout(() => notifications.dismissByTileId(tileId), 2500);
    },
    onTermContextMenu(tileId, counts = {}) {
      // Show context menu → screenshot via webContents.capturePage(),
      // or line stats from the xterm buffer.
      const tile = tileManager.getTile(tileId);
      if (!tile) return;
      if (tile.type !== "term") return;
      const dom = tileManager.getTileDOMs().get(tileId);
      if (!dom?.webview) return;
      if (!tile.ptySessionId) {
        window.shellApi.showConfirmDialog({
          message: "No terminal session",
          detail: "This terminal tile has no active session.",
          buttons: ["OK"],
        });
        return;
      }
      window.shellApi
        .showContextMenu([
          { id: "screenshot", label: "Screenshot" },
          { id: "line-count", label: "行数统计" },
        ])
        .then((selected) => {
          if (selected === "screenshot") {
            const wcId = dom.webview.getWebContentsId();
            window.shellApi.termScreenshotClipboard(wcId);
          } else if (selected === "line-count") {
            const bufferLines = Number.isFinite(counts?.bufferLines)
              ? counts.bufferLines
              : "—";
            const scrollbackLines = Number.isFinite(counts?.scrollbackLines)
              ? counts.scrollbackLines
              : "—";
            const viewportRows = Number.isFinite(counts?.viewportRows)
              ? counts.viewportRows
              : "—";
            const totalLines =
              typeof scrollbackLines === "number" &&
              typeof bufferLines === "number"
                ? scrollbackLines + bufferLines
                : "—";
            window.shellApi.showConfirmDialog({
              message: "终端行数统计",
              detail: `缓冲区总行数：${totalLines}（含滚动区 ${scrollbackLines} 行）\n视口行数：${viewportRows}`,
              buttons: ["OK"],
            });
          }
        });
    },
  });

  // Set up save memory mode — read initial prefs and wire onPrefChanged
  updateSaveMemConfig = tileManager.updateSaveMemConfig;
  const [prefSaveMemMode, prefSaveMemMaxTiles, prefSaveMemDestroyDelay] =
    await Promise.all([
      window.shellApi.getPref("saveMemMode"),
      window.shellApi.getPref("saveMemMaxTiles"),
      window.shellApi.getPref("saveMemDestroyDelay"),
    ]);
  updateSaveMemConfig({
    mode: typeof prefSaveMemMode === "boolean" ? prefSaveMemMode : true,
    maxTiles: typeof prefSaveMemMaxTiles === "number" ? prefSaveMemMaxTiles : 2,
    destroyDelay:
      typeof prefSaveMemDestroyDelay === "number" ? prefSaveMemDestroyDelay : 5,
  });

  // Allow onPrefChanged handler to refresh all tile titles when aliases change
  window.__refreshTileTitles = function () {
    const tileDOMs = tileManager.getTileDOMs();
    for (const [id, dom] of tileDOMs) {
      const tile = tileManager.getTile(id);
      if (tile) updateTileTitle(dom, tile);
    }
  };

  // Expose canvas state getter for main process to use during quit.
  // Save all tiles as-is (no dedup) for exit persistence
  window.__getCanvasStateForSave = function () {
    const state = tileManager.getCanvasStateForSave();
    return toCenterPointState(state);
  };

  // -- Edge indicators --

  const edgeIndicators = createEdgeIndicators({
    canvasEl,
    edgeIndicatorsEl: document.getElementById("edge-indicators"),
    viewportState,
    getTiles: () => tiles,
    getTileDOMs: () => tileManager.getTileDOMs(),
    onViewportUpdate() {
      viewport.updateCanvas();
    },
  });

  // -- Notifications --

  const notifications = createCanvasNotifications({
    getTile,
    edgeIndicators,
    tileManager,
    getTileLabel,
  });

  // -- Minimap --

  const minimap = createMinimap({
    viewportEl: canvasEl,
    wrapperEl: document.getElementById("minimap-wrapper"),
    viewportState,
    getTiles: () => tiles,
    viewport,
  });
  minimapRef = minimap;

  // -- Canvas RPC --

  const handleCanvasRpc = createCanvasRpc({
    tileManager,
    viewportState,
    viewport,
    edgeIndicators,
    notifications,
  });

  // -- Wire viewport updates --

  viewport.init(viewportState, () => {
    tileManager.repositionAllTiles();
    edgeIndicators.update();
    minimap.update();
    tileManager.saveCanvasDebounced();
  });

  edgeIndicators.update();
  minimap.update();

  // -- Surface focus management --

  function noteSurfaceFocus(surface) {
    if (settingsModalOpen && surface !== "settings") {
      focusSurface("settings");
      return;
    }
    if (activeSurface === "canvas-tile" && surface !== "canvas-tile") {
      tileManager.blurCanvasTileGuest();
    }
    activeSurface = surface;
    if (surface !== "settings") {
      lastNonModalSurface = surface;
    }
    const canvasOwned = surface === "canvas" || surface === "canvas-tile";
    canvasEl.classList.toggle("canvas-focused", canvasOwned);
    if (surface !== "canvas-tile") {
      tileManager.clearTileFocusRing();
    }
  }

  function isViewerVisible() {
    return viewerInstance && viewerInstance.webview.style.display !== "none";
  }

  function resolveSurface(surface = lastNonModalSurface) {
    if (surface === "canvas-tile" && tileManager.getFocusedTileId()) {
      const dom = tileManager.getTileDOMs().get(tileManager.getFocusedTileId());
      if (dom && dom.webview) return "canvas-tile";
    }
    if (surface === "viewer" && !isViewerVisible()) {
      surface = null;
    }
    if (surface === "nav" && !panelManager.isVisible()) {
      surface = null;
    }
    if (surface === "viewer") return "viewer";
    if (surface === "nav") return "nav";
    if (panelManager.isVisible()) return "nav";
    if (isViewerVisible()) return "viewer";
    return "canvas";
  }

  function focusSurface(surface = lastNonModalSurface) {
    if (surface === "canvas-tile" && tileManager.getFocusedTileId()) {
      const dom = tileManager.getTileDOMs().get(tileManager.getFocusedTileId());
      if (dom && dom.webview) {
        dom.webview.focus();
        noteSurfaceFocus("canvas-tile");
        return;
      }
    }

    requestAnimationFrame(() => {
      window.focus();
      if (surface === "settings" && singletonWebviews.settings) {
        singletonWebviews.settings.webview.focus();
        noteSurfaceFocus("settings");
        return;
      }
      const resolved = resolveSurface(surface);
      if (resolved === "nav") {
        workspaceManager.getNavWebview().webview.focus();
        noteSurfaceFocus("nav");
        return;
      }
      if (resolved === "viewer" && isViewerVisible()) {
        ensureViewer().webview.focus();
        noteSurfaceFocus("viewer");
        return;
      }
      canvasEl.focus();
      noteSurfaceFocus("canvas");
    });
  }

  function setUnderlyingShellInert(inert) {
    const panelsEl = document.getElementById("panels");
    panelsEl.inert = inert;
    navToggle.inert = inert;
  }

  function blurNonModalSurfaces() {
    canvasEl.blur();
    navToggle.blur();
    if (viewerInstance) viewerInstance.webview.blur();
    workspaceManager.getNavWebview().webview.blur();
  }

  // -- getAllWebviews aggregator --

  function getAllWebviews() {
    const all = [workspaceManager.getNavWebview()];
    if (viewerInstance) all.push(viewerInstance);
    if (tileListWebview) all.push(tileListWebview);
    if (singletonWebviews.settings) all.push(singletonWebviews.settings);
    for (const [, dom] of tileManager.getTileDOMs()) {
      if (dom.webview) {
        all.push({
          webview: dom.webview,
          send: (ch, ...args) => {
            if (dom.webview) dom.webview.send(ch, ...args);
          },
        });
      }
    }
    return all;
  }

  // -- Window + canvas focus listeners --

  window.addEventListener("focus", () => {
    noteSurfaceFocus("shell");
  });
  canvasEl.addEventListener("focus", () => {
    noteSurfaceFocus("canvas");
  });
  canvasEl.classList.add("canvas-focused");

  // -- Double-click to create terminal tile --

  canvasEl.addEventListener("dblclick", (e) => {
    if (spaceHeld || isPanning || Date.now() < suppressCanvasDblClickUntil)
      return;
    if (
      e.target !== canvasEl &&
      e.target !== gridCanvas &&
      e.target !== tileLayer
    )
      return;

    // Convert screen coords to canvas coords
    const rect = canvasEl.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const canvasX = (screenX - viewportState.panX) / viewportState.zoom;
    const canvasY = (screenY - viewportState.panY) / viewportState.zoom;

    // Try to find an adjacent tile to inherit cwd from
    const adjacent = findNearestAdjacentTile(canvasX, canvasY);
    const size = pickCanvasTileSize("term");

    let cwd;
    if (adjacent) {
      cwd =
        adjacent.tile.type === "term"
          ? adjacent.tile.cwd || getTerminalCwd()
          : getTerminalCwd();
    } else {
      cwd = getTerminalCwd();
    }

    // Placement is driven by cwd grouping, not click direction
    const pos = findAutoPlacementForTerminal(cwd, size);

    const tile = tileManager.createCanvasTile("term", pos.x, pos.y, {
      cwd,
      ...size,
    });
    tileManager.spawnTerminalWebview(tile, true);
    tileManager.saveCanvasImmediate();
    minimap.update();
    edgeIndicators.panToTile(tile);
  });

  // -- Right-click context menu --

  canvasEl.addEventListener("contextmenu", async (e) => {
    if (
      e.target !== canvasEl &&
      e.target !== gridCanvas &&
      e.target !== tileLayer
    )
      return;
    e.preventDefault();

    const selected = await window.shellApi.showContextMenu([
      { id: "new-terminal", label: "New terminal tile" },
    ]);

    if (selected === "new-terminal") {
      const cwd = getTerminalCwd();
      const size = pickCanvasTileSize("term");
      const pos = findAutoPlacementForTerminal(cwd, size);
      const tile = tileManager.createCanvasTile("term", pos.x, pos.y, {
        cwd,
        ...size,
      });
      tileManager.spawnTerminalWebview(tile, true);
      tileManager.saveCanvasImmediate();
      minimap.update();
      edgeIndicators.panToTile(tile);
    }
  });

  document.addEventListener("focusin", (event) => {
    if (!settingsModalOpen) return;
    if (settingsOverlay.contains(event.target)) return;
    focusSurface("settings");
  });

  // -- Marquee selection --

  attachMarquee(canvasEl, {
    viewport: {
      get panX() {
        return viewportState.panX;
      },
      get panY() {
        return viewportState.panY;
      },
      get zoom() {
        return viewportState.zoom;
      },
    },
    tiles: () => tiles,
    onSelectionChange: (ids) => {
      if (shiftHeld) {
        for (const id of ids) selectTile(id);
      } else {
        clearSelection();
        for (const id of ids) selectTile(id);
      }
      tileManager.syncSelectionVisuals();
      tileManager.blurCanvasTileGuest();
      tileManager.clearTileFocusRing();
      tileManager.setFocusedTileId(null);
      canvasEl.focus();
      noteSurfaceFocus("canvas");
    },
    isShiftHeld: () => shiftHeld,
    isSpaceHeld: () => spaceHeld,
    getAllWebviews,
  });

  // -- Selection keyboard handlers --

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && getSelectedTiles().length > 0) {
      clearSelection();
      tileManager.syncSelectionVisuals();
      return;
    }

    if (
      (e.key === "Backspace" || e.key === "Delete") &&
      (activeSurface === "canvas" || activeSurface === "canvas-tile")
    ) {
      const selected = getSelectedTiles();
      if (selected.length === 0) return;

      const count = selected.length;
      window.shellApi
        .showConfirmDialog({
          message: count === 1 ? "Delete this tile?" : `Delete ${count} tiles?`,
          detail: "This cannot be undone.",
          buttons: ["Cancel", "Delete"],
        })
        .then((response) => {
          if (response !== 1) return;
          for (const t of selected) {
            tileManager.closeCanvasTile(t.id);
          }
          clearSelection();
          tileManager.syncSelectionVisuals();
          minimap.update();
        });
    }
  });

  // -- Shift scroll passthrough --

  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && !shiftHeld) {
      shiftHeld = true;
      canvasEl.classList.add("shift-held");
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") {
      shiftHeld = false;
      canvasEl.classList.remove("shift-held");
    }
  });

  window.addEventListener("blur", () => {
    if (shiftHeld) {
      shiftHeld = false;
      canvasEl.classList.remove("shift-held");
    }
  });

  // -- Space+click and middle-click pan --

  window.addEventListener("keydown", (e) => {
    if (
      e.code === "Space" &&
      !e.target.closest?.("webview") &&
      !e.target.matches?.("input, textarea")
    ) {
      e.preventDefault();
      if (!e.repeat && !spaceHeld) {
        spaceHeld = true;
        canvasEl.classList.add("space-held");
        for (const h of getAllWebviews()) {
          h.webview.blur();
        }
      }
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceHeld = false;
      if (!isPanning) {
        canvasEl.classList.remove("space-held");
      }
    }
  });

  window.addEventListener("blur", () => {
    if (spaceHeld) {
      spaceHeld = false;
      canvasEl.classList.remove("space-held", "panning");
    }
  });

  canvasEl.addEventListener("mousedown", (e) => {
    const shouldPan = e.button === 1 || (e.button === 0 && spaceHeld);
    if (!shouldPan) return;

    e.preventDefault();
    suppressCanvasDblClickUntil = Date.now() + CANVAS_DBLCLICK_SUPPRESS_MS;
    isPanning = true;
    canvasEl.classList.add("panning");

    const startMX = e.clientX;
    const startMY = e.clientY;
    const startPanX = viewportState.panX;
    const startPanY = viewportState.panY;

    for (const h of getAllWebviews()) {
      h.webview.style.pointerEvents = "none";
    }

    function onMove(ev) {
      viewportState.panX = startPanX + (ev.clientX - startMX);
      viewportState.panY = startPanY + (ev.clientY - startMY);
      viewport.updateCanvas();
    }

    function onUp() {
      isPanning = false;
      canvasEl.classList.remove("panning");
      if (!spaceHeld) {
        canvasEl.classList.remove("space-held");
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      for (const h of getAllWebviews()) {
        h.webview.style.pointerEvents = "";
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // -- Shortcuts --

  function handleShortcut(action) {
    if (settingsModalOpen && action !== "toggle-settings") {
      focusSurface("settings");
      return;
    }
    if (action === "toggle-settings") {
      window.shellApi.toggleSettings();
    } else if (action === "sidebar-files") {
      panelManager.toggle();
    } else if (action === "sidebar-tiles") {
      panelManager.toggleToMode("tiles");
    } else if (action === "focus-file-search") {
      panelManager.setMode("files");
      focusSurface("nav");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          workspaceManager.getNavWebview().send("focus-search");
        });
      });
    } else if (action === "add-workspace") {
      window.shellApi.workspaceAdd();
    } else if (action === "new-tile") {
      const cwd = getTerminalCwd();
      const size = pickCanvasTileSize("term");
      const pos = findAutoPlacementForTerminal(cwd, size);
      const tile = tileManager.createCanvasTile("term", pos.x, pos.y, {
        cwd,
        ...size,
      });
      tileManager.spawnTerminalWebview(tile, true);
      tileManager.saveCanvasImmediate();
      minimap.update();
      edgeIndicators.panToTile(tile);
    } else if (action === "close-tile") {
      const focusedId = tileManager.getFocusedTileId();
      if (!focusedId) return;
      const tile = tileManager.getTile(focusedId);
      const isRunning = tile?.type === "term" && !!tile.running;
      // 关闭前捕获最近的 terminal tile,确认关闭后聚焦它
      const nearestBeforeClose = findNearestTerminalTile(focusedId);
      window.shellApi
        .showConfirmDialog({
          message: "关闭此终端?",
          detail: isRunning
            ? "终端仍有进程在运行,关闭后将终止会话。"
            : undefined,
          buttons: ["取消", "关闭"],
          defaultId: 1,
        })
        .then((response) => {
          if (response !== 1) return;
          // 确认期间 tile 可能已被其他路径关闭(如 pty 退出),重新校验
          if (!tileManager.getTile(focusedId)) return;
          tileManager.closeCanvasTile(focusedId);
          tileManager.setFocusedTileId(null);
          canvasEl.focus();
          noteSurfaceFocus("canvas");
          minimap.update();
          // 关闭后重新排列剩余终端,保持布局紧凑
          relayoutTerminalTiles();
          // 聚焦被关闭 tile 最近处的 terminal tile
          if (nearestBeforeClose?.id) {
            const target = tileManager.getTile(nearestBeforeClose.id);
            if (target && target.id !== focusedId) {
              tileManager.focusCanvasTile(target.id);
            }
          }
        });
    } else if (action === "refresh-terminal") {
      console.log("[refresh-terminal] shortcut triggered");
      const focusedId = tileManager.getFocusedTileId();
      if (focusedId) {
        const dom = tileManager.getTileDOMs().get(focusedId);
        if (dom?.webview) dom.webview.blur();
        requestAnimationFrame(() => {
          tileManager.refreshTerminalTile(focusedId);
          relayoutTerminalTiles();
          tileManager.focusCanvasTile(focusedId);
        });
      }
    } else if (
      action === "focus-tile-right" ||
      action === "focus-tile-left" ||
      action === "focus-tile-up" ||
      action === "focus-tile-down"
    ) {
      const direction = action.replace("focus-tile-", "");
      const currentId = tileManager.getFocusedTileId();
      let target;
      if (!currentId) {
        const rect = canvasEl.getBoundingClientRect();
        const cx = (rect.width / 2 - viewportState.panX) / viewportState.zoom;
        const cy = (rect.height / 2 - viewportState.panY) / viewportState.zoom;
        target = getNearestTileInDirection(null, direction, cx, cy);
      } else {
        target = getNearestTileInDirection(currentId, direction);
      }
      if (target) {
        tileManager.focusCanvasTile(target.id, null);
        notifications.dismissByTileId(target.id);
      }
    } else if (
      action === "nav-history-back" ||
      action === "nav-history-forward"
    ) {
      (async () => {
        const go =
          action === "nav-history-back"
            ? window.shellApi.navigationGoBack
            : window.shellApi.navigationGoForward;
        let tileId = await go();
        while (tileId && !getTile(tileId)) {
          tileId = await go();
        }
        if (tileId) {
          tileManager.focusCanvasTile(tileId, null);
        }
      })();
    } else if (action === "dismiss-notification") {
      const hadNotifications = notifications.dismissFirst();
      if (!hadNotifications) {
        const currentId = tileManager.getFocusedTileId();
        const runningTiles = tiles.filter(
          (t) => t.type === "term" && t.ptySessionId && t.running === true,
        );
        if (runningTiles.length === 0) return;
        const idx = runningTiles.findIndex((t) => t.id === currentId);
        const next = runningTiles[(idx + 1) % runningTiles.length];
        tileManager.focusCanvasTile(next.id, null);
      }
    }
  }

  window.shellApi.onShortcut(handleShortcut);

  window.addEventListener("keydown", (event) => {
    if (!isFocusSearchShortcut(event)) return;
    event.preventDefault();
    handleShortcut("focus-file-search");
  });

  window.addEventListener("keydown", (event) => {
    if (!event.metaKey || event.shiftKey || event.altKey) return;
    if (event.key === "n") {
      event.preventDefault();
      handleShortcut("new-tile");
    } else if (event.key === "w") {
      event.preventDefault();
      handleShortcut("close-tile");
    }
  });

  // -- IPC forwarding --

  window.shellApi.onForwardToWebview((target, channel, ...args) => {
    if (target === "shell") {
      if (channel === "remote:resynced") {
        // 连接/重连全量同步后：重读视觉类 pref 与 Host 对齐。
        // theme 已由主进程同步到 nativeTheme（prefers-color-scheme 自动随动）。
        window.shellApi
          .getPref("canvasOpacity")
          .then((v) => {
            if (v != null) {
              lastCanvasOpacity = v;
              applyCanvasOpacity(v);
              broadcastCanvasOpacity();
            }
          })
          .catch(() => {});
        window.shellApi
          .getPref("tileSize")
          .then((v) => {
            if (v && typeof v === "object") {
              const val = /** @type {{width?:number;height?:number}} */ (v);
              if (typeof val.width === "number") filesNavTileSize = val;
            } else {
              filesNavTileSize = null;
            }
          })
          .catch(() => {});
        return;
      }
      if (channel === "canvas:remote-state") {
        // Remote mode (client side): replay the host's canvas snapshot。
        // 全量对齐：先清空本地 tile（不 kill A 端 session），再重放 ——
        // A 端是 B 端的持久化权威。载荷含 hostWindow 时进入适配视图
        // （Client 本地等比缩放，Host 显示不受影响）。
        const payload = args[0];
        const canvasState =
          payload && typeof payload === "object" && payload.canvasState
            ? payload.canvasState
            : payload;
        const hostWindow =
          payload && typeof payload === "object" ? payload.hostWindow : null;
        tileManager.clearCanvasKeepSessions();
        void applyCanvasState(canvasState).then(() => {
          if (
            IS_REMOTE_APP &&
            hostWindow &&
            hostWindow.width &&
            hostWindow.height
          ) {
            const vp = canvasState?.viewport ?? {};
            const centerX =
              vp.centerX != null ? vp.centerX : canvasEl.clientWidth / 2;
            const centerY =
              vp.centerY != null ? vp.centerY : canvasEl.clientHeight / 2;
            fitHost = {
              w: hostWindow.width,
              h: hostWindow.height,
              centerX,
              centerY,
              hostZoom: vp.zoom ?? 1,
            };
            fitActive = true;
            const fitMenuBtn = document.getElementById("remote-menu-fit");
            if (fitMenuBtn) fitMenuBtn.disabled = false;
            applyFitNow();
          }
        });
        return;
      }
      if (channel === "remote:tile-geometry") {
        // 对端用户拖拽/缩放落定后的几何镜像 → 本地静默应用并 refit。
        // 应用路径不经过用户交互提交点，不会把随动当作新提交回推（回声抑制）。
        const payload = args[0];
        if (!payload || typeof payload.tileId !== "string") return;
        const tile = tileManager.getTile(payload.tileId);
        if (!tile) return;
        applyRemoteTileGeometry(tile, payload);
        return;
      }
      if (channel === "remote:pty-opened") {
        // A 端镜像：B 端经远程 pty:create 新建了终端，本端同步创建镜像 tile。
        // B 端自身也会收到该事件（forwardToWebview 的 mirror），按 tileId 幂等忽略。
        const payload = args[0];
        if (!payload?.tileId || !payload?.sessionId) return;
        if (tileManager.getTile(payload.tileId)) return;
        const layout = payload.layout;
        const tile = tileManager.createCanvasTile(
          "term",
          layout?.x ?? 0,
          layout?.y ?? 0,
          {
            id: payload.tileId,
            width: layout?.width,
            height: layout?.height,
            ptySessionId: payload.sessionId,
            cwd: payload.cwd,
            autoTitle: payload.displayName,
          },
        );
        tileManager.spawnTerminalWebview(tile, false);
        tileManager.saveCanvasImmediate();
        minimap.update();
        return;
      }
    } else if (target === "settings" && singletonWebviews.settings) {
      singletonWebviews.settings.send(channel, ...args);
    } else if (target === "nav") {
      workspaceManager.getNavWebview().send(channel, ...args);
    } else if (target === "viewer" || target.startsWith("viewer:")) {
      if (channel === "file-selected") {
        const hasSelectedFile = !!args[0];
        if (hasSelectedFile) {
          const v = ensureViewer();
          v.webview.style.display = "";
          v.send(channel, ...args);
        } else {
          destroyViewer();
          focusSurface(lastNonModalSurface);
        }
        return;
      }
      if (!viewerInstance) return;
      if (channel !== "workspace-changed") {
        viewerInstance.send(channel, ...args);
      }
      if (
        channel === "fs-changed" ||
        channel === "wikilinks-updated" ||
        channel.startsWith("agent:") ||
        channel === "replay:data"
      ) {
        tileManager.broadcastToTileWebviews(channel, ...args);
      }
    } else if (target === "canvas") {
      if (channel === "open-terminal") {
        const cwd = args[0];
        console.log(`[open-terminal] cwd="${cwd}"`);
        setLastTerminalCwd(cwd);
        const existing = tiles.find((t) => t.type === "term" && t.cwd === cwd);
        if (existing) {
          edgeIndicators.panToTile(existing);
          tileManager.focusCanvasTile(existing.id);
          return;
        }
        const size = filesNavTileSize || defaultSize("term");
        const pos = findAutoPlacementForTerminal(cwd, size);
        const tile = tileManager.createCanvasTile("term", pos.x, pos.y, {
          cwd,
          ...size,
        });
        tileManager.spawnTerminalWebview(tile, true);
        tileManager.saveCanvasImmediate();
        minimap.update();
        edgeIndicators.panToTile(tile);
      }
      if (channel === "locate-terminal") {
        const folderPath = args[0];
        const termTile = tiles.find(
          (t) => t.type === "term" && t.cwd === folderPath,
        );
        if (termTile) {
          edgeIndicators.panToTile(termTile);
          tileManager.focusCanvasTile(termTile.id);
        }
      }
    }
  });

  // -- Canvas pinch from tile webviews --

  window.shellApi.onCanvasPinch((deltaY) => {
    const rect = canvasEl.getBoundingClientRect();
    viewport.applyZoom(deltaY, rect.width / 2, rect.height / 2);
  });

  // -- Canvas RPC --

  window.shellApi.onCanvasRpcRequest(handleCanvasRpc);

  // -- PTY lifecycle forwarding --

  window.shellApi.onPtyExit((payload) => {
    // During app shutdown, ignore PTY exit events — the canvas
    // state has already been saved with terminal tiles intact,
    // and removing tiles here would overwrite the saved state.
    if (window.__canvasShuttingDown) return;
    for (const [id] of tileManager.getTileDOMs()) {
      const tile = getTile(id);
      if (tile?.type === "term" && tile.ptySessionId === payload.sessionId) {
        tileManager.closeCanvasTile(id);
        minimap.update();
        break;
      }
    }
  });

  // -- Tile list lazy-init --

  function ensureTileListWebview() {
    if (tileListWebview) return;
    tileListWebview = createWebview(
      "tile 列表",
      configs.tileList,
      tileListContainer,
      handleDndMessage,
      "tile-list",
    );
    tileListWebview.webview.addEventListener("dom-ready", () => {
      lastTileSnapshot = new Map();
      const initEntries = [];
      const domMap = tileManager.getTileDOMs();
      const sorted = [...tiles]
        .filter((t) => domMap.has(t.id))
        .sort((a, b) => a.y - b.y || a.x - b.x);
      for (const tile of sorted) {
        const entry = buildTileListEntry(tile);
        initEntries.push(entry);
        lastTileSnapshot.set(tile.id, entry);
      }
      tileListWebview.send("tile-list:init", initEntries);
      const focusedId = tileManager.getFocusedTileId();
      if (focusedId) {
        tileListWebview.send("tile-list:focus", focusedId);
      }
    });
    tileListWebview.webview.addEventListener("ipc-message", (event) => {
      if (event.channel === "tile-list:peek-tile") {
        const tileId = event.args[0];
        const tile = getTile(tileId);
        if (tile) {
          edgeIndicators.panToTile(tile, { targetZoom: 1 });
        }
      } else if (event.channel === "tile-list:focus-tile") {
        const tileId = event.args[0];
        const tile = getTile(tileId);
        if (tile) {
          edgeIndicators.panToTile(tile, { targetZoom: 1 });
          tileManager.focusCanvasTile(tileId);
        }
      } else if (event.channel === "tile-list:rename-tile") {
        const tileId = event.args[0];
        const newTitle = event.args[1];
        tileManager.renameTile(tileId, newTitle);
      }
    });
  }

  // Defer creation if starting in tiles mode (tileManager + edgeIndicators are ready by now)
  if (panelManager.getMode() === "tiles") ensureTileListWebview();

  // -- Nav resize --

  panelManager.setupResize(() => {
    panelManager.updateTogglePosition();
  });

  const panelsEl = document.getElementById("panels");
  new ResizeObserver(() => {
    panelManager.updateTogglePosition();
  }).observe(panelsEl);

  // -- Nav toggle --

  navToggle.addEventListener("click", () => {
    panelManager.toggle();
  });

  // -- Settings --

  settingsBackdrop.addEventListener("click", () => {
    window.shellApi.closeSettings();
  });

  window.shellApi.onSettingsToggle((action, pane) => {
    const open = action !== "close";
    settingsModalOpen = open;
    if (open) {
      if (!singletonWebviews.settings) {
        singletonWebviews.settings = createWebview(
          "设置窗口",
          configs.settings,
          settingsModal,
          handleDndMessage,
          "settings",
        );
        singletonWebviews.settings.webview.addEventListener("focus", () => {
          noteSurfaceFocus("settings");
        });
      }
      blurNonModalSurfaces();
      if (pane) {
        const wv = singletonWebviews.settings.webview;
        const sendPane = () => {
          try {
            wv.send("settings:open-pane", pane);
          } catch {
            // webview already gone
          }
        };
        if (wv.isLoading()) {
          wv.addEventListener("dom-ready", sendPane, { once: true });
        } else {
          sendPane();
        }
      }
    } else {
      singletonWebviews.settings?.webview.blur();
    }
    setUnderlyingShellInert(open);
    settingsOverlay.classList.toggle("visible", open);
    if (open) {
      focusSurface("settings");
      return;
    }
    // Destroy settings webview to free the renderer process
    if (singletonWebviews.settings) {
      singletonWebviews.settings.webview.remove();
      singletonWebviews.settings = null;
    }
    focusSurface(lastNonModalSurface);
  });

  newTileBtn.addEventListener("click", async () => {
    const cwd = getTerminalCwd();
    console.log(`[new-tile-btn] term cwd="${cwd}"`);
    const size = pickCanvasTileSize("term");
    const pos = findAutoPlacementForTerminal(cwd, size);
    const tile = tileManager.createCanvasTile("term", pos.x, pos.y, {
      cwd,
      ...size,
    });
    tileManager.spawnTerminalWebview(tile, true);
    tileManager.saveCanvasImmediate();
    minimap.update();
    const newTile = tiles[tiles.length - 1];
    edgeIndicators.panToTile(newTile);
  });

  settingsBtn.addEventListener("click", () => {
    window.shellApi.toggleSettings();
  });

  // -- Remote control button + status badge --

  const APP_FLAVOR = window.shellApi.getAppFlavor();
  const IS_REMOTE_APP = APP_FLAVOR === "remote";

  const remoteBtn = document.getElementById("remote-btn");
  const remoteIndicator = document.getElementById("remote-indicator");
  const remoteStatusDot = document.getElementById("remote-status-dot");
  const remoteStatusText = document.getElementById("remote-status-text");
  const remoteMenu = document.getElementById("remote-menu");
  const remoteMenuDisconnect = document.getElementById(
    "remote-menu-disconnect",
  );
  const remoteMenuFit = document.getElementById("remote-menu-fit");

  const REMOTE_STRINGS = {
    en: {
      disconnectedTitle: "Connection lost",
      disconnectedSub: "Reconnecting automatically…",
      authTitle: "Pairing code expired",
      authSub:
        "The pairing code is no longer valid. Return to the connect screen to pair again.",
      back: "Back to Connect",
      disconnect: "Disconnect",
      resetFit: "Reset Fit View",
    },
    zh: {
      disconnectedTitle: "连接已断开",
      disconnectedSub: "正在自动重新连接…",
      authTitle: "配对码已失效",
      authSub: "配对码已过期，返回连接页重新配对即可。",
      back: "返回连接页",
      disconnect: "断开连接",
      resetFit: "重置为适配视图",
    },
  };
  let remoteStrings = REMOTE_STRINGS.en;
  window.shellApi.getPref("locale").then((v) => {
    if (v === "zh") remoteStrings = REMOTE_STRINGS.zh;
    else remoteStrings = REMOTE_STRINGS.en;
    renderRemoteOverlay(currentRemoteStatus);
  });

  const remoteOverlay = document.getElementById("remote-overlay");
  const remoteOverlayTitle = document.getElementById("remote-overlay-title");
  const remoteOverlaySub = document.getElementById("remote-overlay-sub");
  const remoteOverlayActions = document.getElementById("remote-overlay-actions");
  const remoteOverlayBack = document.getElementById("remote-overlay-back");
  const remoteOverlaySpinner = document.getElementById("remote-overlay-spinner");
  const remoteOverlayWarn = document.getElementById("remote-overlay-warn");

  /** 镜像 shell 只在连接成功后创建；连接态被打破时依状态展示 overlay */
  let currentRemoteStatus = null;
  function renderRemoteOverlay(status) {
    if (!IS_REMOTE_APP) return;
    currentRemoteStatus = status;
    const showSpinner = status?.state === "connecting";
    const authFailed = status?.state === "idle" && !!status?.lastError;
    const visible = showSpinner || authFailed;
    if (visible) {
      remoteOverlaySpinner.classList.toggle("hidden", !showSpinner);
      remoteOverlayWarn.classList.toggle("hidden", showSpinner);
      remoteOverlayTitle.textContent = showSpinner
        ? remoteStrings.disconnectedTitle
        : remoteStrings.authTitle;
      remoteOverlaySub.textContent = showSpinner
        ? remoteStrings.disconnectedSub
        : remoteStrings.authSub;
      remoteOverlayBack.textContent = remoteStrings.back;
      remoteOverlayActions.style.display = showSpinner ? "none" : "flex";
      remoteOverlay.classList.add("visible");
    } else {
      remoteOverlay.classList.remove("visible");
    }
  }

  remoteOverlayBack.addEventListener("click", () => {
    // 主动断开：主进程销毁镜像 shell 并回到连接页
    window.shellApi.disconnectRemoteClient?.();
  });

  remoteMenuDisconnect.textContent = remoteStrings.disconnect;
  remoteMenuFit.textContent = remoteStrings.resetFit;
  if (!fitHost) remoteMenuFit.disabled = true;

  // 适配视图计算(Client 本地):等比缩放使 Host 画布完整填充本端视口,
  // 中心沿用 Host 视口中心。仅本地视图变换,不回写 Host。
  function applyFitNow() {
    if (!fitHost) return;
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    if (!w || !h) return;
    const fit = computeFitZoom({
      hostW: fitHost.w,
      hostH: fitHost.h,
      hostZoom: fitHost.hostZoom,
      clientW: w,
      clientH: h,
    });
    if (!fit) return;
    viewportState.zoom = fit.zoom;
    viewportState.panX = w / 2 - fitHost.centerX * fit.zoom;
    viewportState.panY = h / 2 - fitHost.centerY * fit.zoom;
    viewport.updateCanvas();
    minimap.update();
  }

  // 适配模式下窗口尺寸变化(防抖 200ms)自动重算保持完整展示
  if (IS_REMOTE_APP) {
    let fitResizeTimer = null;
    new ResizeObserver(() => {
      if (!fitActive) return;
      clearTimeout(fitResizeTimer);
      fitResizeTimer = setTimeout(() => {
        fitResizeTimer = null;
        if (fitActive) applyFitNow();
      }, 200);
    }).observe(canvasEl);
  }

  function positionRemoteMenu() {
    const rect = remoteBtn.getBoundingClientRect();
    remoteMenu.style.left = `${Math.max(8, rect.left)}px`;
    remoteMenu.style.top = `${rect.bottom + 6}px`;
  }

  function toggleRemoteMenu() {
    if (remoteMenu.classList.contains("hidden")) {
      positionRemoteMenu();
      remoteMenu.classList.remove("hidden");
    } else {
      remoteMenu.classList.add("hidden");
    }
  }

  remoteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!IS_REMOTE_APP) {
      window.shellApi.openSettingsPane("remote");
      return;
    }
    toggleRemoteMenu();
  });

  window.addEventListener("mousedown", (e) => {
    if (
      !remoteMenu.classList.contains("hidden") &&
      !remoteMenu.contains(e.target) &&
      e.target !== remoteBtn
    ) {
      remoteMenu.classList.add("hidden");
    }
  });

  remoteMenuDisconnect.addEventListener("click", () => {
    remoteMenu.classList.add("hidden");
    window.shellApi.disconnectRemoteClient?.();
  });

  remoteMenuFit.addEventListener("click", () => {
    remoteMenu.classList.add("hidden");
    if (!fitHost) return;
    fitActive = true;
    applyFitNow();
  });

  function renderRemoteBadge(status) {
    currentRemoteStatus = status;
    if (!status || typeof status.state !== "string") return;
    if (status.state === "idle") {
      remoteIndicator.style.display = "none";
      renderRemoteOverlay(status);
      return;
    }
    remoteIndicator.style.display = "flex";
    remoteStatusDot.className = `remote-dot is-${status.state}`;
    if (status.state === "connected") {
      const peerId =
        status.hostInfo?.deviceId ??
        status.peer?.deviceId ??
        status.peer?.displayName ??
        "";
      remoteStatusText.textContent =
        status.pairCode ?? (peerId ? `→ ${peerId}` : "");
      remoteIndicator.title = `Remote: connected${peerId ? ` (${peerId})` : ""}`;
    } else if (status.state === "connecting") {
      remoteStatusText.textContent = "";
      remoteIndicator.title = "Remote: connecting…";
    } else {
      remoteStatusText.textContent = "";
      remoteIndicator.title = "Remote: off";
    }
    renderRemoteOverlay(status);
  }

  window.shellApi
    .getRemoteStatus()
    .then((s) => renderRemoteBadge(s))
    .catch(() => {});
  window.shellApi.onRemoteStatus((s) => {
    renderRemoteBadge(s);
    // nav webview 是独立 webContents，收不到主进程 broadcast 的 remote-status，
    // 由 shell 桥接转发（nav 据此隐藏/恢复「Add workspace」按钮）。
    workspaceManager.getNavWebview().send("remote-status", s);
  });

  function relayoutTerminalTiles() {
    const positions = computeTerminalLayout();
    for (const [id, x, y] of positions) {
      const tile = getTile(id);
      if (!tile) continue;
      tile.x = x;
      tile.y = y;
    }
    tileManager.repositionAllTiles();
    tileManager.saveCanvasImmediate();
    minimap.update();
  }

  relayoutBtn.addEventListener("click", relayoutTerminalTiles);

  // -- Loading --

  window.shellApi.onLoadingStatus((message) => {
    loadingStatusEl.textContent = message;
  });

  window.shellApi.onLoadingDone(() => {
    loadingOverlay.classList.add("fade-out");
    setTimeout(() => {
      loadingOverlay.remove();
    }, 350);
    checkFirstLaunchDialog();
  });

  // -- Drag-and-drop (window-level) --

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1 && dragDropOverlay) {
      dragDropOverlay.classList.add("visible");
    }
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0 && dragDropOverlay) {
      dragDropOverlay.classList.remove("visible");
    }
  });

  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (dragDropOverlay) {
      dragDropOverlay.classList.remove("visible");
    }

    const rect = canvasEl.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const cx = (screenX - viewportState.panX) / viewportState.zoom;
    const cy = (screenY - viewportState.panY) / viewportState.zoom;

    // Extract Finder file paths synchronously — native file
    // handles on DataTransfer are invalidated after the first
    // await, so getPathForFile must run before getDragPaths.
    const finderPaths = [];
    if (e.dataTransfer?.files) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        let p = "";
        try {
          p = window.shellApi.getPathForFile(e.dataTransfer.files[i]);
        } catch {
          /* skip non-file items */
        }
        if (p) finderPaths.push(p);
      }
    }

    let paths = [];
    if (window.shellApi.getDragPaths) {
      try {
        paths = await window.shellApi.getDragPaths();
      } catch {
        /* noop */
      }
    }
    if (paths.length === 0) {
      paths = finderPaths;
    }
    if (paths.length === 0) return;

    const viewerRect = panelViewer.getBoundingClientRect();
    if (e.clientX < viewerRect.left) return;

    // Filter out directories in parallel (folder drops not supported)
    const checks = paths.map(async (p) => {
      const isDir = await window.shellApi.isDirectory(p);
      return isDir ? null : p;
    });
    const filePaths = (await Promise.all(checks)).filter(Boolean);
    if (filePaths.length === 0) return;

    // If drop landed on a terminal tile, paste paths into the PTY
    const targetTile = tileAtPoint(cx, cy);
    if (targetTile && targetTile.type === "term" && targetTile.ptySessionId) {
      const escaped = filePaths.map(
        (p) => "'" + p.replace(/'/g, "'\\''") + "'",
      );
      window.shellApi.ptyWrite(targetTile.ptySessionId, escaped.join(" "));
      tileManager.focusCanvasTile(targetTile.id);
      return;
    }
  });

  if (dragDropOverlay) {
    dragDropOverlay.addEventListener("transitionend", () => {
      if (!dragDropOverlay.classList.contains("visible")) {
        for (const h of getAllWebviews()) {
          h.webview.style.pointerEvents = "";
        }
      }
    });
  }

  // -- Restore canvas state --

  async function applyCanvasState(savedState) {
    if (!savedState) return;
    const { centerX, centerY, zoom } = savedState.viewport;
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    viewportState.zoom = zoom ?? 1;
    viewportState.panX =
      centerX != null ? w / 2 - centerX * viewportState.zoom : 0;
    viewportState.panY =
      centerY != null ? h / 2 - centerY * viewportState.zoom : 0;
    viewport.updateCanvas();
    tileManager.restoreCanvasState(savedState.tiles);
    viewport.redrawGrid();
    minimap.update();

    // Batch-sync metadata for restored terminal tiles
    const restoredTermTiles = tiles.filter(
      (t) => t.type === "term" && t.ptySessionId,
    );
    if (restoredTermTiles.length > 0) {
      const discovered = (await window.shellApi.ptyDiscover?.()) ?? [];
      for (const tile of restoredTermTiles) {
        const session = discovered.find(
          (entry) => entry.sessionId === tile.ptySessionId,
        );
        syncTerminalTileMeta(tile, session?.meta);
      }
      tileManager.saveCanvasDebounced();
    }
  }

  const savedState = await window.shellApi.canvasLoadState();
  if (savedState) {
    await applyCanvasState(savedState);
  }

  // -- Initialize workspaces --

  navWebview.send("workspace-init", workspaceData.workspaces);

  panelManager.applyVisibility();

  // Auto-relayout terminals on app open — same as clicking the relayout button
  const relayoutPositions = computeTerminalLayout();
  if (relayoutPositions.length > 0) {
    for (const [id, x, y] of relayoutPositions) {
      const tile = getTile(id);
      if (!tile) continue;
      tile.x = x;
      tile.y = y;
    }
    tileManager.repositionAllTiles();
    tileManager.saveCanvasImmediate();
    minimap.update();
  }
}

async function checkFirstLaunchDialog() {
  const offered = await window.shellApi.hasOfferedPlugin();
  if (offered) return;

  const agents = await window.shellApi.getAgents();

  const dialog = document.getElementById("canvas-skill-dialog");
  const agentsContainer = document.getElementById("canvas-skill-agents");
  const skipBtn = document.getElementById("canvas-skill-skip");
  const installBtn = document.getElementById("canvas-skill-install");
  if (!dialog || !agentsContainer || !skipBtn || !installBtn) return;

  agentsContainer.innerHTML = "";
  const checkboxes = [];

  for (const agent of agents) {
    const row = document.createElement("label");
    row.className = "canvas-skill-agent-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = agent.detected;
    checkbox.dataset.agentId = agent.id;
    checkboxes.push(checkbox);

    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = agent.name;

    const badge = document.createElement("span");
    badge.className = agent.detected
      ? "agent-badge detected"
      : "agent-badge not-found";
    badge.textContent = agent.detected ? "detected" : "not found";

    row.appendChild(checkbox);
    row.appendChild(name);
    row.appendChild(badge);
    agentsContainer.appendChild(row);
  }

  dialog.classList.remove("hidden");

  function closeDialog() {
    dialog.classList.add("hidden");
    window.shellApi.markPluginOffered();
  }

  skipBtn.addEventListener("click", closeDialog, { once: true });

  installBtn.addEventListener("click", async function onInstall() {
    installBtn.disabled = true;
    installBtn.textContent = "Installing…";
    // Clear previous error if retrying
    dialog.querySelector(".canvas-skill-error")?.remove();
    const errors = [];
    for (const cb of checkboxes) {
      if (cb.checked) {
        try {
          const result = await window.shellApi.installSkill(cb.dataset.agentId);
          if (result && !result.ok) {
            errors.push(`${cb.dataset.agentId}: ${result.error}`);
          }
        } catch (err) {
          errors.push(`${cb.dataset.agentId}: ${err.message || err}`);
        }
      }
    }
    if (errors.length > 0) {
      installBtn.textContent = "Install";
      installBtn.disabled = false;
      const errEl = document.createElement("p");
      errEl.className = "canvas-skill-error";
      errEl.textContent = `Install failed: ${errors.join("; ")}`;
      dialog
        .querySelector("#canvas-skill-actions")
        ?.insertAdjacentElement("beforebegin", errEl);
      return;
    }
    installBtn.removeEventListener("click", onInstall);
    closeDialog();
  });
}

init().catch((err) => {
  console.error("[shell] init() failed:", err);
  const el = document.getElementById("loading-status");
  if (el) el.textContent = `ERROR: ${err?.message || err}`;
});
