import { splitDisplayPath } from "@collab/shared/path-utils";

/**
 * Turns arbitrary input into a navigable URL.
 * If the input looks like a URL (has a scheme or a recognized TLD),
 * return it (prepending https:// when needed). Otherwise treat it as
 * a Google search query.
 */
function resolveInput(raw) {
  const s = raw.trim();
  if (!s) return "";

  // Already has a scheme
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;

  // Looks like a domain (with TLD), optionally followed by path/query
  if (/^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return `https://${s}`;

  // Anything else → Google search
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

/**
 * Creates the DOM structure for a tile.
 * @param {import('./canvas-state.js').Tile} tile
 * @param {object} callbacks
 * @param {(id: string) => void} callbacks.onClose
 * @param {(id: string, e?: MouseEvent) => void} callbacks.onFocus
 * @param {((id: string) => void)|null} [callbacks.onOpenInViewer]
 * @param {((id: string, url: string) => void)|null} [callbacks.onNavigate]
 * @param {((id: string) => void)|null} [callbacks.onRename]
 * @param {((id: string) => void)|null} [callbacks.onDuplicate]
 * @param {((id: string) => void)|null} [callbacks.onRefresh]
 * @param {((id: string) => void)|null} [callbacks.onLocate]
 * @param {((id: string) => void)|null} [callbacks.onToggleLock]
 */
export function createTileDOM(tile, callbacks) {
  const container = document.createElement("div");
  container.className = "canvas-tile";
  container.dataset.tileId = tile.id;
  container.dataset.tileType = tile.type;

  const titleBar = document.createElement("div");
  titleBar.className = "tile-title-bar";

  const titleText = document.createElement("span");
  titleText.className = "tile-title-text";
  renderTileTitleContent(titleText, tile, window.__tileAliases);
  titleBar.appendChild(titleText);

  // For browser tiles, add nav controls and a URL input to the title bar
  let urlInput;
  let navBack;
  let navForward;
  let navReload;
  if (tile.type === "browser") {
    const navGroup = document.createElement("div");
    navGroup.className = "tile-nav-group";

    navBack = document.createElement("button");
    navBack.className = "tile-nav-btn";
    navBack.title = "Back";
    navBack.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>`;
    navBack.disabled = true;
    navBack.addEventListener("mousedown", (e) => e.stopPropagation());

    navForward = document.createElement("button");
    navForward.className = "tile-nav-btn";
    navForward.title = "Forward";
    navForward.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>`;
    navForward.disabled = true;
    navForward.addEventListener("mousedown", (e) => e.stopPropagation());

    navReload = document.createElement("button");
    navReload.className = "tile-nav-btn";
    navReload.title = "Reload";
    navReload.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3v4h-4"/><path d="M12.36 10a5 5 0 1 1-.96-5.36L13 7"/></svg>`;
    navReload.addEventListener("mousedown", (e) => e.stopPropagation());

    navGroup.appendChild(navBack);
    navGroup.appendChild(navForward);
    navGroup.appendChild(navReload);
    titleBar.appendChild(navGroup);
    urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "tile-url-input";
    urlInput.placeholder = "Search or enter URL...";
    urlInput.value = tile.url || "";
    if (tile.url) urlInput.readOnly = true;
    let dragOccurred = false;
    urlInput.addEventListener("mousedown", (e) => {
      dragOccurred = false;
      if (urlInput.readOnly) return;
      e.stopPropagation();
    });
    urlInput.addEventListener("mousemove", () => {
      dragOccurred = true;
    });
    urlInput.addEventListener("click", () => {
      if (urlInput.readOnly && !dragOccurred) {
        urlInput.readOnly = false;
        urlInput.select();
      }
    });
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const url = resolveInput(urlInput.value);
        if (url && callbacks.onNavigate) callbacks.onNavigate(tile.id, url);
        urlInput.readOnly = true;
        urlInput.blur();
      }
      if (e.key === "Escape") {
        urlInput.value = tile.url || "";
        urlInput.readOnly = true;
        urlInput.blur();
      }
    });
    urlInput.addEventListener("blur", () => {
      if (!urlInput.readOnly) {
        urlInput.value = tile.url || "";
        urlInput.readOnly = true;
      }
      window.getSelection()?.removeAllRanges();
    });
    titleText.style.display = "none";
  }

  const btnGroup = document.createElement("div");
  btnGroup.className = "tile-btn-group";

  const copyablePath = tile.filePath || tile.folderPath;
  if (copyablePath) {
    const copySvg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/></svg>`;
    const checkSvg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#4caf50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4"/></svg>`;
    const copyBtn = document.createElement("button");
    copyBtn.className = "tile-action-btn tile-copy-path-btn";
    copyBtn.innerHTML = copySvg;
    copyBtn.title = "Copy path";
    copyBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(copyablePath);
      copyBtn.innerHTML = checkSvg;
      setTimeout(() => {
        copyBtn.innerHTML = copySvg;
      }, 1000);
    });
    btnGroup.appendChild(copyBtn);
  }

  if (tile.filePath && callbacks.onOpenInViewer) {
    const viewBtn = document.createElement("button");
    viewBtn.className = "tile-action-btn tile-view-btn";
    viewBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s3-5.5 7-5.5S15 8 15 8s-3 5.5-7 5.5S1 8 1 8z"/><circle cx="8" cy="8" r="2.5"/></svg>`;
    viewBtn.title = "Open in viewer";
    viewBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      callbacks.onOpenInViewer(tile.id);
    });
    btnGroup.appendChild(viewBtn);
  }

  if (tile.type === "term" && tile.cwd) {
    const editBtn = document.createElement("button");
    editBtn.className = "tile-action-btn tile-editor-btn";
    editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13.5 4 13.5 2 11.5 2"/><line x1="9" y1="7" x2="13.5" y2="2"/><polyline points="12 8 12 13.5 2 13.5 2 4 7.5 4"/></svg>`;
    editBtn.title = "Open in external editor";
    editBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof window.shellApi.openWorkspaceInExternalEditor === "function") {
        window.shellApi.openWorkspaceInExternalEditor(tile.cwd);
      }
    });
    btnGroup.appendChild(editBtn);
  }

  if (tile.type === "term" && tile.cwd && callbacks.onLocate) {
    const locateBtn = document.createElement("button");
    locateBtn.className = "tile-action-btn tile-locate-btn";
    locateBtn.setAttribute("data-tile-id", tile.id);
    locateBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2m0 10v2M1 8h2m10 0h2"/></svg>`;
    locateBtn.title = "Locate in Files";
    locateBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    locateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      callbacks.onLocate(tile.id);
    });
    btnGroup.appendChild(locateBtn);
  }

  if (tile.type === "term" && callbacks.onRefresh) {
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "tile-action-btn tile-refresh-btn";
    refreshBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 0-1.5 3.5"/><path d="M13 3v4h-4"/></svg>`;
    refreshBtn.title = "Refresh terminal";
    refreshBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    refreshBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (refreshBtn.classList.contains("spinning")) return;
      refreshBtn.classList.add("spinning");
      setTimeout(() => refreshBtn.classList.remove("spinning"), 1500);

      // Show a translucent overlay with a spinning icon over
      // the tile content area while the terminal reloads.
      const overlay = document.createElement("div");
      overlay.className = "tile-refresh-overlay";
      overlay.innerHTML = refreshBtn.innerHTML;
      contentArea.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("visible"));
      setTimeout(() => {
        overlay.classList.remove("visible");
        setTimeout(() => overlay.remove(), 600);
      }, 1200);

      callbacks.onRefresh(tile.id);
    });
    btnGroup.appendChild(refreshBtn);
  }

  const lockBtn = document.createElement("button");
  lockBtn.className = "tile-action-btn tile-lock-btn";
  const lockedIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;
  const unlockedIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><line x1="8.5" y1="11" x2="8.5" y2="13"/></svg>`;
  lockBtn.innerHTML = tile.locked !== false ? lockedIcon : unlockedIcon;
  lockBtn.title = tile.locked !== false ? "Unlock resize" : "Lock resize";
  lockBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  lockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (callbacks.onToggleLock) callbacks.onToggleLock(tile.id);
  });
  btnGroup.appendChild(lockBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "tile-action-btn tile-close-btn";
  closeBtn.innerHTML = "&times;";
  closeBtn.title = "Close tile";
  closeBtn.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    callbacks.onClose(tile.id);
  });
  btnGroup.appendChild(closeBtn);
  titleBar.appendChild(btnGroup);

  if (tile.type === "term") {
    titleBar.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const selected = await window.shellApi.showContextMenu([
        { id: "rename", label: "Rename" },
        { id: "duplicate", label: "Duplicate" },
      ]);
      if (selected === "rename" && callbacks.onRename) {
        callbacks.onRename(tile.id);
      } else if (selected === "duplicate" && callbacks.onDuplicate) {
        callbacks.onDuplicate(tile.id);
      }
    });
  }

  const contentArea = document.createElement("div");
  contentArea.className = "tile-content";

  const contentOverlay = document.createElement("div");
  contentOverlay.className = "tile-content-overlay";

  if (urlInput) titleBar.insertBefore(urlInput, btnGroup);

  container.appendChild(titleBar);
  container.appendChild(contentArea);
  contentArea.appendChild(contentOverlay);

  if (tile.type === "term") {
    const runIndicator = document.createElement("div");
    runIndicator.className = "tile-run-indicator";
    container.insertBefore(runIndicator, contentArea);
  }

  return {
    container,
    titleBar,
    titleText,
    contentArea,
    contentOverlay,
    closeBtn,
    lockBtn,
    urlInput,
    navBack,
    navForward,
    navReload,
  };
}

export function updateLockButton(lockBtn, locked) {
  const lockedIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;
  const unlockedIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><line x1="8.5" y1="11" x2="8.5" y2="13"/></svg>`;
  lockBtn.innerHTML = locked ? lockedIcon : unlockedIcon;
  lockBtn.title = locked ? "Unlock resize" : "Lock resize";
}

export function updateTileStatus(dom, tile) {
  if (!dom) return;
  const indicator = dom.container.querySelector(".tile-run-indicator");
  if (!indicator) return;
  const running = tile.running === true;
  indicator.classList.toggle("active", running);
  if (running && tile.runningCommand) {
    dom.container.title = `Running: ${tile.runningCommand}`;
  } else {
    dom.container.title = "";
  }
}

export function getTileLabel(tile, aliases) {
  if (tile.type === "term") {
    if (tile.userTitle) return { parent: "", name: tile.userTitle };
    if (tile.autoTitle) return splitFilepath(tile.autoTitle);
    if (tile.cwd) {
      const alias = aliases?.[tile.cwd];
      if (alias) return { parent: tile.cwd, name: alias };
      return splitFilepath(tile.cwd);
    }
    return { parent: "", name: "Terminal" };
  }
  if (tile.type === "browser") {
    if (tile.url) {
      try {
        return { parent: "", name: new URL(tile.url).hostname };
      } catch {
        return { parent: "", name: tile.url };
      }
    }
    return { parent: "", name: "Browser" };
  }
  if (tile.type === "graph") {
    if (tile.folderPath) return splitFilepath(tile.folderPath);
    return { parent: "", name: "Graph" };
  }
  if (tile.filePath) return splitFilepath(tile.filePath);
  return { parent: "", name: tile.type };
}

export function splitFilepath(path) {
  return splitDisplayPath(path);
}

function renderTileTitleContent(titleText, tile, aliases) {
  titleText.textContent = "";
  const alias =
    tile.type === "term" && !tile.userTitle && tile.cwd
      ? aliases?.[tile.cwd]
      : null;

  if (alias) {
    const iconSpan = document.createElement("span");
    iconSpan.className = "tile-title-alias-icon";
    iconSpan.textContent = "@";
    iconSpan.title = "Click to toggle full path";

    const nameSpan = document.createElement("span");
    nameSpan.className = "tile-title-alias-name";
    nameSpan.textContent = alias;

    let showPath = false;
    let revertTimer = null;

    iconSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      showPath = !showPath;
      nameSpan.textContent = showPath ? tile.cwd : alias;
      if (revertTimer) clearTimeout(revertTimer);
      if (showPath) {
        revertTimer = setTimeout(() => {
          showPath = false;
          nameSpan.textContent = alias;
          revertTimer = null;
        }, 3000);
      }
    });

    titleText.appendChild(iconSpan);
    titleText.appendChild(nameSpan);
    titleText.title = tile.cwd || "";
  } else {
    const label = getTileLabel(tile, aliases);
    const parentSpan = document.createElement("span");
    parentSpan.className = "tile-title-parent";
    parentSpan.textContent = label.parent;
    const nameSpan = document.createElement("span");
    nameSpan.className = "tile-title-name";
    nameSpan.textContent = label.name;
    titleText.appendChild(parentSpan);
    titleText.appendChild(nameSpan);
    titleText.title = tile.filePath || tile.folderPath || tile.cwd || "";
  }
}

export function updateTileTitle(dom, tile) {
  renderTileTitleContent(dom.titleText, tile, window.__tileAliases);
}

export function startInlineRename(dom, tile, onCommit) {
  const existing = dom.titleText.parentNode.querySelector(".tile-rename-input");
  if (existing) return;
  const titleText = dom.titleText;
  const currentLabel = getTileLabel(tile, window.__tileAliases);
  const currentName = currentLabel.parent
    ? currentLabel.parent + currentLabel.name
    : currentLabel.name;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tile-rename-input";
  input.value = tile.userTitle ?? currentName;
  titleText.style.display = "none";
  titleText.parentNode.insertBefore(input, titleText);
  input.select();
  input.focus();

  let committed = false;

  function commit() {
    if (committed) return;
    committed = true;
    const value = input.value.trim();
    input.remove();
    titleText.style.display = "";
    onCommit(value);
  }

  function cancel() {
    if (committed) return;
    committed = true;
    input.remove();
    titleText.style.display = "";
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => commit());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

/**
 * Positions a tile container in screen coordinates.
 * @param {HTMLElement} container
 * @param {import('./canvas-state.js').Tile} tile
 * @param {number} panX
 * @param {number} panY
 * @param {number} zoom
 */
export function positionTile(container, tile, panX, panY, zoom) {
  let sx = tile.x * zoom + panX;
  let sy = tile.y * zoom + panY;

  container.style.width = `${tile.width}px`;
  container.style.height = `${tile.height}px`;
  if (zoom !== 1) {
    container.style.transform = `scale(${zoom})`;
    container.style.transformOrigin = "top left";
  } else {
    container.style.transform = "";
    container.style.transformOrigin = "";
    // Round to integer pixels to avoid sub-pixel rendering that
    // causes text ghosting in webview tiles (e.g. xterm).
    sx = Math.round(sx);
    sy = Math.round(sy);
  }
  container.style.left = `${sx}px`;
  container.style.top = `${sy}px`;
  container.style.zIndex = String(tile.zIndex);
}

/**
 * Positions all tile containers.
 * @param {Map<string, {container: HTMLElement}>} tileDOMs
 * @param {import('./canvas-state.js').Tile[]} tiles
 * @param {number} panX
 * @param {number} panY
 * @param {number} zoom
 */
export function positionAllTiles(tileDOMs, tiles, panX, panY, zoom) {
  for (const tile of tiles) {
    const dom = tileDOMs.get(tile.id);
    if (dom) positionTile(dom.container, tile, panX, panY, zoom);
  }
}
