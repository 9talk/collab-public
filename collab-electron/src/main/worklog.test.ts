import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// worklog.ts 顶层 import electron(仅注册 IPC 用);纯逻辑测试不触达 IPC,
// 但模块加载需要 mock。
mock.module("electron", () => ({
  ipcMain: { on: () => {}, handle: () => {} },
}));

const { listWorklogDays, readWorklogDay } = await import("./worklog");

const ROOT = join(tmpdir(), `worklog-test-${Date.now()}`);
const DIR = join(ROOT, "worklog");

function writeLines(file: string, lines: string[]) {
  writeFileSync(join(DIR, file), lines.join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("listWorklogDays", () => {
  test("目录不存在返回空数组", () => {
    expect(listWorklogDays(join(ROOT, "missing"))).toEqual([]);
  });

  test("按天汇总记录数与会话数, 倒序", () => {
    writeLines("2026-10-08.jsonl", [
      JSON.stringify({
        ts: "2026-10-08T10:00:00+0800",
        session_id: "a",
        cwd: "/w1",
        prompt: "p1",
      }),
      JSON.stringify({
        ts: "2026-10-08T11:00:00+0800",
        session_id: "a",
        cwd: "/w1",
        prompt: "p2",
      }),
      JSON.stringify({
        ts: "2026-10-08T12:00:00+0800",
        session_id: "b",
        cwd: "/w2",
        prompt: "p3",
      }),
    ]);
    writeLines("2026-10-09.jsonl", [
      JSON.stringify({
        ts: "2026-10-09T09:00:00+0800",
        session_id: "c",
        cwd: "/w1",
        prompt: "p4",
      }),
    ]);
    expect(listWorklogDays(DIR)).toEqual([
      { date: "2026-10-09", sessionCount: 1, promptCount: 1 },
      { date: "2026-10-08", sessionCount: 2, promptCount: 3 },
    ]);
  });

  test("坏行跳过; 非日期文件忽略", () => {
    writeLines("2026-10-08.jsonl", [
      JSON.stringify({
        ts: "2026-10-08T10:00:00+0800",
        session_id: "a",
        cwd: "/w1",
        prompt: "p1",
      }),
      "{broken",
      "",
    ]);
    writeFileSync(join(DIR, "readme.txt"), "x", "utf-8");
    expect(listWorklogDays(DIR)).toEqual([
      { date: "2026-10-08", sessionCount: 1, promptCount: 1 },
    ]);
  });
});

describe("readWorklogDay", () => {
  const lines = [
    JSON.stringify({
      ts: "2026-10-08T10:00:00+0800",
      session_id: "a",
      cwd: "/w1",
      prompt: "p1",
      transcript: "/t/a.jsonl",
    }),
    JSON.stringify({
      ts: "2026-10-08T12:00:00+0800",
      session_id: "b",
      cwd: "/w2",
      prompt: "p2",
      transcript: "/t/b.jsonl",
    }),
    JSON.stringify({
      ts: "2026-10-08T11:00:00+0800",
      session_id: "a",
      cwd: "/w1",
      prompt: "p3",
    }),
  ];

  test("按 cwd 分组、组内按 session 聚合、按时间排序", () => {
    writeLines("2026-10-08.jsonl", lines);
    const day = readWorklogDay(DIR, "2026-10-08");
    expect(day.date).toBe("2026-10-08");
    // 两组: /w2(最新 12:00) 的 lastTs 晚于 /w1(11:00) → /w2 在前
    expect(day.groups.map((g) => g.cwd)).toEqual(["/w2", "/w1"]);
    const w1 = day.groups.find((g) => g.cwd === "/w1")!;
    expect(w1.sessions.length).toBe(1);
    expect(w1.sessions[0]!.sessionId).toBe("a");
    expect(w1.sessions[0]!.prompts.map((p) => p.prompt)).toEqual(["p1", "p3"]);
    expect(w1.sessions[0]!.transcript).toBe("/t/a.jsonl");
    expect(w1.firstTs).toBe("2026-10-08T10:00:00+0800");
  });

  test("alias 回调注入", () => {
    writeLines("2026-10-08.jsonl", lines);
    const day = readWorklogDay(DIR, "2026-10-08", (cwd) =>
      cwd === "/w1" ? "项目一" : null,
    );
    expect(day.groups.find((g) => g.cwd === "/w1")!.alias).toBe("项目一");
    expect(day.groups.find((g) => g.cwd === "/w2")!.alias).toBeNull();
  });

  test("坏行跳过; 不存在的日期返回空分组", () => {
    writeLines("2026-10-08.jsonl", [lines[0]!, "{broken"]);
    expect(readWorklogDay(DIR, "2026-10-08").groups.length).toBe(1);
    expect(readWorklogDay(DIR, "2026-01-01").groups).toEqual([]);
  });

  test("非法日期参数不触达文件系统", () => {
    expect(readWorklogDay(DIR, "../etc/passwd").groups).toEqual([]);
  });
});
