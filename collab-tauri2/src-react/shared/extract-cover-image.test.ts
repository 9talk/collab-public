import { describe, test, expect } from "bun:test";
import { extractCoverImageUrl } from "./extract-cover-image";

describe("extractCoverImageUrl", () => {
  test("returns null for plain text with no images", () => {
    expect(extractCoverImageUrl("Just some text")).toBeNull();
  });

  test("extracts from cover_image frontmatter", () => {
    const result = extractCoverImageUrl("body", {
      cover_image: "https://img.example.com/photo.jpg",
    });
    expect(result).toBe("https://img.example.com/photo.jpg");
  });

  test("extracts from coverImage frontmatter", () => {
    const result = extractCoverImageUrl("body", {
      coverImage: "https://img.example.com/photo.jpg",
    });
    expect(result).toBe("https://img.example.com/photo.jpg");
  });

  test("resolves relative frontmatter image with notePath", () => {
    const result = extractCoverImageUrl(
      "body",
      { cover_image: "images/photo.jpg" },
      "/workspace/notes/my-note.md",
    );
    expect(result).toBe("collab-file:///workspace/notes/images/photo.jpg");
  });

  test("resolves absolute local path in frontmatter", () => {
    const result = extractCoverImageUrl(
      "body",
      { cover_image: "/absolute/path/img.png" },
      "/workspace/notes/note.md",
    );
    expect(result).toBe("collab-file:///absolute/path/img.png");
  });

  test("resolves Windows absolute local path in frontmatter", () => {
    const result = extractCoverImageUrl(
      "body",
      { cover_image: "C:\\absolute\\path\\img.png" },
      "C:\\workspace\\notes\\note.md",
    );
    expect(result).toBe("collab-file:///C:/absolute/path/img.png");
  });

  test("returns null for relative image without notePath", () => {
    const result = extractCoverImageUrl("body", {
      cover_image: "relative/img.png",
    });
    expect(result).toBeNull();
  });

  test("extracts from markdown image syntax", () => {
    const result = extractCoverImageUrl(
      "Some text\n![alt](https://img.example.com/photo.jpg)\nMore text",
    );
    expect(result).toBe("https://img.example.com/photo.jpg");
  });

  test("extracts from HTML img tag", () => {
    const result = extractCoverImageUrl(
      'Text <img src="https://img.example.com/photo.jpg" /> more',
    );
    expect(result).toBe("https://img.example.com/photo.jpg");
  });

  test("prefers frontmatter over markdown image", () => {
    const result = extractCoverImageUrl(
      "![alt](https://markdown-img.com/a.jpg)",
      { cover_image: "https://frontmatter-img.com/b.jpg" },
    );
    expect(result).toBe("https://frontmatter-img.com/b.jpg");
  });

  test("resolves relative markdown image with notePath", () => {
    const result = extractCoverImageUrl(
      "![photo](../assets/pic.png)",
      undefined,
      "/workspace/notes/sub/note.md",
    );
    expect(result).toBe("collab-file:///workspace/notes/assets/pic.png");
  });

  test("passes through data: URLs", () => {
    const result = extractCoverImageUrl(
      "![](data:image/png;base64,abc123)",
    );
    expect(result).toBe("data:image/png;base64,abc123");
  });

  test("passes through collab-file:// URLs", () => {
    const result = extractCoverImageUrl("body", {
      cover_image: "collab-file:///some/path.jpg",
    });
    expect(result).toBe("collab-file:///some/path.jpg");
  });
});
