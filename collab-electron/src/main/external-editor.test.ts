import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expandTilde,
  obsidianFileUri,
  findContainingVault,
  parseObsidianVaults,
} from "./external-editor";

describe("obsidianFileUri", () => {
  test("把绝对路径编码进 path 参数", () => {
    expect(obsidianFileUri("/Users/me/vault/note.md")).toBe(
      "obsidian://open?path=%2FUsers%2Fme%2Fvault%2Fnote.md",
    );
  });

  test("空格与中文按百分号编码(ASCII 斜杠转 %2F)", () => {
    expect(obsidianFileUri("/Users/me/my vault/笔记.md")).toBe(
      "obsidian://open?path=%2FUsers%2Fme%2Fmy%20vault%2F%E7%AC%94%E8%AE%B0.md",
    );
  });

  test("路径中的保留字符被编码, 避免破坏 URI 解析", () => {
    // 官方文档警告:未正确编码的保留字符会让 URI 被错误解析
    expect(obsidianFileUri("/tmp/a&b?c#d.md")).toBe(
      "obsidian://open?path=%2Ftmp%2Fa%26b%3Fc%23d.md",
    );
  });
});

describe("parseObsidianVaults", () => {
  test("从 obsidian.json 提取 id 与路径", () => {
    const raw = JSON.stringify({
      vaults: {
        aaaa1111: { path: "/vaults/notes", ts: 1, open: true },
        bbbb2222: { path: "/vaults/work" },
      },
      appVersion: "1.13.7",
    });
    expect(parseObsidianVaults(raw)).toEqual([
      { id: "aaaa1111", path: "/vaults/notes" },
      { id: "bbbb2222", path: "/vaults/work" },
    ]);
  });

  test("缺少 vaults 字段返回空数组", () => {
    expect(parseObsidianVaults(JSON.stringify({ appVersion: "1.0" }))).toEqual(
      [],
    );
  });

  test("非法 JSON 返回空数组而不是抛错", () => {
    expect(parseObsidianVaults("{ not json")).toEqual([]);
  });

  test("跳过缺少 path 的条目", () => {
    const raw = JSON.stringify({
      vaults: { aaaa1111: { ts: 1 }, bbbb2222: { path: "/vaults/work" } },
    });
    expect(parseObsidianVaults(raw)).toEqual([
      { id: "bbbb2222", path: "/vaults/work" },
    ]);
  });
});

describe("findContainingVault", () => {
  const vaults = [
    { id: "outer", path: "/vaults/notes" },
    { id: "inner", path: "/vaults/notes/nested" },
    { id: "other", path: "/vaults/work" },
  ];

  test("命中 vault 根目录下的文件", () => {
    expect(findContainingVault("/vaults/work/todo.md", vaults)?.id).toBe(
      "other",
    );
  });

  test("命中 vault 子目录下的文件", () => {
    expect(
      findContainingVault("/vaults/notes/daily/2026-09-29.md", vaults)?.id,
    ).toBe("outer");
  });

  test("嵌套 vault 时取最具体的那个(与 Obsidian 语义一致)", () => {
    expect(
      findContainingVault("/vaults/notes/nested/deep.md", vaults)?.id,
    ).toBe("inner");
  });

  test("vault 根目录自身也被视为命中(打开项目用)", () => {
    expect(findContainingVault("/vaults/notes", vaults)?.id).toBe("outer");
  });

  test("vault 外的文件返回 null", () => {
    expect(findContainingVault("/tmp/loose.md", vaults)).toBeNull();
  });

  test("前缀相同但不在 vault 内不算命中(目录边界)", () => {
    // /vaults/notes-archive 与 /vaults/notes 只差字符串前缀, 不是包含关系
    expect(
      findContainingVault("/vaults/notes-archive/x.md", vaults),
    ).toBeNull();
  });

  test("空 vault 列表返回 null", () => {
    expect(findContainingVault("/vaults/work/todo.md", [])).toBeNull();
  });

  test("vault 路径带尾随斜杠时仍能命中", () => {
    const trailing = [{ id: "t", path: "/vaults/notes/" }];
    expect(findContainingVault("/vaults/notes/a.md", trailing)?.id).toBe("t");
  });
});

describe("expandTilde", () => {
  test("expands a bare ~ to the home directory", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  test("expands a ~/ path to an absolute path", () => {
    expect(expandTilde("~/Projects/notes.md")).toBe(
      join(homedir(), "Projects/notes.md"),
    );
  });

  test("leaves absolute paths untouched", () => {
    expect(expandTilde("/Users/other/file.md")).toBe("/Users/other/file.md");
  });

  test("leaves paths without a leading tilde untouched", () => {
    expect(expandTilde("relative/file.md")).toBe("relative/file.md");
  });

  test("does not expand ~user forms", () => {
    expect(expandTilde("~other/file.md")).toBe("~other/file.md");
  });
});
