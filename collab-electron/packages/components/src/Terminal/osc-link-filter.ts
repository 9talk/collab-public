import type { ILink, Terminal } from "@xterm/xterm";

// Claude Code 的 markdown 自动链接(marked)会把 URL 后紧邻的非空白文本
// (CJK 标点及后续整句)并入 href, 经 OSC 8 发给终端。例:
// 「服务已启动（http://localhost:16030）。用浏览器…」整体成为 href, 悬停
// 整句下划线、点击打开被污染的 URL。OSC 8 链接在 xterm 中优先级高于本组件
// 的 URL_RE 兜底, 会盖住正确截断的链接; xterm 内置的「无效 URI 不生成链接」
// 校验又因 linkHandler.allowNonHttpProtocols(为 file:// 链接放行)而停用。
// 这里补一道校验: http(s) URI 含非 ASCII 字符即按误检丢弃, 让 URL_RE 兜底
// 接管; file:// 等其他 scheme(路径可含非 ASCII)原样保留。
export function isPlausibleOscUri(uri: string): boolean {
  const isHttp = uri.startsWith("http:") || uri.startsWith("https:");
  return !isHttp || !/[^\x20-\x7E]/.test(uri);
}

type LinkProviderLike = {
  _oscLinkService?: unknown;
  provideLinks: (
    y: number,
    callback: (links: ILink[] | undefined) => void,
  ) => void;
};

// xterm 未公开 provider 列表, 只能锁 _core 内部接口; 取不到时静默跳过
// (降级为无过滤, 即修复前行为), 避免 xterm 升级后此处硬崩。
export function installOscLinkFilter(term: Terminal): void {
  const core = (
    term as unknown as {
      _core?: {
        _linkProviderService?: { linkProviders?: LinkProviderLike[] };
      };
    }
  )._core;
  const providers = core?._linkProviderService?.linkProviders;
  const oscProvider = providers?.find((p) => p._oscLinkService);
  if (!oscProvider) return;

  const original = oscProvider.provideLinks.bind(oscProvider);
  oscProvider.provideLinks = (y, callback) => {
    original(y, (links) =>
      callback(links?.filter((link) => isPlausibleOscUri(link.text))),
    );
  };
}
