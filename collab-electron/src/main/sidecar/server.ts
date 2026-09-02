// src/main/sidecar/server.ts
import * as net from "node:net";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as pty from "node-pty";
import type { IDisposable } from "node-pty";
import { displayCommandName } from "@collab/shared/path-utils";
import { buildRebuildQueryRe } from "@collab/shared/terminal-queries";
import { cleanupEndpoint, prepareEndpoint } from "../ipc-endpoint";
import { RingBuffer } from "./ring-buffer";
import {
  makeResponse,
  makeError,
  makeNotification,
  DEFAULT_RING_BUFFER_BYTES,
  sessionSocketPath as buildSessionSocketPath,
  type JsonRpcRequest,
  type SessionCreateParams,
  type SessionCreateResult,
  type SessionReconnectParams,
  type SessionReconnectResult,
  type SessionInfo,
  type PingResult,
  type PidFileData,
} from "./protocol";

interface ServerOptions {
  controlSocketPath: string;
  sessionSocketDir: string;
  pidFilePath: string;
  token: string;
  ringBufferBytes?: number;
}

interface Session {
  id: string;
  pty: pty.IPty;
  terminateProcess: () => void;
  shell: string;
  displayName: string;
  target: string;
  cwd: string;
  cwdHostPath: string;
  cwdGuestPath?: string;
  createdAt: string;
  ringBuffer: RingBuffer;
  dataServer: net.Server;
  dataClient: net.Socket | null;
  socketPath: string;
  hasAttachedClient: boolean;
  /** When non-null, PTY output is queued here instead of sent to client. */
  reconnectQueue: Array<string | Buffer> | null;
  exited: boolean;
  terminating: boolean;
}

export class SidecarServer {
  private controlServer: net.Server | null = null;
  private controlClients = new Set<net.Socket>();
  private sessions = new Map<string, Session>();
  private startTime = Date.now();
  private readonly opts: Required<ServerOptions>;

  constructor(opts: ServerOptions) {
    this.opts = {
      ...opts,
      ringBufferBytes: opts.ringBufferBytes ?? DEFAULT_RING_BUFFER_BYTES,
    };
  }

  private withOptional<T extends object>(
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

  private chunkToBuffer(data: string | Uint8Array): Buffer {
    return typeof data === "string"
      ? Buffer.from(data, "utf8")
      : Buffer.from(data);
  }

  /**
   * 重连/重建回放 ring buffer 时, 剥离 shell 早前发出的 DSR/DA/XTVERSION/
   * XTGETTCAP 查询 (\x1b[6n、\x1b[...c、\x1b[>0q、\x1b[?Psq)。这些是历史
   * 查询, 回放给新 xterm 会触发对过期查询的应答, 应答涌入 shell 侧被回显成
   * "37;3R"/"1;2c"/">|xterm.js(6.0.0)2026;2$y" 泄漏(主进程 pty.ts 拦截
   * 回放流中的 \x1b[>0q 时也会重复应答写回 pty, zsh 将其当键盘输入回显)。
   * 仅作用于回放快照, 实时数据不受影响。
   */
  private stripRebuildReportQueries(buf: Buffer): Buffer {
    if (buf.length === 0) return buf;
    const s = buf.toString("utf-8");
    const cleaned = s
      // 剥离历史查询(DA/DSR/DECRQM/XTGETTCAP/XTVERSION, 清单见
      // @collab/shared/terminal-queries), 防全新 xterm / 主进程对过期查询
      // 重复应答
      .replace(buildRebuildQueryRe(), "")
      // 剥离回放里已污染的无 \x1b 前缀应答载荷(上次泄漏残留), 防再次显示
      .replace(/(?<![\d\x1b[?])(?:\d{1,4};\d{1,4}R|\d{1,3};2c)/g, "")
      // 剥离 XTVERSION/XTGETTCAP 应答被 shell 回显后的纯文本残留(如
      // ">|xterm.js(6.0.0)2026;2$y"), 防历史泄漏在重建后再次回放显示
      .replace(/>\|xterm\.js\([^)]*\)[\d;]*\$y/g, "");
    return cleaned === s ? buf : Buffer.from(cleaned, "utf-8");
  }

  private windowsPathKey(env: Record<string, string>): string | null {
    return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? null;
  }

  private normalizeWindowsPathEntry(value: string): string {
    let normalized = value.trim().replace(/\//g, "\\");
    if (normalized.startsWith("\\\\?\\")) {
      normalized = normalized.slice(4);
    } else if (normalized.startsWith("\\??\\")) {
      normalized = normalized.slice(4);
    }
    return normalized;
  }

  private isMalformedNodeModulesBinEntry(value: string): boolean {
    const normalized = this.normalizeWindowsPathEntry(value);
    return /^(?:\.\\|\\+)?node_modules\\\.bin\\?$/i.test(normalized);
  }

  private sanitizeWindowsWslEnv(env: Record<string, string>): void {
    const pathKey = this.windowsPathKey(env);
    if (!pathKey) return;

    const filtered = env[pathKey]
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => !this.isMalformedNodeModulesBinEntry(entry));

    env[pathKey] = filtered.join(";");
    if (pathKey !== "PATH" && env.PATH == null) {
      env.PATH = env[pathKey];
    }
  }

  private killWindowsProcessTree(pid: number, fallback: () => void): void {
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {
      fallback();
    }
  }

  private createTerminateProcess(ptyProcess: pty.IPty): () => void {
    const originalKill = ptyProcess.kill.bind(ptyProcess);
    if (process.platform !== "win32") {
      return () => originalKill();
    }

    ptyProcess.kill = ((signal?: string) => {
      if (signal) {
        throw new Error("Signals not supported on windows.");
      }
      this.killWindowsProcessTree(ptyProcess.pid, () => originalKill());
    }) as typeof ptyProcess.kill;

    return () =>
      this.killWindowsProcessTree(ptyProcess.pid, () => originalKill());
  }

  async start(): Promise<void> {
    if (process.platform !== "win32") {
      fs.mkdirSync(this.opts.sessionSocketDir, { recursive: true });
    }
    prepareEndpoint(this.opts.controlSocketPath);

    // Write PID file
    const pidData: PidFileData = {
      pid: process.pid,
      token: this.opts.token,
    };
    fs.writeFileSync(this.opts.pidFilePath, JSON.stringify(pidData));

    await new Promise<void>((resolve) => {
      this.controlServer = net.createServer((sock) =>
        this.handleControlClient(sock),
      );
      this.controlServer.listen(this.opts.controlSocketPath, resolve);
    });
  }

  async shutdown(): Promise<void> {
    // Shut down all sessions before closing the control server so tests and
    // non-exit-driven callers do not hang on still-open data servers.
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.shutdownSession(id)));

    // Close control clients
    for (const client of this.controlClients) {
      client.destroy();
    }

    // Close control server
    if (this.controlServer) {
      await new Promise<void>((resolve) =>
        this.controlServer!.close(() => resolve()),
      );
    }

    // Clean up files
    cleanupEndpoint(this.opts.controlSocketPath);
    try {
      fs.unlinkSync(this.opts.pidFilePath);
    } catch {}
  }

  private shutdownSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();

    if (session.dataClient && !session.dataClient.destroyed) {
      session.dataClient.destroy();
    }

    if (session.exited) {
      this.cleanupSession(sessionId);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let exitSubscription: IDisposable | null = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        exitSubscription?.dispose();
        this.cleanupSession(sessionId);
        resolve();
      };

      exitSubscription = session.pty.onExit(() => finish());
      if (!session.terminating) {
        session.terminating = true;
        this.terminateSessionProcess(session);
      }
      setTimeout(finish, 2000);
    });
  }

  private handleControlClient(sock: net.Socket): void {
    this.controlClients.add(sock);
    let buf = "";

    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.handleRpcMessage(sock, line);
      }
    });

    sock.on("close", () => {
      this.controlClients.delete(sock);
    });

    sock.on("error", () => {
      this.controlClients.delete(sock);
    });
  }

  private handleRpcMessage(sock: net.Socket, line: string): void {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line);
    } catch {
      sock.write(makeError(0, -32700, "Parse error"));
      return;
    }

    const { id, method, params } = msg;

    switch (method) {
      case "sidecar.ping":
        return this.handlePing(sock, id);
      case "sidecar.shutdown":
        sock.write(makeResponse(id, { ok: true }));
        void this.shutdown().then(() => process.exit(0));
        return;
      case "session.create":
        return this.handleCreate(
          sock,
          id,
          params as unknown as SessionCreateParams,
        );
      case "session.reconnect":
        return this.handleReconnect(
          sock,
          id,
          params as unknown as SessionReconnectParams,
        );
      case "session.resize":
        return this.handleResize(sock, id, params as Record<string, unknown>);
      case "session.kill":
        return this.handleKill(sock, id, params as Record<string, unknown>);
      case "session.list":
        return this.handleList(sock, id);
      case "session.foreground":
        return this.handleForeground(
          sock,
          id,
          params as Record<string, unknown>,
        );
      case "session.signal":
        return this.handleSignal(sock, id, params as Record<string, unknown>);
      case "session.capture":
        return this.handleCapture(sock, id, params as Record<string, unknown>);
      case "session.clearBuffer":
        return this.handleClearBuffer(
          sock,
          id,
          params as Record<string, unknown>,
        );
      default:
        sock.write(makeError(id, -32601, `Unknown method: ${method}`));
    }
  }

  private handlePing(sock: net.Socket, id: number): void {
    const result: PingResult = {
      pid: process.pid,
      uptime: Date.now() - this.startTime,
      token: this.opts.token,
    };
    sock.write(makeResponse(id, result));
  }

  private handleCreate(
    sock: net.Socket,
    id: number,
    params: SessionCreateParams,
  ): void {
    const sessionId = crypto.randomBytes(8).toString("hex");
    const socketPath = this.sessionSocketPath(sessionId);

    const target = params.target || "shell";
    // Shell env 完全以主进程传入的 params.env 为准 (其基座为主进程的
    // login shell 快照), 不再展开 sidecar 自身 process.env, 避免应用环境
    // (ELECTRON_*/npm_* 等) 泄漏进用户 shell。
    const env: Record<string, string> = {
      ...(params.env ?? {}),
      COLLAB_PTY_SESSION_ID: sessionId,
    };
    // ELECTRON_RUN_AS_NODE 曾由主进程设置在 sidecar 上; 若仍出现在传入
    // env 中必须清除, 否则任何 `electron` 调用会以 Node 模式运行
    // (例如 `bun run dev` 报 "module 'electron' does not provide an
    // export named 'BrowserWindow'")。
    delete env.ELECTRON_RUN_AS_NODE;
    if (!env.LANG || !env.LANG.includes("UTF-8")) {
      env.LANG = "en_US.UTF-8";
    }
    if (process.platform === "win32" && target.startsWith("wsl:")) {
      this.sanitizeWindowsWslEnv(env);
    }

    // Backward compat: old clients send `shell` instead of `command`/`args`.
    const command = params.command || params.shell || "/bin/sh";
    const args = params.args || [];
    const displayName = params.displayName || displayCommandName(command);
    const cwdHostPath = params.cwdHostPath || params.cwd;

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(command, args, {
        name: "xterm-256color",
        cols: params.cols,
        rows: params.rows,
        cwd: params.cwd,
        env,
        encoding: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `pty.spawn failed: command=${command} args=${JSON.stringify(args)}` +
          ` cwd=${params.cwd} error=${msg}\n`,
      );
      sock.write(makeError(id, -32000, `Failed to spawn: ${msg}`));
      return;
    }

    const ringBuffer = new RingBuffer(this.opts.ringBufferBytes);
    const terminateProcess = this.createTerminateProcess(ptyProcess);
    const session = this.withOptional(
      {
        id: sessionId,
        pty: ptyProcess,
        terminateProcess,
        shell: command,
        displayName,
        target,
        cwd: params.cwd,
        cwdHostPath,
        cwdGuestPath: params.cwdGuestPath,
        createdAt: new Date().toISOString(),
        ringBuffer,
        dataServer: null!,
        dataClient: null,
        socketPath,
        hasAttachedClient: false,
        reconnectQueue: null,
        exited: false,
        terminating: false,
      },
      {
        cwdGuestPath: params.cwdGuestPath,
      },
    ) as Session;

    // Listen for PTY output
    ptyProcess.onData((data: string | Buffer) => {
      ringBuffer.write(this.chunkToBuffer(data));

      if (session.reconnectQueue) {
        session.reconnectQueue.push(data);
        return;
      }

      if (session.dataClient && !session.dataClient.destroyed) {
        session.dataClient.write(data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.exited = true;
      // Notify all control clients
      const notification = makeNotification("session.exited", {
        sessionId,
        exitCode,
      });
      for (const client of this.controlClients) {
        client.write(notification);
      }
      this.cleanupSession(sessionId);
    });

    // Create per-session data socket server
    prepareEndpoint(socketPath);
    const dataServer = net.createServer((client) => {
      // Last-attach-wins: close previous client
      if (session.dataClient && !session.dataClient.destroyed) {
        session.dataClient.destroy();
      }
      session.dataClient = client;

      // If reconnecting, flush ring buffer snapshot + queued data
      if (session.reconnectQueue) {
        const snapshot = ringBuffer.snapshot();
        if (snapshot.length > 0) {
          client.write(this.stripRebuildReportQueries(snapshot));
        }
        // 先合并再剥离: 查询序列可能被断开期间的分块输出切断,
        // 逐块剥离会漏掉跨块的查询。
        const queued = session.reconnectQueue.map((c) => this.chunkToBuffer(c));
        if (queued.length > 0) {
          client.write(
            this.stripRebuildReportQueries(
              queued.length === 1 ? queued[0]! : Buffer.concat(queued),
            ),
          );
        }
        session.reconnectQueue = null;
        this.scheduleRepaintNudge(session);
      } else if (!session.hasAttachedClient) {
        const snapshot = ringBuffer.snapshot();
        if (snapshot.length > 0) {
          client.write(this.stripRebuildReportQueries(snapshot));
        }
      }
      session.hasAttachedClient = true;

      // Pipe client input to PTY
      client.on("data", (data) => {
        ptyProcess.write(data.toString());
      });

      client.on("close", () => {
        if (session.dataClient === client) {
          session.dataClient = null;
        }
      });

      client.on("error", () => {
        if (session.dataClient === client) {
          session.dataClient = null;
        }
      });
    });
    session.dataServer = dataServer;
    this.sessions.set(sessionId, session);

    dataServer.listen(socketPath, () => {
      const result: SessionCreateResult = { sessionId, socketPath };
      sock.write(makeResponse(id, result));
    });
  }

  private handleReconnect(
    sock: net.Socket,
    id: number,
    params: SessionReconnectParams,
  ): void {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      sock.write(
        makeError(id, -32000, `Session not found: ${params.sessionId}`),
      );
      return;
    }

    // Start queuing PTY output
    session.reconnectQueue = [];

    // Resize to match new client
    session.pty.resize(params.cols, params.rows);

    // Close old data client if present
    if (session.dataClient && !session.dataClient.destroyed) {
      session.dataClient.destroy();
      session.dataClient = null;
    }

    const result: SessionReconnectResult = {
      sessionId: params.sessionId,
      socketPath: session.socketPath,
    };
    sock.write(makeResponse(id, result));
  }

  private handleResize(
    sock: net.Socket,
    id: number,
    params: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(params.sessionId as string);
    if (!session) {
      sock.write(makeError(id, -32000, "Session not found"));
      return;
    }
    session.pty.resize(params.cols as number, params.rows as number);
    sock.write(makeResponse(id, { ok: true }));
  }

  /**
   * Reconnect 后的新 xterm（本地恢复 / 远程 B 端）从空画面仅回放字节历史，
   * 差分式整屏 TUI（ink/ncurses 等按自身模型只重写变更区）缺整帧基态时
   * 画面无法收敛。±1 行 resize 抖动产生 SIGWINCH，强制此类程序整帧重绘，
   * 使各 attach 方画面与输出流确定性一致（普通 shell 仅重绘提示行，无副作用）。
   */
  private scheduleRepaintNudge(session: Session): void {
    const { cols, rows } = session.pty;
    const nudgeTo = (targetRows: number): void => {
      if (
        session.exited ||
        session.terminating ||
        !session.dataClient ||
        session.dataClient.destroyed
      ) {
        return;
      }
      try {
        session.pty.resize(cols, targetRows);
      } catch {
        // PTY already dead
      }
    };
    setTimeout(() => nudgeTo(rows + 1), 120);
    setTimeout(() => nudgeTo(rows), 400);
  }

  private handleKill(
    sock: net.Socket,
    id: number,
    params: Record<string, unknown>,
  ): void {
    const sessionId = params.sessionId as string;
    this.killSession(sessionId);
    sock.write(makeResponse(id, { ok: true }));
  }

  private handleList(sock: net.Socket, id: number): void {
    const sessions: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      sessions.push(
        this.withOptional(
          {
            sessionId: s.id,
            shell: s.shell,
            displayName: s.displayName,
            target: s.target,
            cwd: s.cwd,
            cwdHostPath: s.cwdHostPath,
            pid: s.pty.pid,
            createdAt: s.createdAt,
          },
          {
            cwdGuestPath: s.cwdGuestPath,
          },
        ) as SessionInfo,
      );
    }
    sock.write(makeResponse(id, { sessions }));
  }

  private handleForeground(
    sock: net.Socket,
    id: number,
    params: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(params.sessionId as string);
    if (!session) {
      sock.write(makeError(id, -32000, "Session not found"));
      return;
    }
    try {
      const command = this.getForegroundCommand(session);
      sock.write(makeResponse(id, { command }));
    } catch {
      sock.write(makeResponse(id, { command: session.displayName }));
    }
  }

  private handleSignal(
    sock: net.Socket,
    id: number,
    params: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(params.sessionId as string);
    if (!session) {
      sock.write(makeError(id, -32000, "Session not found"));
      return;
    }
    try {
      process.kill(session.pty.pid, params.signal as string);
      sock.write(makeResponse(id, { ok: true }));
    } catch (err) {
      sock.write(makeError(id, -32000, String(err)));
    }
  }

  private handleCapture(
    sock: net.Socket,
    id: number,
    params: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(params.sessionId as string);
    if (!session) {
      sock.write(makeError(id, -32000, "Session not found"));
      return;
    }
    const snapshot = session.ringBuffer.snapshot();
    const text = snapshot.toString("utf-8");
    const lines = (params.lines as number) || 50;
    const allLines = text.split("\n");
    const tail = allLines.slice(-lines).join("\n");
    sock.write(makeResponse(id, { output: tail }));
  }

  private handleClearBuffer(
    sock: net.Socket,
    id: number,
    params: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(params.sessionId as string);
    if (!session) {
      sock.write(makeError(id, -32000, "Session not found"));
      return;
    }
    session.ringBuffer.clear();
    sock.write(makeResponse(id, { ok: true }));
  }

  private killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.exited) {
      this.cleanupSession(sessionId);
      return;
    }

    if (session.terminating) return;
    session.terminating = true;

    if (session.dataClient && !session.dataClient.destroyed) {
      session.dataClient.destroy();
    }

    this.terminateSessionProcess(session);
    this.cleanupSession(sessionId);
  }

  private terminateSessionProcess(session: Session): void {
    session.terminateProcess();
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.dataClient && !session.dataClient.destroyed) {
      session.dataClient.destroy();
    }
    session.dataServer.close();
    cleanupEndpoint(session.socketPath);
    this.sessions.delete(sessionId);
  }

  private sessionSocketPath(sessionId: string): string {
    return buildSessionSocketPath(sessionId);
  }

  private getForegroundCommand(session: Session): string {
    if (process.platform === "win32") {
      const fallback = session.target.startsWith("wsl:")
        ? session.displayName
        : displayCommandName(session.shell);
      try {
        const { execFileSync } = require("node:child_process");
        const output = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            [
              `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${session.pty.pid}" | Sort-Object ProcessId;`,
              "if ($children.Count -gt 0) {",
              "  $children[-1].Name",
              "}",
            ].join(" "),
          ],
          { encoding: "utf8", timeout: 2000, windowsHide: true },
        ).trim();
        return output ? displayCommandName(output) : fallback;
      } catch {
        return fallback;
      }
    }

    const { execFileSync } = require("node:child_process");
    const out = execFileSync(
      "ps",
      ["-o", "pid=,comm=", "-g", String(session.pty.pid)],
      { encoding: "utf8", timeout: 2000 },
    ).trim();
    const lines = out.split("\n").filter(Boolean);
    const last = lines[lines.length - 1]?.trim();
    return last
      ? displayCommandName(last.replace(/^\d+\s+/, ""))
      : session.displayName;
  }
}
