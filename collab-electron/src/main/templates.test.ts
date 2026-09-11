import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "templates-test-"));
const TEMPLATES = join(ROOT, "templates");
const WS = join(ROOT, "ws-a");

// paths 提供模板库根（真实模块指向用户 ~/.collab，测试必须隔离）；
// electron 仅为模块加载期的命名导入服务，本组测试不触达窗口/IPC。
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
  listTemplates,
  readTemplateDir,
  createTemplate,
  renameTemplate,
  deleteTemplate,
  createNode,
  renameNode,
  deleteNode,
  checkLink,
  createLink,
  removeLinkAt,
  getLinkInfoAt,
  scanWorkspaceMounts,
} = await import("./templates");

const WORKSPACES = [WS];

function resetFixture(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(TEMPLATES, { recursive: true });
  mkdirSync(WS, { recursive: true });
}

/** 在模板库内创建 <template>/<rel...> 目录与文件 */
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

beforeEach(resetFixture);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("templates CRUD", () => {
  test("create / list 忽略隐藏目录与非目录", async () => {
    expect(await createTemplate("alpha")).toEqual(["alpha"]);
    mkdirSync(join(TEMPLATES, ".hidden"));
    writeFileSync(join(TEMPLATES, "notes.txt"), "x");
    expect(await listTemplates()).toEqual(["alpha"]);
  });

  test("create 重名与非法名拒绝", async () => {
    await createTemplate("alpha");
    await expect(createTemplate("alpha")).rejects.toThrow("已存在同名模板");
    await expect(createTemplate("a/b")).rejects.toThrow("路径分隔符");
    await expect(createTemplate("..")).rejects.toThrow("名称无效");
    await expect(createTemplate("  ")).rejects.toThrow("名称无效");
  });

  test("rename / delete", async () => {
    await createTemplate("alpha");
    expect(await renameTemplate("alpha", "beta")).toEqual(["beta"]);
    await expect(renameTemplate("beta", "gamma")).resolves.toEqual(["gamma"]);
    await createTemplate("delta");
    await expect(renameTemplate("gamma", "delta")).rejects.toThrow(
      "已存在同名模板",
    );
    expect(await deleteTemplate("delta")).toEqual(["gamma"]);
    expect(existsSync(join(TEMPLATES, "delta"))).toBe(false);
  });

  test("createNode / renameNode / deleteNode", async () => {
    seedTemplate("t1", []);
    await createNode({
      template: "t1",
      relPath: "",
      kind: "dir",
      name: "rules",
    });
    await createNode({
      template: "t1",
      relPath: "rules",
      kind: "file",
      name: "vue.md",
    });
    expect(existsSync(join(TEMPLATES, "t1", "rules", "vue.md"))).toBe(true);

    await renameNode({ template: "t1", relPath: "rules", newName: "guides" });
    expect(existsSync(join(TEMPLATES, "t1", "guides"))).toBe(true);
    expect(existsSync(join(TEMPLATES, "t1", "rules"))).toBe(false);

    await deleteNode({ template: "t1", relPath: "guides/vue.md" });
    expect(existsSync(join(TEMPLATES, "t1", "guides", "vue.md"))).toBe(false);

    await expect(deleteNode({ template: "t1", relPath: "" })).rejects.toThrow(
      "不能删除模板根目录",
    );
  });

  test("路径越界一律拒绝", async () => {
    seedTemplate("t1", ["a.md"]);
    await expect(readTemplateDir("t1", "../../..")).rejects.toThrow("路径越界");
    await expect(
      createNode({
        template: "t1",
        relPath: "../..",
        kind: "file",
        name: "evil.md",
      }),
    ).rejects.toThrow("路径越界");
  });

  test("readTemplateDir 返回相对路径与断链标记", async () => {
    seedTemplate("t1", ["rules/", "rules/a.md", "b.md"]);
    symlinkSync(
      join(TEMPLATES, "t1", "ghost-target"),
      join(TEMPLATES, "t1", "dangling"),
    );

    const nodes = await readTemplateDir("t1", "rules");
    // relPath 始终相对模板根（模板窗口以 template::relPath 作节点 key）
    expect(nodes.map((n) => n.relPath)).toEqual(["rules/a.md"]);

    const rootNodes = await readTemplateDir("t1", "");
    const byName = new Map(rootNodes.map((n) => [n.name, n]));
    expect(byName.get("rules")?.kind).toBe("folder");
    expect(byName.get("rules")?.relPath).toBe("rules");
    expect(byName.get("b.md")?.kind).toBe("file");
    const dangling = byName.get("dangling");
    expect(dangling?.isSymlink).toBe(true);
    expect(dangling?.broken).toBe(true);
  });
});

describe("模板内软链", () => {
  test("链接内部禁止写入:create / rename / delete", async () => {
    seedTemplate("t1", ["real/a.md"]);
    symlinkSync(
      join(TEMPLATES, "t1", "real"),
      join(TEMPLATES, "t1", "shared"),
      "dir",
    );

    await expect(
      createNode({
        template: "t1",
        relPath: "shared",
        kind: "file",
        name: "x.md",
      }),
    ).rejects.toThrow("软链接内部禁止写入");
    await expect(
      renameNode({ template: "t1", relPath: "shared/a.md", newName: "b.md" }),
    ).rejects.toThrow("软链接内部禁止写入");
    await expect(
      deleteNode({ template: "t1", relPath: "shared/a.md" }),
    ).rejects.toThrow("软链接内部禁止写入");

    expect(existsSync(join(TEMPLATES, "t1", "real", "a.md"))).toBe(true);
    expect(existsSync(join(TEMPLATES, "t1", "real", "b.md"))).toBe(false);
  });

  test("对链接本身 rename / delete 只动链接，不伤目标", async () => {
    seedTemplate("t1", ["real/a.md"]);
    symlinkSync(
      join(TEMPLATES, "t1", "real"),
      join(TEMPLATES, "t1", "shared"),
      "dir",
    );

    await renameNode({ template: "t1", relPath: "shared", newName: "linked" });
    expect(lstatSync(join(TEMPLATES, "t1", "linked")).isSymbolicLink()).toBe(
      true,
    );
    expect(existsSync(join(TEMPLATES, "t1", "real", "a.md"))).toBe(true);

    await deleteNode({ template: "t1", relPath: "linked" });
    expect(existsSync(join(TEMPLATES, "t1", "linked"))).toBe(false);
    expect(existsSync(join(TEMPLATES, "t1", "real", "a.md"))).toBe(true);
  });

  test("顶层软链模板可见；断链顶层条目隐藏", async () => {
    seedTemplate("t1", ["a.md"]);
    symlinkSync(join(TEMPLATES, "t1"), join(TEMPLATES, "alias"), "dir");
    symlinkSync(join(TEMPLATES, "ghost-target"), join(TEMPLATES, "ghost"));

    expect(await listTemplates()).toEqual(["alias", "t1"]);
  });

  test("挂载断链源被拒绝", async () => {
    seedTemplate("t1", ["a.md"]);
    symlinkSync(join(TEMPLATES, "t1", "gone"), join(TEMPLATES, "t1", "dead"));

    await expect(
      checkLink(
        { template: "t1", relPath: "dead" },
        { workspace: WS, relPath: "" },
        WORKSPACES,
      ),
    ).rejects.toThrow("已断链");
  });
});

describe("scanWorkspaceMounts", () => {
  test("识别挂载（目录/文件/整模板/断链），忽略库外软链与被忽略目录", async () => {
    seedTemplate("t1", ["rules/a.md", "CLAUDE.md"]);
    mkdirSync(join(WS, ".claude"), { recursive: true });
    symlinkSync(
      join(TEMPLATES, "t1", "rules"),
      join(WS, ".claude", "rules"),
      "dir",
    );
    symlinkSync(join(TEMPLATES, "t1", "CLAUDE.md"), join(WS, "CLAUDE.md"));
    symlinkSync(join(TEMPLATES, "t1"), join(WS, "whole"), "dir");
    symlinkSync(join(TEMPLATES, "t1", "gone"), join(WS, "dead.md"));
    symlinkSync(join(ROOT, "elsewhere"), join(WS, "other"));
    mkdirSync(join(WS, "node_modules"), { recursive: true });
    symlinkSync(
      join(TEMPLATES, "t1", "CLAUDE.md"),
      join(WS, "node_modules", "x.md"),
    );

    const mounts = await scanWorkspaceMounts(
      WS,
      (rel) => rel.split("/")[0] === "node_modules",
    );
    const key = (m: {
      template: string;
      sourceRel: string;
      linkRel: string;
      broken: boolean;
    }) => `${m.template}|${m.sourceRel}|${m.linkRel}|${m.broken}`;
    expect(mounts.map(key).sort()).toEqual([
      "t1|CLAUDE.md|CLAUDE.md|false",
      "t1|gone|dead.md|true",
      "t1|rules|.claude/rules|false",
      "t1||whole|false",
    ]);
  });
});

describe("checkLink 冲突矩阵", () => {
  test("目标不存在 → ok", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    const r = await checkLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    expect(r.status).toBe("ok");
    expect(r.name).toBe("rules");
    expect(r.targetPath).toBe(join(WS, "rules"));
    expect(r.sourceLabel).toBe("t1/rules");
  });

  test("同名同源软链 → same", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    symlinkSync(join(TEMPLATES, "t1", "rules"), join(WS, "rules"), "dir");
    const r = await checkLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    expect(r.status).toBe("same");
  });

  test("同名异源软链 → conflict-symlink 且给出建议名", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    seedTemplate("t2", ["rules/a.md"]);
    symlinkSync(join(TEMPLATES, "t2", "rules"), join(WS, "rules"), "dir");

    const r = await checkLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    expect(r.status).toBe("conflict-symlink");
    expect(r.existingTarget).toBe(join(TEMPLATES, "t2", "rules"));
    expect(r.suggestedName).toBe("rules-1");
  });

  test("同名真实目录 → conflict-real（不覆盖用户数据）", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    mkdirSync(join(WS, "rules"));
    writeFileSync(join(WS, "rules", "mine.md"), "keep me");

    const r = await checkLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    expect(r.status).toBe("conflict-real");
    expect(r.suggestedName).toBe("rules-1");
  });

  test("同名断链 → conflict-symlink", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    symlinkSync(join(TEMPLATES, "t9", "rules"), join(WS, "rules"), "dir");

    const r = await checkLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    expect(r.status).toBe("conflict-symlink");
  });

  test("非法输入被拒绝", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    await expect(
      checkLink(
        { template: "t1", relPath: "../secret" },
        { workspace: WS, relPath: "" },
        WORKSPACES,
      ),
    ).rejects.toThrow("路径越界");
    await expect(
      checkLink(
        { template: "t1", relPath: "rules" },
        { workspace: WS, relPath: "../../etc" },
        WORKSPACES,
      ),
    ).rejects.toThrow("路径越界");
    await expect(
      checkLink(
        { template: "t1", relPath: "rules" },
        { workspace: "/not/a/workspace", relPath: "" },
        WORKSPACES,
      ),
    ).rejects.toThrow("workspace 不在列表中");
    await expect(
      checkLink(
        { template: "../t1", relPath: "rules" },
        { workspace: WS, relPath: "" },
        WORKSPACES,
      ),
    ).rejects.toThrow("路径分隔符");
    await expect(
      checkLink(
        { template: "t1", relPath: "nope" },
        { workspace: WS, relPath: "" },
        WORKSPACES,
      ),
    ).rejects.toThrow("模板内容不存在");
  });
});

describe("createLink / removeLinkAt", () => {
  test("建链指向模板源；重复建链幂等", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    const p1 = await createLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    expect(p1).toBe(join(WS, "rules"));
    expect(readlinkSync(p1)).toBe(join(TEMPLATES, "t1", "rules"));
    expect(lstatSync(p1).isSymbolicLink()).toBe(true);

    const p2 = await createLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    expect(p2).toBe(p1);
  });

  test("同名真实文件拒绝覆盖", async () => {
    seedTemplate("t1", ["rules/"]);
    writeFileSync(join(WS, "rules"), "user data");
    await expect(
      createLink(
        { template: "t1", relPath: "rules" },
        { workspace: WS, relPath: "" },
        WORKSPACES,
      ),
    ).rejects.toThrow("已拒绝覆盖");
    expect(existsSync(join(WS, "rules"))).toBe(true);
  });

  test("异源软链需显式 replace 才可替换", async () => {
    seedTemplate("t1", ["rules/"]);
    seedTemplate("t2", ["rules/"]);
    symlinkSync(join(TEMPLATES, "t2", "rules"), join(WS, "rules"), "dir");

    await expect(
      createLink(
        { template: "t1", relPath: "rules" },
        { workspace: WS, relPath: "" },
        WORKSPACES,
      ),
    ).rejects.toThrow("已存在");

    await createLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
      { replace: true },
    );
    expect(readlinkSync(join(WS, "rules"))).toBe(
      join(TEMPLATES, "t1", "rules"),
    );
  });

  test("rename 选项落到指定名称", async () => {
    seedTemplate("t1", ["rules/"]);
    const p = await createLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
      { name: "rules-1" },
    );
    expect(p).toBe(join(WS, "rules-1"));
  });

  test("removeLinkAt 只删软链，不动真实内容；模板源不受影响", async () => {
    seedTemplate("t1", ["rules/a.md"]);
    await createLink(
      { template: "t1", relPath: "rules" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );
    await removeLinkAt(WS, "rules", WORKSPACES);
    expect(existsSync(join(WS, "rules"))).toBe(false);
    expect(existsSync(join(TEMPLATES, "t1", "rules", "a.md"))).toBe(true);

    writeFileSync(join(WS, "real.md"), "x");
    await expect(removeLinkAt(WS, "real.md", WORKSPACES)).rejects.toThrow(
      "不是软链接",
    );
    expect(existsSync(join(WS, "real.md"))).toBe(true);
  });
});

describe("getLinkInfoAt", () => {
  test("模板来源可追溯；普通文件返回 isLink:false", async () => {
    seedTemplate("t1", ["rules/sub/a.md"]);
    await createLink(
      { template: "t1", relPath: "rules/sub" },
      { workspace: WS, relPath: "" },
      WORKSPACES,
    );

    const info = await getLinkInfoAt(WS, "sub", WORKSPACES);
    expect(info.isLink).toBe(true);
    expect(info.template).toBe("t1");
    expect(info.templateRelPath).toBe("rules/sub");
    expect(info.resolvedTarget).toBe(join(TEMPLATES, "t1", "rules", "sub"));

    writeFileSync(join(WS, "plain.md"), "x");
    expect((await getLinkInfoAt(WS, "plain.md", WORKSPACES)).isLink).toBe(
      false,
    );
    expect((await getLinkInfoAt(WS, "missing", WORKSPACES)).isLink).toBe(false);
  });
});
