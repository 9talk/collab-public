import { describe, test, expect } from "bun:test";
import { isTemplateDropTarget } from "./useTemplateDrop";

describe("isTemplateDropTarget", () => {
  test("workspace 根与普通目录可放置", () => {
    expect(isTemplateDropTarget({ kind: "workspace" })).toBe(true);
    expect(isTemplateDropTarget({ kind: "folder" })).toBe(true);
  });

  test("文件节点禁止", () => {
    expect(isTemplateDropTarget({ kind: "file" })).toBe(false);
  });

  test("软链接节点自身禁止（写入会落到模板源）", () => {
    expect(isTemplateDropTarget({ kind: "folder", isSymlink: true })).toBe(
      false,
    );
    expect(isTemplateDropTarget({ kind: "file", isSymlink: true })).toBe(false);
  });

  test("链接内部任意层级禁止", () => {
    expect(isTemplateDropTarget({ kind: "folder", linkAncestor: true })).toBe(
      false,
    );
    expect(isTemplateDropTarget({ kind: "file", linkAncestor: true })).toBe(
      false,
    );
  });

  test("未知目标（树空白区域）禁止", () => {
    expect(isTemplateDropTarget(undefined)).toBe(false);
  });
});
