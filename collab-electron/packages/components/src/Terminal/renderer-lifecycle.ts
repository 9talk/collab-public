/** 可释放资源的最小接口(WebglAddon 等均满足)。 */
export interface Disposable {
  dispose(): void;
}

/**
 * 单实例资源槽。
 *
 * xterm 的 RenderService.setRenderer 只替换引用、不 dispose 旧渲染器;
 * 回收整套 GL 资源(纹理/program/上下文)只能靠 WebglAddon.dispose()。
 * 不显式回收会泄漏显存,且旧 addon 永久滞留在 AddonManager 里。
 *
 * 顺序约束:必须 replace() 释放旧实例后,再 loadAddon() 激活新实例 ——
 * WebglAddon.dispose() 会把 renderer 重置回默认 DOM 渲染器,反序会顶掉
 * 刚装上的新实例。
 */
export function createDisposableSlot<T extends Disposable>() {
  let current: T | null = null;
  return {
    replace(create: () => T): T {
      current?.dispose();
      current = create();
      return current;
    },
    /** 释放指定实例;仅当它是槽内当前实例时才清空槽位,避免迟到回调误伤。 */
    release(target: T): void {
      target.dispose();
      if (current === target) {
        current = null;
      }
    },
    clear(): void {
      current?.dispose();
      current = null;
    },
    get current(): T | null {
      return current;
    },
  };
}

/**
 * 数据落盘后的视口重绘策略。
 *
 * 主屏:立即 refresh(标记脏行重绘)全视口。
 * alt 屏(全屏 TUI,如 Claude Code):不在数据流现场重绘(滚动高峰会放大卡顿),
 * 交给 scheduleAltRepaint 去节流,最长每 ALT_REPAINT_INTERVAL_MS 强制重绘一次
 * —— 见 TerminalTab 的说明。用 refresh 而非 clearTextureAtlas:后者清空跨
 * Terminal 实例共享的字形图集并触发全部重栅格化,代价远高于重绘本身。
 */
export function repaintAfterData(
  term: { rows: number; refresh(start: number, end: number): void },
  isAltScreen: boolean,
  scheduleAltRepaint: () => void,
): void {
  if (!isAltScreen) {
    term.refresh(0, term.rows - 1);
    return;
  }
  scheduleAltRepaint();
}
