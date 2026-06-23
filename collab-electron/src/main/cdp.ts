import { webContents as webContentsModule } from "electron";

const attached = new Set<number>();

export function isAttached(webContentsId: number): boolean {
  return attached.has(webContentsId);
}

export function detach(webContentsId: number): void {
  const wc = webContentsModule.fromId(webContentsId);
  if (wc && !wc.isDestroyed() && attached.has(webContentsId)) {
    try {
      wc.debugger.detach();
    } catch {
      // already detached
    }
  }
  attached.delete(webContentsId);
}

export async function cdpSend(
  webContentsId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const wc = webContentsModule.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    throw new Error(`webContents ${webContentsId} not found or destroyed`);
  }

  if (!attached.has(webContentsId)) {
    wc.debugger.attach("1.3");
    attached.add(webContentsId);

    wc.once("destroyed", () => {
      attached.delete(webContentsId);
    });

    wc.debugger.on("detach", () => {
      attached.delete(webContentsId);
    });
  }

  return wc.debugger.sendCommand(method, params);
}
