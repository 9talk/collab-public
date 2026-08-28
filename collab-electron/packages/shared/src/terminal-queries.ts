/**
 * 终端协议中会被宿主自动应答的历史查询序列。
 *
 * 这些查询会原样进入 pty 输出流并被 ring buffer 记录;省内存销毁重建回放
 * 时, 若不清除, 新 xterm / 主进程 pty.ts 会对过期查询重复应答, 应答被空闲
 * 的 shell 回显成文本泄漏("37;3R"/"1;2c"/">|xterm.js(6.0.0)..." )。
 *
 * 主进程的代答拦截(pty.ts)与 sidecar 的回放剥离(server.ts)必须同步覆盖
 * 这份清单 — 新增代答规则时在此登记, 回放剥离自动跟进。
 */

/** xterm.js 自身会应答的查询(重放时必须剥离, 防重复应答)。 */
export const XTERM_AUTO_REPLY_PATTERNS: RegExp[] = [
  /\x1b\[[?>=]?[0-9;]*c/, // DA1/DA2 设备属性
  /\x1b\[\??6n/, // DSR 光标位置
  /\x1b\[\?[0-9;]*\$p/, // DECRQM 模式报告
  /\x1b\[\?[0-9;]*q/, // XTGETTCAP 能力查询
];

/** 主进程 pty.ts 代答的查询 → 应答(xterm.js 不响应、由宿主代答以告知真实
 * 终端身份, 如 Claude Code 的 XTVERSION 探测)。
 * 注意: query 正则用于 test, 不能带 g 标志(无状态)。
 */
export const HOST_DEFERRED_REPLIES: Array<{
  query: RegExp;
  reply: string;
}> = [
  {
    query: /\x1b\[>0q/,
    reply: "\x1bP>|xterm.js(6.0.0)\x1b\\",
  },
];

/** 组合出回放剥离用的单一查询正则(供 String.replace 使用, 需 g 标志)。 */
export function buildRebuildQueryRe(): RegExp {
  const sources = [
    ...XTERM_AUTO_REPLY_PATTERNS,
    ...HOST_DEFERRED_REPLIES.map((r) => r.query),
  ].map((re) => re.source);
  return new RegExp(sources.join("|"), "g");
}
