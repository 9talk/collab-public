import { describe, test, expect, afterAll, mock } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "svc-test-data-"));

mock.module("./paths", () => ({ COLLAB_DIR: dataDir }));

const {
  startService,
  stopService,
  restartService,
  checkService,
  listServices,
  getLogPath,
  readServiceLogs,
} = await import("./service-manager");

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "svc-test-proj-"));
}

function writeStartSh(dir: string, body: string): void {
  writeFileSync(join(dir, "start.sh"), body, "utf-8");
}

// 后台型成功脚本：后台拉起 sleep 后上报其真实 pid，脚本自身退出
const SUCCESS_SH =
  '#!/bin/bash\nnohup sleep 30 >/dev/null 2>&1 &\necho "COLLAB_PID:$!"\nexit 0\n';
const FAIL_SH = '#!/bin/bash\necho "COLLAB_ERROR:port in use"\nexit 1\n';
const NO_PID_SH = "#!/bin/bash\nexit 0\n";

afterAll(async () => {
  for (const s of listServices()) {
    if (s.pid) {
      await stopService(s.projectPath).catch(() => {});
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("service-manager", () => {
  test("startService rejects when start.sh missing", async () => {
    const dir = makeProject();
    await expect(startService(dir)).rejects.toThrow(/没有 start.sh 脚本/);
  });

  test("startService rejects when projectPath is not a directory", async () => {
    const dir = join(tmpdir(), "no-such-dir-00000");
    await expect(startService(dir)).rejects.toThrow(/项目目录不存在/);
  });

  test("start success reports running with reported service pid", async () => {
    const dir = makeProject();
    writeStartSh(dir, SUCCESS_SH);
    const s = await startService(dir);
    expect(s.status).toBe("running");
    expect(s.pid).toBeGreaterThan(0);
    expect(s.projectPath).toBe(dir);

    const running = checkService(dir);
    expect(running.status).toBe("running");
    expect(running.pid).toBe(s.pid);
  });

  test("start is idempotent while running", async () => {
    const dir = makeProject();
    writeStartSh(dir, SUCCESS_SH);
    const first = await startService(dir);
    const second = await startService(dir);
    expect(second.pid).toBe(first.pid);
    expect(second.status).toBe("running");
  });

  test("start failure with COLLAB_ERROR reports failed + reason", async () => {
    const dir = makeProject();
    writeStartSh(dir, FAIL_SH);
    const s = await startService(dir);
    expect(s.status).toBe("failed");
    expect(s.exitCode).toBe(1);
    expect(s.startError).toBe("port in use");
  });

  test("start timeout reports failed with timeout reason", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\nsleep 200\n");
    const s = await startService(dir, 300);
    expect(s.status).toBe("failed");
    expect(s.startError).toBe("timeout");
  });

  test("start exit 0 without PID reports failed with no-pid", async () => {
    const dir = makeProject();
    writeStartSh(dir, NO_PID_SH);
    const s = await startService(dir);
    expect(s.status).toBe("failed");
    expect(s.startError).toBe("no-pid");
  });

  test("stop terminates the process group and nulls the pid", async () => {
    const dir = makeProject();
    writeStartSh(dir, SUCCESS_SH);
    const s = await startService(dir);
    expect(s.status).toBe("running");

    const stopped = await stopService(dir);
    expect(stopped.status).toBe("stopped");
    expect(stopped.pid).toBeNull();

    const after = checkService(dir);
    expect(after.status).toBe("stopped");
  });

  test("double detection: reported service pid dead => exited even if group alive", async () => {
    const dir = makeProject();
    // 进程组里跑两个 sleep，上报的 PID 是第二个；杀掉它后进程组仍留有第一个，
    // 若只查进程组会误报 running，双重检测应判 exited
    writeStartSh(
      dir,
      '#!/bin/bash\nnohup sleep 30 >/dev/null 2>&1 &\nnohup sleep 30 >/dev/null 2>&1 &\necho "COLLAB_PID:$!"\nexit 0\n',
    );
    const s = await startService(dir);
    expect(s.status).toBe("running");
    expect(s.pid).toBeGreaterThan(0);

    process.kill(s.pid as number, "SIGKILL");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && checkService(dir).status !== "exited") {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(checkService(dir).status).toBe("exited");

    await stopService(dir);
  });

  test("restart changes pid and keeps running", async () => {
    const dir = makeProject();
    writeStartSh(dir, SUCCESS_SH);
    const first = await startService(dir);
    const second = await restartService(dir);
    expect(second.status).toBe("running");
    expect(second.pid).not.toBe(first.pid);
  });

  test("listServices returns all running services", async () => {
    const dir1 = makeProject();
    const dir2 = makeProject();
    writeStartSh(dir1, SUCCESS_SH);
    writeStartSh(dir2, SUCCESS_SH);
    await startService(dir1);
    await startService(dir2);

    const list = listServices();
    const byPath = new Map(list.map((s) => [s.projectPath, s]));
    expect(byPath.get(dir1)?.status).toBe("running");
    expect(byPath.get(dir2)?.status).toBe("running");
  });

  test("listServices returns only running services", async () => {
    const runningDir = makeProject();
    const stoppedDir = makeProject();
    const failedDir = makeProject();
    writeStartSh(runningDir, SUCCESS_SH);
    writeStartSh(stoppedDir, SUCCESS_SH);
    writeStartSh(failedDir, FAIL_SH);
    await startService(runningDir);
    await startService(stoppedDir);
    await stopService(stoppedDir);
    await startService(failedDir);

    const paths = listServices().map((s) => s.projectPath);
    expect(paths).toContain(runningDir);
    expect(paths).not.toContain(stoppedDir);
    expect(paths).not.toContain(failedDir);
  });

  test("listServices cleans up stale non-running records older than a day", async () => {
    const dir = makeProject();
    writeStartSh(dir, FAIL_SH);
    await startService(dir);

    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 24 * 60 * 60 * 1000;
    try {
      const list = listServices();
      expect(list.some((s) => s.projectPath === dir)).toBe(false);
    } finally {
      Date.now = realNow;
    }

    const persisted = readFileSync(join(dataDir, "services.json"), "utf-8");
    expect(persisted).not.toContain(dir);
  });

  test("logs are written to disk", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\necho hello-svc-log\nexit 0\n");
    await startService(dir);

    const logPath = getLogPath(dir);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("hello-svc-log");
  });

  test("log file is named by md5 of projectPath", () => {
    const dir = makeProject();
    const logPath = getLogPath(dir);
    const expected = createHash("md5").update(dir).digest("hex");
    expect(logPath).toBe(join(dataDir, "services-logs", `${expected}.log`));
  });

  test("restart truncates previous logs", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\necho run-one\nexit 0\n");
    await startService(dir);
    expect(readFileSync(getLogPath(dir), "utf-8")).toContain("run-one");

    writeStartSh(dir, "#!/bin/bash\necho run-two\nexit 0\n");
    await restartService(dir);
    const content = readFileSync(getLogPath(dir), "utf-8");
    expect(content).toContain("run-two");
    expect(content).not.toContain("run-one");
  });

  test("readServiceLogs returns tail of 200 lines by default", async () => {
    const dir = makeProject();
    writeStartSh(
      dir,
      "#!/bin/bash\nfor i in $(seq 1 300); do echo log-$i; done\nexit 0\n",
    );
    await startService(dir);

    const tail = readServiceLogs(dir);
    expect(tail.totalLines).toBe(300);
    const tailLines = tail.content.split("\n");
    expect(tailLines).toHaveLength(200);
    expect(tailLines[0]).toBe("log-101");
    expect(tailLines[tailLines.length - 1]).toBe("log-300");

    const all = readServiceLogs(dir, 0);
    expect(all.content.split("\n")).toHaveLength(300);
    expect(all.content).toContain("log-1");
  });
});
