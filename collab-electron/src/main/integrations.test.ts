import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
} = await import("./integrations");

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
