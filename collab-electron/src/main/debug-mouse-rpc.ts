import { webContents } from "electron";
import { registerMethod } from "./json-rpc-server";

/**
 * 自动化调试通道(仅本机 unix socket 可达, 与 service/* 等现有方法同一信任
 * 模型): 在 terminal-tile webview 内查找 OSC 8 链接、并模拟鼠标点击。
 * 供开发期验证"链接点击拦截/编辑器打开"行为, 无需人工点击。
 */

function findTerminalTileWebContents(): Electron.WebContents {
  const wc = webContents
    .getAllWebContents()
    .find((w) => !w.isDestroyed() && w.getURL().includes("terminal-tile"));
  if (!wc) throw new Error("no terminal-tile webview found");
  return wc;
}

const FIND_LINKS_CODE = `(() => {
  const term = window.__collabTerm;
  if (!term) return [];
  const buf = term.buffer.active;
  const vpY = buf.viewportY;
  const out = [];
  for (let r = 0; r < term.rows; r++) {
    const line = buf.getLine(vpY + r);
    if (!line) continue;
    for (let c = 0; c < line.length; c++) {
      const cell = line.getCell(c);
      if (
        cell &&
        typeof cell.hasExtendedAttrs === "function" &&
        cell.hasExtendedAttrs() &&
        cell.extended &&
        cell.extended.urlId > 0
      ) {
        out.push({ col: c + 1, row: r + 1 });
        break;
      }
    }
  }
  return out;
})()`;

function clickCode(col: number, row: number): string {
  return `(() => {
  const term = window.__collabTerm;
  if (!term) return "NO_TERM";
  const canvas = term.element.querySelector("canvas");
  if (!canvas) return "NO_CANVAS";
  const rect = canvas.getBoundingClientRect();
  const cellW = rect.width / term.cols;
  const cellH = rect.height / term.rows;
  const x = rect.left + cellW * (${col} - 0.5);
  const y = rect.top + cellH * (${row} - 0.5);
  const screen = term.element.querySelector(".xterm-screen") || term.element;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  screen.dispatchEvent(new MouseEvent("mousemove", Object.assign({}, opts, { buttons: 0, button: 0 })));
  return new Promise((resolve) => {
    setTimeout(() => {
      screen.dispatchEvent(new MouseEvent("mousedown", Object.assign({}, opts, { buttons: 1, button: 0 })));
      screen.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, opts, { buttons: 0, button: 0 })));
      resolve("OK");
    }, 200);
  });
})()`;
}

export function registerDebugMouseRpc(): void {
  registerMethod(
    "debug.terminalFindLinks",
    async () => {
      const wc = findTerminalTileWebContents();
      return await wc.executeJavaScript(FIND_LINKS_CODE);
    },
    {
      description: "Find OSC 8 link cells in the terminal-tile viewport",
    },
  );

  registerMethod(
    "debug.terminalClick",
    async (params: unknown) => {
      const { col, row } = params as { col: number; row: number };
      if (typeof col !== "number" || typeof row !== "number") {
        throw new Error("col/row required (1-based)");
      }
      const wc = findTerminalTileWebContents();
      return await wc.executeJavaScript(clickCode(col, row));
    },
    {
      description: "Simulate a mouse click at a cell in the terminal-tile",
      params: { col: "1-based column", row: "1-based row" },
    },
  );
}
