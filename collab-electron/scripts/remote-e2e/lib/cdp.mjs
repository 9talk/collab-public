import WebSocket from "ws";
import { execFileSync } from "node:child_process";

/**
 * 查找 Chromium 调试目标的 websocket URL（electron-vite --remoteDebuggingPort）。
 * target 过滤：url 或 title 包含关键字的 page/webview（terminal-tile 等子窗口是 webview 类型）。
 */
export function cdpTarget(port, keyword) {
  const out = execFileSync(
    "curl",
    ["-s", `http://127.0.0.1:${port}/json/list`],
    { encoding: "utf-8" },
  );
  const list = JSON.parse(out);
  const page = list.find(
    (t) =>
      (t.type === "page" || t.type === "webview") &&
      (t.url.includes(keyword) || (t.title || "").includes(keyword)),
  );
  return page?.webSocketDebuggerUrl ?? null;
}

async function cdpConnect(wsUrl) {
  // 注意:不传 Origin 头(带任何跨源 Origin 都会被 Electron/Chromium 的
  // remote-debugging 服务以 403 拒绝;无 Origin 视为非浏览器客户端放行)。
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error)
        reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

/** 在目标页面执行 JS 表达式（awaitPromise），返回 JSON 值。 */
export async function cdpEval(wsUrl, expression) {
  const c = await cdpConnect(wsUrl);
  try {
    const res = await c.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  } finally {
    c.close();
  }
}

/** 等待目标页面出现（轮询 /json/list），超时返回 null。 */
export async function cdpWaitTarget(port, keyword, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const wsUrl = cdpTarget(port, keyword);
      if (wsUrl) return wsUrl;
    } catch {
      // 调试端口未就绪
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** 在 terminal-tile webview 内轮询表达式直到 truthy，超时抛错。 */
export async function cdpWaitInTerminal(port, expression, timeoutMs = 30_000) {
  const wsUrl = await cdpWaitTarget(port, "terminal-tile", timeoutMs);
  if (!wsUrl) throw new Error(`CDP 未找到 terminal-tile (port=${port})`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await cdpEval(wsUrl, expression);
    if (v) return wsUrl;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`terminal-tile 条件超时 (port=${port}): ${expression}`);
}

/** 点击 shell 窗口的"新建 tile"按钮（浏览器按钮，绕开坐标/z-order）。 */
export async function clickNewTile(port, timeoutMs = 30_000) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", timeoutMs);
  if (!wsUrl) throw new Error(`CDP 未找到 shell 页面 (port=${port})`);
  const res = await cdpEval(
    wsUrl,
    `
(() => {
  const btn = document.getElementById("new-tile-btn");
  if (!btn) return "no-btn";
  btn.click();
  return "clicked";
})()
`,
  );
  if (res !== "clicked") throw new Error(`new-tile-btn 未点击成功: ${res}`);
}

/**
 * 对指定 target 截图（Page.captureScreenshot），写 PNG 到 outPath。
 * 失败抛错由调用方捕获（截图是辅助手段，不影响场景结果）。
 */
export async function cdpScreenshot(
  port,
  keyword,
  outPath,
  timeoutMs = 15_000,
) {
  const wsUrl = await cdpWaitTarget(port, keyword, timeoutMs);
  if (!wsUrl)
    throw new Error(`CDP 未找到截图 target: ${keyword} (port=${port})`);
  const c = await cdpConnect(wsUrl);
  try {
    const res = await c.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, Buffer.from(res.data, "base64"));
  } finally {
    c.close();
  }
}

/** 在 terminal-tile webview 输入文本并回车（xterm 输入缓冲 + PTY 执行）。 */
export async function cdpTerminalInput(port, text, timeoutMs = 15_000) {
  const wsUrl = await cdpWaitInTerminal(
    port,
    `!!document.querySelector(".xterm")`,
    timeoutMs,
  );
  const c = await cdpConnect(wsUrl);
  try {
    await c.send("Runtime.evaluate", {
      expression: `document.querySelector(".xterm-helper-textarea")?.focus()`,
    });
    await new Promise((r) => setTimeout(r, 200));
    await c.send("Input.insertText", { text });
    await new Promise((r) => setTimeout(r, 200));
    await c.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
    await c.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  } finally {
    c.close();
  }
}

/** 等待 shell 画布出现第 index 个 tile（默认第 0 个），返回其屏幕 rect。 */
export async function cdpTileRect(port, index = 0, timeoutMs = 30_000) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", timeoutMs);
  if (!wsUrl) throw new Error(`CDP 未找到 shell (port=${port})`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await cdpEval(
      wsUrl,
      `(() => {
        const el = document.querySelectorAll(".canvas-tile")[${index}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })()`,
    );
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`canvas tile#${index} 超时 (port=${port})`);
}

/** 点击第 index 个 tile 的解锁按钮（tile 默认 locked，需解锁才能拖/缩放）。 */
export async function cdpUnlockTile(port, index = 0) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", 15_000);
  if (!wsUrl) throw new Error(`CDP 未找到 shell (port=${port})`);
  const res = await cdpEval(
    wsUrl,
    `(() => {
      const btn = document.querySelectorAll(".canvas-tile")[${index}]?.querySelector(".tile-lock-btn");
      if (!btn) return "no-btn";
      btn.click();
      return "ok";
    })()`,
  );
  if (res !== "ok") throw new Error(`tile#${index} 解锁失败: ${res}`);
}

/**
 * 真实鼠标拖拽第 index 个 tile 的标题栏（dx/dy 为屏幕像素位移）。
 * 起点取 title-bar 与视口的交集中心（防止 tile 中心在视口外时事件越界），
 * 经 attachDrag 的 mousedown/mousemove/mouseup 完整路径落定并 snap。
 */
export async function cdpDragTileBy(port, dx, dy, index = 0) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", 15_000);
  if (!wsUrl) throw new Error(`CDP 未找到 shell (port=${port})`);
  const pt = await cdpEval(
    wsUrl,
    `(() => {
      const el = document.querySelectorAll(".canvas-tile")[${index}]?.querySelector(".tile-title-bar");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      const cx = clamp(r.left + r.width / 2, r.left + 8, Math.min(r.right - 8, vw - 8));
      const cy = clamp(r.top + r.height / 2, r.top + 8, Math.min(r.bottom - 8, vh - 8));
      return {
        x: Math.round(cx),
        y: Math.round(cy),
        vw,
        vh,
      };
    })()`,
  );
  if (!pt) throw new Error(`tile#${index} 标题栏不存在`);
  console.log(
    `  [cdp] drag tile#${index} 起点 (${pt.x},${pt.y}) 视口 ${pt.vw}x${pt.vh}.`,
  );
  const c = await cdpConnect(wsUrl);
  try {
    const steps = 12;
    await c.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pt.x,
      y: pt.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 14));
      await c.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(pt.x + (dx * i) / steps),
        y: Math.round(pt.y + (dy * i) / steps),
        button: "left",
        buttons: 1,
      });
    }
    await new Promise((r) => setTimeout(r, 40));
    await c.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pt.x + dx,
      y: pt.y + dy,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    c.close();
  }
  // 等 snap + onUpdate + commit 上报落定
  await new Promise((r) => setTimeout(r, 600));
}

/**
 * 真实鼠标单击第 index 个 tile 的标题栏中心(mousedown/mouseup 完整路径,
 * 经 attachDrag onFocus → focusCanvasTile 聚焦)。起点 clamp 与拖拽一致。
 */
export async function cdpClickTile(port, index = 0) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", 15_000);
  if (!wsUrl) throw new Error(`CDP 未找到 shell (port=${port})`);
  const pt = await cdpEval(
    wsUrl,
    `(() => {
      const el = document.querySelectorAll(".canvas-tile")[${index}]?.querySelector(".tile-title-bar");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      const cx = clamp(r.left + r.width / 2, r.left + 8, Math.min(r.right - 8, vw - 8));
      const cy = clamp(r.top + r.height / 2, r.top + 8, Math.min(r.bottom - 8, vh - 8));
      return { x: Math.round(cx), y: Math.round(cy) };
    })()`,
  );
  if (!pt) throw new Error(`tile#${index} 标题栏不存在`);
  const c = await cdpConnect(wsUrl);
  try {
    await c.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pt.x,
      y: pt.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 30));
    await c.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pt.x,
      y: pt.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    c.close();
  }
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * 真实键盘事件(CDP Input.dispatchKeyEvent,带 keyCode 走 Chromium 输入管线,
 * 可驱动 Electron before-input-event 层快捷键)。
 */
export async function cdpKeyEvent(
  port,
  { key, code, keyCode, meta = false, ctrl = false },
  holdMs = 120,
) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", 15_000);
  if (!wsUrl) throw new Error(`CDP 未找到 shell (port=${port})`);
  const modifiers = (meta ? 4 : 0) | (ctrl ? 2 : 0);
  const c = await cdpConnect(wsUrl);
  try {
    await c.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await new Promise((r) => setTimeout(r, holdMs));
    await c.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  } finally {
    c.close();
  }
  await new Promise((r) => setTimeout(r, 300));
}

/** 在 shell 页面执行 JS（带超时等待 target），返回 JSON 值。 */
export async function cdpEvalShell(port, expression, timeoutMs = 15_000) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", timeoutMs);
  if (!wsUrl) throw new Error(`CDP 未找到 shell (port=${port})`);
  return cdpEval(wsUrl, expression);
}

/**
 * 调整窗口尺寸触发 shell 画布 resize（M4 fit 重算入口）。
 * Electron 未实现 CDP Browser.setWindowBounds，改用页面 window.resizeTo
 * （Electron 渲染进程可调整所属 BrowserWindow），并校验真实生效。
 */
export async function cdpResizeWindow(port, width, height) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", 15_000);
  if (!wsUrl) throw new Error(`CDP 未找到 shell (port=${port})`);
  const res = await cdpEval(
    wsUrl,
    `(() => {
      const before = [window.innerWidth, window.innerHeight];
      window.resizeTo(${Math.round(width)}, ${Math.round(height)});
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            before,
            after: [window.innerWidth, window.innerHeight],
            outer: [window.outerWidth, window.outerHeight],
          });
        }, 800);
      });
    })()`,
  );
  if (!res?.after) throw new Error(`resizeTo 未生效: ${JSON.stringify(res)}`);
  const [w0, h0] = res.before;
  const [w1, h1] = res.after;
  if (w1 === w0 && h1 === h0) {
    throw new Error(`resizeTo 后窗口尺寸未变: ${JSON.stringify(res)}`);
  }
  return res;
}
