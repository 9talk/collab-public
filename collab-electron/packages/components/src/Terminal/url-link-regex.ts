// 终端 URL 检测正则, 基于 xterm 默认 strictUrlRegex 收紧: http(s) URL 在遇到
// 任何非 ASCII 字符 (>= U+0080) 处终止 —— 中间段与尾段的排除集都并入高位字符.
// 原因: 上游 Claude Code 的 marked autolink 会把 URL 后紧邻的 CJK 文本/全角
// 标点/em dash 并入 href (GFM 尾部修剪只认 ASCII 标点), 经 OSC 8 发出;
// osc-link-filter 丢弃这类脏 OSC 8 后由本正则兜底截断, 排除集不全时(旧版只
// 排除 U+3000-U+303F 与 U+FF00-U+FFEF 的标点)脏范围会被原样匹配回来.
// 代价: 含非 ASCII 的 http URL 只点亮 ASCII 前缀(罕见); file:// 不走本正则.
// xterm default: /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/
export const URL_RE =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`-￿]*[^\s"':,.!?{}|\\\^~\[\]`()<>-￿]/;
