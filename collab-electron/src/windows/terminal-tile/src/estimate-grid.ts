// 终端初始网格估算:新建/恢复会话时 xterm 尚未挂载、无法 fit,只能按
// 容器像素 ÷ cell 度量估算 cols/rows。cell 度量优先用主进程校准的真实值
// (由 TerminalTab fit 落定后经 ptyReportFit 写入 pref),缺失时回落常量。
export const FALLBACK_CELL_WIDTH = 7.0; // 硬编码假设:Menlo 12px on macOS 实测
export const FALLBACK_CELL_HEIGHT = 14;
export const MIN_COLS = 80;
export const MIN_ROWS = 24;

export function estimateGrid(
  pixelWidth: number,
  pixelHeight: number,
  cellWidth: number = FALLBACK_CELL_WIDTH,
  cellHeight: number = FALLBACK_CELL_HEIGHT,
): { cols: number; rows: number } {
  const cw = cellWidth > 0 ? cellWidth : FALLBACK_CELL_WIDTH;
  const ch = cellHeight > 0 ? cellHeight : FALLBACK_CELL_HEIGHT;
  return {
    cols: Math.max(MIN_COLS, Math.floor(pixelWidth / cw)),
    rows: Math.max(MIN_ROWS, Math.floor(pixelHeight / ch)),
  };
}
