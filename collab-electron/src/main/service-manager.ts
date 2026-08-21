import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { COLLAB_DIR } from "./paths";

export type ServiceStatus = "running" | "stopped" | "exited";

export interface ManagedService {
  projectPath: string;
  pid: number | null;
  startedAt: number | null;
  status: ServiceStatus;
  exitCode?: number | null;
  exitSignal?: string | null;
}

interface PersistedService {
  pid: number | null;
  startedAt: number | null;
}

const IS_WIN = process.platform === "win32";
const DATA_FILE = join(COLLAB_DIR, "services.json");
const LOGS_DIR = join(COLLAB_DIR, "services-logs");

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
      if (s.pid) {
        list[projectPath] = { pid: s.pid, startedAt: s.startedAt };
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

function effectiveStatus(projectPath: string): ServiceStatus {
  const record = services.get(projectPath);
  if (!record?.pid) return "stopped";
  const child = children.get(projectPath);
  if (child) {
    return child.exitCode === null ? "running" : "exited";
  }
  return isAlive(record.pid) ? "running" : "exited";
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
  return out;
}

export function startService(projectPath: string): ManagedService {
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
    stdio: ["ignore", logFd, logFd],
  });

  const record: ManagedService = {
    projectPath,
    pid: child.pid ?? null,
    startedAt: Date.now(),
    status: "running",
  };
  services.set(projectPath, record);
  children.set(projectPath, child);

  child.on("exit", (code, signal) => {
    const cur = services.get(projectPath);
    if (cur && cur.pid === child.pid) {
      cur.status = "exited";
      cur.exitCode = code;
      cur.exitSignal = signal ?? null;
      persist();
    }
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
  });
  child.on("error", (err) => {
    console.error("[service-manager] spawn error:", projectPath, err.message);
  });

  persist();
  return snapshot(record);
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

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 已退出
  }
}

export async function stopService(
  projectPath: string,
): Promise<ManagedService> {
  const record = services.get(projectPath);
  if (!record?.pid) {
    return { projectPath, pid: null, startedAt: null, status: "stopped" };
  }
  killProcessTree(record.pid);
  await waitForExit(record.pid, 5000);
  record.pid = null;
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

export function listServices(): ManagedService[] {
  const result: ManagedService[] = [];
  for (const record of services.values()) {
    result.push(snapshot(record));
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
