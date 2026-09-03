/**
 * 等比适配缩放计算（纯函数）。
 *
 * Client 镜像 Host 画布时，在 Client 本地视口计算适配 zoom：
 * zoom = hostZoom × min(clientW / hostW, clientH / hostH)
 * —— 宽高比一致时按单维比；不一致时取较小比，等比完整展示、不裁剪
 * （短边方向留白）。仅 Client 端视图变换，不回写 Host。
 */

export const FIT_ZOOM_MIN = 0.05;
export const FIT_ZOOM_MAX = 8;

export function computeFitZoom({
  hostW,
  hostH,
  hostZoom = 1,
  clientW,
  clientH,
}) {
  if (!hostW || !hostH || !clientW || !clientH) return null;
  const scale = Math.min(clientW / hostW, clientH / hostH);
  const raw = (hostZoom || 1) * scale;
  const zoom = Math.max(FIT_ZOOM_MIN, Math.min(FIT_ZOOM_MAX, raw));
  return { zoom, scale };
}
