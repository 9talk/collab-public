import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";
import type { ReplayMessage } from "@collab/shared/replay-types";

// -- PTY listener sets (terminal) ------------------------------------

type PtyDataCallback = (payload: {
  sessionId: string;
  data: Uint8Array;
}) => void;
type PtyExitCallback = (payload: {
  sessionId: string;
  exitCode: number;
}) => void;
type PtyResizedCallback = (payload: {
  sessionId: string;
  cols: number;
  rows: number;
}) => void;
type CdToCallback = (path: string) => void;

const dataListeners = new Map<string, Set<PtyDataCallback>>();
const exitListeners = new Map<string, Set<PtyExitCallback>>();
const resizedListeners = new Map<string, Set<PtyResizedCallback>>();
type RunInTerminalCb = (command: string) => void;

const MAX_BUFFERED_PTY_EVENTS = 32;
const bufferedPtyData = new Map<
  string,
  Array<{ sessionId: string; data: Uint8Array }>
>();
const bufferedPtyExit = new Map<
  string,
  { sessionId: string; exitCode: number }
>();

const cdToListeners = new Set<CdToCallback>();
const runInTerminalListeners = new Set<RunInTerminalCb>();

type ReplayDataCb = (msg: ReplayMessage) => void;
const replayDataListeners = new Set<ReplayDataCb>();

type AgentEventCb = (event: {
  kind: string;
  sessionId: string;
  filePath?: string;
  touchType?: string;
  timestamp?: number;
}) => void;

const agentEventListeners = new Set<AgentEventCb>();
type FocusTabCb = (ptySessionId: string) => void;
const focusTabListeners = new Set<FocusTabCb>();
type ShellBlurCb = () => void;
const shellBlurListeners = new Set<ShellBlurCb>();

function getOrCreateListenerSet<T>(
  map: Map<string, Set<T>>,
  sessionId: string,
): Set<T> {
  let listeners = map.get(sessionId);
  if (!listeners) {
    listeners = new Set<T>();
    map.set(sessionId, listeners);
  }
  return listeners;
}

function removeListener<T>(
  map: Map<string, Set<T>>,
  sessionId: string,
  cb: T,
): void {
  const listeners = map.get(sessionId);
  if (!listeners) return;
  listeners.delete(cb);
  if (listeners.size === 0) {
    map.delete(sessionId);
  }
}

ipcRenderer.on("pty:data", (_event, payload) => {
  if ((dataListeners.get(payload.sessionId)?.size ?? 0) === 0) {
    const sessionBuffer = bufferedPtyData.get(payload.sessionId) ?? [];
    sessionBuffer.push(payload);
    if (sessionBuffer.length > MAX_BUFFERED_PTY_EVENTS) {
      sessionBuffer.shift();
    }
    bufferedPtyData.set(payload.sessionId, sessionBuffer);
  }

  for (const cb of dataListeners.get(payload.sessionId) ?? []) cb(payload);
});

ipcRenderer.on("pty:exit", (_event, payload) => {
  if ((exitListeners.get(payload.sessionId)?.size ?? 0) === 0) {
    bufferedPtyExit.set(payload.sessionId, payload);
  }
  for (const cb of exitListeners.get(payload.sessionId) ?? []) cb(payload);
});

// Host 端 settle resize 后的权威 winsize 直达(镜像端据此实时跟随,不再
// 依赖轮询采样瞬态)。不缓冲:丢失由镜像端定时对账兜底。
ipcRenderer.on("pty:resized", (_event, payload) => {
  for (const cb of resizedListeners.get(payload.sessionId) ?? []) cb(payload);
});

ipcRenderer.on("cd-to", (_event, path: string) => {
  for (const cb of cdToListeners) cb(path);
});

ipcRenderer.on("run-in-terminal", (_event, command: string) => {
  for (const cb of runInTerminalListeners) cb(command);
});

ipcRenderer.on("agent:session-started", (_event, data) => {
  for (const cb of agentEventListeners) cb(data);
});
ipcRenderer.on("agent:file-touched", (_event, data) => {
  for (const cb of agentEventListeners) cb(data);
});
ipcRenderer.on("agent:session-ended", (_event, data) => {
  for (const cb of agentEventListeners) cb(data);
});
ipcRenderer.on("focus-tab", (_event, ptySessionId: string) => {
  for (const cb of focusTabListeners) cb(ptySessionId);
});
ipcRenderer.on("shell-blur", () => {
  for (const cb of shellBlurListeners) cb();
});

type TerminalRefreshCb = () => void;
const terminalRefreshListeners = new Set<TerminalRefreshCb>();

ipcRenderer.on("terminal:refresh", () => {
  for (const cb of terminalRefreshListeners) cb();
});

type TerminalClearCb = () => void;
const terminalClearListeners = new Set<TerminalClearCb>();

ipcRenderer.on("terminal:clear", () => {
  for (const cb of terminalClearListeners) cb();
});

ipcRenderer.on("replay:data", (_event, msg) => {
  for (const cb of replayDataListeners) cb(msg);
});

// -- Canvas opacity ---------------------------------------------------
// The shell forwards canvas-opacity so webview backgrounds can match.
ipcRenderer.on("canvas-opacity", (_event: unknown, value: number) => {
  document.documentElement.style.setProperty("--canvas-opacity", String(value));
});

// -- Nav-visibility buffer -------------------------------------------
let bufferedNavVisible: boolean | null = null;
const navVisBuffer = (_event: unknown, visible: boolean) => {
  bufferedNavVisible = visible;
};
ipcRenderer.on("nav-visibility", navVisBuffer);

// -- Remote status ---------------------------------------------------
type RemoteStatusCb = (s: unknown) => void;
const remoteStatusListeners = new Set<RemoteStatusCb>();
ipcRenderer.on("remote-status", (_event: unknown, s: unknown) => {
  for (const cb of remoteStatusListeners) cb(s);
});

// -- Settings pane navigation ---------------------------------------
type OpenPaneCb = (pane: string) => void;
const openPaneListeners = new Set<OpenPaneCb>();
// shell 在 settings webview dom-ready 时即发送 open-pane,而页面侧订阅
// (React useEffect)晚于 dom-ready —— 无监听者时先缓存,首个订阅者回放。
let bufferedOpenPane: string | null = null;
ipcRenderer.on("settings:open-pane", (_event: unknown, pane: string) => {
  if (typeof pane !== "string") return;
  if (openPaneListeners.size === 0) bufferedOpenPane = pane;
  for (const cb of openPaneListeners) cb(pane);
});

// -- Templates reveal buffering --------------------------------------
type TemplatesRevealPayload = { template: string; relPath: string };
type TemplatesRevealCb = (payload: TemplatesRevealPayload) => void;
const templatesRevealListeners = new Set<TemplatesRevealCb>();
// 同 openPane:reveal 随"打开视图"投递,可能早于 React 侧订阅,无监听者时先缓存。
let bufferedTemplatesReveal: TemplatesRevealPayload | null = null;
ipcRenderer.on(
  "templates:reveal",
  (_event: unknown, payload: TemplatesRevealPayload) => {
    if (!payload || typeof payload.template !== "string") return;
    if (templatesRevealListeners.size === 0) bufferedTemplatesReveal = payload;
    for (const cb of templatesRevealListeners) cb(payload);
  },
);

// -- Unified API surface --------------------------------------------

contextBridge.exposeInMainWorld("api", {
  // Shared
  getPlatform: (): NodeJS.Platform => process.platform,
  getAppFlavor: (): string => ipcRenderer.sendSync("app:get-flavor"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  getDeviceId: () => ipcRenderer.invoke("analytics:get-device-id"),
  getPref: (key: string) => ipcRenderer.invoke("pref:get", key),
  getPrefSync: (key: string) => ipcRenderer.sendSync("pref:get-sync", key),
  setPref: (key: string, value: unknown) =>
    ipcRenderer.invoke("pref:set", key, value),
  getRemoteStatus: () => ipcRenderer.invoke("remote:get-status"),
  onRemoteStatus: (cb: RemoteStatusCb) => {
    remoteStatusListeners.add(cb);
    return () => {
      remoteStatusListeners.delete(cb);
    };
  },
  setRemoteHostEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("remote:host-set-enabled", enabled),
  testRemoteHost: (relayUrl: string, deviceToken: string) =>
    ipcRenderer.invoke("remote:host-test", { relayUrl, deviceToken }),
  hostIssueCredential: () => ipcRenderer.invoke("remote:host-issue-credential"),
  connectRemoteClient: (relayUrl: string, credentialPath: string) =>
    ipcRenderer.invoke("remote:client-connect", { relayUrl, credentialPath }),
  pickCredential: () => ipcRenderer.invoke("remote:credential-pick"),
  disconnectRemoteClient: () => ipcRenderer.invoke("remote:client-disconnect"),
  onOpenPane: (cb: OpenPaneCb) => {
    openPaneListeners.add(cb);
    if (bufferedOpenPane !== null) {
      const pane = bufferedOpenPane;
      bufferedOpenPane = null;
      cb(pane);
    }
    return () => {
      openPaneListeners.delete(cb);
    };
  },
  getMemoryStats: () => ipcRenderer.invoke("memory:stats"),
  listTerminalTargets: () => ipcRenderer.invoke("terminal:list-targets"),
  getWorkspacePref: (key: string, workspacePath: string) =>
    ipcRenderer.invoke("workspace-pref:get", { key, workspacePath }),
  setWorkspacePref: (key: string, value: unknown, workspacePath: string) =>
    ipcRenderer.invoke("workspace-pref:set", { key, value, workspacePath }),

  // Nav + Viewer
  selectFile: (path: string | null) =>
    ipcRenderer.send("nav:select-file", path),
  closeViewer: () => ipcRenderer.send("nav:close-viewer"),

  // Nav
  readDir: (path: string) => ipcRenderer.invoke("fs:readdir", path),
  countFiles: (path: string) => ipcRenderer.invoke("fs:count-files", path),
  trashFile: (path: string) => ipcRenderer.invoke("fs:trash", path),
  createDir: (path: string) => ipcRenderer.invoke("fs:mkdir", path),
  moveFile: (oldPath: string, newParentDir: string) =>
    ipcRenderer.invoke("fs:move", oldPath, newParentDir),
  selectFolder: (path: string) => ipcRenderer.send("nav:select-folder", path),
  readFolderTable: (folderPath: string) =>
    ipcRenderer.invoke("fs:read-folder-table", folderPath),
  importWebArticle: (url: string, targetDir: string) =>
    ipcRenderer.invoke("import:web-article", url, targetDir),
  openInTerminal: (path: string) =>
    ipcRenderer.send("nav:open-in-terminal", path),
  revealInFinder: (path: string) =>
    ipcRenderer.send("nav:reveal-in-finder", path),
  locateTerminal: (folderPath: string) =>
    ipcRenderer.send("nav:locate-terminal", folderPath),
  runInTerminal: (command: string) =>
    ipcRenderer.send("viewer:run-in-terminal", command),

  // Templates
  templatesList: () => ipcRenderer.invoke("templates:list"),
  templatesTree: (template: string, relPath: string) =>
    ipcRenderer.invoke("templates:tree", { template, relPath }),
  templatesCreate: (name: string) =>
    ipcRenderer.invoke("templates:create", name),
  templatesRename: (name: string, newName: string) =>
    ipcRenderer.invoke("templates:rename", { name, newName }),
  templatesDelete: (name: string) =>
    ipcRenderer.invoke("templates:delete", name),
  templatesCreateNode: (params: {
    template: string;
    relPath: string;
    kind: "file" | "dir";
    name: string;
  }) => ipcRenderer.invoke("templates:create-node", params),
  templatesRenameNode: (params: {
    template: string;
    relPath: string;
    newName: string;
  }) => ipcRenderer.invoke("templates:rename-node", params),
  templatesDeleteNode: (params: { template: string; relPath: string }) =>
    ipcRenderer.invoke("templates:delete-node", params),
  templatesOpenExternal: (params: {
    template: string;
    relPath?: string;
    isDir?: boolean;
  }) => ipcRenderer.invoke("templates:open-external", params),
  templatesRevealPath: (params: { template?: string; relPath?: string }) =>
    ipcRenderer.invoke("templates:reveal-path", params),
  templatesDragStart: (payload: { template: string; relPath: string }) =>
    ipcRenderer.send("templates:drag-start", payload),
  templatesDragEnd: () => ipcRenderer.send("templates:drag-end"),
  templatesDropMount: (params: { workspace: string; relPath: string }) =>
    ipcRenderer.invoke("templates:drop-mount", params),
  templatesMountTo: (params: {
    source: { template: string; relPath: string };
    target: { workspace: string; relPath: string };
  }) => ipcRenderer.invoke("templates:mount-to", params),
  templatesWorkspaces: () => ipcRenderer.invoke("templates:workspaces"),
  templatesLinkInfo: (params: { workspace: string; relPath: string }) =>
    ipcRenderer.invoke("templates:link-info", params),
  templatesRemoveLink: (params: { workspace: string; relPath: string }) =>
    ipcRenderer.invoke("templates:remove-link", params),
  templatesRevealSource: (params: { workspace: string; relPath: string }) =>
    ipcRenderer.invoke("templates:reveal-source", params),
  templatesListMounts: (params: { template?: string }) =>
    ipcRenderer.invoke("templates:list-mounts", params),
  templatesRevealInWorkspace: (params: {
    workspace: string;
    relPath: string;
  }) => ipcRenderer.invoke("templates:reveal-in-workspace", params),
  onTemplatesReveal: (cb: TemplatesRevealCb) => {
    templatesRevealListeners.add(cb);
    if (bufferedTemplatesReveal !== null) {
      const payload = bufferedTemplatesReveal;
      bufferedTemplatesReveal = null;
      cb(payload);
    }
    return () => {
      templatesRevealListeners.delete(cb);
    };
  },
  templatesCloseView: () => ipcRenderer.send("templates:close-view"),
  onTemplatesMountsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("templates:mounts-changed", handler);
    return () =>
      ipcRenderer.removeListener("templates:mounts-changed", handler);
  },
  onTemplateDragStart: (
    cb: (payload: {
      template: string;
      relPath: string;
      name: string;
      isDir: boolean;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      payload: {
        template: string;
        relPath: string;
        name: string;
        isDir: boolean;
      },
    ) => cb(payload);
    ipcRenderer.on("template-drag:start", handler);
    return () => ipcRenderer.removeListener("template-drag:start", handler);
  },
  onTemplateDragEnd: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("template-drag:end", handler);
    return () => ipcRenderer.removeListener("template-drag:end", handler);
  },

  // Viewer
  readFile: (path: string) => ipcRenderer.invoke("fs:readfile", path),
  renameFile: (oldPath: string, newTitle: string) =>
    ipcRenderer.invoke("fs:rename", oldPath, newTitle),
  getFileStats: (path: string) => ipcRenderer.invoke("fs:stat", path),
  getImageThumbnail: (path: string, size: number) =>
    ipcRenderer.invoke("image:thumbnail", path, size),
  getImageFull: (path: string) => ipcRenderer.invoke("image:full", path),
  resolveImagePath: (reference: string, fromNotePath: string) =>
    ipcRenderer.invoke("image:resolve-path", reference, fromNotePath),
  saveDroppedImage: (noteDir: string, fileName: string, buffer: ArrayBuffer) =>
    ipcRenderer.invoke("image:save-dropped", noteDir, fileName, buffer),
  openImageDialog: () => ipcRenderer.invoke("dialog:open-image"),
  getWorkspaceGraph: (params: { workspacePath: string }) =>
    ipcRenderer.invoke("workspace:get-graph", params),
  updateFrontmatter: (filePath: string, field: string, value: unknown) =>
    ipcRenderer.invoke("workspace:update-frontmatter", filePath, field, value),
  resolveWikilink: (target: string) =>
    ipcRenderer.invoke("wikilink:resolve", target),
  suggestWikilinks: (partial: string) =>
    ipcRenderer.invoke("wikilink:suggest", partial),
  getBacklinks: (filePath: string) =>
    ipcRenderer.invoke("wikilink:backlinks", filePath),

  // Nav + Viewer (shared FS helpers)
  writeFile: (path: string, content: string, expectedMtime?: string) =>
    ipcRenderer.invoke("fs:writefile", path, content, expectedMtime),
  readTree: (params: { root: string }) =>
    ipcRenderer.invoke("workspace:read-tree", params),
  // Terminal (PTY)
  ptyCreate: (
    cwd?: string,
    cols?: number,
    rows?: number,
    target?: string,
    tileId?: string,
    layout?: { x: number; y: number; width: number; height: number },
  ) =>
    ipcRenderer.invoke("pty:create", {
      cwd,
      cols,
      rows,
      target,
      tileId,
      layout,
    }),
  ptyWrite: (sessionId: string, data: string) => {
    ipcRenderer.send("pty:write", { sessionId, data });
  },
  ptySendRawKeys: (sessionId: string, data: string) => {
    ipcRenderer.send("pty:send-raw-keys", { sessionId, data });
  },
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:resize", { sessionId, cols, rows }),
  ptyReportFit: (
    cols: number,
    rows: number,
    widthPx: number,
    heightPx: number,
  ) => {
    ipcRenderer.send("pty:report-fit", { cols, rows, widthPx, heightPx });
  },
  ptyKill: (sessionId: string) => ipcRenderer.invoke("pty:kill", { sessionId }),
  ptyReconnect: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:reconnect", { sessionId, cols, rows }),
  ptyDiscover: () => ipcRenderer.invoke("pty:discover"),
  ptyReadMeta: (sessionId: string) =>
    ipcRenderer.invoke("pty:read-meta", sessionId),
  onPtyData: (sessionId: string, cb: PtyDataCallback) => {
    getOrCreateListenerSet(dataListeners, sessionId).add(cb);
    const buffered = bufferedPtyData.get(sessionId);
    if (buffered && buffered.length > 0) {
      for (const payload of buffered) cb(payload);
      bufferedPtyData.delete(sessionId);
    }
  },
  offPtyData: (sessionId: string, cb: PtyDataCallback) => {
    removeListener(dataListeners, sessionId, cb);
  },
  onPtyExit: (sessionId: string, cb: PtyExitCallback) => {
    getOrCreateListenerSet(exitListeners, sessionId).add(cb);
    const buffered = bufferedPtyExit.get(sessionId);
    if (buffered) {
      cb(buffered);
      bufferedPtyExit.delete(sessionId);
    }
  },
  offPtyExit: (sessionId: string, cb: PtyExitCallback) => {
    removeListener(exitListeners, sessionId, cb);
  },
  onPtyResized: (sessionId: string, cb: PtyResizedCallback) => {
    getOrCreateListenerSet(resizedListeners, sessionId).add(cb);
  },
  offPtyResized: (sessionId: string, cb: PtyResizedCallback) => {
    removeListener(resizedListeners, sessionId, cb);
  },
  notifyPtySessionId: (sessionId: string) =>
    ipcRenderer.sendToHost("pty-session-id", sessionId),
  notifyCwdChanged: (sessionId: string, cwd: string) =>
    ipcRenderer.sendToHost("pty-cwd-changed", sessionId, cwd),
  getClaudeBinding: (tileId: string) =>
    ipcRenderer.invoke("claude:get-binding", tileId),
  notifyTerminalStatus: (sessionId: string, status: string, command?: string) =>
    ipcRenderer.sendToHost("term:status-changed", sessionId, status, command),
  onCdTo: (cb: CdToCallback) => {
    cdToListeners.add(cb);
  },
  offCdTo: (cb: CdToCallback) => {
    cdToListeners.delete(cb);
  },
  onRunInTerminal: (cb: RunInTerminalCb) => {
    runInTerminalListeners.add(cb);
  },
  offRunInTerminal: (cb: RunInTerminalCb) => {
    runInTerminalListeners.delete(cb);
  },

  // File drop support
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  isDirectory: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:is-directory", filePath),

  // Cross-webview drag-and-drop
  setDragPaths: (paths: string[]) => ipcRenderer.send("drag:set-paths", paths),
  clearDragPaths: () => ipcRenderer.send("drag:clear-paths"),
  getDragPaths: () => ipcRenderer.invoke("drag:get-paths"),
  onNavDragActive: (cb: (active: boolean) => void) => {
    const handler = (_event: unknown, active: boolean) => cb(active);
    ipcRenderer.on("nav-drag-active", handler);
    return () => ipcRenderer.removeListener("nav-drag-active", handler);
  },

  // Workspace management
  workspaceAdd: () => ipcRenderer.invoke("workspace:add"),
  workspaceAddByPath: (folderPath: string) =>
    ipcRenderer.invoke("workspace:add-by-path", folderPath),
  workspaceRemoveByPath: (path: string) =>
    ipcRenderer.invoke("workspace:remove-by-path", path),

  // Theme
  setTheme: (mode: string) => ipcRenderer.invoke("theme:set", mode),

  // Settings
  openFolder: () => ipcRenderer.invoke("dialog:open-folder"),
  showContextMenu: (
    items: Array<{
      id: string;
      label: string;
      enabled?: boolean;
    }>,
  ) => ipcRenderer.invoke("context-menu:show", items),
  close: () => ipcRenderer.send("settings:close"),

  openExternal: (url: string) => ipcRenderer.send("shell:open-external", url),
  openPath: (path: string) => ipcRenderer.send("shell:open-path", path),

  // External editor
  listExternalEditors: () => ipcRenderer.invoke("external-editor:list"),
  openFileInExternalEditor: (filePath: string, editorId?: string) =>
    ipcRenderer.send("external-editor:open-file", filePath, editorId),
  openWorkspaceInExternalEditor: (workspacePath: string) =>
    ipcRenderer.send("external-editor:open-workspace", workspacePath),

  // Integrations
  getAgents: () => ipcRenderer.invoke("integrations:get-agents"),
  installSkill: (agentId: string) =>
    ipcRenderer.invoke("integrations:install-skill", agentId),
  uninstallSkill: (agentId: string) =>
    ipcRenderer.invoke("integrations:uninstall-skill", agentId),
  hasOfferedPlugin: () => ipcRenderer.invoke("integrations:has-offered-plugin"),
  markPluginOffered: () =>
    ipcRenderer.invoke("integrations:mark-plugin-offered"),
  setDeepIntegration: (enabled: boolean) =>
    ipcRenderer.invoke("integrations:set-deep-integration", enabled),

  // Claude sound settings
  getClaudeSounds: () => ipcRenderer.invoke("integrations:get-claude-sounds"),
  setClaudeSounds: (sounds: Record<string, unknown>) =>
    ipcRenderer.invoke("integrations:set-claude-sounds", sounds),

  // IPC event listeners (nav, viewer, terminal)
  onFocusSearch: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("focus-search", handler);
    return () => ipcRenderer.removeListener("focus-search", handler);
  },
  onFileSelected: (cb: (path: string | null) => void) => {
    const handler = (_event: unknown, path: string | null) => cb(path);
    ipcRenderer.on("file-selected", handler);
    return () => ipcRenderer.removeListener("file-selected", handler);
  },
  onPrefChanged: (cb: (key: string, value: unknown) => void) => {
    const handler = (_event: unknown, key: string, value: unknown) =>
      cb(key, value);
    // 主进程广播用 pref:changed；shell 向 tile webview 转发沿用 pref-changed
    ipcRenderer.on("pref:changed", handler);
    ipcRenderer.on("pref-changed", handler);
    return () => {
      ipcRenderer.removeListener("pref:changed", handler);
      ipcRenderer.removeListener("pref-changed", handler);
    };
  },
  onFolderSelected: (cb: (path: string) => void) => {
    const handler = (_event: unknown, path: string) => cb(path);
    ipcRenderer.on("folder-selected", handler);
    return () => ipcRenderer.removeListener("folder-selected", handler);
  },
  onFileRenamed: (cb: (oldPath: string, newPath: string) => void) => {
    const handler = (_event: unknown, oldPath: string, newPath: string) =>
      cb(oldPath, newPath);
    ipcRenderer.on("file-renamed", handler);
    return () => ipcRenderer.removeListener("file-renamed", handler);
  },
  onFilesDeleted: (cb: (paths: string[]) => void) => {
    const handler = (_event: unknown, paths: string[]) => cb(paths);
    ipcRenderer.on("files-deleted", handler);
    return () => ipcRenderer.removeListener("files-deleted", handler);
  },
  onFsChanged: (
    cb: (
      events: Array<{
        dirPath: string;
        changes: Array<{ path: string; type: number }>;
      }>,
    ) => void,
  ) => {
    const handler = (_event: unknown, events: unknown) =>
      cb(
        events as Array<{
          dirPath: string;
          changes: Array<{ path: string; type: number }>;
        }>,
      );
    ipcRenderer.on("fs-changed", handler);
    return () => ipcRenderer.removeListener("fs-changed", handler);
  },
  onWorkspaceAdded: (cb: (path: string) => void) => {
    const handler = (_event: unknown, path: string) => cb(path);
    ipcRenderer.on("workspace-added", handler);
    return () => ipcRenderer.removeListener("workspace-added", handler);
  },
  onWorkspaceRemoved: (cb: (path: string) => void) => {
    const handler = (_event: unknown, path: string) => cb(path);
    ipcRenderer.on("workspace-removed", handler);
    return () => ipcRenderer.removeListener("workspace-removed", handler);
  },
  onWikilinksUpdated: (cb: (paths: string[]) => void) => {
    const handler = (_event: unknown, paths: string[]) => cb(paths);
    ipcRenderer.on("wikilinks-updated", handler);
    return () => ipcRenderer.removeListener("wikilinks-updated", handler);
  },
  onNavVisibility: (cb: (visible: boolean) => void) => {
    if (bufferedNavVisible !== null) {
      cb(bufferedNavVisible);
      bufferedNavVisible = null;
    }
    ipcRenderer.removeListener("nav-visibility", navVisBuffer);
    const handler = (_event: unknown, visible: boolean) => cb(visible);
    ipcRenderer.on("nav-visibility", handler);
    return () => ipcRenderer.removeListener("nav-visibility", handler);
  },

  onScopeChanged: (cb: (newPath: string) => void) => {
    const handler = (_event: IpcRendererEvent, path: string) => cb(path);
    ipcRenderer.on("scope-changed", handler);
    return () => ipcRenderer.removeListener("scope-changed", handler);
  },

  // Auto-updater
  updateGetStatus: () => ipcRenderer.invoke("update:getStatus"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateInstall: () => ipcRenderer.send("update:install"),
  onUpdateStatus: (cb: (state: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => cb(state);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },

  // macOS permissions
  checkPermissions: () => ipcRenderer.invoke("permissions:check"),
  openPermissionSettings: (kind: string) =>
    ipcRenderer.invoke("permissions:open-settings", kind),
  closePermissionCheck: () => ipcRenderer.send("permissions:close"),

  // Agent activity
  onAgentEvent: (cb: AgentEventCb) => {
    agentEventListeners.add(cb);
    return () => {
      agentEventListeners.delete(cb);
    };
  },
  focusAgentSession: (sessionId: string) =>
    ipcRenderer.invoke("agent:focus-session", sessionId),

  // Git replay
  startReplay: (params: { workspacePath: string }) =>
    ipcRenderer.invoke("replay:start", params),
  stopReplay: () => ipcRenderer.invoke("replay:stop"),
  onReplayData: (cb: ReplayDataCb) => {
    replayDataListeners.add(cb);
    return () => {
      replayDataListeners.delete(cb);
    };
  },

  // Terminal focus
  onFocusTab: (cb: FocusTabCb) => {
    focusTabListeners.add(cb);
    return () => {
      focusTabListeners.delete(cb);
    };
  },

  onShellBlur: (cb: ShellBlurCb) => {
    shellBlurListeners.add(cb);
    return () => {
      shellBlurListeners.delete(cb);
    };
  },

  onTerminalRefresh: (cb: () => void) => {
    terminalRefreshListeners.add(cb);
    return () => {
      terminalRefreshListeners.delete(cb);
    };
  },

  onTerminalClear: (cb: () => void) => {
    terminalClearListeners.add(cb);
    return () => {
      terminalClearListeners.delete(cb);
    };
  },

  // Canvas pinch forwarding
  forwardPinch: (deltaY: number) =>
    ipcRenderer.send("canvas:forward-pinch", deltaY),

  // Generic sendToHost for webview → shell renderer communication
  sendToHost: (channel: string, ...args: unknown[]) =>
    ipcRenderer.sendToHost(channel, ...args),

  // Terminal list channels (shell renderer → webview via webview.send)
  onTileListMessage: (cb: (channel: string, ...args: unknown[]) => void) => {
    const channels = [
      "tile-list:init",
      "tile-list:add",
      "tile-list:remove",
      "tile-list:update",
      "tile-list:focus",
    ];
    const handlers = channels.map((ch) => {
      const handler = (_event: unknown, ...args: unknown[]) => cb(ch, ...args);
      ipcRenderer.on(ch, handler);
      return { ch, handler };
    });
    return () => {
      for (const { ch, handler } of handlers) {
        ipcRenderer.removeListener(ch, handler);
      }
    };
  },
});

// Forward ctrl+wheel (trackpad pinch) from tile webviews to the canvas
window.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      ipcRenderer.send("canvas:forward-pinch", e.deltaY);
    }
  },
  { passive: false },
);
