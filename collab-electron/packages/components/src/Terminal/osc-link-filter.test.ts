import { describe, expect, test } from "bun:test";
import type { ILink, Terminal } from "@xterm/xterm";
import { installOscLinkFilter, isPlausibleOscUri } from "./osc-link-filter";

function link(text: string): ILink {
  return {
    text,
    range: { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
    activate: () => {},
  };
}

function fakeTerm(providers: unknown[]): Terminal {
  return {
    _core: { _linkProviderService: { linkProviders: providers } },
  } as unknown as Terminal;
}

type Reply = (links: ILink[] | undefined) => void;

function collect(provider: {
  provideLinks: (y: number, cb: Reply) => void;
}): ILink[] | undefined {
  let got: ILink[] | undefined;
  provider.provideLinks(1, (links) => {
    got = links;
  });
  return got;
}

describe("isPlausibleOscUri", () => {
  test("纯 ASCII http(s) URI 保留", () => {
    expect(isPlausibleOscUri("http://localhost:16030")).toBe(true);
    expect(isPlausibleOscUri("https://example.com/path?a=1&b=2")).toBe(true);
  });

  test("http(s) URI 含非 ASCII(上游误检)丢弃", () => {
    expect(
      isPlausibleOscUri("http://localhost:16030）。用浏览器实测各表格的拖拽。"),
    ).toBe(false);
    expect(isPlausibleOscUri("http://localhost:16030/api/v1。完毕")).toBe(
      false,
    );
  });

  test("非 http scheme 保留(路径可含非 ASCII)", () => {
    expect(isPlausibleOscUri("file:///Users/dingxin/中文目录/文件.txt")).toBe(
      true,
    );
    expect(isPlausibleOscUri("mailto:foo@example.com")).toBe(true);
  });
});

describe("installOscLinkFilter", () => {
  test("过滤 OSC provider 的坏 URI, 保留合规链接", () => {
    const oscProvider = {
      _oscLinkService: {},
      provideLinks: (_y: number, cb: Reply) =>
        cb([link("http://ok.test/"), link("http://localhost:16030）。尾巴")]),
    };
    installOscLinkFilter(fakeTerm([oscProvider]));

    expect(collect(oscProvider)?.map((l) => l.text)).toEqual([
      "http://ok.test/",
    ]);
  });

  test("provider 返回 undefined 时原样透传", () => {
    const oscProvider = {
      _oscLinkService: {},
      provideLinks: (_y: number, cb: Reply) => cb(undefined),
    };
    installOscLinkFilter(fakeTerm([oscProvider]));

    expect(collect(oscProvider)).toBeUndefined();
  });

  test("不影响非 OSC provider", () => {
    const other = {
      provideLinks: (_y: number, cb: Reply) =>
        cb([link("http://localhost:16030）。尾巴")]),
    };
    const oscProvider = {
      _oscLinkService: {},
      provideLinks: (_y: number, cb: Reply) => cb([]),
    };
    installOscLinkFilter(fakeTerm([oscProvider, other]));

    expect(collect(other)?.map((l) => l.text)).toEqual([
      "http://localhost:16030）。尾巴",
    ]);
  });

  test("内部结构缺失时静默跳过", () => {
    expect(() => installOscLinkFilter({} as unknown as Terminal)).not.toThrow();
    expect(() =>
      installOscLinkFilter(fakeTerm([{ provideLinks: () => {} }])),
    ).not.toThrow();
  });
});
