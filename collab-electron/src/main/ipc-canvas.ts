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

/** tile 几何提交载荷（拖拽/缩放落定值, 与画布坐标一致） */
export interface TileGeometryPayload {
  tileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Host 激活时由 remote-server 注入（pushEvent 推给控制端 Client）；
// 非 Host 角色（idle full / remote client 本地回落）为 null → no-op。
let tileGeometrySink: ((p: TileGeometryPayload) => void) | null = null;

export function setTileGeometrySink(
  fn: ((p: TileGeometryPayload) => void) | null,
): void {
  tileGeometrySink = fn;
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

  // Tile geometry commit (drag/resize 落定后由 shell renderer 上报)。
  // Full 版本地实现：Host 会话激活时经 sink 镜像给控制端 Client；
  // Remote 版远程模式激活时由 ipc-registry 整体转发为 Host rpc，不经此实现。
  bindIpc("canvas:update-tile-geometry", "handle", (_event, payload) => {
    console.log(
      `[canvas] host update-tile-geometry ${JSON.stringify(payload)}`,
    );
    tileGeometrySink?.(payload as TileGeometryPayload);
    return true;
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
    "canvas:update-tile-geometry",
  ]) {
    markForward(channel);
  }
}
