import { ipcMain, type BrowserWindow } from "electron";
import * as canvasPersistence from "./canvas-persistence";
import { bindIpc, markForward } from "./ipc-registry";

interface IpcContext {
  mainWindow: () => BrowserWindow | null;
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
}

export function registerCanvasHandlers(ctx: IpcContext): void {
  let pendingDragPaths: string[] = [];

  // Canvas persistence
  bindIpc("canvas:load-state", "handle", async () =>
    canvasPersistence.loadState(),
  );

  bindIpc("canvas:save-state", "handle", async (_event, state) =>
    canvasPersistence.saveState(state),
  );

  // Request current canvas state from renderer (used during quit)
  bindIpc("canvas:get-state-for-save", "handle", async () => {
    const win = ctx.mainWindow();
    if (!win || win.isDestroyed()) return null;
    try {
      return await win.webContents.executeJavaScript(
        "window.__getCanvasStateForSave()",
      );
    } catch {
      return null;
    }
  });

  // Canvas pinch forwarding
  ipcMain.on("canvas:forward-pinch", (_event, deltaY: number) => {
    ctx.mainWindow()?.webContents.send("canvas:pinch", deltaY);
  });

  // Cross-webview drag-and-drop
  ipcMain.on("drag:set-paths", (_event, paths: string[]) => {
    pendingDragPaths = paths;
    ctx.forwardToWebview("viewer", "nav-drag-active", true);
  });

  ipcMain.on("drag:clear-paths", () => {
    pendingDragPaths = [];
    ctx.forwardToWebview("viewer", "nav-drag-active", false);
  });

  ipcMain.handle("drag:get-paths", () => {
    const paths = pendingDragPaths;
    pendingDragPaths = [];
    return paths;
  });

  // ---- remote forwarding whitelist ----
  for (const channel of [
    "canvas:load-state",
    "canvas:save-state",
    "canvas:get-state-for-save",
  ]) {
    markForward(channel);
  }
}
