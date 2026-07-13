import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { registerMethod } from "./json-rpc-server";
import { pushToHistory, goBack, goForward } from "./navigation-history";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT_MS = 10_000;

let shellWindow: BrowserWindow | null = null;

function sendToShell(method: string, params: unknown): Promise<unknown> {
  if (!shellWindow || shellWindow.isDestroyed()) {
    return Promise.reject(new Error("Shell window not available"));
  }

  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`canvas RPC timed out: ${method}`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, { resolve, reject, timer });

    shellWindow!.webContents.send("canvas:rpc-request", {
      requestId,
      method: method.replace(/^canvas\./, ""),
      params,
    });
  });
}

export function registerCanvasRpc(win: BrowserWindow): void {
  shellWindow = win;

  ipcMain.on(
    "canvas:rpc-response",
    (
      _event,
      response: {
        requestId: string;
        result?: unknown;
        error?: { code: number; message: string };
      },
    ) => {
      const entry = pending.get(response.requestId);
      if (!entry) return;

      pending.delete(response.requestId);
      clearTimeout(entry.timer);

      if (response.error) {
        entry.reject(new Error(response.error.message));
      } else {
        entry.resolve(response.result);
      }
    },
  );

  registerMethod(
    "canvas.tileList",
    (params) => sendToShell("canvas.tileList", params),
    {
      description: "List all canvas tiles with positions",
      params: {},
    },
  );

  registerMethod(
    "canvas.tileCreate",
    (params) => sendToShell("canvas.tileCreate", params),
    {
      description: "Create a new tile on the canvas",
      params: {
        type: "Tile type (note, code, image, graph, terminal)",
        filePath: "(optional) Absolute path to file",
        folderPath: "(optional) Absolute path to folder",
        position: "(optional) {x, y} canvas coordinates",
        size: "(optional) {width, height} in pixels",
      },
    },
  );

  registerMethod(
    "canvas.tileRemove",
    (params) => sendToShell("canvas.tileRemove", params),
    {
      description: "Remove a tile from the canvas",
      params: { tileId: "ID of the tile to remove" },
    },
  );

  registerMethod(
    "canvas.tileMove",
    (params) => sendToShell("canvas.tileMove", params),
    {
      description: "Move a tile to a new position",
      params: {
        tileId: "ID of the tile to move",
        position: "{x, y} canvas coordinates",
      },
    },
  );

  registerMethod(
    "canvas.tileResize",
    (params) => sendToShell("canvas.tileResize", params),
    {
      description: "Resize a tile",
      params: {
        tileId: "ID of the tile to resize",
        size: "{width, height} in pixels",
      },
    },
  );

  registerMethod(
    "canvas.terminalWrite",
    (params) => sendToShell("canvas.terminalWrite", params),
    {
      description: "Write input to a terminal tile",
      params: {
        tileId: "ID of the terminal tile",
        input: "String to write to the terminal",
      },
    },
  );

  registerMethod(
    "canvas.terminalWriteFocused",
    async (params) => {
      const result = await sendToShell("canvas.terminalWriteFocused", params);
      shellWindow?.focus();
      return result;
    },
    {
      description: "Write input to the focused terminal tile",
      params: {
        input: "String to write to the terminal",
      },
    },
  );

  registerMethod(
    "canvas.terminalRead",
    (params) => sendToShell("canvas.terminalRead", params),
    {
      description: "Read recent output from a terminal tile",
      params: {
        tileId: "ID of the terminal tile",
        lines: "(optional) Number of lines to capture (default 50)",
      },
    },
  );

  registerMethod(
    "canvas.tileFocus",
    (params) => sendToShell("canvas.tileFocus", params),
    {
      description:
        "Pan and zoom viewport to show the specified tiles, " +
        "then flash their focus rings",
      params: {
        tileIds: "Array of tile IDs to bring into view",
      },
    },
  );

  registerMethod(
    "canvas.tileNotify",
    (params) => sendToShell("canvas.tileNotify", params),
    {
      description:
        "Show a macOS-style notification for a tile in the " +
        "top-right corner. Clicking the notification pans to " +
        "and focuses the tile.",
      params: {
        tileId: "ID of the tile to notify about",
        message: "(optional) Extra message text shown below the title",
      },
    },
  );

  registerMethod(
    "canvas.viewportGet",
    (params) => sendToShell("canvas.viewportGet", params),
    {
      description: "Get current canvas viewport (pan and zoom)",
      params: {},
    },
  );

  registerMethod(
    "canvas.viewportSet",
    (params) => sendToShell("canvas.viewportSet", params),
    {
      description: "Set canvas viewport pan and zoom",
      params: {
        x: "Viewport x offset",
        y: "Viewport y offset",
        zoom: "Zoom level (1 = 100%)",
      },
    },
  );

  registerMethod(
    "canvas.browserNavigate",
    (params) => sendToShell("browserNavigate", params),
    {
      description: "Navigate a browser tile to a URL",
      params: {
        tileId: "ID of the browser tile",
        url: "URL to navigate to",
      },
    },
  );

  registerMethod(
    "canvas.browserScreenshot",
    (params) => sendToShell("browserScreenshot", params),
    {
      description: "Capture a screenshot of a browser tile (base64 PNG)",
      params: { tileId: "ID of the browser tile" },
    },
  );

  registerMethod(
    "canvas.browserSnapshot",
    (params) => sendToShell("browserSnapshot", params),
    {
      description: "Get DOM tree snapshot of a browser tile",
      params: { tileId: "ID of the browser tile" },
    },
  );

  registerMethod(
    "canvas.browserClick",
    (params) => sendToShell("browserClick", params),
    {
      description: "Click an element in a browser tile",
      params: {
        tileId: "ID of the browser tile",
        selector: "CSS selector for the element to click",
      },
    },
  );

  registerMethod(
    "canvas.browserType",
    (params) => sendToShell("browserType", params),
    {
      description: "Type text into an element in a browser tile",
      params: {
        tileId: "ID of the browser tile",
        selector: "CSS selector for the element",
        text: "Text to type",
      },
    },
  );

  registerMethod(
    "canvas.browserScroll",
    (params) => sendToShell("browserScroll", params),
    {
      description: "Scroll a browser tile",
      params: {
        tileId: "ID of the browser tile",
        x: "Horizontal scroll delta (pixels)",
        y: "Vertical scroll delta (pixels)",
      },
    },
  );

  registerMethod(
    "canvas.browserEvaluate",
    (params) => sendToShell("browserEvaluate", params),
    {
      description: "Run JavaScript in a browser tile and return the result",
      params: {
        tileId: "ID of the browser tile",
        expression: "JavaScript expression to evaluate",
      },
    },
  );

  registerMethod(
    "canvas.browserWait",
    (params) => sendToShell("browserWait", params),
    {
      description: "Wait for a browser tile to finish loading",
      params: {
        tileId: "ID of the browser tile",
        timeout: "(optional) Max wait in ms (default 10000)",
      },
    },
  );

  registerMethod(
    "canvas.browserInfo",
    (params) => sendToShell("browserInfo", params),
    {
      description:
        "Get current URL, title, and loading state of a " + "browser tile",
      params: { tileId: "ID of the browser tile" },
    },
  );

  // Navigation history IPC
  ipcMain.on("navigation:push", (_event, tileId: string) => {
    pushToHistory(tileId);
  });

  ipcMain.handle("navigation:go-back", () => goBack());
  ipcMain.handle("navigation:go-forward", () => goForward());
}
