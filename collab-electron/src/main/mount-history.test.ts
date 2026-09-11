import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TemplatesContext } from "./templates";

const ROOT = mkdtempSync(join(tmpdir(), "mount-history-test-"));
const TEMPLATES = join(ROOT, "templates");
const WS_A = join(ROOT, "ws-a");
const WS_B = join(ROOT, "ws-b");

mock.module("./paths", () => ({
  DEV_WORKTREE_ID: undefined,
  COLLAB_DIR: ROOT,
  TEMPLATES_DIR: TEMPLATES,
}));
mock.module("electron", () => ({
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
  webContents: {},
  utilityProcess: { fork: () => ({ on: () => {}, postMessage: () => {} }) },
  BrowserWindow: class {},
  dialog: {
    showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  },
  shell: { openPath: async () => "", showItemInFolder: () => {} },
}));

const {
  recordMountPoint,
  createNamedBackup,
  recordCurrent,
  renamePoint,
  deletePoint,
  getHistory,
  previewRestore,
  applyRestore,
  loadHistory,
} = await import("./mount-history");

const WORKSPACES = [WS_A, WS_B];

const ctx: TemplatesContext = {
  mainWindow: () => null,
  forwardToWebview: () => {},
  workspaces: () => WORKSPACES,
  getPref: () => undefined,
  setPref: () => {},
};

const HISTORY_FILE = join(ROOT, "mount-history.json");

function resetFixture(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(TEMPLATES, { recursive: true });
  mkdirSync(WS_A, { recursive: true });
  mkdirSync(WS_B, { recursive: true });
}

/** 在模板库内创建 <template>/<rel...> 目录或文件 */
function seedTemplate(template: string, relPaths: string[]): void {
  const base = join(TEMPLATES, template);
  mkdirSync(base, { recursive: true });
  for (const rel of relPaths) {
    const p = join(base, rel);
    if (rel.endsWith("/")) {
      mkdirSync(p, { recursive: true });
    } else {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `content of ${rel}`);
    }
  }
}

/** 在 workspace 内建一条指向模板库的软链 */
function link(
  template: string,
  sourceRel: string,
  ws: string,
  linkRel: string,
): void {
  const target = join(TEMPLATES, template, sourceRel);
  const p = join(ws, linkRel);
  mkdirSync(join(p, ".."), { recursive: true });
  symlinkSync(target, p);
}

function writeHistoryFile(points: unknown[]): void {
  writeFileSync(HISTORY_FILE, JSON.stringify({ version: 1, points }, null, 2));
}

function rec(
  template: string,
  sourceRel: string,
  workspace: string,
  linkRel: string,
) {
  return { workspace, linkRel, template, sourceRel, broken: false };
}

beforeEach(resetFixture);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("记录与快照", () => {
  test("recordMountPoint 快照当前挂载并追加自动点", async () => {
    seedTemplate("TPL", ["rules/"]);
    link("TPL", "rules", WS_A, ".claude/rules");
    await recordMountPoint(ctx, "挂载 TPL/rules → ws-a/.claude/rules");

    const file = loadHistory();
    expect(file.points).toHaveLength(1);
    const p = file.points[0]!;
    expect(p.kind).toBe("auto");
    expect(p.mounts).toHaveLength(1);
    expect(p.mounts[0]).toMatchObject({
      workspace: WS_A,
      linkRel: ".claude/rules",
      template: "TPL",
      sourceRel: "rules",
      broken: false,
    });
  });

  test("嵌套工作区内同一条软链只记一次（按物理路径去重）", async () => {
    seedTemplate("TPL", ["rules/"]);
    link("TPL", "rules", WS_A, "sub/rules");
    const nestedCtx: TemplatesContext = {
      ...ctx,
      workspaces: () => [WS_A, join(WS_A, "sub")],
    };
    await recordMountPoint(nestedCtx, "挂载");

    const mounts = loadHistory().points[0]!.mounts;
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ workspace: WS_A, linkRel: "sub/rules" });
  });

  test("createNamedBackup / renamePoint / deletePoint 仅限命名点", async () => {
    seedTemplate("TPL", ["rules/"]);
    link("TPL", "rules", WS_A, "rules");

    const named = await createNamedBackup(ctx, "改版前");
    expect(named.kind).toBe("named");
    expect(named.label).toBe("改版前");

    await expect(createNamedBackup(ctx, "  ")).rejects.toThrow(
      "备份名称不能为空",
    );

    const renamed = await renamePoint(ctx, named.id, "改版前2");
    expect(renamed.label).toBe("改版前2");

    const auto = await recordMountPoint(ctx, "挂载 ...");
    await expect(renamePoint(ctx, auto.id, "x")).rejects.toThrow(
      "只能重命名命名备份",
    );
    await expect(deletePoint(ctx, auto.id)).rejects.toThrow("只能删除命名备份");

    await deletePoint(ctx, named.id);
    expect(loadHistory().points.map((p) => p.id)).not.toContain(named.id);
  });

  test("recordCurrent 默认 op；getHistory 返回新→旧与 driftCount", async () => {
    seedTemplate("TPL", ["rules/"]);
    link("TPL", "rules", WS_A, "rules");
    await recordMountPoint(ctx, "挂载 A");
    await recordCurrent(ctx, undefined as unknown);

    const h1 = await getHistory(ctx);
    expect(h1.points).toHaveLength(2);
    expect(h1.points[0]!.op).toBe("记录当前状态");
    expect(h1.driftCount).toBe(0);

    rmSync(join(WS_A, "rules"));
    const h2 = await getHistory(ctx);
    expect(h2.driftCount).toBe(1);
  });

  test("自动点超上限时自最旧淘汰，命名点保留", async () => {
    const pts: unknown[] = [];
    for (let i = 0; i < 500; i++) {
      pts.push({
        id: `auto-${i}`,
        ts: i,
        kind: "auto",
        op: `op ${i}`,
        mounts: [],
      });
    }
    pts.push({
      id: "named-1",
      ts: 1000,
      kind: "named",
      label: "基线",
      op: "备份「基线」",
      mounts: [],
    });
    writeHistoryFile(pts);

    await recordCurrent(ctx, "外部变更");

    const file = loadHistory();
    const autos = file.points.filter((p) => p.kind === "auto");
    expect(autos).toHaveLength(500);
    expect(autos[0]!.id).not.toBe("auto-0");
    expect(autos.at(-1)!.op).toBe("外部变更");
    expect(file.points.filter((p) => p.kind === "named")).toHaveLength(1);
  });
});

describe("差异恢复", () => {
  test("previewRestore 四分类：缺失 / 多余 / 指向不对 / 跳过", async () => {
    seedTemplate("T1", ["rules/", "skills/", "CLAUDE.md"]);
    seedTemplate("T2", ["rules/"]);
    // 当前磁盘：T2/rules（指向不对）、skills（多余）、real.md 为真实文件
    link("T2", "rules", WS_A, "rules");
    link("T1", "skills", WS_A, "skills");
    writeFileSync(join(WS_A, "real.md"), "real content");
    // 目标点：T1/rules（目标为 T1 → 指向不对要改成 T1）、CLAUDE.md（缺失）、
    // real.md（目标位是真实文件 → 跳过 real-content）、gone（源缺失 → 跳过）、
    // WS_B 的条目（workspace 从列表移出 → 跳过）
    writeHistoryFile([
      {
        id: "p1",
        ts: 1,
        kind: "named",
        label: "目标",
        op: "备份「目标」",
        mounts: [
          rec("T1", "rules", WS_A, "rules"),
          rec("T1", "skills", WS_A, "skills-2"),
          rec("T1", "CLAUDE.md", WS_A, "CLAUDE.md"),
          rec("T1", "CLAUDE.md", WS_A, "real.md"),
          rec("T1", "gone", WS_A, "gone"),
          rec("T1", "rules", join(ROOT, "ws-gone"), "rules"),
        ],
      },
    ]);

    const diff = await previewRestore(ctx, "p1");
    expect(diff.missing.map((r) => r.linkRel)).toEqual([
      "skills-2",
      "CLAUDE.md",
    ]);
    expect(diff.extra.map((r) => r.linkRel)).toEqual(["skills"]);
    expect(diff.retarget).toHaveLength(1);
    expect(diff.retarget[0]!.current.template).toBe("T2");
    expect(diff.retarget[0]!.target.template).toBe("T1");
    const reasons = diff.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual([
      "real-content",
      "source-missing",
      "workspace-missing",
    ]);
  });

  test("applyRestore 先删后建：多余被移除、缺失被创建、指向被替换、真实文件零触碰", async () => {
    seedTemplate("T1", ["rules/", "skills/", "CLAUDE.md"]);
    seedTemplate("T2", ["rules/"]);
    link("T2", "rules", WS_A, "rules");
    link("T1", "skills", WS_A, "skills");
    writeFileSync(join(WS_A, "real.md"), "real content");
    writeHistoryFile([
      {
        id: "p1",
        ts: 1,
        kind: "named",
        label: "目标",
        op: "备份「目标」",
        mounts: [
          rec("T1", "rules", WS_A, "rules"),
          rec("T1", "skills", WS_A, "skills-2"),
          rec("T1", "CLAUDE.md", WS_A, "real.md"),
        ],
      },
    ]);

    const summary = await applyRestore(ctx, "p1");
    expect(summary.removed).toBe(1); // skills
    expect(summary.retargeted).toBe(1); // rules: T2 → T1
    expect(summary.created).toBe(1); // skills-2
    expect(summary.failed).toHaveLength(0);
    expect(summary.skipped.map((s) => s.reason)).toEqual(["real-content"]);

    // 磁盘校验
    expect(readlinkSync(join(WS_A, "rules"))).toBe(join(TEMPLATES, "T1/rules"));
    expect(readlinkSync(join(WS_A, "skills-2"))).toBe(
      join(TEMPLATES, "T1/skills"),
    );
    expect(
      lstatSync(join(WS_A, "skills"), { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(readFileSync(join(WS_A, "real.md"), "utf-8")).toBe("real content");

    // 恢复点已追加，且可再回溯
    const file = loadHistory();
    expect(file.points.at(-1)!.kind).toBe("restore");
    expect(file.points.at(-1)!.op).toContain("目标");
  });

  test("applyRestore 幂等：二次执行为零差异", async () => {
    seedTemplate("T1", ["rules/"]);
    writeHistoryFile([
      {
        id: "p1",
        ts: 1,
        kind: "auto",
        op: "挂载 T1/rules",
        mounts: [rec("T1", "rules", WS_A, "rules")],
      },
    ]);

    const s1 = await applyRestore(ctx, "p1");
    expect(s1.created).toBe(1);
    const s2 = await applyRestore(ctx, "p1");
    expect(s2.created + s2.removed + s2.retargeted).toBe(0);
    expect(s2.failed).toHaveLength(0);

    const diff = await previewRestore(ctx, "p1");
    expect(diff.missing).toHaveLength(0);
    expect(diff.extra).toHaveLength(0);
    expect(diff.retarget).toHaveLength(0);
  });

  test("applyRestore workspace 缺失 / 源缺失只报告不动手", async () => {
    seedTemplate("T1", ["rules/"]);
    writeHistoryFile([
      {
        id: "p1",
        ts: 1,
        kind: "auto",
        op: "x",
        mounts: [
          rec("T1", "rules", join(ROOT, "ws-gone"), "rules"),
          rec("T1", "gone", WS_A, "gone"),
        ],
      },
    ]);

    const summary = await applyRestore(ctx, "p1");
    expect(summary.created).toBe(0);
    expect(summary.failed).toHaveLength(0);
    expect(summary.skipped.map((s) => s.reason).sort()).toEqual([
      "source-missing",
      "workspace-missing",
    ]);
  });

  test("不存在的状态点报错", async () => {
    await expect(previewRestore(ctx, "nope")).rejects.toThrow("状态点不存在");
    await expect(applyRestore(ctx, "nope")).rejects.toThrow("状态点不存在");
  });
});
