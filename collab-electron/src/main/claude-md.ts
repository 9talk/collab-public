import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./files";

export const COLLAB_START = "<!-- COLLAB_START -->";
export const COLLAB_END = "<!-- COLLAB_END -->";

// 正文模板存于插件目录（随插件打包），用户可直接编辑该 md 文件。
// 默认正文仅在文件缺失/损坏时回退。
export const DEFAULT_BLOCK_BODY = `## Collaborator

- **服务管理 MCP**（when available）：用 \`devtool_start\`、\`devtool_restart\`、\`devtool_stop\`、\`devtool_check\`、\`devtool_list\` 管理项目后台服务。启动要求项目目录存在 \`start.sh\`，服务独立运行，日志在 \`~/.collab/services-logs/\`

需要管理项目服务时，优先使用以上能力。`;

let blockFile: string | null = null;

/** 注入正文模板文件路径（启动时由主进程用插件目录路径设置）。 */
export function setClaudeMdBlockFile(path: string): void {
  blockFile = path;
}

function resolveBlockFile(): string {
  if (blockFile) return blockFile;
  // 未注入时的回退：dev/测试场景下相对本文件解析插件目录
  return join(
    __dirname,
    "..",
    "..",
    "packages",
    "collab-claude-plugin",
    "claude-md-block.md",
  );
}

function readBlockBody(): string {
  try {
    const content = readFileSync(resolveBlockFile(), "utf-8").trim();
    if (content !== "") return content;
  } catch {
    // 文件缺失或损坏时回退默认正文
  }
  return DEFAULT_BLOCK_BODY;
}

/** 组装完整段落（含 COLLAB 标签），每次读取最新正文。 */
export function getCollabBlock(): string {
  return `${COLLAB_START}\n${readBlockBody()}\n${COLLAB_END}`;
}

export type SyncResult = "inserted" | "updated" | "unchanged";

function claudeMdPath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}

function readLines(filePath: string): string[] | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8").split("\n");
  } catch {
    return null;
  }
}

interface BlockLocation {
  startIdx: number;
  endIdx: number;
}

// 标签必须独占一行、行首开始且前后无空格（整行精确匹配）
function findBlock(lines: string[]): BlockLocation | null {
  const startIdx = lines.findIndex((l) => l === COLLAB_START);
  if (startIdx === -1) return null;
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === COLLAB_END);
  if (endIdx === -1) return null;
  return { startIdx, endIdx };
}

/**
 * 同步 ~/.claude/CLAUDE.md 中的 COLLAB 段落：
 * - 无完整段落（含孤立标签）→ 文件末尾插入一次
 * - 段落内容与当前模板不同 → 替换更新一次
 * - 内容一致 → 不变
 */
export function syncClaudeMdBlock(): SyncResult {
  const filePath = claudeMdPath();
  const lines = readLines(filePath);

  if (lines === null) {
    mkdirSync(dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, getCollabBlock() + "\n");
    return "inserted";
  }

  const block = findBlock(lines);
  if (block === null) {
    // 无完整段落：先清除孤立的 START/END 标签，再追加
    const cleaned = lines.filter((l) => l !== COLLAB_START && l !== COLLAB_END);
    let content = cleaned.join("\n");
    if (content.trim() !== "" && !content.endsWith("\n")) {
      content += "\n";
    }
    content += getCollabBlock() + "\n";
    atomicWriteFileSync(filePath, content);
    return "inserted";
  }

  const body = lines.slice(block.startIdx + 1, block.endIdx).join("\n");
  const blockBody = readBlockBody();
  if (body === blockBody) return "unchanged";

  const updated = [
    ...lines.slice(0, block.startIdx),
    ...getCollabBlock().split("\n"),
    ...lines.slice(block.endIdx + 1),
  ].join("\n");
  atomicWriteFileSync(filePath, updated);
  return "updated";
}

/**
 * 移除 ~/.claude/CLAUDE.md 中的 COLLAB 段落（深度集成关闭时调用）。
 * 文件剩余内容为空则删除文件。
 */
export function removeClaudeMdBlock(): "removed" | "unchanged" {
  const filePath = claudeMdPath();
  const lines = readLines(filePath);
  if (lines === null) return "unchanged";

  const block = findBlock(lines);
  if (block === null) {
    const cleaned = lines.filter((l) => l !== COLLAB_START && l !== COLLAB_END);
    if (cleaned.length === lines.length) return "unchanged";
    writeRemaining(filePath, cleaned);
    return "removed";
  }

  writeRemaining(filePath, [
    ...lines.slice(0, block.startIdx),
    ...lines.slice(block.endIdx + 1),
  ]);
  return "removed";
}

function writeRemaining(filePath: string, remaining: string[]): void {
  const content = remaining.join("\n");
  if (content.trim() === "") {
    try {
      rmSync(filePath);
    } catch {
      // 文件已不存在
    }
  } else {
    atomicWriteFileSync(filePath, content);
  }
}
