import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { getPref, setPref, type AppConfig } from "./config";

type AgentSession = {
  sessionId: string;
  connection: ClientSideConnection;
  process: ChildProcess;
};

const PREF_SESSION_ID = "agent-acp-session-id";
const PREF_SESSION_CWD = "agent-acp-session-cwd";

const sessions = new Map<string, AgentSession>();
let shellWindow: BrowserWindow | null = null;
let appConfig: AppConfig | null = null;

function getMessageCachePath(): string {
  return resolve(app.getPath("home"), ".collaborator", "agent-messages.json");
}

async function loadCachedMessages(): Promise<unknown[]> {
  try {
    const raw = await readFile(getMessageCachePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveCachedMessages(messages: unknown[]): Promise<void> {
  const path = getMessageCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(messages));
}

async function clearCachedMessages(): Promise<void> {
  try {
    await writeFile(getMessageCachePath(), "[]");
  } catch {
    // ignore
  }
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(channel, ...args);
  }
}

function createClient(): Client {
  return {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      sendToRenderer("agent:update", params);
    },

    async requestPermission(
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      const allow = params.options.find((o) => o.kind === "allow_once");
      return {
        outcome: {
          outcome: "selected",
          optionId: allow?.optionId ?? params.options[0].optionId,
        },
      };
    },

    async readTextFile(
      params: ReadTextFileRequest,
    ): Promise<ReadTextFileResponse> {
      const content = await readFile(params.path, "utf-8");
      return { content };
    },

    async writeTextFile(
      params: WriteTextFileRequest,
    ): Promise<WriteTextFileResponse> {
      await writeFile(params.path, params.content, "utf-8");
      return {};
    },
  };
}

function findAgentCommand(): {
  command: string;
  args: string[];
  extraEnv: Record<string, string>;
} {
  if (app.isPackaged) {
    // In production the .bin symlink is stripped by electron-builder,
    // but the package itself lives inside app.asar. Run Electron in
    // node mode against the package's entry script — Electron's asar
    // patch lets the child read it directly.
    const script = resolve(
      app.getAppPath(),
      "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    );
    return {
      command: process.execPath,
      args: [script],
      extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return {
    command: resolve(app.getAppPath(), "node_modules/.bin/claude-agent-acp"),
    args: [],
    extraEnv: {},
  };
}

function saveSessionPref(sessionId: string, cwd: string): void {
  if (!appConfig) return;
  setPref(appConfig, PREF_SESSION_ID, sessionId);
  setPref(appConfig, PREF_SESSION_CWD, cwd);
}

function clearSessionPref(): void {
  if (!appConfig) return;
  setPref(appConfig, PREF_SESSION_ID, null);
  setPref(appConfig, PREF_SESSION_CWD, null);
}

async function spawnAndInitialize(cwd: string): Promise<{
  connection: ClientSideConnection;
  proc: ChildProcess;
}> {
  const t0 = performance.now();
  const { command, args, extraEnv } = findAgentCommand();
  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      ACP_PERMISSION_MODE: "acceptEdits",
    },
  });
  console.log(`[acp-timing] spawn: ${(performance.now() - t0).toFixed(0)}ms`);

  const input = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const connection = new ClientSideConnection(() => createClient(), stream);

  const t1 = performance.now();
  await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    clientInfo: {
      name: "collaborator",
      title: "Collaborator",
      version: "1.0.0",
    },
  });
  console.log(
    `[acp-timing] initialize: ${(performance.now() - t1).toFixed(0)}ms`,
  );

  return { connection, proc };
}

function registerSession(
  sessionId: string,
  connection: ClientSideConnection,
  proc: ChildProcess,
  cwd: string,
): void {
  sessions.set(sessionId, {
    sessionId,
    connection,
    process: proc,
  });

  saveSessionPref(sessionId, cwd);

  proc.on("exit", () => {
    sessions.delete(sessionId);
    sendToRenderer("agent:exit", { sessionId });
  });
}

export async function spawnAgent(cwd: string): Promise<{
  sessionId: string;
  resumed: boolean;
  cachedMessages: unknown[];
}> {
  const savedId = appConfig
    ? (getPref(appConfig, PREF_SESSION_ID) as string)
    : null;
  const savedCwd = appConfig
    ? (getPref(appConfig, PREF_SESSION_CWD) as string)
    : null;

  const tStart = performance.now();

  // Load cached messages in parallel with spawning
  const [{ connection, proc }, cachedMessages] = await Promise.all([
    spawnAndInitialize(cwd),
    savedId ? loadCachedMessages() : [],
  ]);

  if (savedId) {
    registerSession(savedId, connection, proc, cwd);

    // Resume in background — don't block the UI
    const tResume = performance.now();
    (connection as any)
      .unstable_resumeSession({
        sessionId: savedId,
        cwd: savedCwd ?? cwd,
      })
      .then(() => {
        console.log(
          `[acp-timing] resumeSession: ${(performance.now() - tResume).toFixed(0)}ms`,
        );
        sendToRenderer("agent:session-ready", {
          sessionId: savedId,
        });
      })
      .catch(() => {
        clearSessionPref();
        clearCachedMessages();
        sendToRenderer("agent:session-failed", {
          sessionId: savedId,
        });
      });

    console.log(
      `[acp-timing] total (non-blocking): ${(performance.now() - tStart).toFixed(0)}ms`,
    );
    return {
      sessionId: savedId,
      resumed: true,
      cachedMessages,
    };
  }

  const tNew = performance.now();
  const session = await connection.newSession({
    cwd,
    mcpServers: [],
  });
  console.log(
    `[acp-timing] newSession: ${(performance.now() - tNew).toFixed(0)}ms`,
  );
  console.log(
    `[acp-timing] total: ${(performance.now() - tStart).toFixed(0)}ms`,
  );
  const sessionId = session.sessionId;
  registerSession(sessionId, connection, proc, cwd);
  return { sessionId, resumed: false, cachedMessages: [] };
}

export async function promptAgent(
  sessionId: string,
  text: string,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`No agent session: ${sessionId}`);
  }

  try {
    const result = await session.connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
    sendToRenderer("agent:prompt-complete", {
      sessionId,
      stopReason: result.stopReason,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    sendToRenderer("agent:prompt-error", {
      sessionId,
      error: msg,
    });
  }
}

export async function cancelAgent(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  await session.connection.cancel({ sessionId });
}

export function killAgent(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.process.kill();
  sessions.delete(sessionId);
}

export function killAllAgents(): void {
  for (const session of sessions.values()) {
    session.process.kill();
  }
  sessions.clear();
}

export function registerAgentIpc(win: BrowserWindow, cfg: AppConfig): void {
  shellWindow = win;
  appConfig = cfg;

  ipcMain.handle(
    "agent:spawn",
    async (_event: unknown, { cwd }: { cwd: string }) => {
      return await spawnAgent(cwd);
    },
  );

  ipcMain.handle(
    "agent:prompt",
    async (
      _event: unknown,
      {
        sessionId,
        text,
      }: {
        sessionId: string;
        text: string;
      },
    ) => {
      promptAgent(sessionId, text);
      return {};
    },
  );

  ipcMain.handle(
    "agent:cancel",
    async (_event: unknown, { sessionId }: { sessionId: string }) => {
      await cancelAgent(sessionId);
      return {};
    },
  );

  ipcMain.handle(
    "agent:kill",
    async (_event: unknown, { sessionId }: { sessionId: string }) => {
      killAgent(sessionId);
      return {};
    },
  );

  ipcMain.handle(
    "agent:save-messages",
    async (_event: unknown, { messages }: { messages: unknown[] }) => {
      await saveCachedMessages(messages);
      return {};
    },
  );

  win.on("closed", () => {
    killAllAgents();
    shellWindow = null;
  });
}
