import { app, ipcMain } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { atomicWriteFileSync } from "./files";
import { DEFAULT_CLAUDE_SOUNDS } from "@collab/shared/claude-sounds";

export type AgentId = "claude" | "codex" | "gemini";

interface AgentStatus {
  id: AgentId;
  name: string;
  detected: boolean;
  installed: boolean;
}

function agentDetected(id: AgentId): boolean {
  const home = homedir();
  switch (id) {
    case "claude":
      return existsSync(join(home, ".claude")) || isOnPath("claude");
    case "codex":
      return existsSync(join(home, ".codex")) || isOnPath("codex");
    case "gemini":
      return existsSync(join(home, ".gemini")) || isOnPath("gemini");
  }
}

function isOnPath(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// -- skill source --

export const VALID_AGENT_IDS = new Set<string>(["claude", "codex", "gemini"]);

export function skillSourceDir(): string {
  const candidates = [
    // Packaged app: extraResources destination takes priority
    ...(app.isPackaged && process.resourcesPath
      ? [join(process.resourcesPath, "collab-canvas-skill")]
      : []),
    // Development: resolve from app root
    join(app.getAppPath(), "packages", "collab-canvas-skill"),
    join(__dirname, "..", "..", "packages", "collab-canvas-skill"),
    join(__dirname, "..", "packages", "collab-canvas-skill"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "skills", "collab-canvas", "SKILL.md"))) {
      return dir;
    }
  }
  throw new Error(
    `Canvas skill source files not found. Searched: ${candidates.join(", ")}`,
  );
}

// -- plugin source --
// Plugin is loaded via `claude --plugin-dir <path>`, no install/copy needed.

// -- deep integration: Claude Code settings.local.json --

const CLAUDE_SETTINGS_LOCAL = join(homedir(), ".claude", "settings.local.json");

export interface DeepIntegrationResult {
  ok: boolean;
  error?: string;
}

function claudePluginPath(): string {
  // Packaged app: plugin ships under Resources/collab-claude-plugin
  if (app.isPackaged && process.resourcesPath) {
    return join(process.resourcesPath, "collab-claude-plugin");
  }
  // Development: resolve from app root
  return join(app.getAppPath(), "packages", "collab-claude-plugin");
}

/**
 * 开启/关闭深度集成时，向 ~/.claude/settings.local.json 注册或移除
 * Collaborator 本地插件（extraKnownMarketplaces + enabledPlugins）。
 * 只增删 collaborator 相关段，保留文件里其它配置；文件变空则删除。
 */
export function applyClaudeDeepIntegration(
  enabled: boolean,
): DeepIntegrationResult {
  try {
    let data: Record<string, unknown> = {};
    try {
      const raw = readFileSync(CLAUDE_SETTINGS_LOCAL, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // 文件不存在或内容损坏时从空配置开始
    }

    if (enabled) {
      const markets = (
        typeof data.extraKnownMarketplaces === "object" &&
        data.extraKnownMarketplaces !== null &&
        !Array.isArray(data.extraKnownMarketplaces)
          ? data.extraKnownMarketplaces
          : {}
      ) as Record<string, unknown>;
      markets.collaborator = {
        source: {
          autoUpdate: true,
          source: "directory",
          path: claudePluginPath(),
        },
      };
      data.extraKnownMarketplaces = markets;

      const plugins = (
        typeof data.enabledPlugins === "object" &&
        data.enabledPlugins !== null &&
        !Array.isArray(data.enabledPlugins)
          ? data.enabledPlugins
          : {}
      ) as Record<string, unknown>;
      plugins["collaborator@collaborator"] = true;
      data.enabledPlugins = plugins;
    } else {
      if (
        typeof data.extraKnownMarketplaces === "object" &&
        data.extraKnownMarketplaces !== null
      ) {
        const markets = data.extraKnownMarketplaces as Record<string, unknown>;
        delete markets.collaborator;
        if (Object.keys(markets).length === 0) {
          delete data.extraKnownMarketplaces;
        }
      }
      if (
        typeof data.enabledPlugins === "object" &&
        data.enabledPlugins !== null
      ) {
        const plugins = data.enabledPlugins as Record<string, unknown>;
        delete plugins["collaborator@collaborator"];
        if (Object.keys(plugins).length === 0) {
          delete data.enabledPlugins;
        }
      }
    }

    if (Object.keys(data).length === 0) {
      if (existsSync(CLAUDE_SETTINGS_LOCAL)) {
        rmSync(CLAUDE_SETTINGS_LOCAL);
      }
      return { ok: true };
    }

    mkdirSync(dirname(CLAUDE_SETTINGS_LOCAL), { recursive: true });
    atomicWriteFileSync(
      CLAUDE_SETTINGS_LOCAL,
      JSON.stringify(data, null, 2) + "\n",
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "[integrations] Failed to update Claude settings.local.json:",
      msg,
    );
    return { ok: false, error: msg };
  }
}

// -- install paths --

function skillInstallPath(id: AgentId): string {
  const home = homedir();
  switch (id) {
    case "claude":
      return join(home, ".claude", "skills", "collab-canvas");
    case "codex":
      return join(home, ".codex", "instructions", "collab-canvas.md");
    case "gemini":
      return join(home, ".gemini", "instructions", "collab-canvas.md");
  }
}

function skillInstalled(id: AgentId): boolean {
  const target = skillInstallPath(id);
  if (id === "claude") {
    return existsSync(join(target, "SKILL.md"));
  }
  return existsSync(target);
}

// -- install / uninstall --

export function installSkill(id: AgentId): void {
  const srcDir = skillSourceDir();
  const target = skillInstallPath(id);

  if (id === "claude") {
    mkdirSync(target, { recursive: true });
    const src = join(srcDir, "skills", "collab-canvas", "SKILL.md");
    writeFileSync(
      join(target, "SKILL.md"),
      readFileSync(src, "utf-8"),
      "utf-8",
    );
    return;
  }

  mkdirSync(join(target, ".."), { recursive: true });
  const sourceFile =
    id === "codex" ? "collab-canvas-codex.md" : "collab-canvas-gemini.md";
  writeFileSync(
    target,
    readFileSync(join(srcDir, sourceFile), "utf-8"),
    "utf-8",
  );
}

export function uninstallSkill(id: AgentId): void {
  const target = skillInstallPath(id);
  if (id === "claude") {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  if (existsSync(target)) rmSync(target);
}

// -- plugin offered marker --

function markerPath(): string {
  return join(homedir(), ".collab", "canvas-plugin-offered");
}

export function hasOfferedPlugin(): boolean {
  return existsSync(markerPath());
}

export function markPluginOffered(): void {
  const dir = join(homedir(), ".collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath(), new Date().toISOString(), "utf-8");
}

// -- Claude sound settings --

function claudeSoundsPath(): string {
  return join(homedir(), ".collab", "claude-sounds.json");
}

// 旧格式的配置里事件值是声音文件路径字符串，归一化为勾选布尔值
function normalizeClaudeSounds(
  data: Record<string, unknown>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "enabled") {
      out.enabled = value !== false;
    } else if (typeof value === "string") {
      out[key] = true;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

export function readClaudeSounds(): Record<string, boolean> {
  try {
    const raw = readFileSync(claudeSoundsPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const data = parsed as Record<string, unknown>;
      return {
        enabled: data.enabled !== false,
        ...DEFAULT_CLAUDE_SOUNDS,
        ...normalizeClaudeSounds(data),
      };
    }
  } catch {
    // 文件缺失或损坏时使用默认配置
  }
  return { enabled: true, ...DEFAULT_CLAUDE_SOUNDS };
}

export function writeClaudeSounds(sounds: Record<string, unknown>): void {
  const dir = join(homedir(), ".collab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(claudeSoundsPath(), JSON.stringify(sounds, null, 2), "utf-8");
}

// -- IPC --

export function getAgentStatuses(): AgentStatus[] {
  const agents: AgentId[] = ["claude", "codex", "gemini"];
  return agents.map((id) => ({
    id,
    name:
      id === "claude"
        ? "Claude Code"
        : id === "codex"
          ? "Codex CLI"
          : "Gemini CLI",
    detected: agentDetected(id),
    installed: skillInstalled(id),
  }));
}

export function registerIntegrationsIpc(): void {
  ipcMain.handle("integrations:get-agents", () => getAgentStatuses());

  ipcMain.handle("integrations:install-skill", (_event, agentId: string) => {
    if (!VALID_AGENT_IDS.has(agentId)) {
      return { ok: false, error: `Unknown agent: ${agentId}` };
    }
    try {
      installSkill(agentId as AgentId);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[integrations] Failed to install skill:", msg);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle("integrations:uninstall-skill", (_event, agentId: string) => {
    if (!VALID_AGENT_IDS.has(agentId)) {
      return { ok: false, error: `Unknown agent: ${agentId}` };
    }
    try {
      uninstallSkill(agentId as AgentId);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[integrations] Failed to uninstall skill:", msg);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle("integrations:has-offered-plugin", () => hasOfferedPlugin());

  ipcMain.handle("integrations:set-deep-integration", (_event, enabled) => {
    return applyClaudeDeepIntegration(Boolean(enabled));
  });

  ipcMain.handle("integrations:mark-plugin-offered", () => {
    markPluginOffered();
    return { ok: true };
  });

  // -- Claude sound settings IPC --

  ipcMain.handle("integrations:get-claude-sounds", () => {
    return readClaudeSounds();
  });

  ipcMain.handle("integrations:set-claude-sounds", (_event, sounds) => {
    try {
      writeClaudeSounds(sounds as Record<string, unknown>);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });
}
