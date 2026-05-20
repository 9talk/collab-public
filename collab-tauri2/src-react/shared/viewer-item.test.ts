import { describe, test, expect } from "bun:test";
import {
  parseFileToViewerItem,
  serializeViewerItem,
} from "./viewer-item";

describe("parseFileToViewerItem", () => {
  test("parses plain markdown without frontmatter", () => {
    const item = parseFileToViewerItem("/notes/hello.md", "# Hello\nWorld");
    expect(item.id).toBe("/notes/hello.md");
    expect(item.title).toBe("hello");
    expect(item.type).toBe("MD");
    expect(item.text).toBe("# Hello\nWorld");
    expect(item.isEditable).toBe(true);
    expect(item.frontmatter).toBeUndefined();
  });

  test("parses frontmatter attributes", () => {
    const content = `---
type: article
url: "https://example.com"
summary: "A summary"
---
Body text`;
    const item = parseFileToViewerItem("/notes/test.md", content);
    expect(item.type).toBe("article");
    expect(item.url).toBe("https://example.com");
    expect(item.summary).toBe("A summary");
    expect(item.text.trim()).toBe("Body text");
  });

  test("extracts title from filename, not frontmatter", () => {
    const content = `---
title: "FM Title"
---
Body`;
    const item = parseFileToViewerItem("/path/to/My Note.md", content);
    expect(item.title).toBe("My Note");
  });

  test("detects skill paths", () => {
    const item = parseFileToViewerItem(
      "/project/.claude/skills/my-skill.md",
      "Skill content",
    );
    expect(item.type).toBe("skill");
  });

  test("detects plugin skill paths", () => {
    const item = parseFileToViewerItem(
      "/project/.claude/plugins/my-plugin/skills/task.md",
      "content",
    );
    expect(item.type).toBe("skill");
  });

  test("skill type overrides frontmatter type", () => {
    const content = `---
type: article
---
Body`;
    const item = parseFileToViewerItem(
      "/project/.claude/skills/x.md",
      content,
    );
    expect(item.type).toBe("skill");
  });

  test("parses string quotes", () => {
    const content = `---
quotes:
  - "First quote"
  - "Second quote"
---
Body`;
    const item = parseFileToViewerItem("/notes/q.md", content);
    expect(item.quotes).toEqual([
      { text: "First quote" },
      { text: "Second quote" },
    ]);
  });

  test("parses object quotes", () => {
    const content = `---
quotes:
  - text: "A quote"
---
Body`;
    const item = parseFileToViewerItem("/notes/q.md", content);
    expect(item.quotes).toEqual([{ text: "A quote" }]);
  });

  test("uses provided stats for timestamps", () => {
    const stats = {
      ctime: "2026-01-01T00:00:00Z",
      mtime: "2026-01-02T00:00:00Z",
    };
    const item = parseFileToViewerItem("/notes/t.md", "text", stats);
    expect(item.createdAt).toBe(new Date("2026-01-01T00:00:00Z").getTime());
    expect(item.modifiedAt).toBe(new Date("2026-01-02T00:00:00Z").getTime());
  });
});

describe("serializeViewerItem", () => {
  test("returns plain body when type is md", () => {
    const item = parseFileToViewerItem("/notes/plain.md", "Just text");
    item.type = "md";
    expect(serializeViewerItem(item, "Just text")).toBe("Just text");
  });

  test("does not inject frontmatter for extension-derived type", () => {
    const item = parseFileToViewerItem("/notes/plain.md", "Just text");
    const result = serializeViewerItem(item, "Just text");
    expect(result).toBe("Just text");
  });

  test("preserves explicit frontmatter type on save", () => {
    const content = "---\ntype: note\n---\nBody";
    const item = parseFileToViewerItem("/notes/plain.md", content);
    const result = serializeViewerItem(item, "Body");
    expect(result).toContain('type: "note"');
  });

  test("includes frontmatter for article type", () => {
    const content = '---\ntype: article\nurl: "https://example.com"\n---\nbody';
    const item = parseFileToViewerItem("/notes/a.md", content);
    const result = serializeViewerItem(item, "body");
    expect(result).toContain("---");
    expect(result).toContain('"article"');
    expect(result).toContain('"https://example.com"');
    expect(result).toContain("body");
  });

  test("omits type when no explicit frontmatter type existed", () => {
    const item = parseFileToViewerItem("/notes/a.md", "body");
    item.url = "https://x.com";
    const result = serializeViewerItem(item, "body");
    expect(result).not.toContain("type:");
    expect(result).toContain("url:");
  });

  test("strips legacy fields", () => {
    const content = "---\ntype: article\n---\nbody";
    const item = parseFileToViewerItem("/notes/a.md", content);
    const result = serializeViewerItem(item, "body");
    expect(result).not.toContain("createdAt");
    expect(result).not.toContain("modifiedAt");
    expect(result).not.toContain("author");
  });
});
