/**
 * createViewport 的滚轮路径测试。
 *
 * canvas-viewport.test.ts 里的 computeZoomStep 是复制出来的逻辑副本，
 * 测不到模块自身；这里直接构造 DOM stub 驱动 createViewport，覆盖
 * applyZoom / wheel 监听器的真实执行路径（含 zoom-indicator 副作用）。
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// 同进程可能已有其他用例注册过(happy-dom 全局注册不可重复), 幂等处理。
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

type Viewport = {
  init(state: unknown, cb: () => void): void;
  applyZoom(deltaY: number, focalX: number, focalY: number): void;
  setPan(x: number, y: number): void;
};

let createViewport: (
  canvasEl: unknown,
  gridCanvas: unknown,
  tilesRef: unknown[],
) => Viewport;

beforeAll(async () => {
  ({ createViewport } = (await import("./canvas-viewport.js")) as {
    createViewport: typeof createViewport;
  });
});

const W = 800;
const H = 600;

function makeCanvasEl(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: W });
  Object.defineProperty(el, "clientHeight", { value: H });
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: W,
      bottom: H,
      width: W,
      height: H,
      x: 0,
      y: 0,
    }) as DOMRect;
  return el;
}

// happy-dom 无 2d context，用 stub 顶替 drawGrid 的绘制调用。
function makeGridCanvas(): HTMLCanvasElement {
  const ctx = {
    fillStyle: "",
    setTransform() {},
    clearRect() {},
    fillRect() {},
  };
  const el = document.createElement("canvas");
  el.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return el;
}

function setup() {
  document.body.innerHTML = '<div id="zoom-indicator"></div>';
  const canvasEl = makeCanvasEl();
  document.body.appendChild(canvasEl);
  const state = { panX: 0, panY: 0, zoom: 1 };
  const vp = createViewport(canvasEl, makeGridCanvas(), []);
  vp.init(state, () => {});
  return { canvasEl, state, vp };
}

describe("createViewport applyZoom", () => {
  test("applyZoom 生效: 正 deltaY 缩小视图", () => {
    const { state, vp } = setup();
    vp.applyZoom(40, W / 2, H / 2);
    expect(state.zoom).toBeLessThan(1);
  });

  test("applyZoom 生效: 负 deltaY 放大视图且受 ZOOM_MAX 约束", () => {
    const { state, vp } = setup();
    vp.applyZoom(-40, W / 2, H / 2);
    expect(state.zoom).toBeGreaterThanOrEqual(1);
  });

  test("applyZoom 以焦点为中心调整 pan", () => {
    const { state, vp } = setup();
    vp.applyZoom(40, 100, 100);
    expect(state.panX).not.toBe(0);
    expect(state.panY).not.toBe(0);
  });
});

describe("createViewport wheel 监听", () => {
  function wheel(canvasEl: HTMLElement, init: WheelEventInit) {
    const ev = new WheelEvent("wheel", {
      deltaY: 0,
      deltaX: 0,
      clientX: W / 2,
      clientY: H / 2,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    // happy-dom 的 WheelEvent 未实现修饰键访问器, init 里的 ctrlKey/metaKey
    // 读出来是 undefined, 需手动落为实例属性才能驱动 shouldZoom 的分支。
    if (init.ctrlKey) Object.defineProperty(ev, "ctrlKey", { value: true });
    if (init.metaKey) Object.defineProperty(ev, "metaKey", { value: true });
    canvasEl.dispatchEvent(ev);
  }

  test("ctrl+wheel 缩放视图", () => {
    const { canvasEl, state } = setup();
    wheel(canvasEl, { deltaY: 40, ctrlKey: true });
    expect(state.zoom).toBeLessThan(1);
  });

  test("无修饰键的 wheel 平移画布", () => {
    const { canvasEl, state } = setup();
    wheel(canvasEl, { deltaY: 40 });
    expect(state.panY).not.toBe(0);
    expect(state.zoom).toBe(1);
  });
});
