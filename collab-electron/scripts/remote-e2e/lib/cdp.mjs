import WebSocket from "ws";
import { execFileSync } from "node:child_process";

const SCRIPT_ORIGIN = "https://localhost";

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
  const ws = new WebSocket(wsUrl, { origin: SCRIPT_ORIGIN });
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
