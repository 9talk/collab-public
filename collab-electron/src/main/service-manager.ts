import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { COLLAB_DIR } from "./paths";

export type ServiceStatus = "running" | "stopped" | "exited" | "failed";

export interface ManagedService {
  projectPath: string;
  pid: number | null;
  startedAt: number | null;
  status: ServiceStatus;
  exitCode?: number | null;
  exitSignal?: string | null;
  /** 启动失败原因：超时 / spawn 错误 / 无 PID 上报 / COLLAB_ERROR 信息 */
  startError?: string;
  /** 进程组 leader pid（= spawn 出的 start.sh 的 child.pid），用于进程组杀/探活 */
  pgid?: number | null;
  /** 服务上报的 HTTP 端口（start.sh stdout 的 COLLAB_HTTP_PORT:<port> 行） */
  httpPort?: number | null;
  /** 服务上报的成功说明（start.sh stdout 的 COLLAB_MESSAGE:<文本> 行） */
  message?: string;
}

interface PersistedService {
  pid: number | null;
  pgid: number | null;
  startedAt: number | null;
}

const IS_WIN = process.platform === "win32";
const DATA_FILE = join(COLLAB_DIR, "services.json");
const LOGS_DIR = join(COLLAB_DIR, "services-logs");
const START_TIMEOUT_MS = 120_000;

// 本进程 spawn 的子进程对象（应用重启后恢复的记录没有 child，靠 PID 探活）
const children = new Map<string, ChildProcess>();
// 打开的日志文件描述符，子进程退出或应用退出时关闭
const logFds = new Map<string, number>();
const services = new Map<string, ManagedService>();

function load(): void {
  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as {
      services?: Record<string, PersistedService>;
    };
    const list = parsed?.services;
    if (typeof list === "object" && list !== null) {
      for (const [projectPath, s] of Object.entries(list)) {
        if (!s) continue;
        services.set(projectPath, {
          projectPath,
          pid: typeof s.pid === "number" ? s.pid : null,
          pgid: typeof s.pgid === "number" ? s.pgid : null,
          startedAt: typeof s.startedAt === "number" ? s.startedAt : null,
          status: "stopped", // 运行状态实时计算，磁盘只存 pid/startedAt
        });
      }
    }
  } catch {
    // 文件缺失或损坏时从空状态开始
  }
}

function persist(): void {
  try {
    mkdirSync(COLLAB_DIR, { recursive: true });
    const list: Record<string, PersistedService> = {};
    for (const [projectPath, s] of services) {
      if (s.pid || s.pgid) {
        list[projectPath] = {
          pid: s.pid,
          pgid: s.pgid,
          startedAt: s.startedAt,
        };
      }
    }
    const tmp = `${DATA_FILE}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ services: list }, null, 2), "utf-8");
    renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("[service-manager] Failed to persist services:", err);
  }
}

function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 进程组存活探测：detached 后 pgid === child.pid，负 pid 探活整个进程组 */
function isProcessGroupAlive(pgid: number): boolean {
  if (!pgid || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function effectiveStatus(projectPath: string): ServiceStatus {
  const record = services.get(projectPath);
  if (!record?.pid) return "stopped";
  const child = children.get(projectPath);
  if (child) {
    return child.exitCode === null ? "running" : "exited";
  }
  // 双重检测：上报的真实服务 pid 存活 且 进程组存活，两者都成立才算运行中。
  // 避免仅看进程组导致"服务已死但进程组有残留进程"时误报 running。
  const pidAlive = isAlive(record.pid);
  const groupAlive =
    record.pgid !== null &&
    record.pgid !== undefined &&
    isProcessGroupAlive(record.pgid);
  return pidAlive && groupAlive ? "running" : "exited";
}

export function getLogPath(projectPath: string): string {
  // 日志文件按 projectPath 的 md5 唯一命名，避免路径字符歧义
  const hash = createHash("md5").update(projectPath).digest("hex");
  return join(LOGS_DIR, `${hash}.log`);
}

export interface ServiceLogsResult {
  projectPath: string;
  logPath: string;
  content: string;
  totalLines: number;
}

/** 查询服务日志：默认返回末尾 200 行，lines <= 0 时返回全部。 */
export function readServiceLogs(
  projectPath: string,
  lines = 200,
): ServiceLogsResult {
  const logPath = getLogPath(projectPath);
  if (!existsSync(logPath)) {
    return { projectPath, logPath, content: "", totalLines: 0 };
  }
  const full = readFileSync(logPath, "utf-8");
  const allLines = full.split("\n");
  const trimmed = full.endsWith("\n") ? allLines.slice(0, -1) : allLines;
  const total = trimmed.length;
  const content =
    lines > 0 && total > lines
      ? trimmed.slice(-lines).join("\n")
      : trimmed.join("\n");
  return { projectPath, logPath, content, totalLines: total };
}

function validateProject(projectPath: string): void {
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    throw new Error("projectPath 不能为空");
  }
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`项目目录不存在: ${projectPath}`);
  }
  if (!existsSync(join(projectPath, "start.sh"))) {
    throw new Error(`项目 ${projectPath} 下没有 start.sh 脚本`);
  }
}

function snapshot(record: ManagedService): ManagedService {
  const out: ManagedService = {
    projectPath: record.projectPath,
    pid: record.pid,
    startedAt: record.startedAt,
    status: effectiveStatus(record.projectPath),
  };
  if (record.exitCode !== undefined) out.exitCode = record.exitCode;
  if (record.exitSignal !== undefined) out.exitSignal = record.exitSignal;
  if (record.startError !== undefined) out.startError = record.startError;
  if (record.pgid !== undefined) out.pgid = record.pgid;
  if (record.httpPort !== undefined) out.httpPort = record.httpPort;
  if (record.message !== undefined) out.message = record.message;
  return out;
}

type ChildOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "timeout" }
  | { kind: "error" };

/** 阻塞等待子进程退出 / 超时 / spawn 错误，任一触发后移除其余监听。用 close 而非 exit，
 *  确保 stdout 数据(含 COLLAB_PID/COLLAB_ERROR 标记)已被完整读取后再解析。 */
function waitForChildOutcome(
  child: ChildProcess,
  timeoutMs: number,
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ kind: "exit", code, signal });
    const onError = () => finish({ kind: "error" });
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(outcome);
    };
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
  });
}

export async function startService(
  projectPath: string,
  timeoutMs = START_TIMEOUT_MS,
): Promise<ManagedService> {
  validateProject(projectPath);
  const existing = services.get(projectPath);
  if (existing?.pid && effectiveStatus(projectPath) === "running") {
    return snapshot(existing);
  }

  mkdirSync(LOGS_DIR, { recursive: true });
  // 每次启动截断日志文件，只保留本次运行的输出
  const prevFd = logFds.get(projectPath);
  if (prevFd !== undefined) {
    try {
      closeSync(prevFd);
    } catch {
      // 已关闭
    }
  }
  const logFd = openSync(getLogPath(projectPath), "w");
  logFds.set(projectPath, logFd);

  const child = spawn("bash", ["start.sh"], {
    cwd: projectPath,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pgid = child.pid ?? null;

  // 解析脚本通过 stdout 上报的 PID 与失败原因标记，同时 tee 到日志文件
  let reportedPid: number | null = null;
  let reportedError: string | null = null;
  let reportedHttpPort: number | null = null;
  let reportedMessage: string | null = null;
  let stdoutBuf = "";
  const teeLog = (chunk: Buffer) => {
    try {
      writeSync(logFd, chunk);
    } catch {
      // 日志已关闭
    }
  };
  const parseStdout = (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf-8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.startsWith("COLLAB_PID:")) {
        const pidMatch = line.match(/^COLLAB_PID:(\d+)/);
        if (pidMatch) reportedPid = Number(pidMatch[1]);
        continue;
      }
      if (line.startsWith("COLLAB_HTTP_PORT:")) {
        const portMatch = line.match(/^COLLAB_HTTP_PORT:(\d+)/);
        if (portMatch) reportedHttpPort = Number(portMatch[1]);
        continue;
      }
      if (line.startsWith("COLLAB_MESSAGE:")) {
        const msgMatch = line.match(/^COLLAB_MESSAGE:(.+)/);
        if (msgMatch) reportedMessage = msgMatch[1].trim();
        continue;
      }
      const errMatch = line.match(/^COLLAB_ERROR:(.+)/);
      if (errMatch) reportedError = errMatch[1].trim();
    }
  };
  child.stdout?.on("data", (chunk) => {
    teeLog(chunk);
    parseStdout(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    teeLog(chunk);
  });

  const outcome = await waitForChildOutcome(child, timeoutMs);

  // stdout 流关闭后兜底解析残留行（最后一行可能无换行符）
  if (stdoutBuf.trim().length > 0) {
    const line = stdoutBuf.trim();
    const pidMatch = line.match(/^COLLAB_PID:(\d+)/);
    if (pidMatch) reportedPid = Number(pidMatch[1]);
    const portMatch = line.match(/^COLLAB_HTTP_PORT:(\d+)/);
    if (portMatch) reportedHttpPort = Number(portMatch[1]);
    const msgMatch = line.match(/^COLLAB_MESSAGE:(.+)/);
    if (msgMatch) reportedMessage = msgMatch[1].trim();
    const errMatch = line.match(/^COLLAB_ERROR:(.+)/);
    if (errMatch) reportedError = errMatch[1].trim();
  }

  const record: ManagedService = {
    projectPath,
    pid: null,
    startedAt: Date.now(),
    status: "running",
    pgid,
  };
  if (reportedHttpPort !== null) record.httpPort = reportedHttpPort;
  if (reportedMessage !== null) record.message = reportedMessage;

  if (outcome.kind === "exit") {
    record.exitCode = outcome.code;
    record.exitSignal = outcome.signal;
    if (outcome.code === 0) {
      if (reportedPid !== null) {
        record.status = "running";
        record.pid = reportedPid;
      } else {
        record.status = "failed";
        record.startError = "no-pid";
      }
    } else {
      record.status = "failed";
      record.startError = reportedError ?? undefined;
    }
  } else if (outcome.kind === "timeout") {
    record.status = "failed";
    record.startError = "timeout";
    if (pgid !== null) killProcessTree(pgid);
  } else {
    record.status = "failed";
    record.startError = "spawn";
  }

  services.set(projectPath, record);
  children.delete(projectPath);

  const fd = logFds.get(projectPath);
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      // 已关闭
    }
    logFds.delete(projectPath);
  }

  persist();
  // 返回启动判定结果：成功=running，失败=failed；不经过实时探活覆盖。
  const result: ManagedService = {
    projectPath,
    pid: record.pid,
    startedAt: record.startedAt,
    status: record.status,
  };
  if (record.exitCode !== undefined) result.exitCode = record.exitCode;
  if (record.exitSignal !== undefined) result.exitSignal = record.exitSignal;
  if (record.startError !== undefined) result.startError = record.startError;
  if (record.pgid !== undefined) result.pgid = record.pgid;
  if (record.httpPort !== undefined) result.httpPort = record.httpPort;
  if (record.message !== undefined) result.message = record.message;
  return result;
}

function killProcessTree(pid: number): void {
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      // detached 后子进程是进程组组长（pgid === pid），杀负 pid 即杀整组，
      // 覆盖 start.sh 内部拉起的后台子进程
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // 进程已不存在
  }
}

async function waitForExit(pgid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(pgid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pgid, "SIGKILL");
    }
  } catch {
    // 已退出
  }
}

export async function stopService(
  projectPath: string,
): Promise<ManagedService> {
  const record = services.get(projectPath);
  if (!record?.pid && !record?.pgid) {
    return { projectPath, pid: null, startedAt: null, status: "stopped" };
  }
  const pgid = record.pgid ?? record.pid;
  killProcessTree(pgid);
  await waitForExit(pgid, 5000);
  record.pid = null;
  record.pgid = null;
  record.startedAt = null;
  persist();
  return snapshot(record);
}

export async function restartService(
  projectPath: string,
): Promise<ManagedService> {
  await stopService(projectPath);
  return startService(projectPath);
}

export function checkService(projectPath: string): ManagedService {
  const record = services.get(projectPath);
  if (!record) {
    return { projectPath, pid: null, startedAt: null, status: "stopped" };
  }
  return snapshot(record);
}

const STALE_CLEANUP_MS = 24 * 60 * 60 * 1000;

/** 清理超过 1 天且未在运行的服务记录；已停止的（无 startedAt）保留，供 checkService 查询历史状态 */
function cleanupStaleServices(): void {
  const cutoff = Date.now() - STALE_CLEANUP_MS;
  let changed = false;
  for (const [projectPath, record] of services) {
    if (effectiveStatus(projectPath) === "running") continue;
    if (record.startedAt === null || record.startedAt >= cutoff) continue;
    const fd = logFds.get(projectPath);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 已关闭
      }
      logFds.delete(projectPath);
    }
    services.delete(projectPath);
    children.delete(projectPath);
    changed = true;
  }
  if (changed) persist();
}

export function listServices(): ManagedService[] {
  cleanupStaleServices();
  const result: ManagedService[] = [];
  for (const record of services.values()) {
    const snap = snapshot(record);
    if (snap.status === "running") {
      result.push(snap);
    }
  }
  return result;
}

/**
 * 应用退出清理：只关闭日志文件描述符。
 * start.sh 服务进程 detached 独立运行，不随 Collaborator 退出。
 */
export function shutdownServices(): void {
  for (const [projectPath, fd] of logFds) {
    try {
      closeSync(fd);
    } catch {
      // 已关闭
    }
    logFds.delete(projectPath);
  }
}

load();
