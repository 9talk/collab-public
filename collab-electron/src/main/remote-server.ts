// Host-side remote-control module. When enabled, connects outbound to the
// relay, authenticates with a device token, issues client credentials
// (ed25519), and mirrors local events (PTY data, fs-changed, shell:forward,
// canvas RPC responses) to the verified client. Everything is gated on the
// on/off switch: when disabled, all hooks are null and no data leaves this
// machine. Business data only flows after a two-way signature handshake
// (peerVerified); the relay cannot impersonate either side.

import { WebSocket, type RawData } from "ws";
import { app, screen, shell, dialog, BrowserWindow } from "electron";
import { existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { createMethodTable, type MethodTable } from "./json-rpc-server";
import { encodePtyBinary } from "@collab/relay/src/protocol";
import {
  getPref,
  setPref,
  saveConfig,
  type AppConfig,
  type TerminalTarget,
} from "./config";
import { listTerminalTargets } from "./terminal-target";
import * as pty from "./pty";
import * as files from "./files";
import { readSessionMeta } from "./session-meta";
import {
  loadState as loadCanvasState,
  saveState as saveCanvasState,
} from "./canvas-persistence";
import {
  forwardCanvasRpcRequest,
  setCanvasRpcResponseMirror,
} from "./canvas-rpc";
import {
  setTileFocusSink,
  setTileGeometrySink,
  type TileGeometryPayload,
} from "./ipc-canvas";
import { randomUUID } from "node:crypto";
import { setRemotePtyConsumers } from "./pty";
import {
  forwardToWebview,
  forwardToWebviewOrigin,
  setRemoteEventMirror,
  type RemoteEventOrigin,
} from "./ipc";
import {
  getWsConfig,
  readTreeRecursive,
  initWorkspaceFiles,
  startSingleWorkspaceServices,
  stopSingleWorkspaceServices,
  workspaceForFile,
  updateFrontmatter,
} from "./ipc-workspace";
import { readFolderTable } from "./ipc-filesystem";
import { saveWorkspaceConfig } from "./workspace-config";
import {
  createConfiguredFileFilter,
  resolveIgnoreCase,
  resolveIgnorePatterns,
  type FileFilter,
} from "./file-filter";
import * as wikilinkIndex from "./wikilink-index";
import {
  getImageThumbnail,
  getImageFull,
  resolveImagePath,
  saveDroppedImage,
} from "./image-service";
import {
  detectEditors,
  openFileInEditor,
  openWorkspaceInEditor,
} from "./external-editor";
import { findLatestEditLine } from "./claude-edits-rpc";
import * as services from "./service-manager";
import { COLLAB_DIR } from "./paths";
import {
  loadOrCreateHostKeys,
  saveHostKeys,
  issueCredential,
  fingerprint,
  signChallenge,
  verifyChallenge,
  newNonce,
  CLIENT_AUTH_DOMAIN,
  HOST_AUTH_DOMAIN,
  type HostKeys,
} from "./remote-auth";

export type RemoteHostState = "idle" | "connecting" | "connected" | "error";

export interface RemoteHostStatus {
  role?: "host";
  state: RemoteHostState;
  relayUrl: string;
  enabled: boolean;
  deviceId?: string;
  peerConnected: boolean;
  peer?: { role: "host" | "client"; deviceId: string; displayName?: string };
  /** 当前授权 client 公钥指纹(sha256[0:10])——UI 凭此展示「当前授权」 */
  clientFingerprint?: string;
  lastError?: string;
}

interface HostOptions {
  config: AppConfig;
  relayUrl: string;
  deviceToken: string;
  deviceName?: string;
}

let ws: WebSocket | null = null;
let opts: HostOptions | null = null;
let table: MethodTable | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 1000;
let stopped = false;
let deviceId: string | undefined;
let peerConnected = false;
let peerInfo: RemoteHostStatus["peer"];
let lastError: string | undefined;
// 双向签名验证通过前不转发任何业务数据(握手帧除外)
let peerVerified = false;
// 身份密钥:host 启用时加载/生成,长期不变,重签不换
let hostKeys: HostKeys | null = null;
let authNonce: string | null = null; // 进行中的 client 挑战
let authTimer: ReturnType<typeof setTimeout> | null = null;

const PEER_AUTH_TIMEOUT_MS = 5000;

const statusListeners = new Set<(s: RemoteHostStatus) => void>();

function status(): RemoteHostStatus {
  const enabled = stopped === false && opts !== null;
  return {
    ...(enabled ? { role: "host" as const } : {}),
    state: !enabled
      ? "idle"
      : ws && ws.readyState === WebSocket.OPEN
        ? "connected"
        : "connecting",
    relayUrl: opts?.relayUrl ?? "",
    enabled,
    ...(deviceId ? { deviceId } : {}),
    peerConnected,
    ...(peerInfo ? { peer: peerInfo } : {}),
    ...(hostKeys?.clientPublicKey
      ? { clientFingerprint: fingerprint(hostKeys.clientPublicKey) }
      : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function emitStatus(): void {
  const s = status();
  for (const cb of statusListeners) cb(s);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("remote-status", s);
    }
  }
  // settings 是 shell 窗口内的惰性 webview(独立 webContents),收不到上面的
  // broadcast——经 shell:forward 桥接,仅面板打开(webview 存在)时送达。
  forwardToWebview("settings", "remote-status", s);
  console.log(
    `[remote] host state=${s.state} relay=${s.relayUrl} peer=${s.peerConnected ? (s.peer?.deviceId ?? "?") : "none"} auth=${s.clientFingerprint ?? "none"}`,
  );
}

export function onRemoteHostStatusChanged(
  cb: (s: RemoteHostStatus) => void,
): void {
  statusListeners.add(cb);
}

export function getRemoteHostStatus(): RemoteHostStatus {
  return status();
}

function pushEvent(
  channel: string,
  args: unknown[],
  origin: RemoteEventOrigin = "host",
): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!peerVerified) return; // 握手完成前不泄漏任何业务数据
  ws.send(JSON.stringify({ v: 1, type: "event", channel, args, origin }));
}

/**
 * Host 本地新建终端(tile webview 经 pty:create 创建,带 tileId)→ 广播给
 * 控制端(origin=host):B 端 shell 据此把画布 tile 的 ptySessionId 指向新
 * 会话并重建镜像 webview。画布恢复期 Host 端 fallback 重建会话(旧 session
 * 已随上次退出消亡)全靠这一广播让 B 端镜像追平,否则 B 端持有过期指向,
 * 镜像 tile 永远连不上(或错误走镜像侧自建会话)。
 */
export function broadcastRemotePtyOpened(payload: {
  tileId: string;
  sessionId: string;
  cwd?: string;
  layout?: unknown;
  displayName?: string;
  shell?: string;
}): void {
  pushEvent("remote:pty-opened", [payload], "host");
}

function pushPtyData(sessionId: string, data: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!peerVerified) return; // 握手完成前不泄漏任何业务数据
  ws.send(encodePtyBinary(sessionId, Buffer.from(data, "utf-8")));
}

function registerRemoteMethods(config: AppConfig): MethodTable {
  const t = createMethodTable();
  let fileFilter: FileFilter | null = createConfiguredFileFilter(config.ui);

  function rebuildFilter(): void {
    fileFilter = createConfiguredFileFilter(config.ui);
  }

  // ---- fs ----
  t.register("fs:readdir", (params) => {
    const [path] = params as [string];
    return files.fsReadDir(
      path,
      fileFilter ?? undefined,
      workspaceForFile(path, config.workspaces) ?? undefined,
    );
  });
  t.register("fs:count-files", (params) => {
    const [path] = params as [string];
    return files.countTreeFiles(
      path,
      fileFilter ?? undefined,
      workspaceForFile(path, config.workspaces) ?? undefined,
    );
  });
  t.register("fs:readfile", (params) =>
    files.fsReadFile((params as [string])[0]),
  );
  t.register("fs:writefile", async (params) => {
    const [path, content, expectedMtime] = params as [
      string,
      string,
      string | undefined,
    ];
    const result = await files.fsWriteFile(path, content, expectedMtime);
    if (result.ok) {
      fileFilter?.invalidateBinaryCache([path]);
      pushEvent("shell:forward", [
        "nav",
        "fs-changed",
        [{ dirPath: dirname(path), changes: [{ path, type: 1 }] }],
      ]);
      pushEvent("shell:forward", [
        "viewer",
        "fs-changed",
        [{ dirPath: dirname(path), changes: [{ path, type: 1 }] }],
      ]);
    }
    return result;
  });
  t.register("fs:rename", async (params) => {
    const [oldPath, newTitle] = params as [string, string];
    const sanitized = newTitle
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\.\s*$/, "")
      .trim();
    if (sanitized.length === 0) throw new Error("Title cannot be empty");
    const ext = extname(oldPath);
    const newPath = await files.fsRename(oldPath, `${sanitized}${ext}`);
    fileFilter?.invalidateBinaryCache([oldPath, newPath]);
    const updatedFiles = await wikilinkIndex.handleRename(oldPath, newPath);
    pushEvent("shell:forward", ["viewer", "file-renamed", oldPath, newPath]);
    pushEvent("shell:forward", ["nav", "file-renamed", oldPath, newPath]);
    if (updatedFiles.length > 0) {
      pushEvent("shell:forward", ["viewer", "wikilinks-updated", updatedFiles]);
    }
    return newPath;
  });
  t.register("fs:stat", async (params) => {
    const [path] = params as [string];
    const stats = await stat(path);
    return {
      ctime: stats.birthtime.toISOString(),
      mtime: stats.mtime.toISOString(),
    };
  });
  t.register("fs:is-directory", async (params) => {
    const [path] = params as [string];
    try {
      const s = await stat(path);
      return s.isDirectory();
    } catch {
      return false;
    }
  });
  t.register("fs:trash", async (params) => {
    const [path] = params as [string];
    await shell.trashItem(path);
    fileFilter?.invalidateBinaryCache([path]);
    return true;
  });
  t.register("fs:mkdir", async (params) => {
    const [path] = params as [string];
    await files.fsMkdir(path);
    const event = [{ dirPath: dirname(path), changes: [{ path, type: 1 }] }];
    pushEvent("shell:forward", ["nav", "fs-changed", event]);
    pushEvent("shell:forward", ["viewer", "fs-changed", event]);
    return true;
  });
  t.register("fs:read-folder-table", (params) => {
    const [folderPath] = params as [string];
    return readFolderTable(folderPath, config.workspaces);
  });
  t.register("fs:move", async (params) => {
    const [oldPath, newParentDir] = params as [string, string];
    const newPath = await files.fsMove(oldPath, newParentDir);
    fileFilter?.invalidateBinaryCache([oldPath, newPath]);
    pushEvent("shell:forward", ["viewer", "file-renamed", oldPath, newPath]);
    pushEvent("shell:forward", ["nav", "file-renamed", oldPath, newPath]);
    return newPath;
  });

  // ---- image ----
  t.register("image:thumbnail", (params) => {
    const [path, size] = params as [string, number];
    return getImageThumbnail(path, size);
  });
  t.register("image:full", (params) => getImageFull((params as [string])[0]));
  t.register("image:resolve-path", (params) => {
    const [reference, fromNotePath] = params as [string, string];
    return resolveImagePath(
      reference,
      fromNotePath,
      workspaceForFile(fromNotePath, config.workspaces) ?? "",
    );
  });
  t.register("image:save-dropped", (params) => {
    const [noteDir, fileName, buffer] = params as [string, string, Uint8Array];
    return saveDroppedImage(noteDir, fileName, Buffer.from(buffer));
  });

  // ---- workspace ----
  t.register("workspace:list", () => {
    const aliases: Record<string, string> = {};
    for (const ws of config.workspaces) {
      const cfg = getWsConfig(ws);
      if (cfg.alias) aliases[ws] = cfg.alias;
    }
    return { workspaces: config.workspaces, aliases };
  });
  t.register("workspace:read-tree", (params) => {
    const [{ root }] = params as [{ root: string }];
    return readTreeRecursive(root, root, fileFilter);
  });
  t.register("workspace:add-by-path", async (params) => {
    const [folderPath] = params as [string];
    if (!folderPath || typeof folderPath !== "string") return null;
    const chosen = realpathSync(folderPath);
    if (config.workspaces.includes(chosen)) {
      return { workspaces: config.workspaces };
    }
    const collabDir = join(chosen, ".collaborator");
    const isNew = !existsSync(collabDir);
    if (isNew) initWorkspaceFiles(chosen);
    config.workspaces.push(chosen);
    saveConfig(config);
    const userIgnored = resolveIgnorePatterns(config.ui);
    startSingleWorkspaceServices(
      chosen,
      (f) => {
        fileFilter = f;
      },
      userIgnored,
      { ignorecase: resolveIgnoreCase(config.ui) },
    );
    pushEvent("shell:forward", ["nav", "workspace-added", chosen]);
    return { workspaces: config.workspaces };
  });
  t.register("workspace:remove-by-path", async (params) => {
    const [path] = params as [string];
    const index = config.workspaces.indexOf(path);
    if (index === -1) return { workspaces: config.workspaces };
    config.workspaces.splice(index, 1);
    saveConfig(config);
    stopSingleWorkspaceServices(path);
    pushEvent("shell:forward", ["nav", "workspace-removed", path]);
    return { workspaces: config.workspaces };
  });
  t.register("workspace-pref:get", (params) => {
    const [{ key, workspacePath }] = params as [
      { key: string; workspacePath: string },
    ];
    if (!workspacePath) return null;
    const cfg = getWsConfig(workspacePath);
    if (key === "expanded_dirs") return cfg.expanded_dirs;
    if (key === "agent_skip_permissions") return cfg.agent_skip_permissions;
    if (key === "alias") return cfg.alias ?? null;
    return null;
  });
  t.register("workspace-pref:set", (params) => {
    const [{ key, workspacePath, value }] = params as [
      { key: string; workspacePath: string; value: unknown },
    ];
    if (!workspacePath) return;
    const cfg = getWsConfig(workspacePath);
    if (key === "expanded_dirs") {
      cfg.expanded_dirs = Array.isArray(value) ? value : [];
    } else if (key === "agent_skip_permissions") {
      cfg.agent_skip_permissions = value === true;
    } else if (key === "alias") {
      if (typeof value === "string" && value.length > 0) {
        cfg.alias = value;
      } else {
        delete cfg.alias;
      }
    }
    saveWorkspaceConfig(workspacePath, cfg);
  });
  t.register("workspace:update-frontmatter", (params) => {
    const [filePath, field, value] = params as [string, string, unknown];
    return updateFrontmatter(filePath, field, value);
  });

  // ---- wikilink ----
  t.register("wikilink:resolve", (params) =>
    wikilinkIndex.resolve((params as [string])[0]),
  );
  t.register("wikilink:suggest", (params) =>
    wikilinkIndex.suggest((params as [string])[0]),
  );
  t.register("wikilink:backlinks", (params) =>
    wikilinkIndex.backlinksWithContext((params as [string])[0]),
  );

  // ---- pty ----
  t.register("pty:create", async (params) => {
    const [p] = params as [
      {
        cwd?: string;
        cols?: number;
        rows?: number;
        tileId?: string;
        target?: unknown;
        layout?: { x: number; y: number; width: number; height: number };
      },
    ];
    const result = await pty.createSession(
      p?.cwd,
      undefined,
      p?.cols,
      p?.rows,
      p?.target as TerminalTarget | undefined,
      p?.tileId,
    );
    // 通知 A 端 shell 创建镜像 tile（B 端新建的终端在 A 端同屏显示）。
    // 广播标注 origin=client：B 端据 origin 丢弃自身回声(本地已建 tile)，
    // 不再依赖 tileId 幂等去重；A 端本地分发照常建镜像。
    if (result?.sessionId) {
      forwardToWebviewOrigin("client", "shell", "remote:pty-opened", {
        tileId: p?.tileId,
        sessionId: result.sessionId,
        cwd: result.cwdHostPath ?? p?.cwd,
        layout: p?.layout,
        displayName: result.displayName,
        shell: result.shell,
      });
    }
    return result;
  });
  t.register("pty:write", (params) => {
    const [{ sessionId, data }] = params as [
      { sessionId: string; data: string },
    ];
    pty.writeToSession(sessionId, data);
    return true;
  });
  t.register("pty:send-raw-keys", (params) => {
    const [{ sessionId, data }] = params as [
      { sessionId: string; data: string },
    ];
    pty.sendRawKeys(sessionId, data);
    return true;
  });
  t.register("pty:resize", (params) => {
    const [{ sessionId, cols, rows }] = params as [
      { sessionId: string; cols: number; rows: number },
    ];
    return pty.resizeSession(sessionId, cols, rows);
  });
  t.register("pty:kill", (params) => {
    const [{ sessionId }] = params as [{ sessionId: string }];
    return pty.killSession(sessionId);
  });
  t.register("pty:reconnect", (params) => {
    const [{ sessionId, cols, rows }] = params as [
      { sessionId: string; cols: number; rows: number },
    ];
    return pty.reconnectSession(sessionId, cols, rows, undefined);
  });
  t.register("pty:discover", () => pty.discoverSessions());
  t.register("pty:read-meta", (params) =>
    readSessionMeta((params as [string])[0]),
  );
  t.register("pty:foreground-process", (params) =>
    pty.getForegroundProcess((params as [string])[0]),
  );
  t.register("pty:capture", (params) => {
    const [{ sessionId, lines }] = params as [
      { sessionId: string; lines?: number },
    ];
    return pty.captureSession(sessionId, lines);
  });
  t.register("pty:clear-buffer", (params) => {
    const [{ sessionId }] = params as [{ sessionId: string }];
    return pty.clearBuffer(sessionId);
  });

  // ---- terminal ----
  t.register("terminal:list-targets", () => listTerminalTargets());

  // ---- pref / config ----
  t.register("config:get", () => config);
  t.register("app:version", () => app.getVersion());
  t.register("pref:get", (params) => getPref(config, (params as [string])[0]));
  t.register("pref:set", (params) => {
    const [key, value] = params as [string, unknown];
    setPref(config, key, value);
    if (key === "ignoredFiles" || key === "ignoreCase") rebuildFilter();
    if (
      key === "externalEditorFileTypes" ||
      key === "useExternalEditor" ||
      key === "externalEditor" ||
      key === "ignoredFiles" ||
      key === "ignoreCase"
    ) {
      pushEvent("shell:forward", ["nav", "pref-changed", key, value]);
    }
    return true;
  });

  // ---- canvas ----
  t.register("canvas:load-state", () => loadCanvasState());
  t.register("canvas:save-state", (params) =>
    saveCanvasState((params as [unknown])[0]),
  );
  t.register("canvas:get-state-for-save", () => loadCanvasState());
  t.register("canvas:rpc-request", (params) => {
    const [payload] = params as [
      { requestId: string; method: string; params?: unknown },
    ];
    return forwardCanvasRpcRequest(payload);
  });
  // Client 端拖拽/缩放落定 → Host 应用几何。经 Host shell 的 canvas rpc
  // 走与本地一致的管线（snap/重排/存档；终端 tile 随之 refit 收敛 pty）。
  // 响应经 canvas:rpc-response 镜像回 Client，属无害冗余（Client 无对应 pending）。
  t.register("canvas:update-tile-geometry", async (params) => {
    const [p] = params as [TileGeometryPayload | undefined];
    if (!p || typeof p.tileId !== "string") {
      throw new Error("tileId required");
    }
    console.log(
      `[remote] rpc canvas:update-tile-geometry ${JSON.stringify(p)}`,
    );
    return forwardCanvasRpcRequest({
      requestId: randomUUID(),
      method: "tileSetGeometry",
      params: p,
    });
  });
  // Client 端聚焦(tile 点击/Cmd+方向键)→ Host 镜像跟随。落点 tileFocus
  // 与本地快捷键一致:聚焦 + bringToFront + pan 到可视区。
  t.register("canvas:focus-tile", (params) => {
    const [tileId] = params as [string | undefined];
    if (typeof tileId !== "string") {
      throw new Error("tileId required");
    }
    console.log(`[remote] rpc canvas:focus-tile ${tileId}`);
    return forwardCanvasRpcRequest({
      requestId: randomUUID(),
      method: "tileFocus",
      params: { tileIds: [tileId] },
    });
  });
  // Client Cmd+R 对称委托 → Host 端执行与本地 Cmd+R 一致的
  // refresh+relayout+focus(结果经 geometry/focus/pty 事件镜像回 Client)。
  t.register("canvas:refresh-tile", (params) => {
    const [tileId] = params as [string | undefined];
    if (typeof tileId !== "string") {
      throw new Error("tileId required");
    }
    console.log(`[remote] rpc canvas:refresh-tile ${tileId}`);
    return forwardCanvasRpcRequest({
      requestId: randomUUID(),
      method: "refreshTile",
      params: { tileId },
    });
  });
  // Client 端 relayout 按钮对称委托 → Host 端重排并广播几何。
  t.register("canvas:relayout-tiles", () => {
    console.log("[remote] rpc canvas:relayout-tiles");
    return forwardCanvasRpcRequest({
      requestId: randomUUID(),
      method: "relayoutTiles",
      params: {},
    });
  });

  // ---- misc ----
  t.register("external-editor:list", () => detectEditors());
  t.register("app:commit-sha", () => __GIT_COMMIT_SHA__);

  /**
   * 只读窗口尺寸查询：应答 Host 主窗口 contentSize，供 Client 端等比缩放
   * 适配计算使用（Client 仅据此做本地视图变换，Host 显示不受影响）。
   * 主窗口不可用时回退主屏 workArea。
   */
  t.register("window-info", () => {
    const hostWin = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes("/shell/"),
    );
    if (hostWin) {
      const [width, height] = hostWin.getContentSize();
      if (width > 0 && height > 0) return { width, height };
    }
    const ws = screen.getPrimaryDisplay().workAreaSize;
    return { width: ws.width, height: ws.height };
  });

  t.register("dialog:open-folder", async () => {
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
      null;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });
  t.register("dialog:open-image", async () => {
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
      null;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        {
          name: "Images",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "bmp",
            "tiff",
            "tif",
            "avif",
            "heic",
            "heif",
          ],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });
  t.register("external-editor:open-file", (params) => {
    const [filePath, editorId] = params as [string, string | undefined];
    const resolvedEditorId =
      editorId ||
      ((getPref(config, "externalEditor") as string | undefined) ??
        "intellij-idea");
    const ws = workspaceForFile(filePath, config.workspaces);
    const line = findLatestEditLine(filePath);
    openFileInEditor(
      resolvedEditorId,
      filePath,
      ws ?? undefined,
      line ?? undefined,
    );
    return true;
  });
  t.register("external-editor:open-workspace", (params) => {
    const [workspacePath] = params as [string];
    const editorId =
      (getPref(config, "externalEditor") as string | undefined) ??
      "intellij-idea";
    openWorkspaceInEditor(editorId, workspacePath);
    return true;
  });
  t.register("ping", () => ({ pong: true }));

  // ---- devtool ----
  const requireProjectPath = (params: unknown): string => {
    const projectPath = (params as { projectPath?: unknown } | null)
      ?.projectPath;
    if (typeof projectPath !== "string" || projectPath.trim() === "") {
      throw new Error("projectPath is required");
    }
    return projectPath;
  };
  t.register("devtool_start", (params) =>
    services.startService(requireProjectPath((params as [unknown])[0])),
  );
  t.register("devtool_restart", (params) =>
    services.restartService(requireProjectPath((params as [unknown])[0])),
  );
  t.register("devtool_stop", (params) =>
    services.stopService(requireProjectPath((params as [unknown])[0])),
  );
  t.register("devtool_check", (params) =>
    services.checkService(requireProjectPath((params as [unknown])[0])),
  );
  t.register("devtool_list", () => services.listServices());
  t.register("devtool_logs", (params) => {
    const [p] = params as [{ projectPath: string; lines?: number }];
    return services.readServiceLogs(requireProjectPath(p), p?.lines);
  });

  return t;
}

function attachHooks(): void {
  setRemotePtyConsumers({
    onData: (sessionId, data) => pushPtyData(sessionId, data),
    onExit: (payload) => pushEvent("pty:exit", [payload]),
    onStatusChanged: (payload) => pushEvent("pty:status-changed", [payload]),
    onResized: (payload) => pushEvent("pty:resized", [payload]),
  });
  setRemoteEventMirror((ev) => {
    // settings 面板属于本地 UI（远程 pane 的状态卡），不外推给控制端
    if (ev.target === "settings") return;
    pushEvent("shell:forward", [ev.target, ev.channel, ...ev.args], ev.origin);
  });
  setCanvasRpcResponseMirror((response) => {
    pushEvent("canvas:rpc-response", [response]);
  });
  // Host 端本地 tile 几何提交 → 镜像给 Client（shell 收到后本地应用并 refit）
  setTileGeometrySink((payload) => {
    pushEvent("shell:forward", ["shell", "remote:tile-geometry", payload]);
  });
  // Host 端本地聚焦 → 镜像给 Client（shell 视觉跟随聚焦，不回推）
  setTileFocusSink((tileId) => {
    pushEvent("shell:forward", ["shell", "remote:tile-focused", tileId]);
  });
}

function detachHooks(): void {
  setRemotePtyConsumers(null);
  setRemoteEventMirror(null);
  setCanvasRpcResponseMirror(null);
  setTileGeometrySink(null);
  setTileFocusSink(null);
}

function clearAuthTimer(): void {
  if (authTimer) {
    clearTimeout(authTimer);
    authTimer = null;
  }
}

function sendToPeer(payload: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

/** 拒绝当前 client:发 peer-auth-error 后断开本连接(close handler 调度重连)。 */
function rejectPeerAuth(code: "unauthorized"): void {
  clearAuthTimer();
  peerVerified = false;
  sendToPeer({
    v: 1,
    type: "peer-auth-error",
    code,
    message: "client not authorized",
  });
  peerConnected = false;
  peerInfo = undefined;
  const socket = ws;
  if (socket && socket.readyState === WebSocket.OPEN) {
    // 不断 ws 引用:close handler 负责置空 + 重连
    socket.close();
  }
  emitStatus();
}

/** peer-connected 后由 Host 先挑战:验 client 对随机 nonce 的签名。 */
function beginPeerAuth(): void {
  clearAuthTimer();
  const store = hostKeys ?? loadOrCreateHostKeys(COLLAB_DIR);
  hostKeys = store;
  if (!store.clientPublicKey) {
    console.log("[remote] no authorized client key, rejecting");
    rejectPeerAuth("unauthorized");
    return;
  }
  peerVerified = false;
  authNonce = newNonce();
  console.log("[remote] challenging client");
  sendToPeer({ v: 1, type: "peer-auth-request", nonce: authNonce });
  authTimer = setTimeout(() => {
    authTimer = null;
    console.log("[remote] peer auth timeout");
    rejectPeerAuth("unauthorized");
  }, PEER_AUTH_TIMEOUT_MS);
}

/** 验签通过后回执:对 client 的 nonce 用身份私钥签名,供 client 验 Host。 */
function sendPeerAuthAck(clientNonce: string): void {
  const store = hostKeys ?? loadOrCreateHostKeys(COLLAB_DIR);
  hostKeys = store;
  if (!store.identityPrivateKey) return;
  const signature = signChallenge(
    HOST_AUTH_DOMAIN,
    clientNonce,
    store.identityPrivateKey,
  );
  sendToPeer({ v: 1, type: "peer-auth-ack", nonce: clientNonce, signature });
}

function handleFrame(frame: { type: string; [key: string]: unknown }): void {
  switch (frame.type) {
    case "auth-ok": {
      deviceId = frame.deviceId as string;
      lastError = undefined;
      // 连接成功才算被控端「开启」：持久化，下次启动据此自动连接
      if (opts) setPref(opts.config, "remote.hostEnabled", true);
      emitStatus();
      break;
    }
    case "auth-error": {
      // 认证失败是配置错误（token/地址），重试无意义：回到 idle 展示错误，
      // 由用户修正后再次点连接。若保持 ws 不关，UI 会误显「已连接」。
      lastError = (frame.message as string) ?? "auth failed";
      peerConnected = false;
      peerInfo = undefined;
      peerVerified = false;
      clearAuthTimer();
      // 连接未成功不持久化「开启」，避免下次启动反复自动连接失败
      if (opts) setPref(opts.config, "remote.hostEnabled", false);
      void stopRemoteHost();
      break;
    }
    case "peer-connected": {
      peerConnected = true;
      peerInfo = frame.peer as RemoteHostStatus["peer"];
      console.log(
        `[remote] peer-connected ${peerInfo?.role}:${peerInfo?.deviceId}`,
      );
      emitStatus();
      beginPeerAuth();
      break;
    }
    case "peer-auth-response": {
      const nonce = frame.nonce as string;
      const signature = frame.signature as string;
      const clientNonce = frame.clientNonce as string;
      if (!peerConnected || peerVerified) break;
      const store = hostKeys ?? loadOrCreateHostKeys(COLLAB_DIR);
      hostKeys = store;
      if (
        !authNonce ||
        nonce !== authNonce ||
        !store.clientPublicKey ||
        !verifyChallenge(
          CLIENT_AUTH_DOMAIN,
          nonce,
          store.clientPublicKey,
          signature,
        )
      ) {
        console.log("[remote] client signature invalid");
        rejectPeerAuth("unauthorized");
        break;
      }
      peerVerified = true;
      clearAuthTimer();
      console.log("[remote] client verified");
      sendPeerAuthAck(clientNonce);
      emitStatus();
      break;
    }
    case "peer-auth-error": {
      // 对端(理论不会)或中继路径异常——按未授权断开
      console.log("[remote] peer auth error received");
      rejectPeerAuth("unauthorized");
      break;
    }
    case "peer-disconnected": {
      peerConnected = false;
      peerInfo = undefined;
      peerVerified = false;
      clearAuthTimer();
      console.log(
        `[remote] peer-disconnected reason=${frame.reason as string}`,
      );
      emitStatus();
      break;
    }
    case "rpc": {
      const frame2 = frame as unknown as {
        id: number;
        method: string;
        params?: unknown;
      };
      const { id, method, params } = frame2;
      if (!table || !ws) return;
      if (!peerVerified) return; // 握手未完成前丢弃一切业务调用
      console.log(`[remote] rpc ${method}`);
      void table.call(method, params).then((result) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!peerVerified) return; // 执行期间被踢/重连,不再回执
        if (result.ok) {
          ws.send(
            JSON.stringify({
              v: 1,
              type: "rpc-result",
              id,
              result: result.result,
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              v: 1,
              type: "rpc-error",
              id,
              code: result.code,
              message: result.message,
            }),
          );
        }
      });
      break;
    }
    default:
      break;
  }
}

function connectOnce(): void {
  if (stopped || !opts) return;
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  lastError = undefined;
  emitStatus();

  try {
    ws = new WebSocket(opts.relayUrl);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    emitStatus();
    scheduleRetry();
    return;
  }
  const socket = ws;

  socket.on("open", () => {
    if (!opts || ws !== socket) return; // 已被断开或替换，忽略陈旧连接
    socket.send(
      JSON.stringify({
        v: 1,
        type: "auth",
        role: "host",
        deviceToken: opts.deviceToken,
        deviceName: opts.deviceName,
        appVersion: app.getVersion(),
      }),
    );
  });

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return; // hosts never receive binary frames
    const raw = data.toString();
    let frame: { type: string; [key: string]: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    handleFrame(frame);
  });

  socket.on("error", (err: Error) => {
    if (ws !== socket) return; // 陈旧连接的错误忽略
    lastError = err.message;
    console.log(`[remote] ws error: ${err.message}`);
  });

  socket.on("close", () => {
    if (ws !== socket) return; // 已被新连接替换，忽略旧连接的 close
    ws = null;
    peerConnected = false;
    peerInfo = undefined;
    peerVerified = false;
    clearAuthTimer();
    console.log("[remote] disconnected");
    emitStatus();
    scheduleRetry();
  });
}

function scheduleRetry(): void {
  if (stopped || retryTimer) return;
  retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectOnce();
  }, retryDelayMs);
}

export async function startRemoteHost(o: HostOptions): Promise<void> {
  stopRemoteHost();
  opts = o;
  stopped = false;
  retryDelayMs = 1000;
  // 启用 host 时载入/生成身份密钥(幂等;长期不变)
  hostKeys = loadOrCreateHostKeys(COLLAB_DIR);
  peerConnected = false;
  peerInfo = undefined;
  peerVerified = false;
  clearAuthTimer();
  lastError = undefined;
  table = registerRemoteMethods(o.config);
  attachHooks();
  console.log(`[remote] host starting relay=${o.relayUrl}`);
  emitStatus();
  connectOnce();
}

/**
 * Starts the host side if configured via prefs (remote.hostEnabled +
 * remote.relayUrl + remote.deviceToken) or env vars (REMOTE_RELAY_URL +
 * REMOTE_DEVICE_TOKEN, which also force-enable). Env vars take priority and
 * are the automation/testing entry point.
 */
export function startRemoteHostIfConfigured(config: AppConfig): void {
  const relayUrl =
    process.env.REMOTE_RELAY_URL ??
    (getPref(config, "remote.relayUrl") as string);
  const deviceToken =
    process.env.REMOTE_DEVICE_TOKEN ??
    (getPref(config, "remote.deviceToken") as string);
  const envForced = Boolean(process.env.REMOTE_DEVICE_TOKEN);
  const enabled = envForced || getPref(config, "remote.hostEnabled") === true;
  if (!enabled || !relayUrl || !deviceToken) return;
  void startRemoteHost({
    config,
    relayUrl,
    deviceToken,
    ...((getPref(config, "remote.deviceName") as string | undefined)
      ? {
          deviceName: getPref(config, "remote.deviceName") as string,
        }
      : {}),
  });
}

export async function stopRemoteHost(): Promise<void> {
  stopped = true;
  opts = null;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (ws) {
    const old = ws;
    ws = null;
    try {
      old.close();
    } catch {
      // already closed
    }
  }
  peerConnected = false;
  peerInfo = undefined;
  peerVerified = false;
  clearAuthTimer();
  detachHooks();
  emitStatus();
  console.log("[remote] host stopped");
}

/**
 * 测试中继连通性与设备令牌有效性：建立临时连接并认证后立即断开（用完即回收）。
 * host 已启用且连接同一 relay 时直接判定可用——临时连接会以同 token 注册 host，
 * 把正在运行/重连的 host 顶下线，故此时不做临时连接。
 * 最多尝试 2 次（间隔 1s），避免网络抖动误报，同时不让测试拖太久。
 */
export async function testRemoteHostConnection(
  relayUrl: string,
  deviceToken: string,
): Promise<
  { ok: true; deviceId?: string } | { ok: false; code?: string; error: string }
> {
  if (opts && opts.relayUrl === relayUrl) {
    return { ok: true };
  }
  let last: { ok: false; code?: string; error: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 1000));
    const result = await tryTestOnce(relayUrl, deviceToken);
    if (result.ok) return result;
    last = result;
  }
  return last ?? { ok: false, code: "ETIMEDOUT", error: "timeout" };
}

function tryTestOnce(
  relayUrl: string,
  deviceToken: string,
): Promise<
  { ok: true; deviceId?: string } | { ok: false; code?: string; error: string }
> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { ok: true; deviceId?: string }
        | { ok: false; code?: string; error: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      socket.close();
      finish({ ok: false, code: "ETIMEDOUT", error: "timeout" });
    }, 5000);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          v: 1,
          type: "auth",
          role: "host",
          deviceToken,
          deviceName: "test",
        }),
      );
    });
    socket.on("message", (data: RawData) => {
      try {
        const frame = JSON.parse(data.toString()) as {
          type?: string;
          deviceId?: string;
          message?: string;
        };
        if (frame.type === "auth-ok") {
          clearTimeout(timer);
          socket.close();
          finish({ ok: true, deviceId: frame.deviceId });
        } else if (frame.type === "auth-error") {
          clearTimeout(timer);
          socket.close();
          finish({ ok: false, error: frame.message ?? "auth failed" });
        }
      } catch {
        // ignore malformed frames
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      finish({
        ok: false,
        code: (err as { code?: string }).code,
        error: err.message,
      });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish({ ok: false, code: "ECONNRESET", error: "connection closed" });
    });
  });
}

export interface IssueCredentialResult {
  ok: boolean;
  error?: string;
  content?: string; // 凭证 JSON,由主进程弹保存框落盘
  clientFingerprint?: string;
}

/**
 * 生成新授权凭证并作废旧 client(若在线立即断开,旧凭证下次连接即被拒)。
 * 严格单份:新签发自动覆盖本地授权公钥。
 */
export function issueNewCredential(): IssueCredentialResult {
  if (!opts) return { ok: false, error: "Host is not active" };
  const store = hostKeys ?? loadOrCreateHostKeys(COLLAB_DIR);
  hostKeys = store;
  if (!store.identityPrivateKey) return { ok: false, error: "keys missing" };
  if (!deviceId) {
    return { ok: false, error: "Host not connected yet" };
  }
  // 先踢在线的旧 client(签发语义 = 旧凭证立即作废,host 重连后房间即空)
  if (peerVerified || peerConnected) {
    clearAuthTimer();
    peerVerified = false;
    sendToPeer({
      v: 1,
      type: "peer-auth-error",
      code: "unauthorized",
      message: "credential reissued",
    });
    peerConnected = false;
    peerInfo = undefined;
    const socket = ws;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // 不断 ws 引用:close handler 负责置空 + 重连
      socket.close();
    }
  }
  const content = issueCredential({
    hostKeys: store,
    hostId: deviceId,
    relayUrl: opts.relayUrl,
    hostDisplayName: opts.deviceName,
  });
  saveHostKeys(COLLAB_DIR, store);
  const fp = fingerprint(store.clientPublicKey!);
  console.log(`[remote] credential issued fingerprint=${fp}`);
  emitStatus();
  return { ok: true, content, clientFingerprint: fp };
}
