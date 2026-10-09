import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import { WORKLOG_DIR } from "./paths";

/**
 * 工作记录(~/.collab/worklog/YYYY-MM-DD.jsonl)的读取与聚合。
 * 记录由 collab-claude-plugin 的 worklog-record.sh 追加写入, 一行一条:
 * {ts, session_id, cwd, prompt, transcript}。本模块只读, 坏行跳过。
 */

export interface WorklogPrompt {
  ts: string;
  prompt: string;
}

export interface WorklogSession {
  sessionId: string;
  firstTs: string;
  lastTs: string;
  /** 该会话最后一条记录携带的 transcript 路径(skill 深入阅读用) */
  transcript?: string;
  prompts: WorklogPrompt[];
}

export interface WorklogCwdGroup {
  cwd: string;
  alias: string | null;
  firstTs: string;
  lastTs: string;
  sessions: WorklogSession[];
}

export interface WorklogDay {
  date: string;
  groups: WorklogCwdGroup[];
}

export interface WorklogDaySummary {
  date: string;
  sessionCount: number;
  promptCount: number;
}

interface WorklogRecord {
  ts: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  transcript?: string;
}

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function parseLine(line: string): WorklogRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      typeof raw.ts !== "string" ||
      typeof raw.session_id !== "string" ||
      typeof raw.prompt !== "string"
    ) {
      return null;
    }
    return {
      ts: raw.ts,
      sessionId: raw.session_id,
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      prompt: raw.prompt,
      transcript:
        typeof raw.transcript === "string" && raw.transcript.length > 0
          ? raw.transcript
          : undefined,
    };
  } catch {
    return null;
  }
}

function readRecords(dir: string, date: string): WorklogRecord[] {
  const file = join(dir, `${date}.jsonl`);
  if (!existsSync(file)) return [];
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out: WorklogRecord[] = [];
  for (const line of content.split("\n")) {
    const rec = parseLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

/** 目录下所有按天文件 → 汇总(记录数 / 去重会话数), 日期倒序 */
export function listWorklogDays(dir: string): WorklogDaySummary[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const summaries: WorklogDaySummary[] = [];
  for (const file of files) {
    const m = DATE_FILE_RE.exec(file);
    if (!m) continue;
    const date = m[1]!;
    const records = readRecords(dir, date);
    if (records.length === 0) continue;
    summaries.push({
      date,
      sessionCount: new Set(records.map((r) => r.sessionId)).size,
      promptCount: records.length,
    });
  }
  summaries.sort((a, b) => (a.date < b.date ? 1 : -1));
  return summaries;
}

/**
 * 某天记录 → cwd 分组,组内按 sessionId 聚合。
 * 组按 lastTs 倒序;session 按 firstTs 升序;prompt 按 ts 升序。
 * alias 由调用方注入(找不到返回 null)。日期参数非法直接返回空。
 */
export function readWorklogDay(
  dir: string,
  date: string,
  resolveAlias?: (cwd: string) => string | null,
): WorklogDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { date, groups: [] };
  }
  const records = readRecords(dir, date);

  const byCwd = new Map<string, WorklogRecord[]>();
  for (const rec of records) {
    const list = byCwd.get(rec.cwd);
    if (list) list.push(rec);
    else byCwd.set(rec.cwd, [rec]);
  }

  const groups: WorklogCwdGroup[] = [];
  for (const [cwd, recs] of byCwd) {
    const bySession = new Map<string, WorklogRecord[]>();
    for (const rec of recs) {
      const list = bySession.get(rec.sessionId);
      if (list) list.push(rec);
      else bySession.set(rec.sessionId, [rec]);
    }
    const sessions: WorklogSession[] = [];
    for (const [sessionId, srecs] of bySession) {
      srecs.sort((a, b) => (a.ts < b.ts ? -1 : 1));
      const session: WorklogSession = {
        sessionId,
        firstTs: srecs[0]!.ts,
        lastTs: srecs[srecs.length - 1]!.ts,
        prompts: srecs.map((r) => ({ ts: r.ts, prompt: r.prompt })),
      };
      // 回溯取最近一次携带的 transcript(个别记录缺字段时保留已知值)
      for (let i = srecs.length - 1; i >= 0; i--) {
        const t = srecs[i]!.transcript;
        if (t) {
          session.transcript = t;
          break;
        }
      }
      sessions.push(session);
    }
    sessions.sort((a, b) => (a.firstTs < b.firstTs ? -1 : 1));
    const allTs = recs.map((r) => r.ts).sort();
    groups.push({
      cwd,
      alias: resolveAlias?.(cwd) ?? null,
      firstTs: allTs[0]!,
      lastTs: allTs[allTs.length - 1]!,
      sessions,
    });
  }
  groups.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  return { date, groups };
}

// -- IPC --

export function registerWorklogIpc(opts: {
  resolveAlias: (cwd: string) => string | null;
}): void {
  ipcMain.handle("worklog:days", () => listWorklogDays(WORKLOG_DIR));
  ipcMain.handle("worklog:day", (_event, date: string) =>
    readWorklogDay(WORKLOG_DIR, String(date ?? ""), opts.resolveAlias),
  );
}
