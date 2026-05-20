import { invoke, InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppConfig,
  FolderTableData,
  TreeNode,
} from "../shared/types";
import type { ReplayMessage } from "../shared/replay-types";
import type {
  DirEntry,
  FileStats,
  GraphData,
  WikilinkSuggestion,
  Backlink,
  PtySession,
  TerminalTargetOption,
  UpdateState,
  AgentEvent,
} from "../shared/window-api";

type Unsubscribe = () => void;

// ── Tauri invoke wrapper with snake_case mapping ─────────────────────
async function cmd<T>(name: string, args?: InvokeArgs): Promise<T> {
  return invoke<T>(name, args);
}

// ── CollabApi Implementation ─────────────────────────────────────────

// Cached platform (Tauri doesn't expose NodeJS.Platform)
let _platform: string = "darwin";
let _device_id: string | null = null;

// Workspace/file selection events
const _fileSelectedListeners: Array<(path: string | null) => void> = [];
const _folderSelectedListeners: Array<(path: string) => void> = [];
const _runInTerminalListeners: Array<(command: string) => void> = [];
const _cdToListeners: Array<(path: string) => void> = [];
const _focusTabListeners: Array<(ptySessionId: string) => void> = [];
const _shellBlurListeners: Array<() => void> = [];
const _fsChangedListeners: Array<(events: Array<{ dirPath: string; changes: Array<{ path: string; type: number }> }>) => void> = [];
const _workspaceAddedListeners: Array<(path: string) => void> = [];
const _workspaceRemovedListeners: Array<(path: string) => void> = [];
const _fileRenamedListeners: Array<(oldPath: string, newPath: string) => void> = [];
const _filesDeletedListeners: Array<(paths: string[]) => void> = [];
const _wikilinksUpdatedListeners: Array<(paths: string[]) => void> = [];
const _navVisibilityListeners: Array<(visible: boolean) => void> = [];
const _scopeChangedListeners: Array<(newPath: string) => void> = [];
const _updateStatusListeners: Array<(state: UpdateState) => void> = [];
const _agentEventListeners: Array<(event: AgentEvent) => void> = [];
const _replayDataListeners: Array<(msg: ReplayMessage) => void> = [];
const _navDragActiveListeners: Array<(active: boolean) => void> = [];

// PTY data/exit callbacks keyed by sessionId
const _ptyDataCallbacks = new Map<string, Array<(payload: { sessionId: string; data: Uint8Array }) => void>>();
const _ptyExitCallbacks = new Map<string, Array<(payload: { sessionId: string; exitCode: number }) => void>>();

// Start listening for Tauri events
async function _initEventListeners() {
  // PTY data
  listen("pty:data", (event) => {
    const payload = event.payload as { id: string; data: string };
    const cbs = _ptyDataCallbacks.get(payload.id) || [];
    const bytes = new TextEncoder().encode(payload.data);
    for (const cb of cbs) {
      cb({ sessionId: payload.id, data: bytes });
    }
  });

  // PTY exit
  listen("pty:exit", (event) => {
    const payload = event.payload as { id: string; exitCode?: number };
    const cbs = _ptyExitCallbacks.get(payload.id) || [];
    const exitCode = payload.exitCode ?? 0;
    for (const cb of cbs) {
      cb({ sessionId: payload.id, exitCode });
    }
  });

  // File watcher events
  listen("watcher:change", (event) => {
    const payload = event.payload as Array<{ dirPath: string; changes: Array<{ path: string; type: number }> }>;
    for (const cb of _fsChangedListeners) cb(payload);
  });

  // Workspace events
  listen("workspace:added", (event) => {
    for (const cb of _workspaceAddedListeners) cb(event.payload as string);
  });
  listen("workspace:removed", (event) => {
    for (const cb of _workspaceRemovedListeners) cb(event.payload as string);
  });

  // Wikilinks events
  listen("wikilinks:updated", (event) => {
    for (const cb of _wikilinksUpdatedListeners) cb(event.payload as string[]);
  });

  // Nav visibility
  listen("nav:visibility", (event) => {
    for (const cb of _navVisibilityListeners) cb(event.payload as boolean);
  });

  // Nav drag active
  listen("nav:drag-active", (event) => {
    for (const cb of _navDragActiveListeners) cb(event.payload as boolean);
  });

  // Menu actions
  listen("menu:action", (event) => {
    const action = event.payload as string;
    if (action === "run-in-terminal") {
      // handled by menu:action channel
    }
  });

  // Update status
  listen("updater:status", (event) => {
    for (const cb of _updateStatusListeners) cb(event.payload as UpdateState);
  });

  // Agent events
  listen("agent:event", (event) => {
    for (const cb of _agentEventListeners) cb(event.payload as AgentEvent);
  });

  // Replay data
  listen("replay:data", (event) => {
    for (const cb of _replayDataListeners) cb(event.payload as ReplayMessage);
  });

  // cd-to
  listen("cd-to", (event) => {
    for (const cb of _cdToListeners) cb(event.payload as string);
  });

  // run-in-terminal
  listen("run-in-terminal", (event) => {
    for (const cb of _runInTerminalListeners) cb(event.payload as string);
  });

  // file selected (from nav)
  listen("nav:file-selected", (event) => {
    const path = event.payload as string | null;
    for (const cb of _fileSelectedListeners) cb(path);
  });

  // file renamed
  listen("fs:renamed", (event) => {
    const p = event.payload as { oldPath: string; newPath: string };
    for (const cb of _fileRenamedListeners) cb(p.oldPath, p.newPath);
  });

  // files deleted
  listen("fs:deleted", (event) => {
    for (const cb of _filesDeletedListeners) cb(event.payload as string[]);
  });

  // focus tab
  listen("focus:tab", (event) => {
    for (const cb of _focusTabListeners) cb(event.payload as string);
  });

  // shell blur
  listen("shell:blur", () => {
    for (const cb of _shellBlurListeners) cb();
  });

  // scope changed
  listen("scope:changed", (event) => {
    for (const cb of _scopeChangedListeners) cb(event.payload as string);
  });
}

// Initialize listeners on module load
_initEventListeners().catch(console.error);

export const collabApi = {
  // ── Config ───────────────────────────────────────────────────────
  getPlatform: () => _platform as NodeJS.Platform,

  getConfig: async (): Promise<AppConfig> => {
    return cmd<AppConfig>("pref_get", { key: "__config__" });
  },

  getDeviceId: async (): Promise<string> => {
    if (!_device_id) {
      _device_id = await cmd<string>("analytics_get_device_id");
    }
    return _device_id;
  },

  getPref: async (key: string): Promise<unknown> => {
    return cmd("pref_get", { key });
  },

  setPref: async (key: string, value: unknown): Promise<void> => {
    return cmd("pref_set", { key, value });
  },

  listTerminalTargets: async (): Promise<TerminalTargetOption[]> => {
    return cmd("terminal_list_targets");
  },

  getWorkspacePref: async (key: string, workspacePath: string): Promise<unknown> => {
    return cmd("workspace_pref_get", { key, workspacePath });
  },

  setWorkspacePref: async (key: string, value: unknown, workspacePath: string): Promise<void> => {
    return cmd("workspace_pref_set", { key, value, workspacePath });
  },

  // ── Theme ────────────────────────────────────────────────────────
  setTheme: async (mode: string): Promise<void> => {
    return cmd("theme_set", { mode });
  },

  // ── File selection ───────────────────────────────────────────────
  selectFile: (path: string | null): void => {
    for (const cb of _fileSelectedListeners) cb(path);
  },

  // ── Folder selection ─────────────────────────────────────────────
  selectFolder: (path: string): void => {
    for (const cb of _folderSelectedListeners) cb(path);
  },

  readFolderTable: async (folderPath: string): Promise<FolderTableData> => {
    return cmd("fs_read_folder_table", { folderPath });
  },

  // ── File system (nav) ────────────────────────────────────────────
  readDir: async (path: string): Promise<DirEntry[]> => {
    return cmd("fs_readdir", { path });
  },

  countFiles: async (path: string): Promise<number> => {
    return cmd("count_files", { path });
  },

  trashFile: async (path: string): Promise<void> => {
    return cmd("trash_file", { path });
  },

  createDir: async (path: string): Promise<void> => {
    return cmd("make_directory", { path });
  },

  moveFile: async (oldPath: string, newParentDir: string): Promise<string> => {
    return cmd("fs_move", { oldPath, newParentDir });
  },

  // ── Import ───────────────────────────────────────────────────────
  importWebArticle: async (url: string, targetDir: string): Promise<{ path: string }> => {
    return cmd("import_web_article", { url, targetDir });
  },

  // ── File system (viewer) ─────────────────────────────────────────
  readFile: async (path: string): Promise<string> => {
    return cmd("read_file", { path });
  },

  writeFile: async (path: string, content: string, expectedMtime?: string): Promise<WriteResult> => {
    return cmd("fs_writefile", { path, content, expectedMtime });
  },

  renameFile: async (oldPath: string, newTitle: string): Promise<string> => {
    return cmd("rename_file", { oldPath, newTitle });
  },

  getFileStats: async (path: string): Promise<FileStats> => {
    return cmd("file_stat", { path });
  },

  // ── Images ───────────────────────────────────────────────────────
  getImageThumbnail: async (path: string, size: number): Promise<string> => {
    return cmd("image_thumbnail", { path, size });
  },

  getImageFull: async (path: string): Promise<{ url: string; width: number; height: number }> => {
    return cmd("image_full", { path });
  },

  resolveImagePath: async (reference: string, fromNotePath: string): Promise<string | null> => {
    return cmd("image_resolve_path", { reference, fromNotePath });
  },

  saveDroppedImage: async (noteDir: string, fileName: string, buffer: ArrayBuffer): Promise<string> => {
    // Convert ArrayBuffer to base64 for Tauri IPC
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return cmd("image_save_dropped", { noteDir, fileName, base64 });
  },

  openImageDialog: async (): Promise<string | null> => {
    return cmd("dialog_open_image");
  },

  // ── Workspace ────────────────────────────────────────────────────
  readTree: async (params: { root: string }): Promise<TreeNode[]> => {
    return cmd("fs_read_tree", { root: params.root });
  },

  workspaceRemoveByPath: async (path: string): Promise<{ workspaces: string[] }> => {
    return cmd("workspace_remove_by_path", { path });
  },

  getWorkspaceGraph: async (params: { workspacePath: string }): Promise<GraphData> => {
    return cmd("workspace_get_graph", { workspacePath: params.workspacePath });
  },

  updateFrontmatter: async (filePath: string, field: string, value: unknown): Promise<{ ok: boolean; retried?: boolean }> => {
    return cmd("workspace_update_frontmatter", { filePath, field, value });
  },

  // ── Wikilinks ────────────────────────────────────────────────────
  resolveWikilink: async (target: string): Promise<string | null> => {
    return cmd("wikilink_resolve", { target });
  },

  suggestWikilinks: async (partial: string): Promise<WikilinkSuggestion[]> => {
    return cmd("wikilink_suggest", { partial });
  },

  getBacklinks: async (filePath: string): Promise<Backlink[]> => {
    return cmd("wikilink_backlinks", { filePath });
  },

  // ── PTY ──────────────────────────────────────────────────────────
  ptyCreate: async (
    cwd?: string,
    cols?: number,
    rows?: number,
    target?: string,
    tileId?: string,
  ): Promise<PtySession> => {
    const sessionId = await cmd<string>("pty_create", {
      params: { cwd, cols, rows, target, tileId },
    });
    // Return a PtySession-like object (the actual session data comes from pty_read_meta)
    const meta = await collabApi.ptyReadMeta(sessionId);
    return {
      sessionId,
      shell: meta?.shell || "zsh",
      displayName: meta?.cwd || "Terminal",
      target: meta?.target || "local",
      command: meta?.shell || "/bin/zsh",
      args: [],
      cwdHostPath: meta?.cwd || "",
      cwdGuestPath: meta?.cwd,
    };
  },

  ptyWrite: (sessionId: string, data: string): void => {
    cmd("pty_write", { id: sessionId, data }).catch(console.error);
  },

  ptySendRawKeys: (sessionId: string, data: string): void => {
    cmd("pty_send_raw_keys", { id: sessionId, data }).catch(console.error);
  },

  ptyResize: async (sessionId: string, cols: number, rows: number): Promise<void> => {
    return cmd("pty_resize", { id: sessionId, cols, rows });
  },

  ptyKill: async (sessionId: string): Promise<void> => {
    return cmd("pty_kill", { id: sessionId });
  },

  ptyReconnect: async (sessionId: string, cols: number, rows: number): Promise<PtySession & { scrollback: string }> => {
    // For now, just recreate the session
    await cmd("pty_resize", { id: sessionId, cols, rows });
    const meta = await collabApi.ptyReadMeta(sessionId);
    return {
      sessionId,
      shell: meta?.shell || "zsh",
      displayName: meta?.cwd || "Terminal",
      target: meta?.target || "local",
      command: meta?.shell || "/bin/zsh",
      args: [],
      cwdHostPath: meta?.cwd || "",
      cwdGuestPath: meta?.cwd,
      scrollback: "",
    };
  },

  ptyDiscover: async (): Promise<Array<{ sessionId: string; meta: { shell: string; cwd: string; createdAt: string; displayName?: string; target?: string; cwdHostPath?: string; cwdGuestPath?: string } }>> => {
    const sessions = await cmd<Array<{ id: string; cwd: string }>>("pty_discover");
    return sessions.map((s) => ({
      sessionId: s.id,
      meta: {
        shell: "/bin/zsh",
        cwd: s.cwd,
        createdAt: new Date().toISOString(),
        cwdHostPath: s.cwd,
        cwdGuestPath: s.cwd,
      },
    }));
  },

  ptyReadMeta: async (sessionId: string): Promise<{ shell: string; cwd: string; createdAt: string; target?: string; backend?: "sidecar" } | null> => {
    return cmd("pty_read_meta", { id: sessionId });
  },

  notifyPtySessionId: (_sessionId: string): void => {
    // No-op in Tauri
  },

  onPtyData: (sessionId: string, cb: (payload: { sessionId: string; data: Uint8Array }) => void): void => {
    if (!_ptyDataCallbacks.has(sessionId)) {
      _ptyDataCallbacks.set(sessionId, []);
    }
    _ptyDataCallbacks.get(sessionId)!.push(cb);
  },

  offPtyData: (sessionId: string, cb: (payload: { sessionId: string; data: Uint8Array }) => void): void => {
    const cbs = _ptyDataCallbacks.get(sessionId);
    if (cbs) {
      const idx = cbs.indexOf(cb);
      if (idx >= 0) cbs.splice(idx, 1);
    }
  },

  onPtyExit: (sessionId: string, cb: (payload: { sessionId: string; exitCode: number }) => void): void => {
    if (!_ptyExitCallbacks.has(sessionId)) {
      _ptyExitCallbacks.set(sessionId, []);
    }
    _ptyExitCallbacks.get(sessionId)!.push(cb);
  },

  offPtyExit: (sessionId: string, cb: (payload: { sessionId: string; exitCode: number }) => void): void => {
    const cbs = _ptyExitCallbacks.get(sessionId);
    if (cbs) {
      const idx = cbs.indexOf(cb);
      if (idx >= 0) cbs.splice(idx, 1);
    }
  },

  onCdTo: (cb: (path: string) => void): void => {
    _cdToListeners.push(cb);
  },

  offCdTo: (cb: (path: string) => void): void => {
    const idx = _cdToListeners.indexOf(cb);
    if (idx >= 0) _cdToListeners.splice(idx, 1);
  },

  // ── Navigation ───────────────────────────────────────────────────
  openInTerminal: (path: string): void => {
    cmd("nav_open_in_terminal", { path }).catch(console.error);
  },

  createGraphTile: (folderPath: string): void => {
    cmd("nav_create_graph_tile", { folderPath }).catch(console.error);
  },

  runInTerminal: (command: string): void => {
    for (const cb of _runInTerminalListeners) cb(command);
  },

  onRunInTerminal: (cb: (command: string) => void): void => {
    _runInTerminalListeners.push(cb);
  },

  offRunInTerminal: (cb: (command: string) => void): void => {
    const idx = _runInTerminalListeners.indexOf(cb);
    if (idx >= 0) _runInTerminalListeners.splice(idx, 1);
  },

  // ── Cross-webview drag-and-drop ──────────────────────────────────
  setDragPaths: (_paths: string[]): void => {
    // Tauri handles drag differently, no-op for now
  },

  clearDragPaths: (): void => {
    // No-op
  },

  getDragPaths: async (): Promise<string[]> => {
    return [];
  },

  onNavDragActive: (cb: (active: boolean) => void): Unsubscribe => {
    _navDragActiveListeners.push(cb);
    return () => {
      const idx = _navDragActiveListeners.indexOf(cb);
      if (idx >= 0) _navDragActiveListeners.splice(idx, 1);
    };
  },

  // ── Settings ─────────────────────────────────────────────────────
  openFolder: async (): Promise<string | null> => {
    return cmd("dialog_open_folder");
  },

  close: (): void => {
    // In Tauri, close the current window
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().close();
    }).catch(console.error);
  },

  // ── Context menu ─────────────────────────────────────────────────
  showContextMenu: async (items: Array<{ id: string; label: string; enabled?: boolean }>): Promise<string | null> => {
    return cmd("context_menu_show", { items });
  },

  // ── IPC event listeners ──────────────────────────────────────────
  onFocusSearch: (): Unsubscribe => {
    // No-op in Tauri for now
    return () => {};
  },

  onFileSelected: (cb: (path: string | null) => void): Unsubscribe => {
    _fileSelectedListeners.push(cb);
    return () => {
      const idx = _fileSelectedListeners.indexOf(cb);
      if (idx >= 0) _fileSelectedListeners.splice(idx, 1);
    };
  },

  onFolderSelected: (cb: (path: string) => void): Unsubscribe => {
    _folderSelectedListeners.push(cb);
    return () => {
      const idx = _folderSelectedListeners.indexOf(cb);
      if (idx >= 0) _folderSelectedListeners.splice(idx, 1);
    };
  },

  onFileRenamed: (cb: (oldPath: string, newPath: string) => void): Unsubscribe => {
    _fileRenamedListeners.push(cb);
    return () => {
      const idx = _fileRenamedListeners.indexOf(cb);
      if (idx >= 0) _fileRenamedListeners.splice(idx, 1);
    };
  },

  onFilesDeleted: (cb: (paths: string[]) => void): Unsubscribe => {
    _filesDeletedListeners.push(cb);
    return () => {
      const idx = _filesDeletedListeners.indexOf(cb);
      if (idx >= 0) _filesDeletedListeners.splice(idx, 1);
    };
  },

  onFsChanged: (cb: (events: Array<{ dirPath: string; changes: Array<{ path: string; type: number }> }>) => void): Unsubscribe => {
    _fsChangedListeners.push(cb);
    return () => {
      const idx = _fsChangedListeners.indexOf(cb);
      if (idx >= 0) _fsChangedListeners.splice(idx, 1);
    };
  },

  onWorkspaceAdded: (cb: (path: string) => void): Unsubscribe => {
    _workspaceAddedListeners.push(cb);
    return () => {
      const idx = _workspaceAddedListeners.indexOf(cb);
      if (idx >= 0) _workspaceAddedListeners.splice(idx, 1);
    };
  },

  onWorkspaceRemoved: (cb: (path: string) => void): Unsubscribe => {
    _workspaceRemovedListeners.push(cb);
    return () => {
      const idx = _workspaceRemovedListeners.indexOf(cb);
      if (idx >= 0) _workspaceRemovedListeners.splice(idx, 1);
    };
  },

  onWikilinksUpdated: (cb: (paths: string[]) => void): Unsubscribe => {
    _wikilinksUpdatedListeners.push(cb);
    return () => {
      const idx = _wikilinksUpdatedListeners.indexOf(cb);
      if (idx >= 0) _wikilinksUpdatedListeners.splice(idx, 1);
    };
  },

  onNavVisibility: (cb: (visible: boolean) => void): Unsubscribe => {
    _navVisibilityListeners.push(cb);
    return () => {
      const idx = _navVisibilityListeners.indexOf(cb);
      if (idx >= 0) _navVisibilityListeners.splice(idx, 1);
    };
  },

  onScopeChanged: (cb: (newPath: string) => void): Unsubscribe => {
    _scopeChangedListeners.push(cb);
    return () => {
      const idx = _scopeChangedListeners.indexOf(cb);
      if (idx >= 0) _scopeChangedListeners.splice(idx, 1);
    };
  },

  // ── Auto-updater ─────────────────────────────────────────────────
  updateGetStatus: async (): Promise<UpdateState> => {
    return cmd("update_get_status");
  },

  updateCheck: async (): Promise<UpdateState> => {
    return cmd("update_check");
  },

  updateDownload: async (): Promise<UpdateState> => {
    return cmd("update_download");
  },

  updateInstall: (): void => {
    cmd("update_install").catch(console.error);
  },

  onUpdateStatus: (cb: (state: UpdateState) => void): Unsubscribe => {
    _updateStatusListeners.push(cb);
    return () => {
      const idx = _updateStatusListeners.indexOf(cb);
      if (idx >= 0) _updateStatusListeners.splice(idx, 1);
    };
  },

  // ── Agent activity ───────────────────────────────────────────────
  onAgentEvent: (cb: (event: AgentEvent) => void): Unsubscribe => {
    _agentEventListeners.push(cb);
    return () => {
      const idx = _agentEventListeners.indexOf(cb);
      if (idx >= 0) _agentEventListeners.splice(idx, 1);
    };
  },

  focusAgentSession: async (sessionId: string): Promise<void> => {
    return cmd("agent_focus_session", { sessionId });
  },

  // ── Git replay ───────────────────────────────────────────────────
  startReplay: async (params: { workspacePath: string }): Promise<boolean> => {
    return cmd("replay_start", { workspacePath: params.workspacePath });
  },

  stopReplay: async (): Promise<void> => {
    return cmd("replay_stop");
  },

  onReplayData: (cb: (msg: ReplayMessage) => void): Unsubscribe => {
    _replayDataListeners.push(cb);
    return () => {
      const idx = _replayDataListeners.indexOf(cb);
      if (idx >= 0) _replayDataListeners.splice(idx, 1);
    };
  },

  // ── Terminal focus ───────────────────────────────────────────────
  onFocusTab: (cb: (ptySessionId: string) => void): Unsubscribe => {
    _focusTabListeners.push(cb);
    return () => {
      const idx = _focusTabListeners.indexOf(cb);
      if (idx >= 0) _focusTabListeners.splice(idx, 1);
    };
  },

  onShellBlur: (cb: () => void): Unsubscribe => {
    _shellBlurListeners.push(cb);
    return () => {
      const idx = _shellBlurListeners.indexOf(cb);
      if (idx >= 0) _shellBlurListeners.splice(idx, 1);
    };
  },

  // ── Canvas pinch forwarding ──────────────────────────────────────
  forwardPinch: (_deltaY: number): void => {
    // Tauri handles pinch natively, no-op for now
  },

  // ── Extra methods used by components ─────────────────────────────
  openExternal: (url: string): void => {
    cmd("shell_open_external", { url }).catch(console.error);
  },

  notifyCwdChanged: (_sessionId: string, _cwd: string): void => {
    // No-op in Tauri for now
  },

  getPathForFile: (_file: File): string => {
    // In Tauri, we use the file name directly since we don't have
    // the collab-file:// protocol
    return _file.name;
  },

  isDirectory: async (path: string): Promise<boolean> => {
    return cmd("is_directory", { path });
  },
};

// Attach to window for compatibility with components that use window.api
if (typeof window !== "undefined") {
  (window as any).api = collabApi;
}

export type CollabApi = typeof collabApi;
