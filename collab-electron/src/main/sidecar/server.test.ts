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

  it("首挂不补发挂载前的早段输出(历史只经 serialize 交付)", async () => {
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

    // shell 在 attach 之前已输出 marker: 首挂不得补发(ring 已移除,
    // 早段画面由客户端自绘 / Ctrl+L 收敛)
    await sleep(300);

    const data = await connectDataSocket(socketPath);
    const before = await new Promise<string>((resolve) => {
      let buf = "";
      data.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
      });
      setTimeout(() => resolve(buf), 400);
    });
    assert.ok(
      !before.includes(marker),
      `首挂不得补发挂载前的输出, got: ${JSON.stringify(before)}`,
    );

    // 挂载后新产生的输出正常到达
    data.write(TEST_SHELL.echo("post-attach-live"));
    const live = await waitForOutput(data, "post-attach-live");
    assert.ok(live.includes("post-attach-live"));

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

  it("reconnect 后历史经 serialize 快照交付, 数据通道不重放旧字节", async () => {
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
    const data1 = await connectDataSocket(socketPath);
    data1.write(TEST_SHELL.echo("reconnect-marker"));
    await waitForOutput(data1, "reconnect-marker");
    data1.destroy();
    await sleep(100);

    // Reconnect: 历史改经 serialize 快照交付
    const reconResp = await rpcCall(ctrl, 2, "session.reconnect", {
      sessionId,
      cols: 80,
      rows: 24,
    });
    assert.equal(
      (reconResp.result as SessionReconnectResult).sessionId,
      sessionId,
    );
    const snapResp = await rpcCall(ctrl, 3, "session.serialize", { sessionId });
    const snap = snapResp.result as { snapshot: string };
    assert.ok(
      snap.snapshot.includes("reconnect-marker"),
      "快照应涵盖重连前的历史输出",
    );

    // 新数据通道只续接快照之后的输出, 不重放旧字节
    const data2 = await connectDataSocket(socketPath);
    const stale = await new Promise<string>((resolve) => {
      let buf = "";
      data2.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
      });
      setTimeout(() => resolve(buf), 400);
    });
    assert.ok(
      !stale.includes("reconnect-marker"),
      `数据通道不得重放快照已涵盖的旧字节, got: ${JSON.stringify(stale)}`,
    );

    // 通道仍可正常收发
    data2.write(TEST_SHELL.echo("after-reconnect"));
    await waitForOutput(data2, "after-reconnect");

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
  it("断连窗口产生的输出在 attach 时补发", async (t) => {
    if (process.platform === "win32") {
      t.skip("sh sleep 语义依赖 POSIX shell");
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    // 后台任务 1.5s 后输出: 落在 reconnect 开始之后、attach 之前
    const resp = await rpcCall(ctrl, 1, "session.create", {
      command: "/bin/sh",
      args: ["-lc", "(sleep 1.5; echo gap-marker) & exec /bin/sh"],
      displayName: "sh",
      target: "shell",
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId, socketPath } = resp.result as SessionCreateResult;

    // 无数据通道直接 reconnect: 此后输出进入队列
    const reconResp = await rpcCall(ctrl, 2, "session.reconnect", {
      sessionId,
      cols: 80,
      rows: 24,
    });
    assert.equal(
      (reconResp.result as SessionReconnectResult).sessionId,
      sessionId,
    );

    // 等后台任务输出(此刻无客户端, 只能落入队列)
    await sleep(2000);

    const data = await connectDataSocket(socketPath);
    const received = await waitForOutput(data, "gap-marker");
    assert.ok(
      received.includes("gap-marker"),
      "断连窗口的输出应在 attach 时补发",
    );

    data.destroy();
    ctrl.destroy();
  });
});

describe("serialize 之后的 attach 不回放快照前的旧字节", () => {
  it("attach 仅补发快照之后的输出, 快照已涵盖的历史不重放", async (t) => {
    if (process.platform === "win32") {
      t.skip("sh sleep 语义依赖 POSIX shell");
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    // 立即输出 stale 标记(进入 ring), 2.5s 后输出 gap 标记
    // (落在 reconnect 窗口内、serialize 之后)
    const resp = await rpcCall(ctrl, 1, "session.create", {
      command: "/bin/sh",
      args: [
        "-lc",
        "echo stale-before-snap; sleep 2.5; echo gap-after-snap; exec /bin/sh",
      ],
      displayName: "sh",
      target: "shell",
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId, socketPath } = resp.result as SessionCreateResult;

    // 首次 attach: ring 里的 stale 标记到达
    const data1 = await connectDataSocket(socketPath);
    await waitForOutput(data1, "stale-before-snap");

    // 正式流程: reconnect(队列开始) → serialize(队列应重置, 快照涵盖
    // stale 输出) → gap 标记在快照之后进入队列
    await rpcCall(ctrl, 2, "session.reconnect", {
      sessionId,
      cols: 80,
      rows: 24,
    });
    const snapResp = await rpcCall(ctrl, 3, "session.serialize", { sessionId });
    const snap = snapResp.result as { snapshot: string };
    assert.ok(
      snap.snapshot.includes("stale-before-snap"),
      "环境自检: 快照应已涵盖 stale 输出",
    );
    await sleep(3000);

    // attach: 修复后只应为快照之后(gap)的输出; 旧 ring 字节重放会
    // 二次应用(相对定位序列从快照终态出发 → 渲染错位)。
    const data2 = await connectDataSocket(socketPath);
    const received = await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
      };
      data2.on("data", onData);
      setTimeout(() => {
        data2.off("data", onData);
        resolve(buf);
      }, 800);
    });

    assert.ok(
      received.includes("gap-after-snap"),
      "快照之后的输出应补发给新客户端",
    );
    assert.ok(
      !received.includes("stale-before-snap"),
      "快照已涵盖的旧 ring 字节不得重放",
    );

    data2.destroy();
    ctrl.destroy();
  });
});

describe("session.capture 读终端文本", () => {
  it("返回解析器还原的屏面文本, 不含控制序列; lines 截尾部窗口", async (t) => {
    if (process.platform === "win32") {
      t.skip("printf 转义语义依赖 POSIX shell");
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    // KEEP 锚定可见文本, 中段混入真实查询序列(ESC 字节); L 行经参数展开
    // 产出——命令回声里是 L%s5, 不含 "L5" 子串, 等它出现即真实输出已渲染
    data.write(
      "printf 'KEEP-A\\n\\033[6n\\033[c\\033[?2026$p\\nKEEP-B\\n'\nprintf 'L%s1\\nL%s2\\nL%s3\\nL%s4\\nL%s5\\n' '' '' '' '' ''\n",
    );
    await waitForOutput(data, "L5");

    const cap = await rpcCall(ctrl, 2, "session.capture", {
      sessionId,
      lines: 50,
    });
    const output = (cap.result as { output: string }).output;

    assert.ok(output.includes("KEEP-A"), "可见文本应保留");
    assert.ok(output.includes("KEEP-B"), "可见文本应保留");
    assert.ok(
      !output.includes("\x1b"),
      `文本化输出不应含 ESC 控制序列: ${JSON.stringify(output)}`,
    );

    // lines 截尾部窗口: 只保留最近 3 行, 更早的内容(含 L2 行)不出现
    const tail = await rpcCall(ctrl, 3, "session.capture", {
      sessionId,
      lines: 3,
    });
    const tailOut = (tail.result as { output: string }).output;
    assert.ok(tailOut.includes("L5"), "尾部窗口应含最后一行");
    assert.ok(
      !tailOut.includes("KEEP-A") && !tailOut.includes("L2"),
      `尾部窗口不应含更早内容: ${JSON.stringify(tailOut)}`,
    );

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

  it("鼠标编码与光标隐藏状态进入快照(SerializeAddon 不覆盖)", async (t) => {
    if (skipWin(t)) return;
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);
    const data = await connectDataSocket(socketPath);

    // claude code 式启动序列: 开鼠标追踪 + SGR 编码(?1006h) + 隐藏硬件光标
    // (?25l)。SerializeAddon 只序列化 trackingMode, 编码模式与光标可见性
    // 缺失时恢复端回退 X10 编码/显示光标 —— SGR 点击定位失效、光标显形。
    data.write(
      "printf '\\033[?1000h\\033[?1002h\\033[?1003h\\033[?1006h\\033[?25lMODE%s\\n' -ON\n",
    );
    await waitForOutput(data, "MODE-ON");

    const resp = await rpcCall(ctrl, 2, "session.serialize", { sessionId });
    const snap = resp.result as { snapshot: string };
    assert.ok(
      snap.snapshot.includes("\x1b[?1006h"),
      "SGR 鼠标编码(?1006h)状态应进入快照",
    );
    assert.ok(
      snap.snapshot.includes("\x1b[?25l"),
      "光标隐藏(?25l)状态应进入快照",
    );

    // 端到端: 快照写入全新 headless 后, 恢复端应处于 SGR 编码态且光标隐藏
    const fresh = new Terminal({
      cols: snap.cols,
      rows: snap.rows,
      allowProposedApi: true,
    });
    await new Promise<void>((resolve) =>
      fresh.write(snap.snapshot, () => resolve()),
    );
    const freshCore = (
      fresh as unknown as {
        _core: {
          coreMouseService: { _activeEncoding: string };
          coreService: { isCursorHidden: boolean };
        };
      }
    )._core;
    assert.equal(
      freshCore.coreMouseService._activeEncoding,
      "SGR",
      "恢复端应处于 SGR 鼠标编码态",
    );
    assert.equal(
      freshCore.coreService.isCursorHidden,
      true,
      "恢复端光标应保持隐藏",
    );
    fresh.dispose();

    // 关闭 SGR 编码后序列化 → 不再补 ?1006h
    data.write("printf '\\033[?1006lMODE%s\\n' -OFF\n");
    await waitForOutput(data, "MODE-OFF");
    const resp2 = await rpcCall(ctrl, 3, "session.serialize", { sessionId });
    const snap2 = resp2.result as { snapshot: string };
    assert.ok(
      !snap2.snapshot.includes("\x1b[?1006h"),
      "SGR 关闭后快照不应含 ?1006h",
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
