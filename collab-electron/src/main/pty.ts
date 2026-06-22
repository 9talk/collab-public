import * as os from "os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as crypto from "crypto";
import { displayBasename } from "@collab/shared/path-utils";
import {
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
  type SessionMeta,
} from "./session-meta";
import { cleanupEndpoint } from "./ipc-endpoint";
import {
  getTerminalTarget,
  type TerminalTarget,
} from "./config";
import { SidecarClient } from "./sidecar/client";
import {
  SIDECAR_SOCKET_PATH,
  SIDECAR_PID_PATH,
} from "./sidecar/protocol";
import { COLLAB_DIR } from "./paths";
import { resolveTerminalTarget } from "./terminal-target";

let shuttingDown = false;

let sidecarClient: SidecarClient | null = null;

/** Map of sessionId -> data socket for sidecar sessions. */
const dataSockets = new Map<string, net.Socket>();

/**
 * Track which sessions are sidecar-managed.
 */
const sidecarSessionIds = new Set<string>();
const sidecarPowerShellSessionIds = new Set<string>();
const pendingPtyData = new Map<string, Buffer[]>();
const pendingPtyDataTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const WINDOWS_POWERSHELL_PTY_BATCH_MS = 16;

/**
 * Incomplete UTF-8 byte tails from the previous socket chunk.
 * When a chunk ends mid-sequence, the trailing bytes are saved here
 * and prepended to the next chunk to avoid replacement-char corruption.
 */
const trailingUtf8Bytes = new Map<string, Buffer>();

function getSidecarClient(): SidecarClient {
  if (!sidecarClient) throw new Error("Sidecar client not initialized");
  return sidecarClient;
}

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

function getWebContents(): typeof import("electron").webContents | null {
  try {
    return require("electron").webContents;
  } catch {
    return null;
  }
}

function sendToSender(
  senderWebContentsId: number | undefined,
  channel: string,
  payload: unknown,
): void {
  if (senderWebContentsId == null) return;
  const wc = getWebContents();
  if (!wc) return;
  const sender = wc.fromId(senderWebContentsId);
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

function shouldBatchWindowsPowerShellOutput(sessionId: string): boolean {
  return (
    process.platform === "win32"
    && sidecarPowerShellSessionIds.has(sessionId)
  );
}

/**
 * Return the number of trailing bytes in `buf` that form an incomplete
 * UTF-8 sequence.  For example, if the buffer ends with 0xE2 (the start
 * of a 3-byte sequence), this returns 1 so those bytes can be saved and
 * prepended to the next chunk.
 *
 * Strategy: look at the last 1-4 bytes and decode backwards to find
 * whether the tail contains a complete final character or is cut off.
 */
function countTrailingIncompleteUtf8Bytes(buf: Buffer): number {
  if (buf.length === 0) return 0;

  // Read up to 4 bytes from the end.
  const n = Math.min(buf.length, 4);
  const bytes: number[] = [];
  for (let i = 0; i < n; i++) bytes.push(buf[buf.length - n + i]!);

  // Walk backwards to find the lead byte of the final character.
  // Continuation bytes are 10xxxxxx (0x80-0xBF).
  let leadIdx = n - 1;
  while (leadIdx > 0 && (bytes[leadIdx]! & 0xC0) === 0x80) {
    leadIdx--;
  }
  const lead = bytes[leadIdx]!;
  const contCount = n - 1 - leadIdx; // continuation bytes after the lead

  // ASCII byte at the end → complete.
  if ((lead & 0x80) === 0) return 0;

  // Lone continuation byte (no lead byte in range) → all n bytes are orphaned.
  if ((lead & 0xC0) === 0x80) return n;

  // Determine how many continuation bytes this lead expects.
  let expected: number;
  if ((lead & 0xE0) === 0xC0) expected = 1;
  else if ((lead & 0xF0) === 0xE0) expected = 2;
  else if ((lead & 0xF8) === 0xF0) expected = 3;
  else return 0; // invalid lead (11111xxx)

  if (contCount >= expected) return 0; // complete sequence
  // Incomplete: return total bytes from lead through last byte.
  return n - leadIdx;
}

function clearPendingPtyData(sessionId: string): void {
  const timer = pendingPtyDataTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingPtyDataTimers.delete(sessionId);
  }
  pendingPtyData.delete(sessionId);
  trailingUtf8Bytes.delete(sessionId);
}

function flushPendingPtyData(
  sessionId: string,
  senderWebContentsId: number | undefined,
): void {
  pendingPtyDataTimers.delete(sessionId);
  const chunks = pendingPtyData.get(sessionId);
  if (!chunks || chunks.length === 0) return;
  pendingPtyData.delete(sessionId);

  const data = chunks.length === 1
    ? chunks[0]
    : Buffer.concat(chunks);
  sendToSender(senderWebContentsId, "pty:data", {
    sessionId,
    data: data.toString("utf-8"),
  });
  scheduleForegroundCheck(sessionId);
}

function forwardPtyData(
  sessionId: string,
  senderWebContentsId: number | undefined,
  data: Buffer,
): void {
  // Prepend any incomplete UTF-8 bytes leftover from the previous chunk.
  const leftover = trailingUtf8Bytes.get(sessionId);
  const full = leftover
    ? Buffer.concat([leftover, data])
    : data;

  // Detect trailing incomplete UTF-8 bytes and save them for the next chunk.
  // Slice them off BEFORE decoding so Node.js doesn't replace them with .
  const tail = countTrailingIncompleteUtf8Bytes(full);
  if (tail > 0) {
    trailingUtf8Bytes.set(sessionId, full.slice(-tail));
  } else {
    trailingUtf8Bytes.delete(sessionId);
  }

  const safeLen = tail > 0 ? full.length - tail : full.length;
  const text = full.subarray(0, safeLen).toString("utf-8");

  // Diagnostic: detect U+FFFD indicating invalid UTF-8 bytes
  if (text.includes("�")) {
    const idx = text.indexOf("�");
    const ctxStart = Math.max(0, idx - 20);
    const ctx = text.substring(ctxStart, idx + 20);
    const rawStart = Math.max(0, safeLen - 30);
    const rawBytes = Array.from(full.subarray(rawStart, Math.min(full.length, safeLen + 10)))
      .map(b => b.toString(16).padStart(2, "0")).join(" ");
    console.error(
      "[pty:utf8] session=" + sessionId + " U+FFFD at char " + idx +
      " ctx=\"" + ctx + "\" rawBytes=" + rawBytes,
    );
  }

  if (!shouldBatchWindowsPowerShellOutput(sessionId)) {
    sendToSender(senderWebContentsId, "pty:data", {
      sessionId,
      data: text,
    });
    scheduleForegroundCheck(sessionId);
    return;
  }

  const queued = pendingPtyData.get(sessionId) ?? [];
  queued.push(Buffer.from(text, "utf-8"));
  pendingPtyData.set(sessionId, queued);
  if (!pendingPtyDataTimers.has(sessionId)) {
    pendingPtyDataTimers.set(
      sessionId,
      setTimeout(
        () => flushPendingPtyData(sessionId, senderWebContentsId),
        WINDOWS_POWERSHELL_PTY_BATCH_MS,
      ),
    );
  }
}

function utf8Env(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (!env.LANG || !env.LANG.includes("UTF-8")) {
    env.LANG = "en_US.UTF-8";
  }
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "3";
  env.TERM_PROGRAM = "iTerm.app";
  env.TERM_PROGRAM_VERSION = "3.6.6";
  return env;
}

function withOptionalFields<T extends object>(
  base: T,
  fields: Record<string, unknown>,
): T {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      Object.assign(base, { [key]: value });
    }
  }
  return base;
}

let sidecarStarting: Promise<void> | null = null;

export async function ensureSidecar(): Promise<void> {
  if (sidecarClient) {
    try {
      await sidecarClient.ping();
      return;
    } catch {
      sidecarClient.disconnect();
      sidecarClient = null;
    }
  }

  if (sidecarStarting) return sidecarStarting;
  sidecarStarting = doEnsureSidecar().finally(() => {
    sidecarStarting = null;
  });
  return sidecarStarting;
}

async function doEnsureSidecar(): Promise<void> {
  let needsSpawn = false;
  try {
    fs.readFileSync(SIDECAR_PID_PATH, "utf-8");
    const client = new SidecarClient(SIDECAR_SOCKET_PATH);
    await client.connect();
    await client.ping();
    sidecarClient = client;
  } catch {
    needsSpawn = true;
  }

  if (needsSpawn) {
    await spawnSidecar();
  }

  if (sidecarClient) {
    sidecarClient.onNotification((method, params) => {
      if (method === "session.exited") {
        const { sessionId, exitCode } = params as {
          sessionId: string;
          exitCode: number;
        };
        clearPendingPtyData(sessionId);
        dataSockets.get(sessionId)?.destroy();
        dataSockets.delete(sessionId);
        sidecarPowerShellSessionIds.delete(sessionId);
        deleteSessionMeta(sessionId);
        sendToMainWindow("pty:exit", { sessionId, exitCode });
      }
    });
  }
}

function fixSpawnHelperPerms(): void {
  if (process.platform === "win32") return;
  try {
    const ptyDir = path.dirname(require.resolve("node-pty"));
    const helper = path.join(ptyDir, "..", "build", "Release", "spawn-helper");
    const stat = fs.statSync(helper);
    if (!(stat.mode & 0o111)) {
      fs.chmodSync(helper, 0o755);
    }
  } catch {
    // Best effort — packaged builds bundle the binary with correct perms.
  }
}

async function spawnSidecar(): Promise<void> {
  fixSpawnHelperPerms();
  cleanupEndpoint(SIDECAR_SOCKET_PATH);
  try { fs.unlinkSync(SIDECAR_PID_PATH); } catch {}

  const token = crypto.randomBytes(16).toString("hex");

  let app: typeof import("electron").app | undefined;
  try { app = require("electron").app; } catch {}
  if (!app) throw new Error("Cannot spawn sidecar outside Electron");

  const sidecarPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "app.asar",
        "out",
        "main",
        "pty-sidecar.js",
      )
    : path.join(__dirname, "pty-sidecar.js");

  const child = require("node:child_process").spawn(
    process.execPath,
    [sidecarPath, "--token", token],
    {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[sidecar] ${chunk.toString().trimEnd()}`);
  });
  child.on("exit", (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(`Sidecar exited with code ${code}`);
    }
  });
  child.unref();

  const maxWait = 5000;
  const interval = 100;
  let waited = 0;
  while (waited < maxWait) {
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
    try {
      const client = new SidecarClient(SIDECAR_SOCKET_PATH);
      await client.connect();
      const ping = await client.ping();
      if (ping.token === token) {
        sidecarClient = client;
        return;
      }
      client.disconnect();
    } catch {
      // Not ready yet
    }
  }
  throw new Error("Sidecar failed to start within timeout");
}

const ZSH_INTEGRATION_DIR = path.join(COLLAB_DIR, "shell-integration", "zsh");

function ensureZshIntegrationDir(): string | null {
  try {
    fs.mkdirSync(ZSH_INTEGRATION_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zshenv"),
      '[ -f "${_COLLAB_ZDOTDIR:-$HOME}/.zshenv" ] && '
        + '. "${_COLLAB_ZDOTDIR:-$HOME}/.zshenv"\n',
    );

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zprofile"),
      '[ -f "${_COLLAB_ZDOTDIR:-$HOME}/.zprofile" ] && '
        + '. "${_COLLAB_ZDOTDIR:-$HOME}/.zprofile"\n',
    );

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zshrc"),
      [
        '_collab_zd="${_COLLAB_ZDOTDIR:-$HOME}"',
        'ZDOTDIR="$_collab_zd"',
        "unset _COLLAB_ZDOTDIR",
        '[ -f "$_collab_zd/.zshrc" ] && . "$_collab_zd/.zshrc"',
        "unset _collab_zd",
        '__collab_osc7() { printf "\\e]7;file://%s%s\\a" "$HOST" "$PWD" }',
        "precmd_functions+=(__collab_osc7)",
        "",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zlogin"),
      '[ -f "${ZDOTDIR:-$HOME}/.zlogin" ] && '
        + '. "${ZDOTDIR:-$HOME}/.zlogin"\n',
    );

    return ZSH_INTEGRATION_DIR;
  } catch {
    return null;
  }
}

function osc7ShellHook(shell: string): string | null {
  const base = path.basename(shell);
  if (base === "zsh") {
    return [
      " __collab_osc7()",
      '{ printf "\\e]7;file://%s%s\\a" "$HOST" "$PWD"; };',
      "precmd_functions+=(__collab_osc7);",
      "clear",
    ].join(" ");
  }
  if (base === "bash" || base === "sh") {
    return [
      ' PROMPT_COMMAND=\'printf "\\e]7;file://%s%s\\a"',
      '"$HOSTNAME" "$PWD"\'${PROMPT_COMMAND:+";$PROMPT_COMMAND"};',
      "clear",
    ].join(" ");
  }
  // fish emits OSC 7 by default — no hook needed
  return null;
}

function injectOsc7Hook(
  sessionId: string,
  shell: string,
): void {
  const hook = osc7ShellHook(shell);
  if (!hook) return;
  // Delay to let the shell start and show its first prompt
  setTimeout(() => {
    writeToSession(sessionId, hook + "\n");
  }, 300);
}

export async function createSession(
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
  preferredTarget?: TerminalTarget,
  tileId?: string,
): Promise<{
  sessionId: string;
  shell: string;
  displayName: string;
  target: string;
  command: string;
  args: string[];
  cwdHostPath: string;
  cwdGuestPath?: string;
}> {
  const resolvedCwd = cwd || os.homedir();
  const c = cols || 80;
  const r = rows || 24;

  const resolvedTarget = resolveTerminalTarget(
    preferredTarget ?? getTerminalTarget(),
    resolvedCwd,
  );

  await ensureSidecar();
  const client = getSidecarClient();
  const sidecarEnv = utf8Env();
  if (tileId) sidecarEnv.COLLAB_TILE_ID = tileId;

  let zshIntegrated = false;
  if (path.basename(resolvedTarget.command) === "zsh") {
    const dir = ensureZshIntegrationDir();
    if (dir) {
      sidecarEnv._COLLAB_ZDOTDIR = process.env.ZDOTDIR
        || process.env.HOME || os.homedir();
      sidecarEnv.ZDOTDIR = dir;
      zshIntegrated = true;
    }
  }

  const createParams = withOptionalFields({
    command: resolvedTarget.command,
    args: resolvedTarget.args,
    shell: resolvedTarget.command,
    displayName: resolvedTarget.displayName,
    target: resolvedTarget.target,
    cwd: resolvedTarget.cwd,
    cwdHostPath: resolvedTarget.cwdHostPath,
    cols: c,
    rows: r,
    env: sidecarEnv,
  }, {
    cwdGuestPath: resolvedTarget.cwdGuestPath,
  });
  const { sessionId, socketPath } = await client.createSession(createParams);

  const dataSock = await client.attachDataSocket(
    socketPath,
    (data) => {
      forwardPtyData(sessionId, senderWebContentsId, data);
    },
  );
  dataSockets.set(sessionId, dataSock);

  writeSessionMeta(
    sessionId,
    withOptionalFields({
      shell: resolvedTarget.command,
      cwd: resolvedTarget.cwdHostPath,
      createdAt: new Date().toISOString(),
      target: resolvedTarget.target,
      displayName: resolvedTarget.displayName,
      command: resolvedTarget.command,
      args: resolvedTarget.args,
      cwdHostPath: resolvedTarget.cwdHostPath,
      backend: "sidecar",
    }, {
      cwdGuestPath: resolvedTarget.cwdGuestPath,
    }) as SessionMeta,
  );

  sidecarSessionIds.add(sessionId);
  if (resolvedTarget.target === "powershell") {
    sidecarPowerShellSessionIds.add(sessionId);
  }

  if (!zshIntegrated) {
    injectOsc7Hook(sessionId, resolvedTarget.command);
  }

  return withOptionalFields({
    sessionId,
    shell: resolvedTarget.command,
    displayName: resolvedTarget.displayName,
    target: resolvedTarget.target,
    command: resolvedTarget.command,
    args: resolvedTarget.args,
    cwdHostPath: resolvedTarget.cwdHostPath,
  }, {
    cwdGuestPath: resolvedTarget.cwdGuestPath,
  });
}

export async function reconnectSession(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): Promise<{
  sessionId: string;
  shell: string;
  displayName: string;
  target?: string;
  command?: string;
  args?: string[];
  cwdHostPath?: string;
  cwdGuestPath?: string;
  meta: SessionMeta | null;
  scrollback: string;
}> {
  await ensureSidecar();
  const client = getSidecarClient();
  const meta = readSessionMeta(sessionId);
  const { socketPath } = await client.reconnectSession(
    sessionId, cols, rows,
  );

  const dataSock = await client.attachDataSocket(
    socketPath,
    (data) => {
      forwardPtyData(sessionId, senderWebContentsId, data);
    },
  );

  dataSockets.get(sessionId)?.destroy();
  dataSockets.set(sessionId, dataSock);

  const shell = meta?.command || meta?.shell || process.env.SHELL || "/bin/zsh";
  const displayName = meta?.displayName || displayBasename(shell) || "shell";
  sidecarSessionIds.add(sessionId);
  if (meta?.target === "powershell") {
    sidecarPowerShellSessionIds.add(sessionId);
  }

  return withOptionalFields({
    sessionId,
    shell,
    displayName,
    meta,
    scrollback: "",
  }, {
    target: meta?.target,
    command: meta?.command,
    args: meta?.args,
    cwdHostPath: meta?.cwdHostPath ?? meta?.cwd,
    cwdGuestPath: meta?.cwdGuestPath,
  });
}

export function writeToSession(
  sessionId: string,
  data: string,
): void {
  const dataSock = dataSockets.get(sessionId);
  if (dataSock && !dataSock.destroyed) {
    dataSock.write(data);
  }
}

export function sendRawKeys(
  sessionId: string,
  data: string,
): void {
  writeToSession(sessionId, data);
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  try {
    await ensureSidecar();
    const client = getSidecarClient();
    await client.resizeSession(sessionId, cols, rows);
  } catch {
    // Restored renderer tabs can emit an initial resize before the
    // sidecar client is connected, or after the session is already gone.
    // Treat that startup race as non-fatal.
  }
}

export async function killSession(
  sessionId: string,
): Promise<void> {
  clearForegroundCache(sessionId);
  dataSockets.get(sessionId)?.destroy();
  dataSockets.delete(sessionId);
  try {
    const client = getSidecarClient();
    await client.killSession(sessionId);
  } catch {
    // Session may already be dead
  }
  sidecarSessionIds.delete(sessionId);
  sidecarPowerShellSessionIds.delete(sessionId);
  clearPendingPtyData(sessionId);
  deleteSessionMeta(sessionId);
}

export function listSessions(): string[] {
  return [...sidecarSessionIds];
}

export function killAll(): void {
  shuttingDown = true;
  for (const [, sock] of dataSockets) {
    sock.destroy();
  }
  dataSockets.clear();
  sidecarSessionIds.clear();
  sidecarPowerShellSessionIds.clear();
  for (const sessionId of pendingPtyDataTimers.keys()) {
    clearPendingPtyData(sessionId);
  }
}

const KILL_ALL_TIMEOUT_MS = 2000;

export function killAllAndWait(): Promise<void> {
  shuttingDown = true;
  if (sidecarSessionIds.size === 0) return Promise.resolve();

  const pending: Promise<void>[] = [];
  for (const sessionId of sidecarSessionIds) {
    pending.push(
      new Promise<void>((resolve) => {
        // Sidecar will emit session.exited; resolve after a short timeout
        setTimeout(resolve, 1000);
      }),
    );
  }

  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, KILL_ALL_TIMEOUT_MS),
  );

  for (const sessionId of [...sidecarSessionIds]) {
    killSession(sessionId);
  }

  return Promise.race([
    Promise.all(pending).then(() => {}),
    timeout,
  ]);
}

export function destroyAll(): void {
  killAll();
}

export async function shutdownSidecarIfIdle(): Promise<void> {
  if (!sidecarClient) return;
  try {
    const sessions = await sidecarClient.listSessions();
    if (sessions.length === 0) {
      await sidecarClient.shutdownSidecar();
    }
  } catch {
    // Sidecar already gone or unreachable — nothing to do.
  }
  sidecarClient = null;
}

export interface DiscoveredSession {
  sessionId: string;
  meta: SessionMeta;
}

export async function discoverSessions(): Promise<DiscoveredSession[]> {
  const result: DiscoveredSession[] = [];

  try {
    await ensureSidecar();
    const client = getSidecarClient();
    const list = await client.listSessions();
    result.push(...list.map((s) => ({
      sessionId: s.sessionId,
      meta: withOptionalFields({
        shell: s.shell,
        cwd: s.cwdHostPath,
        createdAt: s.createdAt,
        backend: "sidecar",
        target: s.target,
        displayName: s.displayName,
        command: s.shell,
        cwdHostPath: s.cwdHostPath,
      }, {
        cwdGuestPath: s.cwdGuestPath,
      }) as SessionMeta,
    })));
  } catch {
    // Sidecar not running
  }

  // Clean up orphaned meta files
  let metaFiles: string[];
  try {
    metaFiles = fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"));
  } catch {
    metaFiles = [];
  }

  const sessionIds = new Set(result.map((s) => s.sessionId));
  for (const file of metaFiles) {
    const sessionId = file.replace(".json", "");
    const meta = readSessionMeta(sessionId);
    if (meta?.backend === "sidecar") continue;
    if (!sessionIds.has(sessionId)) {
      deleteSessionMeta(sessionId);
    }
  }

  return result;
}

export async function captureSession(
  sessionId: string,
  lines = 50,
): Promise<string> {
  const client = getSidecarClient();
  return await client.captureSession(sessionId, lines);
}

export async function getForegroundProcess(
  sessionId: string,
): Promise<string | null> {
  try {
    const client = getSidecarClient();
    return await client.getForeground(sessionId);
  } catch {
    return null;
  }
}

const lastForeground = new Map<string, string>();
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
const STATUS_DEBOUNCE_MS = 500;

function shouldSkipForegroundCheck(sessionId: string): boolean {
  return process.platform === "win32";
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const { BrowserWindow } = require("electron");
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function scheduleForegroundCheck(sessionId: string): void {
  if (shouldSkipForegroundCheck(sessionId)) {
    clearForegroundCache(sessionId);
    return;
  }

  const existing = statusTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  statusTimers.set(
    sessionId,
    setTimeout(() => {
      statusTimers.delete(sessionId);
      getForegroundProcess(sessionId).then((fg) => {
        if (fg == null) return;

        const prev = lastForeground.get(sessionId);
        if (fg === prev) return;

        lastForeground.set(sessionId, fg);
        sendToMainWindow("pty:status-changed", {
          sessionId,
          foreground: fg,
        });
      });
    }, STATUS_DEBOUNCE_MS),
  );
}

export function clearForegroundCache(sessionId: string): void {
  lastForeground.delete(sessionId);
  const timer = statusTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    statusTimers.delete(sessionId);
  }
}
