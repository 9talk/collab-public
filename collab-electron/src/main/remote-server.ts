// Host-side remote-control module. When enabled, connects outbound to the
// relay, authenticates with a device token, exposes a pairing code, and
// mirrors local events (PTY data, fs-changed, shell:forward, canvas RPC
// responses) to the paired client. Everything is gated on the on/off switch:
// when disabled, all hooks are null and no data leaves this machine.

import { WebSocket, type RawData } from "ws";
import { app, shell, dialog, BrowserWindow } from "electron";
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
import { setRemotePtyConsumers } from "./pty";
import { forwardToWebview, setRemoteEventMirror } from "./ipc";
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

export type RemoteHostState = "idle" | "connecting" | "connected" | "error";

export interface RemoteHostStatus {
  role?: "host";
  state: RemoteHostState;
  relayUrl: string;
  enabled: boolean;
  deviceId?: string;
  peerConnected: boolean;
  peer?: { role: "host" | "client"; deviceId: string; displayName?: string };
  pairCode?: string;
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
let pairCode: string | undefined;
let deviceId: string | undefined;
let peerConnected = false;
let peerInfo: RemoteHostStatus["peer"];
let lastError: string | undefined;

const statusListeners = new Set<(s: RemoteHostStatus) => void>();

function status(): RemoteHostStatus {
  const enabled = stopped === false && opts !== null;
  return {
    ...(enabled ? { role: "host" as const } : {}),
    state: ws && ws.readyState === WebSocket.OPEN ? "connected" : "connecting",
    relayUrl: opts?.relayUrl ?? "",
    enabled,
    ...(deviceId ? { deviceId } : {}),
    peerConnected,
    ...(peerInfo ? { peer: peerInfo } : {}),
    ...(pairCode ? { pairCode } : {}),
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
  console.log(
    `[remote] host state=${s.state} relay=${s.relayUrl} peer=${s.peerConnected ? (s.peer?.deviceId ?? "?") : "none"}${s.pairCode ? ` code=${s.pairCode}` : ""}`,
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

function pushEvent(channel: string, args: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ v: 1, type: "event", channel, args }));
}

function pushPtyData(sessionId: string, data: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
    // 经 forwardToWebview 同步镜像到 B 端，B 端按 tileId 幂等忽略。
    if (result?.sessionId) {
      forwardToWebview("shell", "remote:pty-opened", {
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

  // ---- misc ----
  t.register("external-editor:list", () => detectEditors());
  t.register("app:commit-sha", () => __GIT_COMMIT_SHA__);
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
  });
  setRemoteEventMirror((ev) => {
    pushEvent("shell:forward", [ev.target, ev.channel, ...ev.args]);
  });
  setCanvasRpcResponseMirror((response) => {
    pushEvent("canvas:rpc-response", [response]);
  });
}

function detachHooks(): void {
  setRemotePtyConsumers(null);
  setRemoteEventMirror(null);
  setCanvasRpcResponseMirror(null);
}

function handleFrame(frame: { type: string; [key: string]: unknown }): void {
  switch (frame.type) {
    case "auth-ok": {
      deviceId = frame.deviceId as string;
      lastError = undefined;
      emitStatus();
      // Ask for a pairing code right away so the UI always shows a live one.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ v: 1, type: "pair-create" }));
      }
      break;
    }
    case "auth-error": {
      lastError = (frame.message as string) ?? "auth failed";
      peerConnected = false;
      peerInfo = undefined;
      emitStatus();
      break;
    }
    case "pair-created": {
      pairCode = frame.code as string;
      console.log(`[remote] pair-code: ${pairCode}`);
      emitStatus();
      break;
    }
    case "peer-connected": {
      peerConnected = true;
      peerInfo = frame.peer as RemoteHostStatus["peer"];
      console.log(
        `[remote] peer-connected ${peerInfo?.role}:${peerInfo?.deviceId}`,
      );
      emitStatus();
      break;
    }
    case "peer-disconnected": {
      peerConnected = false;
      peerInfo = undefined;
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
      console.log(`[remote] rpc ${method}`);
      void table.call(method, params).then((result) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
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

  ws.on("open", () => {
    if (!opts || !ws) return;
    ws.send(
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

  ws.on("message", (data: RawData, isBinary: boolean) => {
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

  ws.on("error", (err: Error) => {
    lastError = err.message;
    console.log(`[remote] ws error: ${err.message}`);
  });

  ws.on("close", () => {
    ws = null;
    peerConnected = false;
    peerInfo = undefined;
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
  pairCode = undefined;
  peerConnected = false;
  peerInfo = undefined;
  lastError = undefined;
  table = registerRemoteMethods(o.config);
  attachHooks();
  console.log(`[remote] host starting relay=${o.relayUrl}`);
  emitStatus();
  connectOnce();
}

/**
 * Starts the host side if configured via prefs (remote.enabled +
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
  const enabled = envForced || getPref(config, "remote.enabled") === true;
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
  pairCode = undefined;
  peerConnected = false;
  peerInfo = undefined;
  detachHooks();
  emitStatus();
  console.log("[remote] host stopped");
}
