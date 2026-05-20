import { describe, expect, test } from "bun:test";
import {
  fromCollabFileUrl,
  toCollabFileUrl,
} from "./collab-file-url";

describe("collab-file-url", () => {
  test("encodes posix absolute paths", () => {
    expect(toCollabFileUrl("/workspace/notes/pic one.png")).toBe(
      "collab-file:///workspace/notes/pic%20one.png",
    );
  });

  test("encodes Windows absolute paths with a leading slash", () => {
    expect(toCollabFileUrl("C:\\Users\\me\\pic one.png")).toBe(
      "collab-file:///C:/Users/me/pic%20one.png",
    );
  });

  test("decodes canonical Windows collab-file URLs", () => {
    expect(fromCollabFileUrl("collab-file:///C:/Users/me/pic%20one.png")).toBe(
      "C:/Users/me/pic one.png",
    );
  });

  test("decodes legacy encoded-host Windows URLs", () => {
    expect(fromCollabFileUrl("collab-file://C%3A%5CUsers%5Cme%5Cpic.png")).toBe(
      "C:\\Users\\me\\pic.png",
    );
  });

  test("decodes legacy drive-host Windows URLs", () => {
    expect(fromCollabFileUrl("collab-file://C/Users/me/pic.png")).toBe(
      "C:/Users/me/pic.png",
    );
  });

  test("encodes # and ? in filenames", () => {
    expect(toCollabFileUrl("/path/to/image#1.png")).toBe(
      "collab-file:///path/to/image%231.png",
    );
    expect(toCollabFileUrl("/path/to/image?v2.png")).toBe(
      "collab-file:///path/to/image%3Fv2.png",
    );
  });

  test("round-trips filenames with # and ?", () => {
    expect(fromCollabFileUrl(toCollabFileUrl("/path/to/image#1.png"))).toBe(
      "/path/to/image#1.png",
    );
    expect(fromCollabFileUrl(toCollabFileUrl("/path/to/image?v2.png"))).toBe(
      "/path/to/image?v2.png",
    );
  });
});
