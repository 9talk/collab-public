import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, statSync, readSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_SPAN = 8 * 1024 * 1024;

function killTreeRec(pid, signal) {
  let children = [];
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf-8",
    });
    children = out.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    // leaf process
  }
  for (const c of children) killTreeRec(c, signal);
  try {
    process.kill(pid, signal);
  } catch {
    // already dead
  }
}

/** 杀进程组 + 递归进程树（electron 主进程可能已脱离 bun 的进程组）。 */
function killTree(child, signal = "SIGTERM") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
  killTreeRec(child.pid, signal);
}

export function spawnLog(name, cmd, args, env, cwd, logDir) {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${name}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
  });
  const ref = { name, child, pid: child.pid, logPath, fd };
  child.on("exit", () => {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  });
  return ref;
}

/** 读日志末尾若干字节（避免大文件整体读入）。fromBytes 可跳过文件头部（锚点）。 */
export function tailLog(logPath, bytes = MAX_LOG_SPAN, fromBytes = 0) {
  try {
    const st = statSync(logPath);
    const start = Math.max(fromBytes, st.size - bytes);
    if (start === 0) return readFileSync(logPath, "utf-8");
    const buf = Buffer.alloc(st.size - start);
    const fd = openSync(logPath, "r");
    const len = readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return buf.subarray(0, len).toString("utf-8");
  } catch {
    return "";
  }
}

export function readLog(logPath) {
  try {
    return readFileSync(logPath, "utf-8");
  } catch {
    return "";
  }
}

/** 轮询直到日志末尾出现匹配正则（或超时）。fromBytes 锚点：只匹配该偏移之后的新内容。 */
export async function waitForLog(
  logPath,
  pattern,
  timeoutMs = 60_000,
  fromBytes = 0,
) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = tailLog(logPath, MAX_LOG_SPAN, fromBytes);
    const m = log.match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export function killTree(child, signal = "SIGTERM") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
  killTreeRec(child.pid, signal);
}

export function killTree9(child) {
  killTree(child, "SIGKILL");
}
