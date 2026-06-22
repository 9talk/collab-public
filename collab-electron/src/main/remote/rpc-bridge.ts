// src/main/remote/rpc-bridge.ts
// Maps WebSocket JSON-RPC methods to existing backend functions.
import * as fs from "node:fs";
import * as path from "node:path";
import { shell, BrowserWindow } from "electron";
import * as pty from "../pty";
import { loadConfig, getPref, setPref } from "../config";
import { readSessionMeta } from "../session-meta";
import { trackEvent } from "../analytics";

interface BridgeContext {
  mainWindow: BrowserWindow | null;
}

const ctx: BridgeContext = { mainWindow: null };

export function setBridgeContext(mainWindow: BrowserWindow | null): void {
  ctx.mainWindow = mainWindow;
}

function forwardToShell(channel: string, ...args: unknown[]): void {
  ctx.mainWindow?.webContents.send(channel, ...args);
}

function forwardToWebview(target: string, channel: string, ...args: unknown[]): void {
  ctx.mainWindow?.webContents.send("shell:forward", target, channel, ...args);
}

export async function handleRemoteRPC(
  method: string,
  params: unknown,
): Promise<unknown> {
  const p = params as Record<string, unknown>;

  switch (method) {
    // Config & Prefs
    case "config:get":
      return loadConfig();
    case "app:version":
      return require("electron").app.getVersion();
    case "pref:get": {
      const cfg = loadConfig();
      const key = p.key as string;
      if (key === "remote.connectionURL") {
        const { getRemoteServer } = require("./index");
        const server = getRemoteServer();
        if (server.isRunning()) return server.getConnectionURL();
      }
      return getPref(cfg, key);
    }
    case "pref:set": {
      const cfg = loadConfig();
      setPref(cfg, p.key as string, p.value);
      return { ok: true };
    }

    // PTY
    case "pty:create": {
      const result = await pty.createSession(
        p.cwd as string | undefined,
        undefined,
        p.cols as number | undefined,
        p.rows as number | undefined,
        p.target as string | undefined,
        p.tileId as string | undefined,
      );
      return result;
    }
    case "pty:write":
      pty.writeToSession(p.sessionId as string, p.data as string);
      return { ok: true };
    case "pty:resize":
      await pty.resizeSession(p.sessionId as string, p.cols as number, p.rows as number);
      return { ok: true };
    case "pty:kill":
      await pty.killSession(p.sessionId as string);
      return { ok: true };
    case "pty:reconnect":
      return pty.reconnectSession(
        p.sessionId as string,
        p.cols as number,
        p.rows as number,
        undefined,
      );
    case "pty:discover":
      return pty.discoverSessions();
    case "pty:read-meta":
      return readSessionMeta(p.sessionId as string);

    // PTY notifications (fire-and-forget from renderer)
    case "pty:notify-session-id":
    case "pty:cwd-changed":
    case "pty:status-changed":
      forwardToShell(method, p);
      return { ok: true };

    // Files
    case "fs:readdir": {
      const entries = fs.readdirSync(p.path as string, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    }
    case "fs:readfile":
      return fs.readFileSync(p.path as string, "utf-8");
    case "fs:writefile": {
      const dir = path.dirname(p.path as string);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p.path as string, p.content as string);
      return { ok: true };
    }
    case "fs:rename": {
      const dir = path.dirname(p.oldPath as string);
      const ext = path.extname(p.oldPath as string);
      const newPath = path.join(dir, (p.newTitle as string) + ext);
      fs.renameSync(p.oldPath as string, newPath);
      return { ok: true };
    }
    case "fs:mkdir":
      fs.mkdirSync(p.path as string, { recursive: true });
      return { ok: true };
    case "fs:trash":
      await shell.trashItem(p.path as string);
      return { ok: true };
    case "fs:move": {
      const name = path.basename(p.oldPath as string);
      const dest = path.join(p.newParentDir as string, name);
      fs.renameSync(p.oldPath as string, dest);
      return { ok: true };
    }
    case "fs:stat":
      return fs.statSync(p.path as string);
    case "fs:count-files": {
      const count = countFilesRecursive(p.path as string);
      return { count };
    }

    // Navigation
    case "nav:select-file":
      forwardToWebview("nav", "file-selected", p.path);
      return { ok: true };
    case "nav:select-folder":
      forwardToWebview("nav", "folder-selected", p.path);
      return { ok: true };

    // Shell
    case "shell:open-external":
      await shell.openExternal(p.url as string);
      return { ok: true };
    case "shell:open-path":
      return shell.openPath(p.path as string);

    // Settings
    case "settings:close":
      return { ok: true };

    // Canvas
    case "canvas:forward-pinch":
      forwardToShell("canvas:pinch", { deltaY: p.deltaY });
      return { ok: true };
    case "send-to-host": {
      const args = p.args as unknown[] | undefined;
      forwardToWebview("shell", p.channel as string, ...(args ?? []));
      return { ok: true };
    }

    // Context menu — not supported in browser
    case "context-menu:show":
      return null;

    // Analytics
    case "analytics:track-event":
      trackEvent(p.name as string, p.properties as Record<string, unknown> | undefined);
      return { ok: true };

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function countFilesRecursive(dir: string): number {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) count += countFilesRecursive(path.join(dir, e.name));
    else count++;
  }
  return count;
}
