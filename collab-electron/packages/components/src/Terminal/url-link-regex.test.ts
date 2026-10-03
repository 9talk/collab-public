import { describe, expect, test } from "bun:test";
import { URL_RE } from "./url-link-regex";

function firstMatch(text: string): string | undefined {
  return text.match(URL_RE)?.[0];
}

describe("URL_RE", () => {
  test("URL 后紧邻 em dash + 汉字(上游 marked autolink 误检)截断到 URL 末尾", () => {
    expect(
      firstMatch(
        "规则推送: http://gitlab.nstl-dev.com/ruc-zlzx/teamai-cli/-/merge_requests/3—含 13-liquibase-changelog.md",
      ),
    ).toBe("http://gitlab.nstl-dev.com/ruc-zlzx/teamai-cli/-/merge_requests/3");
  });

  test("URL 后直接紧邻汉字截断", () => {
    expect(firstMatch("http://example.com/3含 后续文本")).toBe(
      "http://example.com/3",
    );
  });

  test("URL 后紧跟全角标点截断(既有行为守护)", () => {
    expect(
      firstMatch("服务已启动（http://localhost:16030）。用浏览器实测各表格。"),
    ).toBe("http://localhost:16030");
    expect(firstMatch("http://localhost:16030/api/v1。完毕")).toBe(
      "http://localhost:16030/api/v1",
    );
  });

  test("纯 ASCII URL 完整匹配(含大小写 scheme)", () => {
    expect(firstMatch("https://example.com/path?a=1&b=2 后续")).toBe(
      "https://example.com/path?a=1&b=2",
    );
    expect(firstMatch("见 HTTPS://EXAMPLE.COM/A")).toBe(
      "HTTPS://EXAMPLE.COM/A",
    );
  });

  test("URL 主体全为非 ASCII(如中文域名)不再点亮", () => {
    expect(firstMatch("https://例え.jp/路径")).toBeUndefined();
  });
});
