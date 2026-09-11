import type { AppConfig, FolderTableData, TreeNode } from "./types";
import type { ReplayMessage } from "./replay-types";

type Unsubscribe = () => void;

interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  progress?: number;
  version?: string;
  releaseNotes?: string;
  error?: string;
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  linkTarget?: string;
  createdAt: string;
  modifiedAt: string;
  fileCount?: number;
}

interface TemplateEntry {
  name: string;
  relPath: string;
  kind: "folder" | "file";
  isSymlink?: boolean;
  linkTarget?: string;
  broken?: boolean;
}

interface TemplateLinkInfo {
  isLink: boolean;
  linkTarget?: string;
  resolvedTarget?: string;
  template?: string;
  templateRelPath?: string;
}

type TemplateMountStatus =
  | "created"
  | "replaced"
  | "renamed"
  | "already"
  | "cancelled"
  | "error";

interface TemplateMountResult {
  status: TemplateMountStatus;
  path?: string;
  message?: string;
}

interface TemplateDragPayload {
  template: string;
  relPath: string;
  name: string;
  isDir: boolean;
}

interface TemplateMountPoint {
  template: string;
  sourceRel: string;
  workspace: string;
  linkRel: string;
  broken: boolean;
}

type MountHistoryKind = "auto" | "named" | "restore";

interface MountHistoryPoint {
  id: string;
  ts: number;
  kind: MountHistoryKind;
  label?: string;
  op: string;
  mounts: TemplateMountPoint[];
}

interface TemplateHistoryListPayload {
  points: MountHistoryPoint[];
  driftCount: number;
}

type TemplateRestoreSkipReason =
  | "workspace-missing"
  | "source-missing"
  | "real-content";

interface TemplateRestoreDiff {
  missing: TemplateMountPoint[];
  extra: TemplateMountPoint[];
  retarget: Array<{ current: TemplateMountPoint; target: TemplateMountPoint }>;
  skipped: Array<{
    record: TemplateMountPoint;
    reason: TemplateRestoreSkipReason;
  }>;
}

interface TemplateRestoreSummary {
  created: number;
  removed: number;
  retargeted: number;
  failed: Array<{ record: TemplateMountPoint; message: string }>;
  skipped: TemplateRestoreDiff["skipped"];
}

interface FileStats {
  ctime: string;
  mtime: string;
}

interface GraphData {
  nodes: Array<{
    id: string;
    title: string;
    path: string;
    nodeType?: "file" | "code";
    weight?: number;
  }>;
  links: Array<{
    source: string;
    target: string;
    linkType?: "wikilink" | "import";
  }>;
}

interface WikilinkSuggestion {
  stem: string;
  path: string;
  ambiguous: boolean;
}

interface Backlink {
  path: string;
  context: string;
}

interface PtySession {
  sessionId: string;
  shell: string;
  displayName: string;
  target: string;
  command: string;
  args: string[];
  cwdHostPath: string;
  cwdGuestPath?: string;
}

interface TerminalTargetOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

type PtyDataCb = (payload: { sessionId: string; data: Uint8Array }) => void;
type PtyExitCb = (payload: { sessionId: string; exitCode: number }) => void;
type PtyResizedCb = (payload: {
  sessionId: string;
  cols: number;
  rows: number;
}) => void;
type CdToCb = (path: string) => void;
type RunInTerminalCb = (command: string) => void;

interface AgentSessionEvent {
  kind: "session-started";
  sessionId: string;
}

interface AgentFileTouchedEvent {
  kind: "file-touched";
  sessionId: string;
  filePath: string;
  touchType: "read" | "write";
  timestamp: number;
}

interface AgentSessionEndedEvent {
  kind: "session-ended";
  sessionId: string;
}

type AgentEvent =
  | AgentSessionEvent
  | AgentFileTouchedEvent
  | AgentSessionEndedEvent;

export interface CollabApi {
  // Config
  getPlatform: () => NodeJS.Platform;
  getConfig: () => Promise<AppConfig>;
  getDeviceId: () => Promise<string>;
  getPref: (key: string) => Promise<unknown>;
  getPrefSync: (key: string) => unknown;
  setPref: (key: string, value: unknown) => Promise<void>;
  listTerminalTargets: () => Promise<TerminalTargetOption[]>;
  getWorkspacePref: (key: string, workspacePath: string) => Promise<unknown>;
  setWorkspacePref: (
    key: string,
    value: unknown,
    workspacePath: string,
  ) => Promise<void>;

  // Theme
  setTheme: (mode: string) => Promise<void>;

  // File selection
  selectFile: (path: string | null) => void;
  closeViewer: () => void;

  // Folder selection
  selectFolder: (path: string) => void;
  readFolderTable: (folderPath: string) => Promise<FolderTableData>;

  // File system (nav)
  readDir: (path: string) => Promise<DirEntry[]>;
  countFiles: (path: string) => Promise<number>;
  trashFile: (path: string) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  moveFile: (oldPath: string, newParentDir: string) => Promise<string>;

  // Import
  importWebArticle(url: string, targetDir: string): Promise<{ path: string }>;

  // File system (viewer)
  readFile: (path: string) => Promise<string>;
  writeFile: (
    path: string,
    content: string,
    expectedMtime?: string,
  ) => Promise<WriteResult>;
  renameFile: (oldPath: string, newTitle: string) => Promise<string>;
  getFileStats: (path: string) => Promise<FileStats>;

  // Images
  getImageThumbnail: (path: string, size: number) => Promise<string>;
  getImageFull: (path: string) => Promise<{
    url: string;
    width: number;
    height: number;
  }>;
  resolveImagePath: (
    reference: string,
    fromNotePath: string,
  ) => Promise<string | null>;
  saveDroppedImage: (
    noteDir: string,
    fileName: string,
    buffer: ArrayBuffer,
  ) => Promise<string>;
  openImageDialog: () => Promise<string | null>;

  readTree: (params: { root: string }) => Promise<TreeNode[]>;

  // Workspace
  workspaceRemoveByPath: (path: string) => Promise<{ workspaces: string[] }>;
  workspaceAddByPath: (
    folderPath: string,
  ) => Promise<{ workspaces: string[] } | null>;
  getWorkspaceGraph: (params: { workspacePath: string }) => Promise<GraphData>;
  updateFrontmatter: (
    filePath: string,
    field: string,
    value: unknown,
  ) => Promise<{ ok: boolean; retried?: boolean }>;

  // Wikilinks
  resolveWikilink: (target: string) => Promise<string | null>;
  suggestWikilinks: (partial: string) => Promise<WikilinkSuggestion[]>;
  getBacklinks: (filePath: string) => Promise<Backlink[]>;

  // PTY
  ptyCreate: (
    cwd?: string,
    cols?: number,
    rows?: number,
    target?: string,
    tileId?: string,
    layout?: { x: number; y: number; width: number; height: number },
  ) => Promise<PtySession>;
  ptyWrite: (sessionId: string, data: string) => void;
  ptySendRawKeys: (sessionId: string, data: string) => void;
  ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  /**
   * 上报一次真实 fit 落定后的网格与容器像素尺寸,主进程据此校准
   * 终端 cell 度量(px/格),替代新建会话初始 winsize 的硬编码估算常量。
   */
  ptyReportFit: (
    cols: number,
    rows: number,
    widthPx: number,
    heightPx: number,
  ) => void;
  ptyKill: (sessionId: string) => Promise<void>;
  ptyReconnect: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Promise<PtySession & { scrollback: string }>;
  ptyDiscover: () => Promise<
    Array<{
      sessionId: string;
      cols?: number;
      rows?: number;
      meta: {
        shell: string;
        cwd: string;
        createdAt: string;
        displayName?: string;
        target?: string;
        cwdHostPath?: string;
        cwdGuestPath?: string;
      };
    }>
  >;
  ptyReadMeta: (sessionId: string) => Promise<{
    shell: string;
    cwd: string;
    createdAt: string;
    target?: string;
    backend?: "sidecar";
  } | null>;
  notifyPtySessionId: (sessionId: string) => void;
  notifyTerminalStatus: (
    sessionId: string,
    status: string,
    command?: string,
  ) => void;
  onPtyData: (sessionId: string, cb: PtyDataCb) => void;
  offPtyData: (sessionId: string, cb: PtyDataCb) => void;
  onPtyExit: (sessionId: string, cb: PtyExitCb) => void;
  offPtyExit: (sessionId: string, cb: PtyExitCb) => void;
  onPtyResized: (sessionId: string, cb: PtyResizedCb) => void;
  offPtyResized: (sessionId: string, cb: PtyResizedCb) => void;
  onCdTo: (cb: CdToCb) => void;
  offCdTo: (cb: CdToCb) => void;

  // Navigation
  openInTerminal: (path: string) => void;
  locateTerminal: (folderPath: string) => void;
  runInTerminal: (command: string) => void;
  onRunInTerminal: (cb: RunInTerminalCb) => void;
  offRunInTerminal: (cb: RunInTerminalCb) => void;

  // Cross-webview drag-and-drop
  setDragPaths: (paths: string[]) => void;
  clearDragPaths: () => void;
  getDragPaths: () => Promise<string[]>;
  onNavDragActive: (cb: (active: boolean) => void) => Unsubscribe;

  // Settings
  openFolder: () => Promise<string | null>;
  close: () => void;
  openExternal: (url: string) => void;
  openPath: (path: string) => void;

  // External editor
  listExternalEditors: () => Promise<
    Array<{
      id: string;
      name: string;
      appPath: string;
    }>
  >;
  openFileInExternalEditor: (filePath: string, editorId?: string) => void;

  // Templates
  templatesList: () => Promise<string[]>;
  templatesTree: (
    template: string,
    relPath: string,
  ) => Promise<TemplateEntry[]>;
  templatesCreate: (name: string) => Promise<string[]>;
  templatesRename: (name: string, newName: string) => Promise<string[]>;
  templatesDelete: (name: string) => Promise<string[]>;
  templatesCreateNode: (params: {
    template: string;
    relPath: string;
    kind: "file" | "dir";
    name: string;
  }) => Promise<TemplateEntry>;
  templatesRenameNode: (params: {
    template: string;
    relPath: string;
    newName: string;
  }) => Promise<TemplateEntry>;
  templatesDeleteNode: (params: {
    template: string;
    relPath: string;
  }) => Promise<unknown>;
  templatesOpenExternal: (params: {
    template: string;
    relPath?: string;
    isDir?: boolean;
  }) => Promise<unknown>;
  templatesRevealPath: (params: {
    template?: string;
    relPath?: string;
  }) => Promise<unknown>;
  templatesDragStart: (payload: { template: string; relPath: string }) => void;
  templatesDragEnd: () => void;
  templatesDropMount: (params: {
    workspace: string;
    relPath: string;
  }) => Promise<TemplateMountResult>;
  templatesMountTo: (params: {
    source: { template: string; relPath: string };
    target: { workspace: string; relPath: string };
  }) => Promise<TemplateMountResult>;
  templatesWorkspaces: () => Promise<string[]>;
  templatesLinkInfo: (params: {
    workspace: string;
    relPath: string;
  }) => Promise<TemplateLinkInfo>;
  templatesRemoveLink: (params: {
    workspace: string;
    relPath: string;
  }) => Promise<unknown>;
  templatesRevealSource: (params: {
    workspace: string;
    relPath: string;
  }) => Promise<unknown>;
  templatesListMounts: (params: {
    template?: string;
  }) => Promise<TemplateMountPoint[]>;
  templatesRevealInWorkspace: (params: {
    workspace: string;
    relPath: string;
  }) => Promise<unknown>;
  templatesHistoryList: () => Promise<TemplateHistoryListPayload>;
  templatesHistoryCreateBackup: (params: {
    label: string;
  }) => Promise<MountHistoryPoint>;
  templatesHistoryRecordCurrent: (params?: {
    op?: string;
  }) => Promise<MountHistoryPoint>;
  templatesHistoryRename: (params: {
    id: string;
    label: string;
  }) => Promise<MountHistoryPoint>;
  templatesHistoryDelete: (params: { id: string }) => Promise<unknown>;
  templatesHistoryPreviewRestore: (params: {
    id: string;
  }) => Promise<TemplateRestoreDiff>;
  templatesHistoryApplyRestore: (params: {
    id: string;
  }) => Promise<TemplateRestoreSummary>;
  onTemplatesReveal: (
    cb: (payload: { template: string; relPath: string }) => void,
  ) => Unsubscribe;
  templatesCloseView: () => void;
  onTemplatesMountsChanged: (cb: () => void) => Unsubscribe;
  onTemplatesHistoryChanged: (cb: () => void) => Unsubscribe;
  onTemplateDragStart: (
    cb: (payload: TemplateDragPayload) => void,
  ) => Unsubscribe;
  onTemplateDragEnd: (cb: () => void) => Unsubscribe;

  // Context menu
  showContextMenu: (
    items: Array<{
      id: string;
      label: string;
      enabled?: boolean;
    }>,
  ) => Promise<string | null>;

  // IPC event listeners
  onFocusSearch: (cb: () => void) => Unsubscribe;
  onFileSelected: (cb: (path: string | null) => void) => Unsubscribe;
  onFolderSelected: (cb: (path: string) => void) => Unsubscribe;
  onFileRenamed: (
    cb: (oldPath: string, newPath: string) => void,
  ) => Unsubscribe;
  onFilesDeleted: (cb: (paths: string[]) => void) => Unsubscribe;
  onFsChanged: (
    cb: (
      events: Array<{
        dirPath: string;
        changes: Array<{ path: string; type: number }>;
      }>,
    ) => void,
  ) => Unsubscribe;
  onWorkspaceAdded: (cb: (path: string) => void) => Unsubscribe;
  onWorkspaceRemoved: (cb: (path: string) => void) => Unsubscribe;
  onWikilinksUpdated: (cb: (paths: string[]) => void) => Unsubscribe;
  onNavVisibility: (cb: (visible: boolean) => void) => Unsubscribe;
  onPrefChanged: (cb: (key: string, value: unknown) => void) => Unsubscribe;

  onScopeChanged: (cb: (newPath: string) => void) => Unsubscribe;

  // Auto-updater
  updateGetStatus: () => Promise<UpdateState>;
  updateCheck: () => Promise<UpdateState>;
  updateDownload: () => Promise<UpdateState>;
  updateInstall: () => void;
  onUpdateStatus: (cb: (state: UpdateState) => void) => Unsubscribe;

  // macOS permissions
  checkPermissions: () => Promise<Record<string, string>>;
  openPermissionSettings: (kind: string) => Promise<void>;
  closePermissionCheck: () => void;

  // Agent activity
  onAgentEvent: (cb: (event: AgentEvent) => void) => Unsubscribe;
  focusAgentSession: (sessionId: string) => Promise<void>;

  // Git replay
  startReplay: (params: { workspacePath: string }) => Promise<boolean>;
  stopReplay: () => Promise<void>;
  onReplayData: (cb: (msg: ReplayMessage) => void) => Unsubscribe;

  // Terminal focus (receiving end)
  onFocusTab: (cb: (ptySessionId: string) => void) => Unsubscribe;
  onShellBlur: (cb: () => void) => Unsubscribe;
  onTerminalRefresh: (cb: () => void) => Unsubscribe;
  onTerminalClear: (cb: () => void) => Unsubscribe;

  // Canvas pinch forwarding
  forwardPinch: (deltaY: number) => void;

  // Remote control
  getRemoteStatus: () => Promise<RemoteStatus>;
  onRemoteStatus: (cb: (s: RemoteStatus) => void) => Unsubscribe;
  setRemoteHostEnabled: (
    enabled: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  testRemoteHost: (
    relayUrl: string,
    deviceToken: string,
  ) => Promise<{ ok: true; deviceId?: string } | { ok: false; error: string }>;
  connectRemoteClient: (
    relayUrl: string,
    pairCode: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  disconnectRemoteClient: () => Promise<{ ok: boolean }>;
}

export interface RemoteStatus {
  role?: "host" | "client";
  state: string;
  relayUrl: string;
  enabled?: boolean;
  peerConnected?: boolean;
  pairCode?: string;
  hostInfo?: { role: string; deviceId: string; displayName?: string };
  peer?: { role: string; deviceId: string; displayName?: string };
  lastError?: string;
}

declare global {
  interface WriteResult {
    ok: boolean;
    mtime: string;
    conflict?: boolean;
  }

  interface Window {
    api: CollabApi;
  }
}
