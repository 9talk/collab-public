// src/main/remote/ws-preload.ts
// Runs in browser BEFORE renderer code. Provides window.api over WebSocket.
// This replaces the Electron preload for remote browser clients.

const token = new URLSearchParams(window.location.search).get("token") ||
  (document.cookie.match(/(?:^|;\s*)collab_token=([^;]*)/) ?? [])[1] ||
  "";
const wsUrl = `ws://${location.host}/__remote/ws`;

let ws: WebSocket | null = null;
let ready = false;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const requestQueue: Array<{ method: string; params: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
let nextId = 1;
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const buffered = new Map<string, unknown[]>();

function connect(): void {
  ready = false;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: "auth", token }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);

      if (msg.type === "auth:ok") {
        ready = true;
        fire("shell:loading-done", {});
        // Flush queued requests
        while (requestQueue.length > 0) {
          const q = requestQueue.shift()!;
          sendRequest(q.method, q.params).then(q.resolve, q.reject);
        }
        return;
      }

      // Server push (event)
      if (msg.type && msg.id === undefined) {
        fire(msg.type, msg.data);
        return;
      }

      // RPC response
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      }
    }
    // Binary messages handled by PTY data callback
  };

  ws.onclose = () => {
    ready = false;
    setTimeout(connect, 1000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function fire(type: string, data: unknown): void {
  const cbs = listeners.get(type);
  if (cbs) {
    for (const cb of cbs) cb(data);
  }
  if (!cbs || cbs.size === 0) {
    let buf = buffered.get(type);
    if (!buf) { buf = []; buffered.set(type, buf); }
    if (buf.length < 32) buf.push(data);
  }
}

function sendRequest(method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws!.send(JSON.stringify({ id, method, params }));
  });
}

function request(method: string, params?: unknown): Promise<unknown> {
  if (!ready || !ws || ws.readyState !== WebSocket.OPEN) {
    return new Promise((resolve, reject) => {
      requestQueue.push({ method, params, resolve, reject });
    });
  }
  return sendRequest(method, params);
}

function on(type: string, cb: (...args: unknown[]) => void): () => void {
  let cbs = listeners.get(type);
  if (!cbs) { cbs = new Set(); listeners.set(type, cbs); }
  cbs.add(cb);
  const buf = buffered.get(type);
  if (buf) {
    for (const item of buf) cb(item);
    buffered.delete(type);
  }
  return () => {
    cbs?.delete(cb);
    if (cbs && cbs.size === 0) listeners.delete(type);
  };
}

try { connect(); } catch (e) { console.error("[ws-preload] connect failed:", e); }

// ---- window.api ----
const api: Record<string, unknown> = {
  isRemote: true,
  getPlatform: () => "darwin",

  // Config & Prefs
  getConfig: () => request("config:get"),
  getAppVersion: () => request("app:version"),
  getPref: (key: string) => request("pref:get", { key }),
  setPref: (key: string, value: unknown) => request("pref:set", { key, value }),
  getWorkspacePref: (key: string, workspacePath: string) =>
    request("workspace-pref:get", { key, workspacePath }),
  setWorkspacePref: (key: string, value: unknown, workspacePath: string) =>
    request("workspace-pref:set", { key, value, workspacePath }),

  // PTY
  ptyCreate: (cwd?: string, cols?: number, rows?: number, target?: string, tileId?: string) =>
    request("pty:create", { cwd, cols, rows, target, tileId }),
  ptyWrite: (sessionId: string, data: string) =>
    request("pty:write", { sessionId, data }),
  ptySendRawKeys: (sessionId: string, data: string) =>
    request("pty:send-raw-keys", { sessionId, data }),
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    request("pty:resize", { sessionId, cols, rows }),
  ptyKill: (sessionId: string) => request("pty:kill", { sessionId }),
  ptyReconnect: (sessionId: string, cols: number, rows: number) =>
    request("pty:reconnect", { sessionId, cols, rows }),
  ptyDiscover: () => request("pty:discover"),
  ptyReadMeta: (sessionId: string) => request("pty:read-meta", { sessionId }),
  onPtyData: (sessionId: string, cb: (p: unknown) => void) =>
    on(`pty:data:${sessionId}`, cb),
  offPtyData: (sessionId: string, cb: (p: unknown) => void) => {
    listeners.get(`pty:data:${sessionId}`)?.delete(cb);
  },
  onPtyExit: (sessionId: string, cb: (p: unknown) => void) =>
    on(`pty:exit:${sessionId}`, cb),
  offPtyExit: (sessionId: string, cb: (p: unknown) => void) => {
    listeners.get(`pty:exit:${sessionId}`)?.delete(cb);
  },
  notifyPtySessionId: (sessionId: string) =>
    request("pty:notify-session-id", { sessionId }),
  notifyCwdChanged: (sessionId: string, cwd: string) =>
    request("pty:cwd-changed", { sessionId, cwd }),
  notifyTerminalStatus: (sessionId: string, status: string, command?: string) =>
    request("pty:status-changed", { sessionId, status, command }),

  // Files
  readDir: (p: string) => request("fs:readdir", { path: p }),
  readFile: (p: string) => request("fs:readfile", { path: p }),
  readTree: (params: { root: string }) => request("workspace:read-tree", params),
  writeFile: (p: string, content: string, expectedMtime?: string) =>
    request("fs:writefile", { path: p, content, expectedMtime }),
  renameFile: (oldPath: string, newTitle: string) =>
    request("fs:rename", { oldPath, newTitle }),
  createDir: (p: string) => request("fs:mkdir", { path: p }),
  trashFile: (p: string) => request("fs:trash", { path: p }),
  moveFile: (oldPath: string, newParentDir: string) =>
    request("fs:move", { oldPath, newParentDir }),
  getFileStats: (p: string) => request("fs:stat", { path: p }),
  countFiles: (p: string) => request("fs:count-files", { path: p }),
  readFolderTable: (folderPath: string) => request("fs:read-folder-table", { folderPath }),
  getImageThumbnail: (path: string, size: number) =>
    request("image:thumbnail", { path, size }),
  getImageFull: (path: string) => request("image:full", { path }),

  // Select / Navigate
  selectFile: (p: string | null) => request("nav:select-file", { path: p }),
  selectFolder: (p: string) => request("nav:select-folder", { path: p }),
  openInTerminal: (p: string) => request("nav:open-in-terminal", { path: p }),
  revealInFinder: (p: string) => request("nav:reveal-in-finder", { path: p }),
  createGraphTile: (folderPath: string) => request("nav:create-graph-tile", { folderPath }),
  locateTerminal: (folderPath: string) => request("nav:locate-terminal", { folderPath }),
  runInTerminal: (command: string) => request("viewer:run-in-terminal", { command }),

  // UI
  showContextMenu: (items: Array<{ id: string; label: string; enabled?: boolean }>) =>
    request("context-menu:show", { items }),
  close: () => request("settings:close"),
  openExternal: (url: string) => request("shell:open-external", { url }),
  openPath: (p: string) => request("shell:open-path", { path: p }),
  openFolder: () => request("dialog:open-folder"),
  openImageDialog: () => request("dialog:open-image"),

  // Workspace
  workspaceAdd: () => request("workspace:add"),
  workspaceRemoveByPath: (path: string) => request("workspace:remove-by-path", { path }),
  getWorkspaceGraph: (params: { workspacePath: string }) =>
    request("workspace:get-graph", params),

  // Theme
  setTheme: (mode: string) => request("theme:set", { mode }),

  // Wikilinks
  resolveWikilink: (target: string) => request("wikilink:resolve", { target }),
  suggestWikilinks: (partial: string) => request("wikilink:suggest", { partial }),
  getBacklinks: (filePath: string) => request("wikilink:backlinks", { filePath }),

  // Event listeners
  onFocusSearch: (cb: () => void) => on("focus-search", cb),
  onFileSelected: (cb: (p: string | null) => void) => on("file-selected", (d: unknown) => cb(d as string | null)),
  onFolderSelected: (cb: (p: string) => void) => on("folder-selected", (d: unknown) => cb(d as string)),
  onFileRenamed: (cb: (oldPath: string, newPath: string) => void) =>
    on("file-renamed", (d: unknown) => {
      const p = d as { oldPath: string; newPath: string };
      cb(p.oldPath, p.newPath);
    }),
  onFilesDeleted: (cb: (paths: string[]) => void) =>
    on("files-deleted", (d: unknown) => cb((d as { paths: string[] }).paths)),
  onFsChanged: (cb: (events: unknown) => void) => on("fs-changed", cb),
  onWorkspaceAdded: (cb: (path: string) => void) =>
    on("workspace-added", (d: unknown) => cb(d as string)),
  onWorkspaceRemoved: (cb: (path: string) => void) =>
    on("workspace-removed", (d: unknown) => cb(d as string)),
  onWikilinksUpdated: (cb: (paths: string[]) => void) =>
    on("wikilinks-updated", (d: unknown) => cb(d as string[])),
  onNavVisibility: (cb: (visible: boolean) => void) =>
    on("nav-visibility", (d: unknown) => cb(d as boolean)),
  onScopeChanged: (cb: (newPath: string) => void) =>
    on("scope-changed", (d: unknown) => cb(d as string)),

  // Tile list
  onTileListMessage: (cb: (channel: string, ...args: unknown[]) => void) =>
    on("tile-list-message", (d: unknown) => {
      const m = d as { channel: string; args: unknown[] };
      cb(m.channel, ...m.args);
    }),
  sendToHost: (channel: string, ...args: unknown[]) =>
    request("send-to-host", { channel, args }),

  // Terminal events
  onCdTo: (cb: (path: string) => void) => on("cd-to", (d: unknown) => cb(d as string)),
  offCdTo: (_cb: (path: string) => void) => {},
  onRunInTerminal: (cb: (command: string) => void) =>
    on("run-in-terminal", (d: unknown) => cb(d as string)),
  offRunInTerminal: (_cb: (command: string) => void) => {},
  onFocusTab: (cb: (ptySessionId: string) => void) =>
    on("focus-tab", (d: unknown) => cb(d as string)),
  onShellBlur: (cb: () => void) => on("shell-blur", cb),
  onTerminalRefresh: (cb: () => void) => on("terminal:refresh", cb),

  // Agent events
  onAgentEvent: (cb: (event: unknown) => void) => on("agent-event", cb),
  focusAgentSession: (sessionId: string) => request("agent:focus-session", { sessionId }),

  // Replay
  startReplay: (params: { workspacePath: string }) => request("replay:start", params),
  stopReplay: () => request("replay:stop"),
  onReplayData: (cb: (msg: unknown) => void) => on("replay:data", cb),

  // Canvas
  forwardPinch: (deltaY: number) => request("canvas:forward-pinch", { deltaY }),

  // Misc
  getDeviceId: () => request("analytics:get-device-id"),
  listTerminalTargets: () => request("terminal:list-targets"),
  getHomePath: () => request("get-home-path"),

  // Drag-drop
  setDragPaths: (paths: string[]) => request("drag:set-paths", { paths }),
  clearDragPaths: () => request("drag:clear-paths"),
  getDragPaths: () => request("drag:get-paths"),
  onNavDragActive: (cb: (active: boolean) => void) =>
    on("nav-drag-active", (d: unknown) => cb(d as boolean)),

  // Agents / Integrations
  getAgents: () => request("integrations:get-agents"),
  installSkill: (agentId: string) => request("integrations:install-skill", { agentId }),
  uninstallSkill: (agentId: string) => request("integrations:uninstall-skill", { agentId }),

  // Updates
  updateGetStatus: () => request("update:getStatus"),
  updateCheck: () => request("update:check"),
  updateInstall: () => request("update:install"),
  onUpdateStatus: (cb: (state: unknown) => void) => on("update:status", cb),
};

(window as unknown as Record<string, unknown>).api = api;

// ---- window.shellApi (shell-specific methods not in window.api) ----
const shellApi: Record<string, unknown> = {
  ...api,

  getViewConfig: () => request("shell:get-view-config"),

  // Events
  onForwardToWebview: (cb: (target: string, channel: string, ...args: unknown[]) => void) =>
    on("shell:forward", (d: unknown) => {
      const m = d as { target: string; channel: string; args: unknown[] };
      cb(m.target, m.channel, ...(m.args ?? []));
    }),
  onSettingsToggle: (cb: (action: string) => void) => on("shell:settings", cb),
  onLoadingStatus: (cb: (message: string) => void) => on("shell:loading-status", cb),
  onLoadingDone: (cb: () => void) => on("shell:loading-done", cb),
  onShortcut: (cb: (action: string) => void) => on("shell:shortcut", cb),
  onBrowserTileFocusUrl: (cb: (id: number) => void) => on("browser-tile:focus-url", cb),
  onPrefChanged: (cb: (key: string, value: unknown) => void) => on("pref:changed", cb),
  onCanvasPinch: (cb: (deltaY: number) => void) => on("canvas:pinch", cb),
  onCanvasRpcRequest: (cb: (request: unknown) => void) => on("canvas:rpc-request", cb),
  onPtyStatusChanged: (cb: (payload: unknown) => void) => on("pty:status-changed", cb),
  onAgentUpdate: (cb: (params: unknown) => void) => on("agent:update", cb),
  onAgentPromptComplete: (cb: (data: unknown) => void) => on("agent:prompt-complete", cb),
  onAgentPromptError: (cb: (data: unknown) => void) => on("agent:prompt-error", cb),
  onAgentExit: (cb: (data: unknown) => void) => on("agent:exit", cb),
  onAgentSessionReady: (cb: (data: unknown) => void) => on("agent:session-ready", cb),
  onAgentSessionFailed: (cb: (data: unknown) => void) => on("agent:session-failed", cb),

  // Settings
  openSettings: () => { request("settings:open"); },
  closeSettings: () => { request("settings:close"); },
  toggleSettings: () => { request("settings:toggle"); },

  // Logging
  logFromWebview: (panel: string, level: number, message: string, source: string) => {
    request("webview:console", { panel, level, message, source });
  },

  // Updates
  updateDownload: () => request("update:download"),

  // Canvas
  canvasLoadState: () => request("canvas:load-state"),
  canvasSaveState: (state: unknown) => request("canvas:save-state", { state }),
  canvasRpcResponse: (response: unknown) => { request("canvas:rpc-response", response); },

  // Files
  getPathForFile: (file: File) => (file as unknown as { path?: string }).path || file.name || "",
  isDirectory: (filePath: string) => request("fs:is-directory", { path: filePath }),

  // Workspace
  workspaceRemove: (index: number) => request("workspace:remove", { index }),
  workspaceList: () => request("workspace:list"),

  // Dialogs
  showConfirmDialog: (opts: { message: string; detail?: string; buttons?: string[] }) =>
    request("dialog:confirm", opts),
  trackEvent: (name: string, properties?: Record<string, unknown>) => {
    request("analytics:track-event", { name, properties });
  },

  // PTY
  ptyKillSession: (sessionId: string) => request("pty:kill", { sessionId }),
  ptyCapture: (sessionId: string, lines?: number) => request("pty:capture", { sessionId, lines }),

  // Browser tile control (Electron-specific, stubbed for remote)
  browserNavigate: (webContentsId: number, url: string) =>
    request("browser:navigate", { webContentsId, url }),
  browserScreenshot: (webContentsId: number) =>
    request("browser:screenshot", { webContentsId }),
  browserSnapshot: (webContentsId: number) =>
    request("browser:snapshot", { webContentsId }),
  browserClick: (webContentsId: number, selector: string) =>
    request("browser:click", { webContentsId, selector }),
  browserType: (webContentsId: number, selector: string, text: string) =>
    request("browser:type", { webContentsId, selector, text }),
  browserScroll: (webContentsId: number, x: number, y: number) =>
    request("browser:scroll", { webContentsId, x, y }),
  browserEvaluate: (webContentsId: number, expression: string) =>
    request("browser:evaluate", { webContentsId, expression }),
  browserWait: (webContentsId: number, timeout?: number) =>
    request("browser:wait", { webContentsId, timeout }),
  browserInfo: (webContentsId: number) =>
    request("browser:info", { webContentsId }),

  // Navigation
  navigationPush: (tileId: string) => { request("navigation:push", { tileId }); },
  navigationGoBack: () => request("navigation:go-back"),
  navigationGoForward: () => request("navigation:go-forward"),

  // Terminal screenshot
  termScreenshotClipboard: (webContentsId: number) =>
    request("term:screenshot", { webContentsId }),

  // Integrations
  hasOfferedPlugin: () => request("integrations:has-offered-plugin"),
  markPluginOffered: () => { request("integrations:mark-plugin-offered"); },
};

(window as unknown as Record<string, unknown>).shellApi = shellApi;
