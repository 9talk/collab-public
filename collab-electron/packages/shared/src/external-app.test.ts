import { describe, expect, test } from "bun:test";
import { isCodeFile } from "./external-app";

describe("isCodeFile", () => {
  test("treats .properties as a code file", () => {
    expect(isCodeFile("/repo/app.properties")).toBe(true);
  });

  test("treats .http as a code file", () => {
    expect(isCodeFile("/repo/request.http")).toBe(true);
  });

  test("matches extensions case-insensitively", () => {
    expect(isCodeFile("/repo/app.PROPERTIES")).toBe(true);
    expect(isCodeFile("/repo/request.HTTP")).toBe(true);
  });

  test("still rejects office documents", () => {
    expect(isCodeFile("/repo/report.docx")).toBe(false);
  });
});
