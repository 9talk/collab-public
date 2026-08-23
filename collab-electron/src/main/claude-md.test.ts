import { describe, test, expect, afterAll, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = join(tmpdir(), `claude-md-test-${Date.now()}`);

mock.module("node:os", () => ({
  homedir: () => FAKE_HOME,
  tmpdir,
}));

const {
  syncClaudeMdBlock,
  removeClaudeMdBlock,
  getCollabBlock,
  setClaudeMdBlockFile,
  COLLAB_START,
  DEFAULT_BLOCK_BODY,
} = await import("./claude-md");

const mdPath = join(FAKE_HOME, ".claude", "CLAUDE.md");

function readMd(): string | null {
  return existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : null;
}

/** 找到最新一份带时间戳的备份文件路径（无则返回 null）。 */
function lastBackup(): string | null {
  const dir = dirname(mdPath);
  if (!existsSync(dir)) return null;
  const backups = readdirSync(dir).filter((f) =>
    f.startsWith("CLAUDE.md.bak-"),
  );
  if (backups.length === 0) return null;
  backups.sort();
  return join(dir, backups[backups.length - 1]);
}

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("syncClaudeMdBlock", () => {
  test("inserts block when file missing", () => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
    const r = syncClaudeMdBlock();
    expect(r).toBe("inserted");
    expect(readMd()).toBe(getCollabBlock() + "\n");
  });

  test("unchanged when block already matches", () => {
    writeFileSync(
      mdPath,
      "existing content\n" + getCollabBlock() + "\n",
      "utf-8",
    );
    const r = syncClaudeMdBlock();
    expect(r).toBe("unchanged");
    expect(readMd()).toBe("existing content\n" + getCollabBlock() + "\n");
  });

  test("updates stale block in place, keeping other content", () => {
    writeFileSync(
      mdPath,
      "keep this\n<!-- COLLAB_START -->\nold body\n<!-- COLLAB_END -->\ntail\n",
      "utf-8",
    );
    const r = syncClaudeMdBlock();
    expect(r).toBe("updated");
    expect(readMd()).toBe("keep this\n" + getCollabBlock() + "\ntail\n");
  });

  test("appends when tags are not at line start", () => {
    writeFileSync(
      mdPath,
      "  <!-- COLLAB_START -->\nnot a real block\n  <!-- COLLAB_END -->\n",
      "utf-8",
    );
    const r = syncClaudeMdBlock();
    expect(r).toBe("inserted");
    const content = readMd()!;
    expect(
      content.startsWith(
        "  <!-- COLLAB_START -->\nnot a real block\n  <!-- COLLAB_END -->\n",
      ),
    ).toBe(true);
    expect(content).toContain(getCollabBlock());
    expect(content.split("\n").filter((l) => l === COLLAB_START).length).toBe(
      1,
    );
  });

  test("cleans orphan start tag and inserts", () => {
    writeFileSync(mdPath, "<!-- COLLAB_START -->\n", "utf-8");
    const r = syncClaudeMdBlock();
    expect(r).toBe("inserted");
    const content = readMd()!;
    expect(content.split("\n").filter((l) => l === COLLAB_START).length).toBe(
      1,
    );
    expect(content).toContain(getCollabBlock());
  });

  test("uses custom block file body when set", () => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
    const customFile = join(FAKE_HOME, "custom-block.md");
    mkdirSync(dirname(customFile), { recursive: true });
    writeFileSync(customFile, "## Custom\n\ncustom body", "utf-8");
    setClaudeMdBlockFile(customFile);
    const r = syncClaudeMdBlock();
    expect(r).toBe("inserted");
    expect(readMd()).toBe(
      "<!-- COLLAB_START -->\n## Custom\n\ncustom body\n<!-- COLLAB_END -->\n",
    );
  });

  test("falls back to default body when block file missing", () => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
    setClaudeMdBlockFile(join(FAKE_HOME, "does-not-exist.md"));
    const r = syncClaudeMdBlock();
    expect(r).toBe("inserted");
    expect(readMd()!.slice(COLLAB_START.length + 1)).toContain(
      DEFAULT_BLOCK_BODY,
    );
  });
});

describe("removeClaudeMdBlock", () => {
  test("removes block keeping other content", () => {
    writeFileSync(mdPath, "keep\n" + getCollabBlock() + "\ntail\n", "utf-8");
    const r = removeClaudeMdBlock();
    expect(r).toBe("removed");
    expect(readMd()).toBe("keep\ntail\n");
  });

  test("deletes file when only block remains", () => {
    writeFileSync(mdPath, getCollabBlock() + "\n", "utf-8");
    const r = removeClaudeMdBlock();
    expect(r).toBe("removed");
    expect(existsSync(mdPath)).toBe(false);
  });

  test("unchanged when no block", () => {
    writeFileSync(mdPath, "plain content\n", "utf-8");
    const r = removeClaudeMdBlock();
    expect(r).toBe("unchanged");
    expect(readMd()).toBe("plain content\n");
  });

  test("cleans orphan tags", () => {
    writeFileSync(mdPath, "<!-- COLLAB_START -->\n", "utf-8");
    const r = removeClaudeMdBlock();
    expect(r).toBe("removed");
    expect(existsSync(mdPath)).toBe(false);
  });
});

describe("backup before write", () => {
  test("backs up original content before in-place update", () => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
    mkdirSync(dirname(mdPath), { recursive: true });
    const original =
      "keep this\n<!-- COLLAB_START -->\nold body\n<!-- COLLAB_END -->\ntail\n";
    writeFileSync(mdPath, original, "utf-8");
    const r = syncClaudeMdBlock();
    expect(r).toBe("updated");
    const bakPath = lastBackup();
    expect(bakPath).not.toBeNull();
    expect(readFileSync(bakPath!, "utf-8")).toBe(original);
    expect(readMd()).toBe("keep this\n" + getCollabBlock() + "\ntail\n");
  });

  test("backs up original content before removing block", () => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
    mkdirSync(dirname(mdPath), { recursive: true });
    const original = "keep\n" + getCollabBlock() + "\ntail\n";
    writeFileSync(mdPath, original, "utf-8");
    const r = removeClaudeMdBlock();
    expect(r).toBe("removed");
    const bakPath = lastBackup();
    expect(bakPath).not.toBeNull();
    expect(readFileSync(bakPath!, "utf-8")).toBe(original);
    expect(readMd()).toBe("keep\ntail\n");
  });

  test("does not back up when nothing changes", () => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(
      mdPath,
      "existing content\n" + getCollabBlock() + "\n",
      "utf-8",
    );
    const r = syncClaudeMdBlock();
    expect(r).toBe("unchanged");
    expect(lastBackup()).toBeNull();
  });
});
