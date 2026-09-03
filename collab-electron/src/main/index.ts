import "./logger";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  screen,
  shell,
  webContents as webContentsModule,
  type WebContents,
} from "electron";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fromCollabFileUrl } from "@collab/shared/collab-file-url";
import {
  loadConfig,
  saveConfig,
  getPref,
  setPref,
  type WindowState,
  type TerminalTarget,
} from "./config";
import { menuLabels } from "./menu-labels";
import { registerIpcHandlers, setMainWindow, rebuildFileFilter } from "./ipc";
import { registerCanvasRpc } from "./canvas-rpc";
import {
  registerIntegrationsIpc,
  isClaudeDeepIntegrationEnabled,
  claudePluginPath,
} from "./integrations";
import {
  syncClaudeMdBlock,
  removeClaudeMdBlock,
  setClaudeMdBlockFile,
} from "./claude-md";
import { registerClaudeIpc } from "./claude-rpc";
import { registerClaudeEditsRpc, findLatestEditLine } from "./claude-edits-rpc";
import { registerDebugMouseRpc } from "./debug-mouse-rpc";
import {
  registerMethod,
  startJsonRpcServer,
  stopJsonRpcServer,
} from "./json-rpc-server";
import * as watcher from "./watcher";
import * as gitReplay from "./git-replay";
import { DISABLE_GIT_REPLAY } from "@collab/shared/replay-types";
import * as pty from "./pty";
import { updateManager, setupUpdateIPC } from "./updater";
import { DEV_WORKTREE_ID } from "./paths";
import {
  initMainAnalytics,
  trackEvent,
  shutdownAnalytics,
  getDeviceId,
} from "./analytics";
import { stopImageWorker } from "./image-service";
import { installCli } from "./cli-installer";
import { listTerminalTargets } from "./terminal-target";
import {
  detectEditors,
  openFileInEditor,
  openWorkspaceInEditor,
} from "./external-editor";
import { workspaceForFile } from "./ipc-workspace";
import { readSessionMeta } from "./session-meta";
import * as canvasPersistence from "./canvas-persistence";
import {
  startRemoteHost,
  startRemoteHostIfConfigured,
  stopRemoteHost,
  getRemoteHostStatus,
  testRemoteHostConnection,
} from "./remote-server";
import {
  startRemoteClient,
  startRemoteClientIfConfigured,
  stopRemoteClient,
  isRemoteActive,
  getRemoteClientStatus,
} from "./remote-client";
import { bindIpc, markForward } from "./ipc-registry";
import {
  checkPermissions,
  openPermissionSettings,
  type PermissionKind,
} from "./mac-permissions";

// macOS apps launched from Finder don't inherit the user's shell
// LANG, so child processes default to ASCII.
if (!process.env.LANG || !process.env.LANG.includes("UTF-8")) {
  process.env.LANG = "en_US.UTF-8";
}

process.on("uncaughtException", (error) => {
  trackEvent("app_crash", {
    type: "uncaughtException",
    message: error.message,
    stack: error.stack,
  });
  console.error("[crash] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  trackEvent("app_crash", {
    type: "unhandledRejection",
    message: error.message,
    stack: error.stack,
  });
  console.error("[crash] Unhandled rejection:", error);
});

if (import.meta.env.DEV) {
  app.setPath(
    "userData",
    join(app.getPath("userData"), "dev", DEV_WORKTREE_ID ?? "worktree-unknown"),
  );
}

let mainWindow: BrowserWindow | null = null;
let pendingFilePath: string | null = null;
let config = loadConfig();
let shuttingDown = false;
// Cmd+Q 退出确认：quitConfirmed 为 true 后不再弹确认框；
// quitDialogOpen 为 true 时再次触发退出（连按 Cmd+Q）直接放行。
// 确认用非模态小窗（原生模态对话框会拦截 Cmd+Q，导致连按无法生效）。
let quitConfirmed = false;
let quitDialogOpen = false;
let quitConfirmWindow: BrowserWindow | null = null;

// Apply saved theme preference (light/dark/system)
const savedTheme = config.ui.theme;
if (savedTheme === "light" || savedTheme === "dark") {
  nativeTheme.themeSource = savedTheme;
} else {
  nativeTheme.themeSource = "system";
}
let globalZoomLevel = 0;

if (!app.isPackaged) {
  // Vite dev uses a relaxed renderer policy for HMR; suppress Electron's
  // repeated dev-only security banner so actionable logs stay visible.
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
}

// macOS GUI apps launched from Finder get a minimal PATH from launchd.
// Resolve the user's full shell PATH so child processes (terminal, git) work.
if (app.isPackaged && process.platform === "darwin") {
  try {
    const shell = process.env["SHELL"] || "/bin/zsh";
    const output = execFileSync(shell, ["-l", "-c", 'printf "%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
    });
    const resolved = output.split("\n").pop()!;
    if (resolved.includes("/")) {
      process.env["PATH"] = resolved;
    }
  } catch {
    // Fall through with the default PATH if shell resolution fails.
  }
}

const DEFAULT_STATE: WindowState = {
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
};

function boundsVisibleOnAnyDisplay(bounds: WindowState): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    return (
      bounds.x < x + width &&
      bounds.x + bounds.width > x &&
      bounds.y < y + height &&
      bounds.y + bounds.height > y
    );
  });
}

function saveWindowState(state: WindowState): void {
  try {
    config.window_state = state;
    saveConfig(config);
  } catch (err) {
    console.error("Failed to save window state:", err);
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveWindowState(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized() || mainWindow.isMaximized()) return;
    const { x, y, width, height } = mainWindow.getNormalBounds();
    saveWindowState({ x, y, width, height });
  }, 500);
}

function sendShortcut(action: string): void {
  mainWindow?.webContents.send("shell:shortcut", action);
}

const cmdOrCtrl = (input: Electron.Input): boolean =>
  input.meta || input.control;
const shiftCmdOrCtrl = (input: Electron.Input): boolean =>
  input.shift && (input.meta || input.control);
const altCmdOrCtrl = (input: Electron.Input): boolean =>
  input.alt && (input.meta || input.control);
const ctrlOnly = (input: Electron.Input): boolean =>
  input.control && !input.meta;
const altOnly = (input: Electron.Input): boolean =>
  input.alt && !input.meta && !input.control && !input.shift;
const optCmd = (input: Electron.Input): boolean =>
  input.alt && input.meta && !input.control;
const cmdNoAlt = (input: Electron.Input): boolean =>
  (input.meta || input.control) && !input.alt;

interface ShortcutEntry {
  modifier: (input: Electron.Input) => boolean;
  action: string;
}

const TOGGLE_SHORTCUTS: Record<string, ShortcutEntry[]> = {
  Backslash: [{ modifier: cmdOrCtrl, action: "sidebar-files" }],
  Comma: [{ modifier: cmdOrCtrl, action: "toggle-settings" }],
  KeyO: [{ modifier: shiftCmdOrCtrl, action: "add-workspace" }],
  KeyK: [{ modifier: cmdOrCtrl, action: "focus-file-search" }],
  KeyN: [{ modifier: cmdOrCtrl, action: "new-tile" }],
  KeyW: [{ modifier: cmdOrCtrl, action: "close-tile" }],
  KeyR: [{ modifier: cmdOrCtrl, action: "refresh-terminal" }],
  ArrowRight: [
    { modifier: optCmd, action: "nav-history-forward" },
    { modifier: cmdNoAlt, action: "focus-tile-right" },
  ],
  ArrowLeft: [
    { modifier: optCmd, action: "nav-history-back" },
    { modifier: cmdNoAlt, action: "focus-tile-left" },
  ],
  ArrowUp: [{ modifier: cmdNoAlt, action: "focus-tile-up" }],
  ArrowDown: [{ modifier: cmdNoAlt, action: "focus-tile-down" }],
};

const TOGGLE_SHORTCUT_KEYS: Record<string, ShortcutEntry[]> = {
  ",": TOGGLE_SHORTCUTS.Comma!,
  o: TOGGLE_SHORTCUTS.KeyO!,
  k: TOGGLE_SHORTCUTS.KeyK!,
  n: TOGGLE_SHORTCUTS.KeyN!,
  w: TOGGLE_SHORTCUTS.KeyW!,
};

function normalizeShortcutKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.length === 1 ? key.toLowerCase() : key;
}

function resolveToggleShortcut(
  input: Electron.Input,
): ShortcutEntry | undefined {
  const candidates =
    TOGGLE_SHORTCUTS[input.code] ??
    (normalizeShortcutKey(input.key)
      ? TOGGLE_SHORTCUT_KEYS[normalizeShortcutKey(input.key)!]
      : undefined);
  return candidates?.find((s) => s.modifier(input));
}

function attachShortcutListener(target: WebContents): void {
  target.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const toggle = resolveToggleShortcut(input);
    if (toggle) {
      event.preventDefault();
      if (!input.isAutoRepeat) sendShortcut(toggle.action);
    }
  });
}

function registerToggleShortcuts(win: BrowserWindow): void {
  attachShortcutListener(win.webContents);

  win.webContents.on("did-attach-webview", (_event, wc) => {
    attachShortcutListener(wc);

    wc.once("did-finish-load", () => {
      // Transparent compositor surface so terminal tiles can
      // show through to the canvas/vibrancy background.
      wc.insertCSS("html, body { background: transparent !important; }");
    });

    // 覆盖 Chromium 按 URL 记忆的缩放:file:// 页面可能从
    // Preferences 的 per_host_zoom_levels 恢复旧 zoom,必须
    // 在每次加载后统一回应用设定的 globalZoomLevel。
    enforceZoom(wc);
  });
}

function applyZoomToAll(level: number): void {
  globalZoomLevel = level;
  for (const wc of webContentsModule.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.setZoomLevel(level);
  }
}

function enforceZoom(wc: WebContents): void {
  wc.on("did-finish-load", () => {
    if (!wc.isDestroyed()) wc.setZoomLevel(globalZoomLevel);
  });
}

function currentMenuLocale(): "en" | "zh" {
  return getPref(config, "locale") === "zh" ? "zh" : "en";
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const fullScreenAccelerator = isMac ? "Ctrl+Cmd+F" : "F11";
  const L = menuLabels[currentMenuLocale()];
  const appLabel = (s: string): string => s.replace("{app}", app.name);

  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    version: "",
    credits: `Build Time: ${__BUILD_TIME__}`,
  });

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const, label: appLabel(L.about) },
              { type: "separator" as const },
              {
                label: L.settings,
                accelerator: "CommandOrControl+,",
                registerAccelerator: false,
                click: () => sendShortcut("toggle-settings"),
              } as Electron.MenuItemConstructorOptions,
              { type: "separator" as const },
              { role: "services" as const, label: L.services },
              { type: "separator" as const },
              { role: "hide" as const, label: appLabel(L.hide) },
              { role: "hideOthers" as const, label: L.hideOthers },
              { role: "unhide" as const, label: L.unhide },
              { type: "separator" as const },
              { role: "quit" as const, label: appLabel(L.quit) },
            ],
          },
        ]
      : []),
    {
      label: L.file,
      submenu: [
        {
          label: L.newTile,
          accelerator: "CommandOrControl+N",
          registerAccelerator: false,
          click: () => sendShortcut("new-tile"),
        },
        {
          label: L.closeTile,
          accelerator: "CommandOrControl+W",
          registerAccelerator: false,
          click: () => sendShortcut("close-tile"),
        },
        { type: "separator" },
        {
          label: L.openWorkspace,
          accelerator: "CommandOrControl+Shift+O",
          registerAccelerator: false,
          click: () => sendShortcut("add-workspace"),
        },
      ],
    },
    {
      label: L.edit,
      submenu: [
        { role: "undo", label: L.undo },
        { role: "redo", label: L.redo },
        { type: "separator" },
        { role: "cut", label: L.cut },
        { role: "copy", label: L.copy },
        { role: "paste", label: L.paste },
        { role: "selectAll", label: L.selectAll },
        { type: "separator" },
        {
          label: L.find,
          accelerator: "CommandOrControl+K",
          registerAccelerator: false,
          click: () => sendShortcut("focus-file-search"),
        },
      ],
    },
    {
      label: L.view,
      submenu: [
        {
          label: L.toggleFiles,
          accelerator: "CommandOrControl+B",
          registerAccelerator: false,
          click: () => sendShortcut("sidebar-files"),
        },
        { type: "separator" },
        {
          label: L.zoomIn,
          accelerator: "CommandOrControl+=",
          click: () => applyZoomToAll(globalZoomLevel + 0.25),
        },
        {
          label: L.zoomOut,
          accelerator: "CommandOrControl+-",
          click: () => applyZoomToAll(globalZoomLevel - 0.25),
        },
        {
          label: L.actualSize,
          accelerator: "CommandOrControl+0",
          click: () => applyZoomToAll(0),
        },
        { type: "separator" },
        {
          label: L.navigateBack,
          accelerator: "Alt+Cmd+Left",
          registerAccelerator: false,
          click: () => sendShortcut("nav-history-back"),
        },
        {
          label: L.navigateForward,
          accelerator: "Alt+Cmd+Right",
          registerAccelerator: false,
          click: () => sendShortcut("nav-history-forward"),
        },
        { type: "separator" },
        { role: "toggleDevTools", label: L.toggleDevTools },
        {
          label: L.toggleFullScreen,
          accelerator: fullScreenAccelerator,
          click: (_, win) => win?.setFullScreen(!win.isFullScreen()),
        },
      ],
    },
    {
      label: L.windowMenu,
      submenu: [
        { role: "minimize", label: L.minimize },
        { role: "zoom", label: L.windowZoom },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const, label: L.bringAllToFront },
            ]
          : [{ role: "close" as const, label: L.closeWindow }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getPreloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`);
}

function getRendererURL(name: string): string {
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    return `${process.env["ELECTRON_RENDERER_URL"]}/${name}/index.html`;
  }
  return pathToFileURL(join(__dirname, `../renderer/${name}/index.html`)).href;
}

function createWindow(): void {
  const saved = config.window_state;
  const useSaved =
    saved !== null && (saved.isMaximized || boundsVisibleOnAnyDisplay(saved));
  const state = useSaved ? saved : DEFAULT_STATE;

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: 400,
    minHeight: 400,
    webPreferences: {
      preload: getPreloadPath("shell"),
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  };

  if (process.platform === "darwin") {
    Object.assign(windowOptions, {
      titleBarStyle: "hidden",
      vibrancy: "under-window",
      visualEffectState: "active",
      trafficLightPosition: { x: 14, y: 12 },
    } satisfies Partial<Electron.BrowserWindowConstructorOptions>);
  }

  if (process.platform === "win32") {
    Object.assign(windowOptions, {
      backgroundColor: "#00000000",
      backgroundMaterial: "mica",
    } satisfies Partial<Electron.BrowserWindowConstructorOptions>);
  }

  if (useSaved) {
    windowOptions.x = state.x;
    windowOptions.y = state.y;
  }

  mainWindow = new BrowserWindow(windowOptions);
  enforceZoom(mainWindow.webContents);

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on("move", debouncedSaveWindowState);
  mainWindow.on("resize", debouncedSaveWindowState);
  mainWindow.on("close", () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { x, y, width, height } = mainWindow.getNormalBounds();
    saveWindowState({
      x,
      y,
      width,
      height,
      isMaximized: mainWindow.isMaximized(),
    });
  });
  mainWindow.loadURL(getRendererURL("shell"));

  setMainWindow(mainWindow);
  registerCanvasRpc(mainWindow);
}

// -- macOS permission check window ------------------------------------

let permissionWindow: BrowserWindow | null = null;

function showPermissionWindow(): void {
  if (permissionWindow && !permissionWindow.isDestroyed()) {
    permissionWindow.focus();
    return;
  }

  permissionWindow = new BrowserWindow({
    width: 420,
    height: 460,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: "Permissions",
    webPreferences: {
      preload: getPreloadPath("universal"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (process.platform === "darwin") {
    permissionWindow.setWindowButtonVisibility?.(false);
  }
  permissionWindow.setMenuBarVisibility(false);
  enforceZoom(permissionWindow.webContents);
  permissionWindow.loadURL(getRendererURL("permission-check"));
  permissionWindow.on("closed", () => {
    permissionWindow = null;
  });
}

function closePermissionWindow(): void {
  if (permissionWindow && !permissionWindow.isDestroyed()) {
    permissionWindow.close();
  }
}

function maybeCheckPermissionsOnLaunch(): void {
  if (process.platform !== "darwin" || !app.isPackaged) {
    console.log("[permissions] skipped:", process.platform, app.isPackaged);
    return;
  }
  const statuses = checkPermissions();
  console.log("[permissions] statuses:", JSON.stringify(statuses));
  const anyDenied = Object.values(statuses).some((s) => s === "denied");
  if (!anyDenied) return;
  console.log("[permissions] showing window");
  showPermissionWindow();
}

ipcMain.handle("analytics:get-device-id", () => getDeviceId());

ipcMain.on("analytics:track-event", (_event, name, properties) => {
  trackEvent(name, properties);
});

ipcMain.on("get-home-path", (event) => {
  event.returnValue = app.getPath("home");
});

ipcMain.handle("shell:get-view-config", () => {
  const preload = pathToFileURL(getPreloadPath("universal")).href;

  return {
    nav: { src: getRendererURL("nav"), preload },
    viewer: { src: getRendererURL("viewer"), preload },
    terminal: { src: getRendererURL("terminal"), preload },
    terminalTile: { src: getRendererURL("terminal-tile"), preload },
    settings: { src: getRendererURL("settings"), preload },
    tileList: { src: getRendererURL("tile-list"), preload },
    todos: { src: getRendererURL("todos"), preload },
  };
});

bindIpc("pref:get", "handle", (_event, key: string) => getPref(config, key));

ipcMain.on("pref:get-sync", (event, key: string) => {
  event.returnValue = getPref(config, key);
});

bindIpc("pref:set", "handle", (_event, key: string, value: unknown) => {
  setPref(config, key, value);
  if (key === "locale") {
    buildAppMenu();
  }
  if (key === "autoCheckUpdates" && typeof value === "boolean") {
    updateManager.setAutoCheckEnabled(value);
  }
  if (key === "ignoredFiles" && Array.isArray(value)) {
    rebuildFileFilter();
  }
  if (key === "ignoreCase") {
    rebuildFileFilter();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pref:changed", key, value);
    if (
      key === "externalEditorFileTypes" ||
      key === "useExternalEditor" ||
      key === "externalEditor" ||
      key === "ignoredFiles" ||
      key === "ignoreCase"
    ) {
      mainWindow.webContents.send(
        "shell:forward",
        "nav",
        "pref-changed",
        key,
        value,
      );
    }
  }
});

bindIpc("terminal:list-targets", "handle", () => listTerminalTargets());

ipcMain.handle("theme:set", (_event, mode: string) => {
  const valid = mode === "light" || mode === "dark" ? mode : "system";
  nativeTheme.themeSource = valid;
  setPref(config, "theme", valid);
});

bindIpc(
  "pty:create",
  "handle",
  (
    event,
    params?: {
      cwd?: string;
      cols?: number;
      rows?: number;
      tileId?: string;
      target?: TerminalTarget;
    },
  ) =>
    pty.createSession(
      params?.cwd,
      event.sender.id,
      params?.cols,
      params?.rows,
      params?.target,
      params?.tileId,
    ),
);

function handlePtyWrite(sessionId: string, data: string): void {
  pty.writeToSession(sessionId, data);
}

bindIpc(
  "pty:write",
  "handle",
  (_event, { sessionId, data }: { sessionId: string; data: string }) =>
    handlePtyWrite(sessionId, data),
);

bindIpc(
  "pty:write",
  "on",
  (_event, { sessionId, data }: { sessionId: string; data: string }) => {
    handlePtyWrite(sessionId, data);
  },
);

function handlePtySendRawKeys(sessionId: string, data: string): void {
  pty.sendRawKeys(sessionId, data);
}

bindIpc(
  "pty:send-raw-keys",
  "handle",
  (_event, { sessionId, data }: { sessionId: string; data: string }) =>
    handlePtySendRawKeys(sessionId, data),
);

bindIpc(
  "pty:send-raw-keys",
  "on",
  (_event, { sessionId, data }: { sessionId: string; data: string }) => {
    handlePtySendRawKeys(sessionId, data);
  },
);

bindIpc(
  "pty:resize",
  "handle",
  (
    _event,
    {
      sessionId,
      cols,
      rows,
    }: { sessionId: string; cols: number; rows: number },
  ) => pty.resizeSession(sessionId, cols, rows),
);

bindIpc("pty:kill", "handle", (_event, { sessionId }: { sessionId: string }) =>
  pty.killSession(sessionId),
);

bindIpc(
  "pty:reconnect",
  "handle",
  (
    event,
    {
      sessionId,
      cols,
      rows,
    }: { sessionId: string; cols: number; rows: number },
  ) => pty.reconnectSession(sessionId, cols, rows, event.sender.id),
);

bindIpc("pty:discover", "handle", () => pty.discoverSessions());

bindIpc("pty:read-meta", "handle", (_event, sessionId: string) =>
  readSessionMeta(sessionId),
);

bindIpc("pty:foreground-process", "handle", (_event, sessionId: string) =>
  pty.getForegroundProcess(sessionId),
);

bindIpc(
  "pty:capture",
  "handle",
  (_event, { sessionId, lines }: { sessionId: string; lines?: number }) =>
    pty.captureSession(sessionId, lines),
);

bindIpc(
  "pty:clear-buffer",
  "handle",
  (_event, { sessionId }: { sessionId: string }) => pty.clearBuffer(sessionId),
);

// ---- remote forwarding whitelist (B 端远程模式下转发到 A 的通道) ----
for (const channel of [
  "pref:get",
  "pref:set",
  "terminal:list-targets",
  "pty:create",
  "pty:write",
  "pty:send-raw-keys",
  "pty:resize",
  "pty:kill",
  "pty:reconnect",
  "pty:discover",
  "pty:read-meta",
  "pty:foreground-process",
  "pty:capture",
  "pty:clear-buffer",
  "external-editor:list",
  "external-editor:open-file",
  "external-editor:open-workspace",
]) {
  markForward(channel);
}

// Terminal screenshot: capturePage and copy to clipboard
ipcMain.handle(
  "term:screenshot",
  async (_event, { webContentsId }: { webContentsId: number }) => {
    const wc = webContentsModule.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      throw new Error("Terminal webview not found");
    }
    const img = await wc.capturePage();
    clipboard.writeImage(img);
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "Screenshot Copied",
        body: "Terminal screenshot has been copied to clipboard.",
      });
      n.show();
    }
    return { ok: true };
  },
);

let settingsOpen = false;

function setSettingsOpen(open: boolean): void {
  if (!mainWindow || settingsOpen === open) return;
  settingsOpen = open;
  mainWindow.webContents.send("shell:settings", open ? "open" : "close");
}

ipcMain.on("settings:open", () => setSettingsOpen(true));

ipcMain.on("settings:open-pane", (_event, pane: string) => {
  if (typeof pane !== "string") return;
  setSettingsOpen(true);
  mainWindow?.webContents.send("shell:settings", "open-pane", pane);
});

const LOG_FN_BY_LEVEL: Record<number, (...args: unknown[]) => void> = {
  0: console.debug,
  1: console.log,
  2: console.warn,
  3: console.error,
};

ipcMain.on(
  "webview:console",
  (_event, panel: string, level: number, message: string, source: string) => {
    const tag = `[webview:${panel}]`;
    const logFn = LOG_FN_BY_LEVEL[level] ?? console.log;
    logFn(`${tag} ${message}`, source ? `(${source})` : "");
  },
);

ipcMain.on("settings:close", () => setSettingsOpen(false));
ipcMain.on("settings:toggle", () => setSettingsOpen(!settingsOpen));

// External editor
bindIpc("external-editor:list", "handle", () => detectEditors());

bindIpc(
  "external-editor:open-file",
  "on",
  (_event, filePath: string, editorId?: string) => {
    const resolvedEditorId =
      editorId ||
      ((getPref(config, "externalEditor") as string | undefined) ??
        "intellij-idea");
    console.log("[external-editor] open-file:", { editorId, filePath });
    // 文件不在任何 workspace 内时缺少工作区上下文(idea --line 等参数),
    // workspacePath 传空让编辑器以单文件方式打开, 不再降级系统应用。
    const ws = workspaceForFile(filePath, config.workspaces);
    const line = findLatestEditLine(filePath);
    console.log("[external-editor] open-file: line =", line);
    openFileInEditor(
      resolvedEditorId,
      filePath,
      ws ?? undefined,
      line ?? undefined,
    );
  },
);

bindIpc(
  "external-editor:open-workspace",
  "on",
  (_event, workspacePath: string) => {
    const editorId =
      (getPref(config, "externalEditor") as string | undefined) ??
      "intellij-idea";
    console.log("[external-editor] open-workspace:", {
      editorId,
      workspacePath,
    });
    openWorkspaceInEditor(editorId, workspacePath);
  },
);

function sendLoadingDone(): void {
  mainWindow?.webContents.send("shell:loading-done");
}

/**
 * 应用启动时同步 ~/.claude/CLAUDE.md 的 COLLAB 段落：
 * 深度集成开启则插入/更新一次，关闭则移除。
 */
function syncClaudeMdOnLaunch(): void {
  try {
    // 正文模板在插件目录（随插件打包），用户可直接编辑该 md 文件
    setClaudeMdBlockFile(join(claudePluginPath(), "claude-md-block.md"));
    if (isClaudeDeepIntegrationEnabled()) {
      const result = syncClaudeMdBlock();
      if (result === "inserted" || result === "updated") {
        console.log(`[claude-md] COLLAB block ${result}`);
      }
    } else {
      const result = removeClaudeMdBlock();
      if (result === "removed") {
        console.log("[claude-md] COLLAB block removed (deep integration off)");
      }
    }
  } catch (err) {
    console.error("[claude-md] sync failed:", err);
  }
}

async function shutdownBackgroundServices(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  globalShortcut.unregisterAll();
  pty.setShuttingDown(true);
  await pty.killAllAndWait();
  await pty.shutdownSidecarIfIdle();
  watcher.stopWorker();
  if (!DISABLE_GIT_REPLAY) gitReplay.stopWorker();
  stopJsonRpcServer();
  stopRemoteHost();
  stopRemoteClient();
  stopImageWorker();
}

app.on("open-file", (event, path) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "shell:forward",
      "viewer",
      "file-selected",
      path,
    );
  } else {
    pendingFilePath = path;
  }
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "collab-file",
    privileges: {
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

app.on("web-contents-created", (_event, contents) => {
  const isExternal = (url: string): boolean => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return false;
    }
    const devOrigin = process.env["ELECTRON_RENDERER_URL"];
    if (devOrigin && url.startsWith(devOrigin)) return false;
    return true;
  };

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isExternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});

// 单实例锁：防止残留进程 + 新开实例双跑（同 token 会互踢 relay 连接）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  protocol.handle("collab-file", (request) => {
    const filePath = fromCollabFileUrl(request.url);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  shuttingDown = false;

  config = loadConfig();
  installCli();
  watcher.startWorker();
  registerIpcHandlers(config);
  registerIntegrationsIpc();
  syncClaudeMdOnLaunch();
  registerClaudeIpc();
  registerClaudeEditsRpc();
  setupUpdateIPC();
  ipcMain.handle("permissions:check", () => checkPermissions());
  ipcMain.handle("permissions:open-settings", (_event, kind: string) => {
    openPermissionSettings(kind as PermissionKind);
  });
  ipcMain.on("permissions:close", closePermissionWindow);
  const autoCheckUpdates = getPref(config, "autoCheckUpdates") as
    | boolean
    | null;
  updateManager.init({
    onBeforeQuit: () => shutdownBackgroundServices(),
    autoCheckEnabled: autoCheckUpdates ?? false,
  });

  try {
    await pty.ensureSidecar();
  } catch (err) {
    console.error("Sidecar failed to start:", err);
  }

  buildAppMenu();
  createWindow();
  registerToggleShortcuts(mainWindow!);
  setTimeout(maybeCheckPermissionsOnLaunch, 1500);

  // Register F1 as a global shortcut: bring app to front when in background,
  // dismiss the first notification when already focused.
  const f1Registered = globalShortcut.register("F1", () => {
    const win = mainWindow;
    if (!win) return;
    if (!win.isFocused()) {
      win.show();
      win.focus();
      return;
    }
    sendShortcut("dismiss-notification");
  });
  if (!f1Registered) {
    dialog.showMessageBox({
      type: "warning",
      title: "全局快捷键注册失败",
      message:
        "F1 全局快捷键注册失败，可能被其他应用占用或缺少辅助功能权限。\n\n请前往 系统设置 > 隐私与安全性 > 辅助功能 中授予 Collaborator 权限。",
      buttons: ["确定"],
    });
  }

  initMainAnalytics();
  trackEvent("app_launched");

  mainWindow!.webContents.on("did-finish-load", () => {
    sendLoadingDone();
    if (pendingFilePath) {
      mainWindow!.webContents.send(
        "shell:forward",
        "viewer",
        "file-selected",
        pendingFilePath,
      );
      pendingFilePath = null;
    }
  });

  registerMethod("ping", () => ({ pong: true }), {
    description: "Health check — returns {pong: true}",
  });
  registerMethod("workspace.getConfig", () => config, {
    description: "Return the current app configuration",
  });

  registerDebugMouseRpc();

  try {
    await startJsonRpcServer();
  } catch (err) {
    console.error("Failed to start JSON-RPC server:", err);
  }

  startRemoteHostIfConfigured(config);
  startRemoteClientIfConfigured(config);

  ipcMain.handle("remote:get-status", () => {
    if (isRemoteActive()) return getRemoteClientStatus();
    return getRemoteHostStatus();
  });

  ipcMain.handle(
    "remote:host-set-enabled",
    async (_event, enabled: boolean) => {
      if (!enabled) {
        // 用户显式断开 = 被控端关闭：持久化，下次启动不再自动连接
        setPref(config, "remote.hostEnabled", false);
        await stopRemoteHost();
        return { ok: true };
      }
      // 注意：连接成功（auth-ok）后才把 remote.hostEnabled 置 true 并持久化，
      // 此处不预写，避免连接失败/未完成时残留「已开启」。
      // 同实例 host/client 互斥（UI 层已互斥，此处兜底 env/自动化双开）
      await stopRemoteClient();
      const relayUrl = getPref(config, "remote.relayUrl") as string;
      const deviceToken = getPref(config, "remote.deviceToken") as string;
      if (!relayUrl || !deviceToken) {
        return { ok: false, error: "Missing relay URL or device token" };
      }
      const deviceName = getPref(config, "remote.deviceName") as
        | string
        | undefined;
      void startRemoteHost({
        config,
        relayUrl,
        deviceToken,
        ...(deviceName ? { deviceName } : {}),
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "remote:host-test",
    async (_event, opts: { relayUrl?: string; deviceToken?: string }) => {
      if (!opts || !opts.relayUrl || !opts.deviceToken) {
        return { ok: false, error: "Missing relay URL or device token" };
      }
      return testRemoteHostConnection(opts.relayUrl, opts.deviceToken);
    },
  );

  ipcMain.handle(
    "remote:client-connect",
    async (_event, opts: { relayUrl?: string; pairCode?: string }) => {
      if (!opts || !opts.relayUrl || !opts.pairCode) {
        return { ok: false, error: "Missing relay URL or pair code" };
      }
      // 同实例 host/client 互斥：切到控制端先停被控端
      await stopRemoteHost();
      await startRemoteClient({
        config,
        relayUrl: opts.relayUrl,
        pairCode: opts.pairCode,
      });
      return { ok: true };
    },
  );

  ipcMain.handle("remote:client-disconnect", async () => {
    await stopRemoteClient();
    return { ok: true };
  });
});

const QUIT_CONFIRM_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    background: #f5f5f7;
    color: #1d1d1f;
    -webkit-user-select: none;
    user-select: none;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #2a2a2e; color: #f5f5f7; }
    button { background: #3a3a3e; border-color: #4a4a4e; color: #f5f5f7; }
    button.primary { background: #0a84ff; border-color: #0a84ff; color: #fff; }
  }
  .wrap { padding: 20px 22px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  p { margin: 0 0 18px; font-size: 13px; line-height: 1.5; }
  .btns { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; }
  button {
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid #d0d0d5;
    background: #fff;
    color: #1d1d1f;
    cursor: pointer;
  }
  button.primary { background: #007aff; border-color: #007aff; color: #fff; }
  button:focus { outline: none; }
</style>
</head>
<body>
  <div class="wrap">
    <p>确认退出 Collaborator 吗？</p>
    <div class="btns">
      <button id="cancel">取消</button>
      <button id="ok" class="primary" autofocus>确认退出</button>
    </div>
  </div>
  <script>
    const ok = document.getElementById("ok");
    const cancel = document.getElementById("cancel");
    ok.onclick = () => window.quitConfirm.respond(true);
    cancel.onclick = () => window.quitConfirm.respond(false);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok.click();
      else if (e.key === "Escape") cancel.click();
    });
  </script>
</body>
</html>`;

function showQuitConfirmWindow(): void {
  if (quitDialogOpen) return;
  quitDialogOpen = true;
  const parent =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  quitConfirmWindow = new BrowserWindow({
    width: 380,
    height: 190,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "退出 Collaborator",
    parent,
    webPreferences: {
      preload: join(__dirname, "../preload/quit-confirm.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  quitConfirmWindow.setMenuBarVisibility(false);
  quitConfirmWindow.on("closed", () => {
    quitConfirmWindow = null;
    quitDialogOpen = false;
  });
  void quitConfirmWindow.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(QUIT_CONFIRM_HTML),
  );
}

ipcMain.on("quit-confirm:response", (_event, confirmed: boolean) => {
  if (quitConfirmWindow && !quitConfirmWindow.isDestroyed()) {
    quitConfirmWindow.close();
  }
  if (confirmed) {
    quitConfirmed = true;
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (!quitConfirmed) {
    event.preventDefault();

    if (quitDialogOpen) {
      // 确认框已弹出时再次触发退出（如连按 Cmd+Q）：直接退出
      quitConfirmed = true;
    } else {
      showQuitConfirmWindow();
    }
  }

  if (!shuttingDown) {
    event.preventDefault();

    // Save canvas state BEFORE killing PTY sessions, so terminal tiles
    // are persisted before their exit events would trigger tile removal.
    // Also set a shutdown flag so the renderer ignores pty:exit during
    // shutdown and doesn't overwrite the saved state.
    try {
      const win = mainWindow;
      if (win && !win.isDestroyed()) {
        const state = await win.webContents.executeJavaScript(
          "window.__getCanvasStateForSave()",
        );
        if (state) {
          await canvasPersistence.saveState(state);
        }
        // Set shutdown flag before killing PTY — renderer will ignore
        // pty:exit tile removal while this flag is set.
        await win.webContents.executeJavaScript(
          "window.__canvasShuttingDown = true;",
        );
      }
    } catch {
      // Renderer may already be shutting down — skip save.
    }

    await shutdownBackgroundServices();
    app.quit();
  }
});

app.on("window-all-closed", async () => {
  await shutdownBackgroundServices();
  await shutdownAnalytics();
  app.quit();
});
