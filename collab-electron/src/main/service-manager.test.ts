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
import { dirname, join } from "node:path";

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

afterAll(async () => {
  for (const s of listServices()) {
    if (s.pid) {
      await stopService(s.projectPath).catch(() => {});
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("service-manager", () => {
  test("startService throws Chinese error when start.sh missing", () => {
    const dir = makeProject();
    expect(() => startService(dir)).toThrow(/没有 start.sh 脚本/);
  });

  test("startService throws when projectPath is not a directory", () => {
    const dir = join(tmpdir(), "no-such-dir-00000");
    expect(() => startService(dir)).toThrow(/项目目录不存在/);
  });

  test("start then check reports running with matching pid", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\nsleep 30\n");
    const s = startService(dir);
    expect(s.status).toBe("running");
    expect(s.pid).toBeGreaterThan(0);
    expect(s.projectPath).toBe(dir);

    const running = checkService(dir);
    expect(running.status).toBe("running");
    expect(running.pid).toBe(s.pid);
  });

  test("start is idempotent while running", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\nsleep 30\n");
    const first = startService(dir);
    const second = startService(dir);
    expect(second.pid).toBe(first.pid);
  });

  test("stop terminates the process and nulls the pid", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\nsleep 30\n");
    const s = startService(dir);
    expect(s.status).toBe("running");

    const stopped = await stopService(dir);
    expect(stopped.status).toBe("stopped");
    expect(stopped.pid).toBeNull();

    const after = checkService(dir);
    expect(after.status).toBe("stopped");
  });

  test("restart changes pid and keeps running", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\nsleep 30\n");
    const first = startService(dir);
    await new Promise((r) => setTimeout(r, 100));
    const second = await restartService(dir);
    expect(second.status).toBe("running");
    expect(second.pid).not.toBe(first.pid);
  });

  test("listServices returns all managed services", async () => {
    const dir1 = makeProject();
    const dir2 = makeProject();
    writeStartSh(dir1, "#!/bin/bash\nsleep 30\n");
    writeStartSh(dir2, "#!/bin/bash\nsleep 30\n");
    startService(dir1);
    startService(dir2);

    const list = listServices();
    const byPath = new Map(list.map((s) => [s.projectPath, s]));
    expect(byPath.get(dir1)?.status).toBe("running");
    expect(byPath.get(dir2)?.status).toBe("running");
  });

  test("logs are written to disk", async () => {
    const dir = makeProject();
    writeStartSh(dir, "#!/bin/bash\necho hello-svc-log\nsleep 30\n");
    startService(dir);
    await new Promise((r) => setTimeout(r, 300));

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
    writeStartSh(dir, "#!/bin/bash\necho run-one\nsleep 30\n");
    startService(dir);
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(getLogPath(dir), "utf-8")).toContain("run-one");

    writeStartSh(dir, "#!/bin/bash\necho run-two\nsleep 30\n");
    await restartService(dir);
    await new Promise((r) => setTimeout(r, 300));
    const content = readFileSync(getLogPath(dir), "utf-8");
    expect(content).toContain("run-two");
    expect(content).not.toContain("run-one");
  });

  test("readServiceLogs returns tail of 200 lines by default", async () => {
    const dir = makeProject();
    writeStartSh(
      dir,
      "#!/bin/bash\nfor i in $(seq 1 300); do echo log-$i; done\nsleep 30\n",
    );
    startService(dir);
    await new Promise((r) => setTimeout(r, 300));

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
