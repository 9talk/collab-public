import { ipcMain, webContents as webContentsModule } from "electron";
import { cdpSend } from "./cdp";

function getWc(webContentsId: number) {
  const wc = webContentsModule.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    throw new Error("Browser tile not found");
  }
  return wc;
}

export function registerBrowserIpc(): void {
  ipcMain.handle(
    "browser:navigate",
    async (
      _event,
      {
        webContentsId,
        url,
      }: {
        webContentsId: number;
        url: string;
      },
    ) => {
      const wc = getWc(webContentsId);
      await wc.loadURL(url);
      return { url: wc.getURL() };
    },
  );

  ipcMain.handle(
    "browser:screenshot",
    async (
      _event,
      {
        webContentsId,
      }: {
        webContentsId: number;
      },
    ) => {
      const wc = getWc(webContentsId);
      const image = await wc.capturePage();
      return { data: image.toPNG().toString("base64") };
    },
  );

  ipcMain.handle(
    "browser:snapshot",
    async (
      _event,
      {
        webContentsId,
      }: {
        webContentsId: number;
      },
    ) => {
      const result = await cdpSend(webContentsId, "DOM.getDocument", {
        depth: -1,
        pierce: true,
      });
      return result;
    },
  );

  ipcMain.handle(
    "browser:click",
    async (
      _event,
      {
        webContentsId,
        selector,
      }: {
        webContentsId: number;
        selector: string;
      },
    ) => {
      const doc = (await cdpSend(webContentsId, "DOM.getDocument")) as {
        root: { nodeId: number };
      };
      const found = (await cdpSend(webContentsId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeId: number };
      if (!found.nodeId) {
        throw new Error(`Element not found: ${selector}`);
      }
      const box = (await cdpSend(webContentsId, "DOM.getBoxModel", {
        nodeId: found.nodeId,
      })) as { model: { content: number[] } };
      const quad = box.model.content;
      const x = (quad[0]! + quad[2]!) / 2;
      const y = (quad[1]! + quad[5]!) / 2;
      await cdpSend(webContentsId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await cdpSend(webContentsId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return {};
    },
  );

  ipcMain.handle(
    "browser:type",
    async (
      _event,
      {
        webContentsId,
        selector,
        text,
      }: {
        webContentsId: number;
        selector: string;
        text: string;
      },
    ) => {
      const doc = (await cdpSend(webContentsId, "DOM.getDocument")) as {
        root: { nodeId: number };
      };
      const found = (await cdpSend(webContentsId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeId: number };
      if (!found.nodeId) {
        throw new Error(`Element not found: ${selector}`);
      }
      await cdpSend(webContentsId, "DOM.focus", {
        nodeId: found.nodeId,
      });
      await cdpSend(webContentsId, "Input.insertText", { text });
      return {};
    },
  );

  ipcMain.handle(
    "browser:scroll",
    async (
      _event,
      {
        webContentsId,
        x,
        y,
      }: {
        webContentsId: number;
        x: number;
        y: number;
      },
    ) => {
      // Fire-and-forget: CDP mouseWheel doesn't resolve
      // reliably, so don't await it.
      cdpSend(webContentsId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 0,
        y: 0,
        deltaX: x,
        deltaY: y,
      });
      return {};
    },
  );

  ipcMain.handle(
    "browser:wait",
    async (
      _event,
      {
        webContentsId,
        timeout,
      }: {
        webContentsId: number;
        timeout?: number;
      },
    ) => {
      const ms = timeout ?? 10_000;
      const wc = getWc(webContentsId);
      if (!wc.isLoading()) {
        return { status: "ready" };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          wc.removeListener("did-finish-load", onLoad);
          wc.removeListener("did-fail-load", onFail);
          reject(new Error("waitFor timed out"));
        }, ms);
        const onLoad = () => {
          clearTimeout(timer);
          wc.removeListener("did-fail-load", onFail);
          resolve();
        };
        const onFail = (_e: unknown, code: number, desc: string) => {
          clearTimeout(timer);
          wc.removeListener("did-finish-load", onLoad);
          reject(new Error(`Load failed (${code}): ${desc}`));
        };
        wc.once("did-finish-load", onLoad);
        wc.once("did-fail-load", onFail);
      });
      return { status: "ready" };
    },
  );

  ipcMain.handle(
    "browser:info",
    async (
      _event,
      {
        webContentsId,
      }: {
        webContentsId: number;
      },
    ) => {
      const wc = getWc(webContentsId);
      return {
        url: wc.getURL(),
        title: wc.getTitle(),
        loading: wc.isLoading(),
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
      };
    },
  );

  ipcMain.handle(
    "browser:evaluate",
    async (
      _event,
      {
        webContentsId,
        expression,
      }: {
        webContentsId: number;
        expression: string;
      },
    ) => {
      const result = (await cdpSend(webContentsId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
      })) as { result: { value?: unknown } };
      return { value: result.result?.value };
    },
  );
}
