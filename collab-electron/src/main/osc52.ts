// OSC 52 (clipboard write) 拦截与解码。
// Claude Code 的 selection:copy 总会把复制文本以 OSC 52 序列写进 stdout:
//   ESC ] 52 ; c ; <base64> (BEL | ESC \)
// 本模块供 Host 在把 PTY 输出转发给控制端前剥掉该序列并解码文本, 让控制端
// 把复制结果写进它自己的系统剪贴板。OSC 52 可被任意 PTY chunk 切分, 需由
// 调用方把上一 chunk 留下的半截前缀(prev)与当前 data 拼接后处理。

const MAX_PENDING = 1 << 20; // 悬空前缀上限(字节), 防垃圾字节失控累积
const OSC52_RE = /\x1b\]52;([cp]?);([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;

export interface Osc52ExtractResult {
  /** 剥除 OSC 52 后应继续转发的文本 */
  rest: string;
  /** 解码出的剪贴板文本(按出现顺序) */
  copies: string[];
  /** 需要与下一 chunk 拼接的半截前缀;空串表示无悬挂 */
  pending: string;
}

export function extractOsc52(prev: string, data: string): Osc52ExtractResult {
  const full = prev + data;

  const copies: string[] = [];
  OSC52_RE.lastIndex = 0;
  let rest = "";
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC52_RE.exec(full)) !== null) {
    rest += full.slice(pos, m.index);
    pos = m.index + m[0].length;
    const decoded = Buffer.from(m[2]!, "base64").toString("utf-8");
    if (decoded.length > 0) copies.push(decoded);
  }
  rest += full.slice(pos);

  // 尾部若遗留未闭合的 "\x1b]52…"(被 chunk 切开的前缀), 缓存到下一段补齐;
  // 过长则视为误匹配丢弃, 不再等待。
  const tailIdx = rest.lastIndexOf("\x1b]52");
  if (tailIdx >= 0 && !/(?:\x07|\x1b\\)/.test(rest.slice(tailIdx))) {
    const tail = rest.slice(tailIdx);
    if (tail.length <= MAX_PENDING) {
      rest = rest.slice(0, tailIdx);
      return { rest, copies, pending: tail };
    }
  }
  return { rest, copies, pending: "" };
}
