import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";

function normalizeWindowsPath(path) {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

const repoDir = normalizeWindowsPath(process.cwd());

// --flavor full|remote 单起一端;缺省同时启动 Host(full) 与 Client(remote)
// 双端。双端必须各自独立的 COLLAB_DEV_WORKTREE_ROOT:仅靠 paths.ts 的
// "-remote" 数据目录后缀隔离不够,共享 root 时后启动的 Client 主进程在
// import 早期即退出(实测:连 [analytics] 都未打印)。Host 用 repoDir,
// Client 缺省落在 ~/.collab/dev/client-<repo 名>(与 e2e 双 root 同构)。
// 设了 REMOTE_RELAY_URL + REMOTE_DEVICE_TOKEN 时自动接力:捕获 Host 注册
// 后打印的配对码,注入 Client 的 REMOTE_PAIR_CODE,双端跨 relay 自动互联
// (e2e 同款 env 入口,见 remote-server/remote-client)。
const flavorIndex = process.argv.indexOf("--flavor");
const flavorArg =
  flavorIndex !== -1 && process.argv[flavorIndex + 1]
    ? process.argv[flavorIndex + 1]
    : null;
const mode = flavorArg ?? "both"; // both | full | remote
if (!["both", "full", "remote"].includes(mode)) {
  console.error(
    `dev.mjs: unknown --flavor "${flavorArg}" (expected full | remote)`,
  );
  process.exit(1);
}

const CLIENT_ROOT = join(
  homedir(),
  ".collab",
  "dev",
  `client-${basename(repoDir)}`,
);

// CDP 端口:full/单端用 REMOTE_DEBUG_PORT;双端时 host=REMOTE_DEBUG_PORT,
// client 自动 +1(与 remote-e2e 的 9223/9224 分配一致)。
function debugPortFor(flavor, isBoth) {
  const port = process.env.REMOTE_DEBUG_PORT;
  if (!port) return undefined;
  return isBoth && flavor === "remote" ? String(Number(port) + 1) : port;
}

function devChild(flavor, { stdio = "inherit" } = {}) {
  const isBoth = mode === "both";
  const isClient = isBoth && flavor === "remote";
  const debugPort = debugPortFor(flavor, isBoth);
  const args = [
    "x",
    "electron-vite",
    "dev",
    ...(debugPort ? ["--remoteDebuggingPort", debugPort] : []),
  ];
  const child = spawn(process.execPath, args, {
    stdio,
    cwd: repoDir,
    env: {
      ...process.env,
      COLLAB_FLAVOR: flavor,
      COLLAB_DEV_WORKTREE_ROOT:
        process.env.COLLAB_DEV_WORKTREE_ROOT ??
        (isClient ? CLIENT_ROOT : repoDir),
    },
  });
  return child;
}

/**
 * Host 已配置 relay(REMOTE_RELAY_URL + REMOTE_DEVICE_TOKEN)时以 pipe 方式
 * spawn:stdout 原样转发到本终端,同时尾部缓存捕获注册配对码([remote]
 * pair-code: XXXXXX),供 Client 自动连接。超时(120s)返回 null 并继续。
 */
async function spawnHostWithPairCode() {
  const wantAutoPair = Boolean(
    process.env.REMOTE_RELAY_URL && process.env.REMOTE_DEVICE_TOKEN,
  );
  const child = devChild("full", { stdio: wantAutoPair ? "pipe" : "inherit" });
  if (!wantAutoPair) return { child, pairCode: null };
  let tail = "";
  child.stdout.on("data", (d) => {
    process.stdout.write(d);
    tail = `${tail}${d.toString("utf8")}`.slice(-2048);
  });
  const pairCode = await new Promise((resolve) => {
    const deadline = Date.now() + 120_000;
    const poll = setInterval(() => {
      const m = tail.match(/pair-code: ([0-9A-Za-z]+)/);
      if (m) {
        clearInterval(poll);
        resolve(m[1]);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        resolve(null);
      }
    }, 250);
  });
  if (pairCode) {
    console.log(`[dev] host 配对码 ${pairCode},注入 client 自动连接`);
  } else {
    console.warn(
      "[dev] 等待 host 配对码超时(relay 不可达或 token 无效?),client 将手动连接",
    );
  }
  return { child, pairCode };
}

const children = [];
const forwardSignal = (signal) => {
  for (const c of children) {
    if (!c.killed) c.kill(signal);
  }
};
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

async function main() {
  if (process.platform === "win32") {
    if (mode === "both") {
      console.warn(
        "[dev] win32 暂不支持双端同起,本次仅启动 Host(full);两端可分别用",
        "--flavor full / --flavor remote 各起一个窗口",
      );
    }
    const flavor = mode === "remote" ? "remote" : "full";
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repoDir, "scripts", "dev.ps1"),
      ],
      {
        stdio: "inherit",
        cwd: repoDir,
        env: {
          ...process.env,
          COLLAB_FLAVOR: flavor,
          COLLAB_DEV_WORKTREE_ROOT:
            process.env.COLLAB_DEV_WORKTREE_ROOT ?? repoDir,
        },
      },
    );
    children.push(child);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  let hostRef = null;
  let clientRef = null;
  if (mode !== "remote") {
    const { child, pairCode } = await spawnHostWithPairCode();
    hostRef = child;
    if (pairCode) process.env.REMOTE_PAIR_CODE = pairCode;
  }
  if (mode !== "full") {
    clientRef = devChild("remote");
  }
  for (const c of [hostRef, clientRef]) {
    if (!c) continue;
    children.push(c);
    c.on("exit", (code, signal) => {
      for (const other of [hostRef, clientRef]) {
        if (other && other !== c && !other.killed) other.kill("SIGTERM");
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
  }
}

void main();
