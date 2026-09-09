import { describe, expect, test } from "bun:test";
import {
  estimateGrid,
  FALLBACK_CELL_HEIGHT,
  FALLBACK_CELL_WIDTH,
  MIN_COLS,
  MIN_ROWS,
} from "./estimate-grid";

describe("estimateGrid", () => {
  test("无校准回落常量", () => {
    expect(estimateGrid(1200, 900)).toEqual({
      cols: Math.floor(1200 / FALLBACK_CELL_WIDTH),
      rows: Math.floor(900 / FALLBACK_CELL_HEIGHT),
    });
  });

  test("校准 cell 度量生效(px/格与网格互洽)", () => {
    // 容器 1200px 渲染出 168 列 → cellW ≈ 7.1429
    const cellW = 1200 / 168;
    const cellH = 900 / 64;
    expect(estimateGrid(1200, 900, cellW, cellH)).toEqual({
      cols: 168,
      rows: 64,
    });
  });

  test("任意像素尺寸都按校准度量换算", () => {
    const cellW = 7.5;
    const cellH = 16;
    expect(estimateGrid(900, 500, cellW, cellH)).toEqual({
      cols: 120,
      rows: 31,
    });
  });

  test("像素不足时夹到下限(80x24)", () => {
    expect(estimateGrid(100, 100)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
    expect(estimateGrid(0, 0)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
  });

  test("非法校准值回落到常量", () => {
    expect(estimateGrid(1200, 900, 0, -5)).toEqual({
      cols: Math.floor(1200 / FALLBACK_CELL_WIDTH),
      rows: Math.floor(900 / FALLBACK_CELL_HEIGHT),
    });
  });
});
