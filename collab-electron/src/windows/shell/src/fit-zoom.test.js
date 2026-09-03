import { describe, expect, test } from "bun:test";
import { computeFitZoom, FIT_ZOOM_MIN, FIT_ZOOM_MAX } from "./fit-zoom";

describe("computeFitZoom", () => {
  test("宽高比一致时按单维比缩放(1200 vs 1920)", () => {
    const fit = computeFitZoom({
      hostW: 1920,
      hostH: 1080,
      hostZoom: 1,
      clientW: 1200,
      clientH: 675,
    });
    expect(fit.zoom).toBeCloseTo(0.625, 5);
    expect(fit.scale).toBeCloseTo(0.625, 5);
  });

  test("比例不一致时取 min(宽比, 高比), 内容完整不裁剪", () => {
    const fit = computeFitZoom({
      hostW: 2560,
      hostH: 1440,
      hostZoom: 1,
      clientW: 1280,
      clientH: 600,
    });
    // 宽比 0.5, 高比 ~0.4167 → 取 0.4167(短边方向留白)
    expect(fit.zoom).toBeCloseTo(0.4167, 3);
  });

  test("基准 zoom 参与计算(host zoom 0.8 → 等比缩小)", () => {
    const fit = computeFitZoom({
      hostW: 1920,
      hostH: 1080,
      hostZoom: 0.8,
      clientW: 1200,
      clientH: 675,
    });
    expect(fit.zoom).toBeCloseTo(0.625 * 0.8, 5);
  });

  test("Client 更大时等比放大", () => {
    const fit = computeFitZoom({
      hostW: 1280,
      hostH: 720,
      hostZoom: 1,
      clientW: 2560,
      clientH: 1440,
    });
    expect(fit.zoom).toBeCloseTo(2, 5);
  });

  test("边界:非法输入返回 null", () => {
    expect(
      computeFitZoom({ hostW: 0, hostH: 1, clientW: 1, clientH: 1 }),
    ).toBeNull();
    expect(
      computeFitZoom({ hostW: 1, hostH: 1, clientW: 0, clientH: 1 }),
    ).toBeNull();
  });

  test("边界:极端比例 clamp 到安全范围", () => {
    const tiny = computeFitZoom({
      hostW: 32000,
      hostH: 2000,
      clientW: 100,
      clientH: 100,
    });
    expect(tiny.zoom).toBeGreaterThanOrEqual(FIT_ZOOM_MIN);

    const huge = computeFitZoom({
      hostW: 100,
      hostH: 100,
      clientW: 50000,
      clientH: 50000,
    });
    expect(huge.zoom).toBeLessThanOrEqual(FIT_ZOOM_MAX);
  });
});
