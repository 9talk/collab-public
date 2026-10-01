import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Expand a leading `~` to the home directory. Editors are spawned without a
 * shell, so a literal `~` would be treated as a relative directory name.
 */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export interface ExternalEditor {
  id: string;
  name: string;
  appPath: string;
}

const KNOWN_EDITORS: ExternalEditor[] = [
  {
    id: "intellij-idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
  },
  {
    id: "visual-studio-code",
    name: "Visual Studio Code",
    appPath: "/Applications/Visual Studio Code.app",
  },
  {
    id: "typora",
    name: "Typora",
    appPath: "/Applications/Typora.app",
  },
  {
    id: "cursor",
    name: "Cursor",
    appPath: "/Applications/Cursor.app",
  },
  {
    id: "trae",
    name: "Trae",
    appPath: "/Applications/Trae.app",
  },
  {
    id: "zed",
    name: "Zed",
    appPath: "/Applications/Zed.app",
  },
  {
    id: "qoder",
    name: "Qoder",
    appPath: "/Applications/Qoder.app",
  },
  {
    id: "sublime-text",
    name: "Sublime Text",
    appPath: "/Applications/Sublime Text.app",
  },
  {
    id: "fleet",
    name: "Fleet",
    appPath: "/Applications/Fleet.app",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    appPath: "/Applications/Obsidian.app",
  },
];

/** Always-available virtual editors (not detected from disk). */
export const VIRTUAL_EDITORS: ExternalEditor[] = [
  {
    id: "system-app",
    name: "系统应用",
    appPath: "",
  },
];

export function detectEditors(): ExternalEditor[] {
  return KNOWN_EDITORS.filter((ed) => existsSync(ed.appPath));
}

/**
 * Obsidian 的打开 URI。Obsidian 以 vault 为工作单位、没有 CLI,只能经
 * `obsidian://` scheme 打开;`path` 传绝对路径即可 —— 该参数会覆盖
 * vault/file,Obsidian 自行匹配包含此文件的最具体 vault,因此无需知道
 * vault 名,也不会顺带打开整个项目。前提是文件位于某个已注册 vault 内。
 */
export function obsidianFileUri(filePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(filePath)}`;
}

export interface ObsidianVault {
  id: string;
  path: string;
}

/** Obsidian 的 vault 注册表(macOS)。 */
export const OBSIDIAN_CONFIG_PATH = join(
  homedir(),
  "Library/Application Support/obsidian/obsidian.json",
);

/**
 * 解析 obsidian.json 的 vaults 段, 结构形如
 * `{ vaults: { "<16位id>": { path, ts, open? } } }`。
 * 判断"能否用 Obsidian 打开"必须以这份注册表为准: Obsidian 只认被它
 * 注册过的目录, 目录里有 .obsidian 并不足以说明注册过。
 */
export function parseObsidianVaults(raw: string): ObsidianVault[] {
  try {
    const parsed = JSON.parse(raw) as {
      vaults?: Record<string, { path?: unknown }>;
    };
    const entries = parsed?.vaults;
    if (!entries || typeof entries !== "object") return [];
    const out: ObsidianVault[] = [];
    for (const [id, entry] of Object.entries(entries)) {
      if (entry && typeof entry.path === "string" && entry.path.length > 0) {
        out.push({ id, path: entry.path });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function loadObsidianVaults(): ObsidianVault[] {
  try {
    return parseObsidianVaults(readFileSync(OBSIDIAN_CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }
}

/**
 * 返回包含该路径的最具体 vault; 不在任何 vault 内返回 null。
 * "最具体"取路径最长者, 与 Obsidian 匹配嵌套 vault 的规则一致; 比较
 * 按目录边界进行, 避免 /a/notes 误匹配 /a/notes-archive。
 */
export function findContainingVault(
  targetPath: string,
  vaults: ObsidianVault[],
): ObsidianVault | null {
  let best: ObsidianVault | null = null;
  let bestLen = -1;
  for (const vault of vaults) {
    const base = vault.path.endsWith("/")
      ? vault.path.slice(0, -1)
      : vault.path;
    if (targetPath !== base && !targetPath.startsWith(`${base}/`)) continue;
    if (base.length > bestLen) {
      best = vault;
      bestLen = base.length;
    }
  }
  return best;
}

function spawnEditor(bin: string, args: string[]): void {
  console.log("[external-editor] spawning:", bin, args);
  spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
}

function openWithCodeFork(appPath: string, filePath: string): void {
  const codeBin = `${appPath}/Contents/Resources/app/bin/code`;
  spawnEditor(codeBin, [filePath]);
}

function openWorkspaceWithCodeFork(
  appPath: string,
  workspacePath: string,
): void {
  const codeBin = `${appPath}/Contents/Resources/app/bin/code`;
  spawnEditor(codeBin, [workspacePath]);
}

/**
 * 打开结果。目前只有 Obsidian 会失败: 它只认已注册 vault 内的文件,
 * 其余编辑器对任意路径都能启动, 调用方据此决定是否提示用户。
 */
export type OpenInEditorResult =
  | { ok: true }
  | { ok: false; reason: "not-in-vault" };

export function openFileInEditor(
  editorId: string,
  filePath: string,
  workspacePath?: string,
  line?: number,
): OpenInEditorResult {
  if (editorId === "intellij-idea") {
    const args: string[] = [];
    if (workspacePath) {
      args.push(workspacePath);
    }
    if (line && Number.isFinite(line)) {
      args.push("--line", String(line));
    }
    args.push(filePath);
    spawnEditor("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", args);
  } else if (editorId === "visual-studio-code") {
    spawnEditor(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      [filePath],
    );
  } else if (editorId === "typora") {
    spawnEditor("open", ["-a", "Typora", filePath]);
  } else if (editorId === "cursor") {
    openWithCodeFork("/Applications/Cursor.app", filePath);
  } else if (editorId === "trae") {
    openWithCodeFork("/Applications/Trae.app", filePath);
  } else if (editorId === "qoder") {
    openWithCodeFork("/Applications/Qoder.app", filePath);
  } else if (editorId === "zed") {
    spawnEditor("/Applications/Zed.app/Contents/MacOS/cli", [filePath]);
  } else if (editorId === "sublime-text") {
    const sublBin =
      "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl";
    const args = sublimeArgs(workspacePath, filePath);
    spawnEditor(sublBin, args);
  } else if (editorId === "fleet") {
    const bin = "/Applications/Fleet.app/Contents/MacOS/Fleet";
    if (line && Number.isFinite(line)) {
      // Fleet 定位语法:fleet <workspace> --goto=<file>:<line>
      const args = workspacePath ? [workspacePath] : [];
      args.push(`--goto=${filePath}:${line}`);
      spawnEditor(bin, args);
    } else {
      // 无行号时只传文件路径,避免 fleet 将 workspace 与 file 视为两个目标
      spawnEditor(bin, [filePath]);
    }
  } else if (editorId === "obsidian") {
    // 经 URI scheme 打开(Obsidian 无 CLI);不支持行号定位。
    // Obsidian 只认已注册 vault 内的文件, 不在此范围时提前失败交由调用方
    // 提示更明确(直接发 URI 只会换来它自己一句 "Vault not found")。
    if (!findContainingVault(filePath, loadObsidianVaults())) {
      return { ok: false, reason: "not-in-vault" };
    }
    spawnEditor("open", [obsidianFileUri(filePath)]);
  }
  return { ok: true };
}

function sublimeArgs(workspacePath?: string, filePath?: string): string[] {
  const projectFile = workspacePath ? findSublimeProject(workspacePath) : null;
  if (projectFile) {
    return filePath
      ? ["--project", projectFile, filePath]
      : ["--project", projectFile];
  }
  // 打开文件时不带 workspace 上下文，只传文件路径
  if (filePath) return [filePath];
  // 打开工作区时用 -n 新窗口(仅 openWorkspaceInEditor 调用,workspacePath 必传)
  return ["-n", workspacePath!];
}

function findSublimeProject(dir: string): string | null {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.endsWith(".sublime-project")) {
        return join(dir, entry);
      }
    }
  } catch {}
  return null;
}

export function openWorkspaceInEditor(
  editorId: string,
  workspacePath: string,
): OpenInEditorResult {
  if (editorId === "intellij-idea") {
    spawnEditor("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", [
      workspacePath,
    ]);
  } else if (editorId === "visual-studio-code") {
    spawnEditor(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      [workspacePath],
    );
  } else if (editorId === "typora") {
    spawnEditor("open", ["-a", "Typora", workspacePath]);
  } else if (editorId === "cursor") {
    openWorkspaceWithCodeFork("/Applications/Cursor.app", workspacePath);
  } else if (editorId === "trae") {
    openWorkspaceWithCodeFork("/Applications/Trae.app", workspacePath);
  } else if (editorId === "qoder") {
    openWorkspaceWithCodeFork("/Applications/Qoder.app", workspacePath);
  } else if (editorId === "zed") {
    spawnEditor("/Applications/Zed.app/Contents/MacOS/cli", [workspacePath]);
  } else if (editorId === "sublime-text") {
    const sublBin =
      "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl";
    spawnEditor(sublBin, sublimeArgs(workspacePath));
  } else if (editorId === "fleet") {
    spawnEditor("/Applications/Fleet.app/Contents/MacOS/Fleet", [
      workspacePath,
    ]);
  } else if (editorId === "obsidian") {
    // Obsidian 无"项目"概念, 只有 vault:命中已注册 vault 才打开。
    // 注意不能用 path=<目录> —— 实测对目录无效(文档把 path 定义为文件
    // 路径), 必须按 vault id 打开, 它会在新窗口里开该 vault。
    const vault = findContainingVault(workspacePath, loadObsidianVaults());
    if (!vault) return { ok: false, reason: "not-in-vault" };
    spawnEditor("open", [
      `obsidian://open?vault=${encodeURIComponent(vault.id)}`,
    ]);
  }
  return { ok: true };
}
