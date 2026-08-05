import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { COLLAB_DIR } from "./paths";
import { registerMethod } from "./json-rpc-server";

const EDITS_FILE = join(COLLAB_DIR, "claude-edits.jsonl");
const EDITS_LOG_DIR = join(COLLAB_DIR, "logs");
const EDITS_MAX_LINES = 2000;
const EDITS_LOG_RETENTION_DAYS = 7;

export interface ClaudeEditEvent {
  toolName: string;
  filePath: string;
  oldString: string;
  newString: string;
  cwd: string;
  sessionId: string;
  tileId: string;
  receivedAt: number; // Unix timestamp ms
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 按天轮转的归档日志路径:logs/claude-edits-yyyy-MM-dd.jsonl */
function dailyLogPath(): string {
  return join(EDITS_LOG_DIR, `claude-edits-${dateStamp()}.jsonl`);
}

function appendLine(path: string, line: string): void {
  mkdirSync(EDITS_LOG_DIR, { recursive: true });
  writeFileSync(path, line, { flag: "a" });
}

/** 主文件 FIFO 截断:最多保留 EDITS_MAX_LINES 行(先进先出) */
function trimEditsFile(): void {
  const text = readFileSync(EDITS_FILE, "utf-8");
  const lines = text.split("\n");
  // 文件以 \n 结尾时 split 会多一个末尾空串,按真实行数判断
  const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
  if (lineCount <= EDITS_MAX_LINES) return;
  const trimmed = lines.slice(lineCount - EDITS_MAX_LINES).join("\n");
  writeFileSync(EDITS_FILE, trimmed);
}

/** 清理超过保留天数的按天归档日志 */
function pruneDailyLogs(): void {
  const cutoff = Date.now() - EDITS_LOG_RETENTION_DAYS * 86400000;
  let files: string[] = [];
  try {
    files = readdirSync(EDITS_LOG_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    const match = /^claude-edits-\d{4}-\d{2}-\d{2}\.jsonl$/.exec(name);
    if (!match) continue;
    const ts = new Date(`${match[1]}T00:00:00Z`).getTime();
    if (!Number.isNaN(ts) && ts < cutoff) {
      try {
        unlinkSync(join(EDITS_LOG_DIR, name));
      } catch {
        // ignore
      }
    }
  }
}

/** 在文件中定位某行:先精确匹配,失败则回退为包含匹配 */
function lineIndexOf(fileLines: string[], needle: string): number | null {
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i] === needle) return i + 1;
  }
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].includes(needle)) return i + 1;
  }
  return null;
}

/**
 * 根据 filePath 查找该文件最新的修改行号(1-based)。
 * 取 claude-edits.jsonl 中该文件最新记录的 newString,按 \n 拆分取第一段、
 * 去掉 \r 后,在磁盘文件中查找该行,返回行号。找不到返回 null。
 */
export function findLatestEditLine(filePath: string): number | null {
  let needle = "";
  try {
    const lines = readFileSync(EDITS_FILE, "utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let record: ClaudeEditEvent;
      try {
        record = JSON.parse(line) as ClaudeEditEvent;
      } catch {
        continue;
      }
      if (record.filePath !== filePath) continue;
      needle = record.newString.split("\n")[0].replace(/\r/g, "");
      break;
    }
  } catch {
    return null;
  }
  if (!needle) return null;
  try {
    const fileLines = readFileSync(filePath, "utf-8").split("\n");
    return lineIndexOf(fileLines, needle);
  } catch {
    return null;
  }
}

export function registerClaudeEditsRpc(): void {
  pruneDailyLogs();

  registerMethod(
    "claude.edit",
    (params: unknown) => {
      const p = params as {
        tileId: string;
        event: {
          tool_name?: string;
          tool_input?: Record<string, unknown>;
          session_id?: string;
          cwd?: string;
        };
      };
      if (!p.tileId || typeof p.tileId !== "string") {
        throw new Error("tileId is required");
      }
      const input = p.event?.tool_input;
      if (!input || typeof input !== "object") {
        throw new Error("event.tool_input is required");
      }
      const filePath =
        typeof input.file_path === "string" ? input.file_path : "";
      if (!filePath) {
        throw new Error("event.tool_input.file_path is required");
      }
      const oldString =
        typeof input.old_string === "string" ? input.old_string : "";
      const newString =
        typeof input.new_string === "string" ? input.new_string : "";
      const cwd = typeof p.event.cwd === "string" ? p.event.cwd : "";
      const sessionId =
        typeof p.event.session_id === "string" ? p.event.session_id : "";
      const record: ClaudeEditEvent = {
        toolName:
          typeof p.event.tool_name === "string" ? p.event.tool_name : "",
        filePath: isAbsolute(filePath) ? filePath : resolve(cwd, filePath),
        oldString,
        newString,
        cwd,
        sessionId,
        tileId: p.tileId,
        receivedAt: Date.now(),
      };
      const line = JSON.stringify(record) + "\n";
      // 主文件:限制 2000 条,超出 FIFO 截断
      appendLine(EDITS_FILE, line);
      trimEditsFile();
      // 按天归档:最多保留 7 天
      appendLine(dailyLogPath(), line);
      return { ok: true };
    },
    {
      description:
        "Record a Claude Code file-edit event (PostToolUse hook) to the edits log",
      params: {
        tileId: "string (required)",
        event: "PostToolUse hook JSON (tool_name, tool_input, session_id, cwd)",
      },
    },
  );
}
