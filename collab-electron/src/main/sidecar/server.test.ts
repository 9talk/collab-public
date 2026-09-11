// src/main/sidecar/server.test.ts
//
// Integration tests for SidecarServer. Must run with node (not bun)
// because node-pty's native addon requires node's libuv event loop.
//
// Run: cd collab-electron && npx tsx --test src/main/sidecar/server.test.ts

import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { SidecarServer } from "./server";
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import {
  makeRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type PingResult,
  type SessionCreateResult,
  type SessionReconnectResult,
  type SessionInfo,
} from "./protocol";

// Use short temp dir to stay under macOS 104-byte sun_path limit
const TEST_DIR = path.join(os.tmpdir(), `sc-${process.pid}`);
const CONTROL_SOCK =
  process.platform === "win32"
    ? `\\\\.\\pipe\\sc-${process.pid}-ctrl`
    : path.join(TEST_DIR, "ctrl.sock");
const SESSION_DIR = path.join(TEST_DIR, "s");
const PID_PATH = path.join(TEST_DIR, "pid");
const TOKEN = "test-token-abc123";

const TEST_CWD = process.platform === "win32" ? os.tmpdir() : "/tmp";
const TEST_SHELL =
  process.platform === "win32"
    ? {
        command: "powershell.exe",
        args: ["-NoLogo"],
        displayName: "PowerShell",
        target: "powershell",
        echo: (marker: string) => `Write-Output '${marker}'\n`,
        exit: "exit\r",
      }
    : {
        command: "/bin/sh",
        args: [],
        displayName: "sh",
        target: "shell",
        echo: (marker: string) => `echo ${marker}\n`,
        exit: "exit\n",
      };

let server: SidecarServer | null = null;

afterEach(async () => {
  if (server) {
    await server.shutdown();
    server = null;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function connectControl(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(CONTROL_SOCK, () => resolve(sock));
    sock.on("error", reject);
  });
}

function rpcCall(
  sock: net.Socket,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        sock.off("data", onData);
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    };
    sock.on("data", onData);
    sock.write(makeRequest(id, method, params));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectDataSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => resolve(s));
    s.on("error", reject);
  });
}

function waitForOutput(
  sock: net.Socket,
  marker: string,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      sock.off("data", onData);
      reject(
        new Error(
          `Timed out waiting for "${marker}". Got: ${JSON.stringify(buf)}`,
        ),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes(marker)) {
        clearTimeout(timer);
        sock.off("data", onData);
        resolve(buf);
      }
    };
    sock.on("data", onData);
  });
}

async function waitForNotification(
  messages: Array<JsonRpcNotification | JsonRpcResponse>,
  method: string,
  timeoutMs = 5000,
): Promise<JsonRpcNotification> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notification = messages.find(
      (message) => "method" in message && message.method === method,
    );
    if (notification) {
      return notification as JsonRpcNotification;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for ${method}`);
}

function createServer(): SidecarServer {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  return new SidecarServer({
    controlSocketPath: CONTROL_SOCK,
    sessionSocketDir: SESSION_DIR,
    pidFilePath: PID_PATH,
    token: TOKEN,
  });
}

async function createSession(
  ctrl: net.Socket,
  id: number,
): Promise<SessionCreateResult> {
  const resp = await rpcCall(ctrl, id, "session.create", {
    command: TEST_SHELL.command,
    args: TEST_SHELL.args,
    displayName: TEST_SHELL.displayName,
    target: TEST_SHELL.target,
    cwdHostPath: TEST_CWD,
    cwd: TEST_CWD,
    cols: 80,
    rows: 24,
  });
  return resp.result as SessionCreateResult;
}

function earlyOutputShell(marker: string): {
  command: string;
  args: string[];
  displayName: string;
  target: string;
} {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoExit", "-Command", `Write-Output '${marker}'`],
      displayName: "PowerShell",
      target: "powershell",
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", `echo ${marker}; exec /bin/sh`],
    displayName: "sh",
    target: "shell",
  };
}

function exitSoonShell(): {
  command: string;
  args: string[];
  displayName: string;
  target: string;
} {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Start-Sleep -Milliseconds 200; exit 0",
      ],
      displayName: "PowerShell",
      target: "powershell",
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", "sleep 0.2; exit 0"],
    displayName: "sh",
    target: "shell",
  };
}

/**
 * Collect newline-delimited JSON messages from a socket
 * into a shared array, useful for listening for notifications.
 */
function collectMessages(
  sock: net.Socket,
  dest: Array<JsonRpcNotification | JsonRpcResponse>,
): void {
  let buf = "";
  sock.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        dest.push(JSON.parse(line));
      }
    }
  });
}

/** 读取 headless 终端当前屏面文本(逐行 translateToString) */
function readScreenText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\n");
}

describe("SidecarServer", () => {
  it("starts and responds to ping", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
    });
    await server.start();

    const sock = await connectControl();
    const resp = await rpcCall(sock, 1, "sidecar.ping");
    const result = resp.result as PingResult;

    assert.equal(result.token, TOKEN);
    assert.equal(result.pid, process.pid);
    assert.equal(typeof result.uptime, "number");

    sock.destroy();
  });
});

describe("SidecarServer session lifecycle", () => {
  it("session.create spawns a shell and returns socketPath", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
    });
    await server.start();

    const sock = await connectControl();
    const resp = await rpcCall(sock, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });

    const result = resp.result as SessionCreateResult;
    assert.match(result.sessionId, /^[0-9a-f]{16}$/);
    assert.ok(result.socketPath.includes(result.sessionId));
    if (process.platform !== "win32") {
      assert.ok(fs.existsSync(result.socketPath));
    }

    sock.destroy();
  });

  it("data socket sends PTY output", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
    });
    await server.start();

    const ctrl = await connectControl();
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { socketPath } = createResp.result as SessionCreateResult;

    // Connect data socket
    const data = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath, () => resolve(s));
      s.on("error", reject);
    });

    // Send a command and wait for output
    data.write(TEST_SHELL.echo("sidecar-test-output"));
    const output = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        data.off("data", onData);
        reject(
          new Error(
            `Timed out waiting for PTY output. Got: ${JSON.stringify(buf)}`,
          ),
        );
      }, 5000);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("sidecar-test-output")) {
          clearTimeout(timer);
          data.off("data", onData);
          resolve(buf);
        }
      };
      data.on("data", onData);
    });

    assert.ok(output.includes("sidecar-test-output"));

    data.destroy();
    ctrl.destroy();
  });

  it("replays early PTY output to the first attached data client", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const marker = "early-sidecar-marker";
    const shell = earlyOutputShell(marker);
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: shell.command,
      args: shell.args,
      displayName: shell.displayName,
      target: shell.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { socketPath } = createResp.result as SessionCreateResult;

    await sleep(300);

    const data = await connectDataSocket(socketPath);
    const output = await waitForOutput(data, marker);

    assert.ok(output.includes(marker));

    data.destroy();
    ctrl.destroy();
  });

  it("session.list returns created sessions", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
    });
    await server.start();

    const sock = await connectControl();
    await rpcCall(sock, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });

    const listResp = await rpcCall(sock, 2, "session.list");
    const { sessions } = listResp.result as { sessions: SessionInfo[] };
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].shell, TEST_SHELL.command);

    sock.destroy();
  });

  it("session.kill removes session from list", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
    });
    await server.start();

    const sock = await connectControl();
    const createResp = await rpcCall(sock, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId } = createResp.result as SessionCreateResult;

    await rpcCall(sock, 2, "session.kill", { sessionId });

    const listResp = await rpcCall(sock, 3, "session.list");
    const { sessions } = listResp.result as { sessions: SessionInfo[] };
    assert.equal(sessions.length, 0);

    sock.destroy();
  });

  it("session.reconnect returns scrollback over data socket", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
    });
    await server.start();

    const ctrl = await connectControl();

    // Create session and write some output
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId, socketPath } = createResp.result as SessionCreateResult;

    // Connect, send command, wait for output, then disconnect
    const data1 = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath, () => resolve(s));
      s.on("error", reject);
    });
    data1.write(TEST_SHELL.echo("reconnect-marker"));
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes("reconnect-marker")) {
          data1.off("data", onData);
          resolve();
        }
      };
      data1.on("data", onData);
    });
    data1.destroy();
    await sleep(100);

    // Reconnect
    const reconResp = await rpcCall(ctrl, 2, "session.reconnect", {
      sessionId,
      cols: 80,
      rows: 24,
    });
    assert.equal(
      (reconResp.result as SessionReconnectResult).sessionId,
      sessionId,
    );

    // Connect new data socket — should receive scrollback
    const data2 = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath, () => resolve(s));
      s.on("error", reject);
    });

    const scrollback = await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("reconnect-marker")) {
          data2.off("data", onData);
          resolve(buf);
        }
      };
      data2.on("data", onData);
      // Timeout fallback
      setTimeout(() => {
        data2.off("data", onData);
        resolve(buf);
      }, 2000);
    });

    assert.ok(scrollback.includes("reconnect-marker"));

    data2.destroy();
    ctrl.destroy();
  });
});

describe("Shell exit sends session.exited notification", () => {
  it("emits session.exited with sessionId and exitCode", async (t) => {
    if (process.platform === "win32") {
      t.skip(
        "Windows native PTY exit is covered by the client notification test",
      );
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const messages: Array<JsonRpcNotification | JsonRpcResponse> = [];
    collectMessages(ctrl, messages);

    const shell = exitSoonShell();
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: shell.command,
      args: shell.args,
      displayName: shell.displayName,
      target: shell.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId } = createResp.result as SessionCreateResult;

    const notification = await waitForNotification(messages, "session.exited");

    assert.equal(notification.method, "session.exited");
    assert.equal(notification.params?.sessionId, sessionId);
    assert.equal(typeof notification.params?.exitCode, "number");

    ctrl.destroy();
  });
});

describe("Last-attach-wins eviction", () => {
  it("closes socket A when socket B connects", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { socketPath } = await createSession(ctrl, 1);

    // Connect data socket A and verify it works
    const dataA = await connectDataSocket(socketPath);
    dataA.write(TEST_SHELL.echo("socket-a-marker"));
    await waitForOutput(dataA, "socket-a-marker");

    // Connect data socket B (should evict A)
    const dataB = await connectDataSocket(socketPath);
    await sleep(200);

    // Verify A no longer receives new output.
    // After eviction, A should not get any data from a new command.
    let aGotNewData = false;
    dataA.on("data", () => {
      aGotNewData = true;
    });

    // Verify B receives output
    dataB.write(TEST_SHELL.echo("socket-b-marker"));
    const output = await waitForOutput(dataB, "socket-b-marker");
    assert.ok(output.includes("socket-b-marker"));

    // Give a moment for any stray data to arrive on A
    await sleep(100);
    assert.ok(
      !aGotNewData,
      "Socket A should not receive output after eviction",
    );

    dataA.destroy();
    dataB.destroy();
    ctrl.destroy();
  });
});

describe("session.resize works", () => {
  it("returns { ok: true } when resizing", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId } = await createSession(ctrl, 1);

    const resp = await rpcCall(ctrl, 2, "session.resize", {
      sessionId,
      cols: 120,
      rows: 40,
    });

    assert.deepEqual(resp.result, { ok: true });
    assert.equal(resp.error, undefined);

    ctrl.destroy();
  });
});

describe("session.foreground returns a command name", () => {
  it("returns a non-empty command string", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);

    // Connect data socket so the shell is active and wait for prompt
    const data = await connectDataSocket(socketPath);
    await sleep(500);

    const resp = await rpcCall(ctrl, 2, "session.foreground", {
      sessionId,
    });

    const result = resp.result as { command: string };
    assert.equal(typeof result.command, "string");
    assert.ok(
      result.command.length > 0,
      "Foreground command should be non-empty",
    );

    data.destroy();
    ctrl.destroy();
  });
});

describe("Reconnect queues output produced during gap", () => {
  it("scrollback includes output from both commands", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);

    // Connect first data socket, send command, wait for output
    const data1 = await connectDataSocket(socketPath);
    data1.write(TEST_SHELL.echo("first-cmd-aaa"));
    await waitForOutput(data1, "first-cmd-aaa");

    // Disconnect first data socket
    data1.destroy();
    await sleep(200);

    // Connect a second data socket directly (no reconnect)
    // to send another command while the session is alive
    const data2 = await connectDataSocket(socketPath);
    data2.write(TEST_SHELL.echo("second-cmd-bbb"));
    await waitForOutput(data2, "second-cmd-bbb");

    // Disconnect second data socket
    data2.destroy();
    await sleep(200);

    // Now do a formal reconnect
    const reconResp = await rpcCall(ctrl, 2, "session.reconnect", {
      sessionId,
      cols: 80,
      rows: 24,
    });
    assert.equal(
      (reconResp.result as SessionReconnectResult).sessionId,
      sessionId,
    );

    // Connect new data socket to receive scrollback
    const data3 = await connectDataSocket(socketPath);
    const scrollback = await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        // Wait until we see both markers or timeout
        if (buf.includes("first-cmd-aaa") && buf.includes("second-cmd-bbb")) {
          data3.off("data", onData);
          resolve(buf);
        }
      };
      data3.on("data", onData);
      setTimeout(() => {
        data3.off("data", onData);
        resolve(buf);
      }, 3000);
    });

    assert.ok(
      scrollback.includes("first-cmd-aaa"),
      "Scrollback should contain output from the first command",
    );
    assert.ok(
      scrollback.includes("second-cmd-bbb"),
      "Scrollback should contain output from the second command",
    );

    data3.destroy();
    ctrl.destroy();
  });
});

describe("capture strips replayed query/residue payloads", () => {
  it("capture 输出剥离 DSR/DA/DECRQM 查询与已回显的应答残留", async (t) => {
    if (process.platform === "win32") {
      t.skip("printf 转义语义依赖 POSIX shell");
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    // KEEP 锚定头尾;中段 = 三类查询(真 ESC 字节) + 被 shell 回显过的
    // 应答残留(无 ESC 前缀的纯文本 "24;3R 1;2c 2026;2$y")
    data.write(
      "printf 'KEEP-A\\n\\033[6n\\033[c\\033[?2026$p24;3R 1;2c 2026;2$y\\nKEEP-B\\n'\n",
    );
    await waitForOutput(data, "KEEP-B");

    // capture 的消费方(pty.ts reconnectSession scrollback)会把它回放给
    // 全新 xterm, 不剥离则新 xterm 对历史查询重复应答, 被空闲 shell 回显
    const cap = await rpcCall(ctrl, 2, "session.capture", {
      sessionId,
      lines: 50,
    });
    const output = (cap.result as { output: string }).output;

    assert.ok(output.includes("KEEP-A"), "无查询的正常输出应保留");
    assert.ok(output.includes("KEEP-B"), "无查询的正常输出应保留");
    for (const gone of [
      "\x1b[6n",
      "\x1b[c",
      "\x1b[?2026$p",
      "24;3R",
      "1;2c",
      "2026;2$y",
    ]) {
      assert.ok(
        !output.includes(gone),
        `capture 不应再包含 ${JSON.stringify(gone)}`,
      );
    }

    data.destroy();
    ctrl.destroy();
  });
});

describe("session.serialize outputs terminal-state snapshot", () => {
  const skipWin = (t: { skip: (msg: string) => void }): boolean => {
    if (process.platform === "win32") {
      t.skip("printf 转义语义依赖 POSIX shell");
      return true;
    }
    return false;
  };

  it("基本: 快照含输出文本, 携带网格尺寸", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    data.write("printf 'SNAP%s\\nSNAP%s\\n' -ONE -TWO\n");
    await waitForOutput(data, "SNAP-TWO");

    const resp = await rpcCall(ctrl, 2, "session.serialize", { sessionId });
    assert.equal(resp.error, undefined);
    const snap = resp.result as {
      snapshot: string;
      cols: number;
      rows: number;
    };
    assert.ok(snap.snapshot.includes("SNAP-ONE"), "快照应含输出文本");
    assert.ok(snap.snapshot.includes("SNAP-TWO"), "快照应含输出文本");
    assert.equal(snap.cols, 80);
    assert.equal(snap.rows, 24);

    data.destroy();
    ctrl.destroy();
  });

  it("全屏: alt 缓冲内容与 ?1049h 进入快照", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    data.write(
      "printf '\\033[?1049h\\033[2J\\033[HFULLSCREEN%s\\nALT%s\\n' -TITLE -ROW\n",
    );
    await waitForOutput(data, "ALT-ROW");

    const resp = await rpcCall(ctrl, 2, "session.serialize", { sessionId });
    const snap = resp.result as { snapshot: string };
    assert.ok(snap.snapshot.includes("FULLSCREEN-TITLE"));
    assert.ok(snap.snapshot.includes("ALT-ROW"));
    assert.ok(
      snap.snapshot.includes("\x1b[?1049h"),
      "alt 缓冲激活标记应进入快照",
    );

    data.destroy();
    ctrl.destroy();
  });

  it("往返保真: 快照写入全新 headless 后屏面一致", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    data.write(
      "printf 'RT%s\\n\\033[?1049h\\033[2J\\033[HROUNDTRIP%s\\n' -HEAD -ALT\n",
    );
    await waitForOutput(data, "ROUNDTRIP-ALT");

    const resp = await rpcCall(ctrl, 2, "session.serialize", { sessionId });
    const snap = resp.result as {
      snapshot: string;
      cols: number;
      rows: number;
    };

    const fresh = new Terminal({
      cols: snap.cols,
      rows: snap.rows,
      allowProposedApi: true,
    });
    await new Promise<void>((resolve) =>
      fresh.write(snap.snapshot, () => resolve()),
    );
    assert.equal(
      fresh.buffer.active.type,
      "alternate",
      "恢复后应处于 alt 缓冲",
    );
    assert.ok(
      readScreenText(fresh).includes("ROUNDTRIP-ALT"),
      "alt 屏面文本应还原",
    );

    fresh.dispose();
    data.destroy();
    ctrl.destroy();
  });

  it("查询序列不进快照(按构造消除)", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    data.write("printf 'Q%s\\n\\033[6n\\033[c\\033[?2026$p\\nQ%s\\n' -A -B\n");
    await waitForOutput(data, "Q-B");

    const resp = await rpcCall(ctrl, 2, "session.serialize", { sessionId });
    const snap = resp.result as { snapshot: string };
    assert.ok(snap.snapshot.includes("Q-A"));
    assert.ok(snap.snapshot.includes("Q-B"));
    for (const gone of ["\x1b[6n", "\x1b[c", "\x1b[?2026$p"]) {
      assert.ok(
        !snap.snapshot.includes(gone),
        `快照不应包含查询 ${JSON.stringify(gone)}`,
      );
    }

    data.destroy();
    ctrl.destroy();
  });

  it("resize 后 serialize 的尺寸跟随", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    data.write("printf 'RESIZE%s\\n' -MARK\n");
    await waitForOutput(data, "RESIZE-MARK");

    await rpcCall(ctrl, 2, "session.resize", {
      sessionId,
      cols: 100,
      rows: 30,
    });
    const resp = await rpcCall(ctrl, 3, "session.serialize", { sessionId });
    const snap = resp.result as { cols: number; rows: number };
    assert.equal(snap.cols, 100);
    assert.equal(snap.rows, 30);

    data.destroy();
    ctrl.destroy();
  });

  it("clearBuffer 后快照近空", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    data.write("printf 'WILL%s\\n' -BE-CLEARED\n");
    await waitForOutput(data, "WILL-BE-CLEARED");

    await rpcCall(ctrl, 2, "session.clearBuffer", { sessionId });
    const resp = await rpcCall(ctrl, 3, "session.serialize", { sessionId });
    const snap = resp.result as { snapshot: string };
    assert.ok(
      !snap.snapshot.includes("WILL-BE-CLEARED"),
      "clearBuffer 后历史不应出现在快照",
    );

    data.destroy();
    ctrl.destroy();
  });

  it("洪峰后 serialize 含最后一段(排空生效)", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    data.write("awk 'BEGIN{i=0; while(i<4000){print \"DRN-\" i; i++}}'\n");
    await waitForOutput(data, "DRN-3999", 15000);

    const resp = await rpcCall(ctrl, 2, "session.serialize", { sessionId });
    const snap = resp.result as { snapshot: string };
    assert.ok(snap.snapshot.includes("DRN-3999"), "排空后快照应含洪峰最后一行");

    data.destroy();
    ctrl.destroy();
  });

  it("压力: 持续写入流中反复 serialize 不卡死且终帧完整", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    // 10 段洪峰连续投递(经 pty 输入队列串行执行), 每段之间不等待,
    // 同时并发 40 次 serialize: 覆盖 enqueue 链"排空与持续写入交错"
    // 的重入路径 —— 每次 serialize 都可能落在某段洪峰中途。
    const pending: Array<ReturnType<typeof rpcCall>> = [];
    const bursts = "ABCDEFGHIJ".split("");
    bursts.forEach((tag, bi) => {
      data.write(`awk 'BEGIN{for(i=0;i<50;i++) print "${tag}-" i}'\n`);
      for (let k = 0; k < 4; k++) {
        pending.push(
          rpcCall(ctrl, 100 + bi * 10 + k, "session.serialize", { sessionId }),
        );
      }
    });
    const all = await Promise.all(pending);
    for (const [i, resp] of all.entries()) {
      assert.ok(
        !resp.error,
        `并发第 ${i} 次 serialize 不应报错: ${JSON.stringify(resp.error)}`,
      );
      assert.ok(
        typeof (resp.result as { snapshot: string }).snapshot === "string",
        `并发第 ${i} 次 serialize 应返回字符串快照`,
      );
    }

    await waitForOutput(data, "J-49", 15000);
    const fin = await rpcCall(ctrl, 999, "session.serialize", { sessionId });
    const finSnap = fin.result as { snapshot: string };
    assert.ok(
      finSnap.snapshot.includes("J-49"),
      "持续写入结束后终帧应含最后一段(排空生效)",
    );

    data.destroy();
    ctrl.destroy();
  });

  it("未知会话返回错误", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const resp = await rpcCall(ctrl, 1, "session.serialize", {
      sessionId: "no-such-session",
    });
    assert.ok(resp.error, "应返回错误");
    assert.equal(resp.error!.code, -32000);

    ctrl.destroy();
  });

  it("性能对比: 快照恢复 vs 字节历史回放(全屏多帧负载)", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    // 模拟全屏 TUI 逐帧重绘: 250 帧 alt 屏整屏覆盖 + 彩色 SGR,
    // 帧尾用运行期拼接的标记规避命令回声误匹配。
    data.write(
      'awk \'BEGIN{printf "\\033[?1049h"; for(i=0;i<250;i++){printf "\\033[H\\033[2J\\033[3%dmFRAME-%d\\n", i%8, i; for(j=0;j<18;j++) printf "row %d filler content %d\\n", j, i}; printf "FRAME-F%s\\n", "INAL"}\'\n',
    );
    await waitForOutput(data, "FRAME-FINAL", 15000);

    const capResp = await rpcCall(ctrl, 2, "session.capture", {
      sessionId,
      lines: 500,
    });
    const captureText = (capResp.result as { output: string }).output;
    const snapResp = await rpcCall(ctrl, 3, "session.serialize", {
      sessionId,
    });
    const snap = snapResp.result as {
      snapshot: string;
      cols: number;
      rows: number;
    };

    const parseInto = async (
      text: string,
      cols: number,
      rows: number,
    ): Promise<{ ms: number; text: string }> => {
      const fresh = new Terminal({ cols, rows, allowProposedApi: true });
      const t0 = performance.now();
      await new Promise<void>((resolve) => fresh.write(text, () => resolve()));
      const ms = performance.now() - t0;
      const screen = readScreenText(fresh);
      fresh.dispose();
      return { ms, text: screen };
    };

    const capture = await parseInto(captureText, 80, 24);
    const snapshot = await parseInto(snap.snapshot, snap.cols, snap.rows);

    // 两条路径都应恢复到同一终帧(还原正确性等价), 快照体积应是
    // 字节历史的一帧量级而非全部帧(约 250 帧负载下数量级更小)。
    assert.ok(capture.text.includes("FRAME-FINAL"), "旧路径恢复终帧");
    assert.ok(snapshot.text.includes("FRAME-FINAL"), "快照恢复终帧");
    assert.ok(
      snap.snapshot.length < captureText.length,
      `快照应小于字节历史 (snapshot=${snap.snapshot.length}B capture=${captureText.length}B)`,
    );
    console.log(
      `[perf] 快照 ${snap.snapshot.length}B / 解析 ${snapshot.ms.toFixed(1)}ms · 字节历史 ${captureText.length}B / 解析 ${capture.ms.toFixed(1)}ms (${(captureText.length / snap.snapshot.length).toFixed(1)}x 体积)`,
    );

    data.destroy();
    ctrl.destroy();
  });
});

describe("Unknown RPC method returns error", () => {
  it("returns error code -32601 for unknown method", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const resp = await rpcCall(ctrl, 1, "nonexistent.method");

    assert.ok(resp.error, "Response should have an error");
    assert.equal(resp.error!.code, -32601);
    assert.ok(resp.error!.message.includes("nonexistent.method"));

    ctrl.destroy();
  });
});

describe("Windows WSL smoke", () => {
  const isWindows = process.platform === "win32";
  const runWslSmoke = process.env.RUN_WSL_SMOKE === "1";
  const defaultDistro = isWindows
    ? (() => {
        try {
          const out = execFileSync("wsl.exe", ["-l", "-q"], {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
          });
          return (
            out
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find(Boolean) ?? null
          );
        } catch {
          return null;
        }
      })()
    : null;

  it("can spawn a WSL session when a distro is installed", async (t) => {
    if (!runWslSmoke) {
      t.skip("Set RUN_WSL_SMOKE=1 to run the WSL integration smoke test");
      return;
    }

    if (!isWindows || !defaultDistro) {
      t.skip("WSL not available");
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: "wsl.exe",
      args: ["-d", defaultDistro],
      displayName: defaultDistro,
      target: `wsl:${defaultDistro}`,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId, socketPath } = createResp.result as SessionCreateResult;

    const data = await connectDataSocket(socketPath);
    data.write("echo WSL_SMOKE_OK\n");
    const output = await waitForOutput(data, "WSL_SMOKE_OK", 10000);
    assert.ok(output.includes("WSL_SMOKE_OK"));

    await rpcCall(ctrl, 2, "session.kill", { sessionId });
    data.destroy();
    ctrl.destroy();
  });
});
