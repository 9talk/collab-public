// Client-side remote-control module. Connects outbound to the relay with a
// pairing code, then switches this instance's IPC forwarding layer so every
// forwarded channel reaches the remote host (A). Events pushed by A are
// injected into the local webviews; PTY data is routed per-session to the
// terminal tile that owns it.

import { WebSocket, type RawData } from "ws";
import { app, BrowserWindow, nativeTheme, webContents } from "electron";
import { decodePtyBinary } from "@collab/relay/src/protocol";
import {
  activateRemoteForwarding,
  deactivateRemoteForwarding,
  setRemoteCallHandler,
  type IpcKind,
} from "./ipc-registry";
import { forwardToWebview } from "./ipc";
import { getPref, setPref, type AppConfig } from "./config";

export type RemoteClientState = "idle" | "connecting" | "connected" | "error";

export interface RemoteClientStatus {
  role?: "client";
  state: RemoteClientState;
  relayUrl: string;
  hostInfo?: { role: string; deviceId: string; displayName?: string };
  lastError?: string;
}

interface ClientOptions {
  config: AppConfig;
  relayUrl: string;
  pairCode: string;
}

let ws: WebSocket | null = null;
let opts: ClientOptions | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 1000;
let stopped = false;
let hostInfo: RemoteClientStatus["hostInfo"];
let lastError: string | undefined;

const statusListeners = new Set<(s: RemoteClientStatus) => void>();

/** 进行中的 rpc 请求 id → 回调 */
const rpcPending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let nextRpcId = 1;

/** 会话 → 控制端发起它的 webContents id（终端数据/退出事件按此路由） */
const ownerBySession = new Map<string, number>();

function status(): RemoteClientStatus {
  const active = !stopped && opts !== null;
  return {
    ...(active ? { role: "client" as const } : {}),
    state: !active
      ? "idle"
      : ws && ws.readyState === WebSocket.OPEN
        ? "connected"
        : "connecting",
    relayUrl: opts?.relayUrl ?? "",
    ...(hostInfo ? { hostInfo } : {}),
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
  // settings 是 shell 窗口内的惰性 webview（独立 webContents），收不到上面的
  // broadcast——经 shell:forward 桥接，仅面板打开（webview 存在）时送达。
  forwardToWebview("settings", "remote-status", s);
  console.log(
    `[remote] client state=${s.state} relay=${s.relayUrl} host=${s.hostInfo?.deviceId ?? "none"}`,
  );
}

export function onRemoteStateChanged(
  cb: (s: RemoteClientStatus) => void,
): void {
  statusListeners.add(cb);
}

export function getRemoteClientStatus(): RemoteClientStatus {
  return status();
}

export function isRemoteActive(): boolean {
  return !stopped && opts !== null;
}

function rpcInvoke(channel: string, args: unknown[]): Promise<unknown> {
  if (channel === "canvas:update-tile-geometry") {
    console.log(
      `[remote] client rpc-out ${channel} ${JSON.stringify(args[0])}`,
    );
  }
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("remote connection not open"));
      return;
    }
    const id = nextRpcId++;
    // relay 对无 peer 的 rpc 静默丢弃（host 尚未上线时），超时避免永久挂起
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`rpc timeout: ${channel}`));
    }, 10_000);
    rpcPending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(
      JSON.stringify({ v: 1, type: "rpc", id, method: channel, params: args }),
    );
  });
}

function sendToOwner(
  sessionId: string,
  channel: string,
  ...args: unknown[]
): void {
  const wcId = ownerBySession.get(sessionId);
  if (wcId === undefined) return;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, ...args);
}

function handleRemoteEvent(
  channel: string,
  args: unknown[],
  origin: "host" | "client" = "host",
): void {
  // 自身 rpc 引发的广播回声(origin=client,如经 host 执行的 pty:create 再
  // 广播回来的 remote:pty-opened):本地发起时已就地处理,直接丢弃防回环。
  if (origin === "client") return;
  if (channel === "shell:forward") {
    const [target, evChannel, ...evArgs] = args as [
      string,
      string,
      ...unknown[],
    ];
    forwardToWebview(target, evChannel, ...evArgs);
    return;
  }
  if (channel === "pty:exit") {
    const payload = args[0] as { sessionId: string };
    sendToOwner(payload.sessionId, "pty:exit", payload);
    ownerBySession.delete(payload.sessionId);
    // 广播到 B 端 shell（canvas 据此关闭对应 tile：A 端关闭镜像 tile 的级联）
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("pty:exit", payload);
      }
    }
    return;
  }
  if (channel === "pty:status-changed") {
    const payload = args[0] as { sessionId: string };
    sendToOwner(payload.sessionId, "pty:status-changed", payload);
    return;
  }
  if (channel === "pty:resized") {
    // Host 端权威 resize 落定 → 拥有该会话的镜像终端实时跟随。
    // owner 未 attach(镜像 tile 尚未拉起)时丢弃,镜像端定时对账兜底。
    const payload = args[0] as {
      sessionId: string;
      cols: number;
      rows: number;
    };
    sendToOwner(payload.sessionId, "pty:resized", payload);
    return;
  }
  if (channel === "canvas:rpc-response") {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("canvas:rpc-response", ...args);
      }
    }
    return;
  }
  // 其余白名单事件灌入主窗口
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

function handlePtyBinary(data: RawData): void {
  const decoded = decodePtyBinary(Buffer.from(data as Buffer));
  sendToOwner(decoded.sessionId, "pty:data", {
    sessionId: decoded.sessionId,
    data: decoded.payload.toString("utf-8"),
  });
}

function handleFrame(frame: { type: string; [key: string]: unknown }): void {
  switch (frame.type) {
    case "auth-ok": {
      lastError = undefined;
      // 连接成功 → 存档 relayUrl + 配对码，供下次启动自动连接
      //（配对码有 TTL，失效后 auth-error 会自然回到表单）
      if (opts) {
        try {
          setPref(opts.config, "remote.relayUrl", opts.relayUrl);
          setPref(opts.config, "remote.pairCode", opts.pairCode);
        } catch {
          // 存档失败不阻断连接
        }
      }
      emitStatus();
      onConnected();
      break;
    }
    case "auth-error": {
      // 配对失败（码过期/错误）：回到 idle 由用户重新输入，不能让模块
      // 停留在 active+connecting 死态——否则 isRemoteActive() 恒为 true，
      // 会遮蔽 host 侧的状态上报与操作。
      lastError = (frame.message as string) ?? "auth failed";
      console.log(`[remote] auth error: ${lastError}`);
      if (frame.code === "host-unavailable") {
        // Host 尚未注册（relay 刚重启/host 重连中）是暂态：不清码、不退出，
        // relay 已关闭本 socket → close handler 会自动重试直到 host 上线
        emitStatus();
        return;
      }
      // 存档码已失效，清掉避免下次启动重复自动连接失败
      if (opts) {
        try {
          setPref(opts.config, "remote.pairCode", null);
        } catch {
          // ignore
        }
      }
      void stopRemoteClient("auth-error");
      break;
    }
    case "peer-connected": {
      hostInfo = frame.peer as RemoteClientStatus["hostInfo"];
      console.log(`[remote] host connected: ${hostInfo?.deviceId}`);
      emitStatus();
      break;
    }
    case "peer-disconnected": {
      hostInfo = undefined;
      console.log(
        `[remote] host disconnected reason=${frame.reason as string}`,
      );
      emitStatus();
      break;
    }
    case "rpc-result": {
      const id = frame.id as number;
      const entry = rpcPending.get(id);
      if (entry) {
        rpcPending.delete(id);
        entry.resolve(frame.result);
      }
      break;
    }
    case "rpc-error": {
      const id = frame.id as number;
      const entry = rpcPending.get(id);
      if (entry) {
        rpcPending.delete(id);
        console.log(
          `[remote] rpc-error ${frame.code as string}: ${frame.message as string}`,
        );
        entry.reject(
          new Error((frame.message as string) ?? `rpc failed: ${frame.code}`),
        );
      }
      break;
    }
    case "event": {
      handleRemoteEvent(
        frame.channel as string,
        (frame.args as unknown[] | undefined) ?? [],
        frame.origin as "host" | "client" | undefined,
      );
      break;
    }
    default:
      break;
  }
}

/** 连接建立（或重连）后：切换转发层并做全量同步 */
function onConnected(): void {
  activateRemoteForwarding();
  void resyncMirror();
}

let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 全量同步：画布快照（A 端磁盘状态 → B 端 shell renderer 重放）+ 会话列表。
 * A（host）与 B 同时断线重连时，B 可能先于 A 上线，relay 会静默丢弃
 * 无 peer 的 rpc —— 失败后定时重试，直到 A 上线同步成功。
 * 镜像 shell 加载完成（did-finish-load）后由编排层再次调用，兜底首连时
 * shell 尚未就绪导致的全量状态丢失。
 */
export async function resyncMirror(): Promise<void> {
  if (syncRetryTimer) {
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
  }
  try {
    // Host 视觉主题同步到本机 nativeTheme，镜像 shell/终端随 Host 深浅色
    try {
      const theme = (await rpcInvoke("pref:get", ["theme"])) as unknown;
      if (theme === "light" || theme === "dark" || theme === "system") {
        nativeTheme.themeSource = theme;
      }
    } catch {
      // 主题同步失败不阻断画布同步，重连时会再对齐
    }
    const state = await rpcInvoke("canvas:get-state-for-save", []);
    if (state != null) {
      forwardToWebview("shell", "canvas:remote-state", {
        canvasState: state,
      });
    }
    // 会话列表缓存（B 端 shell 拉起 terminal tile 时会据此 reconnect）
    const sessions = await rpcInvoke("pty:discover", []);
    const sessionCount = Array.isArray(sessions) ? sessions.length : 0;
    // 通知镜像 shell 重读视觉类 pref（canvasOpacity 等），与 Host 严格对齐
    forwardToWebview("shell", "remote:resynced");
    console.log(
      `[remote] sync complete: canvas=${state != null ? "ok" : "empty"} ptySessions=${sessionCount}`,
    );
  } catch (err) {
    console.log("[remote] initial sync failed:", err);
    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = null;
      void resyncMirror();
    }, 5000);
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
        role: "client",
        pairCode: opts.pairCode,
        deviceName: app.getName(),
        appVersion: app.getVersion(),
      }),
    );
  });

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      handlePtyBinary(data);
      return;
    }
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
    hostInfo = undefined;
    deactivateRemoteForwarding();
    for (const entry of rpcPending.values()) {
      entry.reject(new Error("remote connection closed"));
    }
    rpcPending.clear();
    ownerBySession.clear();
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

export async function startRemoteClient(o: ClientOptions): Promise<void> {
  await stopRemoteClient();
  opts = o;
  stopped = false;
  retryDelayMs = 1000;
  hostInfo = undefined;
  lastError = undefined;
  ownerBySession.clear();

  setRemoteCallHandler(async (channel, kind, args, senderId) => {
    if (channel === "pty:create") {
      const result = await rpcInvoke(channel, args);
      const sessionId = (result as { sessionId?: string } | null)?.sessionId;
      if (sessionId) ownerBySession.set(sessionId, senderId);
      return result;
    }
    if (channel === "pty:reconnect") {
      const sessionId = (args[0] as { sessionId: string }).sessionId;
      ownerBySession.set(sessionId, senderId);
      return rpcInvoke(channel, args);
    }
    if (channel === "pty:kill") {
      const sessionId = (args[0] as { sessionId: string }).sessionId;
      ownerBySession.delete(sessionId);
      return rpcInvoke(channel, args);
    }
    if (kind === "handle") return rpcInvoke(channel, args);
    void rpcInvoke(channel, args);
    return undefined;
  });

  console.log(`[remote] client starting relay=${o.relayUrl}`);
  emitStatus();
  connectOnce();
}

/**
 * 启动入口：env REMOTE_PAIR_CODE（+ REMOTE_RELAY_URL）为自动化/测试入口，
 * 优先于 pref 存档。pref 存档来自上次连接成功(auth-ok)时写入的
 * remote.relayUrl + remote.pairCode —— 配对码有 TTL，失效后 auth-error
 * 会清掉存档并回到连接表单。
 */
export function startRemoteClientIfConfigured(config: AppConfig): void {
  const relayUrl =
    process.env.REMOTE_RELAY_URL ??
    (getPref(config, "remote.relayUrl") as string);
  const pairCode =
    process.env.REMOTE_PAIR_CODE ??
    (getPref(config, "remote.pairCode") as string);
  if (!relayUrl || !pairCode) return;
  void startRemoteClient({ config, relayUrl, pairCode });
}

/**
 * 停止连接。reason 语义：
 * - "auth-error"：配对失败自动停，保留 lastError 供 UI 提示码失效
 * - "user"（或默认）：用户主动断开，清除 lastError（回到连接页表单态）
 */
export type RemoteStopReason = "auth-error" | "user";

export async function stopRemoteClient(
  reason?: RemoteStopReason,
): Promise<void> {
  stopped = true;
  opts = null;
  if (reason !== "auth-error") lastError = undefined;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (syncRetryTimer) {
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
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
  for (const entry of rpcPending.values()) {
    entry.reject(new Error("remote stopped"));
  }
  rpcPending.clear();
  ownerBySession.clear();
  hostInfo = undefined;
  deactivateRemoteForwarding();
  setRemoteCallHandler(null);
  emitStatus();
  console.log("[remote] client stopped");
}
