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

  // Client 端聚焦 → Host 镜像跟随。full(full) 本地无镜像视图可跟,仅占位
  // 注册以保证 remote 模式激活时 ipc-registry 能整体转发为 Host rpc。
  bindIpc("canvas:focus-tile", "handle", (_event, tileId) => {
    console.log(`[canvas] focus-tile ${String(tileId)}`);
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
  // 注:canvas:save-state 不转发——镜像(Client)端保存 no-op(renderer 已
  // gate),画布持久化以 Host 为唯一权威;转发会把 Client 本地状态写坏 Host 盘。
  for (const channel of [
    "canvas:load-state",
    "canvas:get-state-for-save",
    "canvas:update-tile-geometry",
    "canvas:focus-tile",
  ]) {
    markForward(channel);
  }
}
