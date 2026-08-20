import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// -- Temp dirs for isolation --

const TEST_ROOT = join(tmpdir(), `integrations-test-${Date.now()}`);
const FAKE_HOME = join(TEST_ROOT, "home");
const FAKE_SKILL_SRC = join(TEST_ROOT, "skill-source");
const FAKE_APP_PATH = join(TEST_ROOT, "app");
const FAKE_RESOURCES = join(TEST_ROOT, "resources");

function setupSkillSource(baseDir: string) {
  const skillDir = join(baseDir, "skills", "collab-canvas");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Test SKILL", "utf-8");
  writeFileSync(
    join(baseDir, "collab-canvas-codex.md"),
    "# Codex instructions",
    "utf-8",
  );
  writeFileSync(
    join(baseDir, "collab-canvas-gemini.md"),
    "# Gemini instructions",
    "utf-8",
  );
}

// -- Mock electron before importing the module --

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => FAKE_APP_PATH,
  },
  ipcMain: {
    handle: () => {},
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
}));

// Mock homedir to isolate from real user config
mock.module("node:os", () => ({
  homedir: () => FAKE_HOME,
  tmpdir,
}));

const {
  skillSourceDir,
  installSkill,
  uninstallSkill,
  VALID_AGENT_IDS,
  getAgentStatuses,
  applyClaudeDeepIntegration,
  readClaudeSounds,
  writeClaudeSounds,
} = await import("./integrations");
import { DEFAULT_CLAUDE_SOUNDS } from "@collab/shared/claude-sounds";

// -- Setup / Teardown --

beforeEach(() => {
  mkdirSync(FAKE_HOME, { recursive: true });
  mkdirSync(FAKE_APP_PATH, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// -- Tests --

describe("VALID_AGENT_IDS", () => {
  test("contains exactly claude, codex, gemini", () => {
    expect(VALID_AGENT_IDS.has("claude")).toBe(true);
    expect(VALID_AGENT_IDS.has("codex")).toBe(true);
    expect(VALID_AGENT_IDS.has("gemini")).toBe(true);
    expect(VALID_AGENT_IDS.has("unknown")).toBe(false);
    expect(VALID_AGENT_IDS.size).toBe(3);
  });
});

describe("skillSourceDir", () => {
  test("finds skill via app.getAppPath()/packages/collab-canvas-skill", () => {
    const srcDir = join(FAKE_APP_PATH, "packages", "collab-canvas-skill");
    setupSkillSource(srcDir);
    expect(skillSourceDir()).toBe(srcDir);
  });

  test("falls back to __dirname-relative paths in dev mode", () => {
    // In dev mode, __dirname-based candidates may resolve to the real repo.
    // As long as skillSourceDir() returns a valid path containing SKILL.md,
    // the fallback is working correctly.
    const result = skillSourceDir();
    expect(
      existsSync(join(result, "skills", "collab-canvas", "SKILL.md")),
    ).toBe(true);
  });
});

describe("installSkill / uninstallSkill", () => {
  beforeEach(() => {
    // Set up the skill source so installSkill can find it
    const srcDir = join(FAKE_APP_PATH, "packages", "collab-canvas-skill");
    setupSkillSource(srcDir);
  });

  test("installs Claude skill (copies SKILL.md)", () => {
    installSkill("claude");
    const installed = join(
      FAKE_HOME,
      ".claude",
      "skills",
      "collab-canvas",
      "SKILL.md",
    );
    expect(existsSync(installed)).toBe(true);
  });

  test("installs Codex skill (copies collab-canvas-codex.md)", () => {
    installSkill("codex");
    const installed = join(
      FAKE_HOME,
      ".codex",
      "instructions",
      "collab-canvas.md",
    );
    expect(existsSync(installed)).toBe(true);
  });

  test("installs Gemini skill (copies collab-canvas-gemini.md)", () => {
    installSkill("gemini");
    const installed = join(
      FAKE_HOME,
      ".gemini",
      "instructions",
      "collab-canvas.md",
    );
    expect(existsSync(installed)).toBe(true);
  });

  test("uninstallSkill removes Claude skill directory", () => {
    installSkill("claude");
    const dir = join(FAKE_HOME, ".claude", "skills", "collab-canvas");
    expect(existsSync(dir)).toBe(true);

    uninstallSkill("claude");
    expect(existsSync(dir)).toBe(false);
  });

  test("uninstallSkill removes Codex instruction file", () => {
    installSkill("codex");
    const file = join(FAKE_HOME, ".codex", "instructions", "collab-canvas.md");
    expect(existsSync(file)).toBe(true);

    uninstallSkill("codex");
    expect(existsSync(file)).toBe(false);
  });

  test("uninstallSkill is safe when target does not exist", () => {
    // Should not throw
    expect(() => uninstallSkill("claude")).not.toThrow();
    expect(() => uninstallSkill("codex")).not.toThrow();
    expect(() => uninstallSkill("gemini")).not.toThrow();
  });
});

describe("getAgentStatuses", () => {
  test("returns entries for all three agents", () => {
    const statuses = getAgentStatuses();
    expect(statuses).toHaveLength(3);
    const ids = statuses.map((s: { id: string }) => s.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
  });

  test("reports installed=false when skills are not present", () => {
    const statuses = getAgentStatuses();
    for (const s of statuses) {
      expect(s.installed).toBe(false);
    }
  });

  test("reports installed=true after installSkill", () => {
    const srcDir = join(FAKE_APP_PATH, "packages", "collab-canvas-skill");
    setupSkillSource(srcDir);

    installSkill("claude");
    const statuses = getAgentStatuses();
    const claude = statuses.find((s: { id: string }) => s.id === "claude");
    expect(claude?.installed).toBe(true);
  });
});

describe("applyClaudeDeepIntegration", () => {
  const settingsPath = () => join(FAKE_HOME, ".claude", "settings.json");

  test("enable writes extraKnownMarketplaces and enabledPlugins", () => {
    const result = applyClaudeDeepIntegration(true);
    expect(result.ok).toBe(true);

    const data = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const market = data.extraKnownMarketplaces as Record<
      string,
      Record<string, unknown>
    >;
    const source = market.collaborator?.source as Record<string, unknown>;
    expect(source.autoUpdate).toBe(true);
    expect(source.source).toBe("directory");
    expect(source.path).toBe(
      join(FAKE_APP_PATH, "packages", "collab-claude-plugin"),
    );
    const plugins = data.enabledPlugins as Record<string, unknown>;
    expect(plugins["collaborator@collaborator"]).toBe(true);
  });

  test("enable preserves existing unrelated config keys", () => {
    mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        customKey: "keep",
        enabledPlugins: { "other@x": true },
      }),
      "utf-8",
    );

    applyClaudeDeepIntegration(true);
    const data = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(data.customKey).toBe("keep");
    const plugins = data.enabledPlugins as Record<string, unknown>;
    expect(plugins["other@x"]).toBe(true);
    expect(plugins["collaborator@collaborator"]).toBe(true);
  });

  test("disable removes collaborator entries but keeps other config", () => {
    applyClaudeDeepIntegration(true);
    const existing = JSON.parse(
      readFileSync(settingsPath(), "utf-8"),
    ) as Record<string, unknown>;
    existing.customKey = "keep";
    existing.enabledPlugins = {
      "other@x": true,
      "collaborator@collaborator": true,
    };
    writeFileSync(settingsPath(), JSON.stringify(existing), "utf-8");

    const result = applyClaudeDeepIntegration(false);
    expect(result.ok).toBe(true);

    const data = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(data.customKey).toBe("keep");
    expect(data.enabledPlugins).toEqual({ "other@x": true });
    expect(data.extraKnownMarketplaces).toBeUndefined();
  });

  test("disable deletes the file when it becomes empty", () => {
    applyClaudeDeepIntegration(true);
    expect(existsSync(settingsPath())).toBe(true);

    applyClaudeDeepIntegration(false);
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("enable recovers from corrupt json", () => {
    mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{ not valid json", "utf-8");

    const result = applyClaudeDeepIntegration(true);
    expect(result.ok).toBe(true);
    const data = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    const plugins = data.enabledPlugins as Record<string, unknown>;
    expect(plugins["collaborator@collaborator"]).toBe(true);
  });
});

describe("Claude sounds config", () => {
  const soundsPath = () => join(FAKE_HOME, ".collab", "claude-sounds.json");

  test("DEFAULT_CLAUDE_SOUNDS enables the 5 legacy events", () => {
    expect(DEFAULT_CLAUDE_SOUNDS.UserPromptSubmit).toBe(true);
    expect(DEFAULT_CLAUDE_SOUNDS.Stop).toBe(true);
    expect(DEFAULT_CLAUDE_SOUNDS.Notification).toBe(true);
    expect(DEFAULT_CLAUDE_SOUNDS.PermissionRequest).toBe(true);
    expect(DEFAULT_CLAUDE_SOUNDS.PreCompact).toBe(true);
    expect(DEFAULT_CLAUDE_SOUNDS.SessionStart).toBe(false);
  });

  test("readClaudeSounds returns defaults when file is missing", () => {
    const s = readClaudeSounds();
    expect(s.enabled).toBe(true);
    expect(s.UserPromptSubmit).toBe(true);
    expect(s.Stop).toBe(true);
    expect(s.SessionStart).toBe(false);
  });

  test("readClaudeSounds normalizes legacy path values to true", () => {
    mkdirSync(join(FAKE_HOME, ".collab"), { recursive: true });
    writeFileSync(
      soundsPath(),
      JSON.stringify({
        enabled: true,
        Stop: "/some/path/Stop.mp3",
        SessionStart: false,
      }),
      "utf-8",
    );

    const s = readClaudeSounds() as Record<string, boolean>;
    expect(s.enabled).toBe(true);
    expect(s.Stop).toBe(true); // 旧 path → 开启
    expect(s.SessionStart).toBe(false); // 显式关闭保留
    expect(s.UserPromptSubmit).toBe(true); // 未配置事件用默认
  });

  test("readClaudeSounds merges defaults with user overrides", () => {
    mkdirSync(join(FAKE_HOME, ".collab"), { recursive: true });
    writeFileSync(
      soundsPath(),
      JSON.stringify({
        enabled: true,
        Notification: false,
      }),
      "utf-8",
    );

    const s = readClaudeSounds() as Record<string, boolean>;
    expect(s.Notification).toBe(false); // 用户关闭覆盖默认
    expect(s.Stop).toBe(true); // 其它默认保持
  });

  test("writeClaudeSounds persists boolean config", () => {
    writeClaudeSounds({ enabled: true, Stop: true, SessionStart: false });
    const data = JSON.parse(readFileSync(soundsPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(data).toEqual({ enabled: true, Stop: true, SessionStart: false });
  });
});
