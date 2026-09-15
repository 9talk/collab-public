// OSC 9;4 (iTerm2 进度上报) 运行态扫描。
// Claude Code 的 ink 在工具运行时写 "\x1b]9;4;3;\x07"(INDETERMINATE),
// 任务完成时写 "\x1b]9;4;0;\x07"(CLEAR), 错误结束时写 9;4;2(ERROR)。
// Host 在转发 PTY 输出时扫描该序列, 维护 tile 的运行指示条 —— 状态解析
// 必须在主进程完成: 省内存模式回收终端 webview 后, 到达已销毁 frame 的
// 数据会被丢弃, 依赖 webview 解析会丢失 CLEAR 导致指示条卡在运行中。
// 序列可被任意 PTY chunk 切分, 需由调用方把上一 chunk 留下的半截前缀
// (prev)与当前 data 拼接后扫描; 返回的 pending 须缓存到下一次拼接。

const MAX_PENDING = 32; // 9;4 序列本身极短, 超长前缀视为垃圾不再等待
const OSC94_RE = /\x1b\]9;4;(\d+)(?:;\d*)?(?:\x07|\x1b\\)/g;

export type Osc94State = "running" | "idle";

export interface Osc94ScanResult {
  /** 按出现顺序解析出的运行态(未识别的状态值不产出) */
  states: Osc94State[];
  /** 需要与下一 chunk 拼接的半截前缀; 空串表示无悬挂 */
  pending: string;
}

export function scanOsc94(prev: string, data: string): Osc94ScanResult {
  const full = prev + data;

  const states: Osc94State[] = [];
  OSC94_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC94_RE.exec(full)) !== null) {
    const n = Number(m[1]);
    if (n === 1 || n === 3) states.push("running");
    else if (n === 0 || n === 2) states.push("idle");
  }

  // 尾部若遗留未闭合的 "\x1b]9;4…"(被 chunk 切开的前缀), 缓存到下一段补齐。
  const tailIdx = full.lastIndexOf("\x1b]9;4");
  if (tailIdx >= 0) {
    const tail = full.slice(tailIdx);
    if (!/(?:\x07|\x1b\\)/.test(tail) && tail.length <= MAX_PENDING) {
      return { states, pending: tail };
    }
  }
  return { states, pending: "" };
}
