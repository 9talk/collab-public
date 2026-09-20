import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde } from "./external-editor";

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
