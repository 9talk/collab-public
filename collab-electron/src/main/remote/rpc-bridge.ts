// src/main/remote/rpc-bridge.ts
// Maps WebSocket JSON-RPC methods to existing backend functions.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shell, dialog, BrowserWindow } from "electron";
import * as pty from "../pty";
import { loadConfig, getPref, setPref, saveConfig } from "../config";
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
    case "pty:reconnect": {
      // Remote clients must NOT reconnect — that would destroy the existing
      // data socket and steal the session from the local terminal.
      // Instead, return metadata + scrollback so the browser can mirror.
      const meta = readSessionMeta(p.sessionId as string);
      const shell = meta?.command || meta?.shell || process.env.SHELL || "/bin/zsh";
      const displayName = meta?.displayName || path.basename(shell);
      let scrollback = "";
      try { scrollback = await pty.captureSession(p.sessionId as string, 50); } catch { /* ok */ }
      return {
        sessionId: p.sessionId,
        shell,
        displayName,
        target: meta?.target,
        command: meta?.command,
        args: meta?.args,
        cwdHostPath: meta?.cwdHostPath ?? meta?.cwd,
        cwdGuestPath: meta?.cwdGuestPath,
        meta,
        scrollback,
      };
    }
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

    // ---- shellApi-specific methods ----

    // View config (return HTTP URLs for remote clients)
    case "shell:get-view-config":
      return {
        nav: { src: "/nav/", preload: "" },
        viewer: { src: "/viewer/", preload: "" },
        terminal: { src: "/terminal/", preload: "" },
        terminalTile: { src: "/terminal-tile/", preload: "" },
        graphTile: { src: "/graph-tile/", preload: "" },
        settings: { src: "/settings/", preload: "" },
        tileList: { src: "/tile-list/", preload: "" },
        agentChat: { src: "/agent-chat/", preload: "" },
      };

    // Settings
    case "settings:open":
      forwardToShell("settings:open");
      return { ok: true };
    case "settings:toggle":
      forwardToShell("settings:toggle");
      return { ok: true };

    // Webview console forwarding
    case "webview:console":
      forwardToShell("webview:console", p.panel, p.level, p.message, p.source);
      return { ok: true };

    // Updates
    case "update:download":
      forwardToShell("update:download");
      return { ok: true };

    // Canvas state
    case "canvas:load-state": {
      const { getRemoteServer } = require("./index");
      return getRemoteServer().getCanvasState();
    }
    case "canvas:save-state": {
      const { getRemoteServer } = require("./index");
      const server = getRemoteServer();
      server.setCanvasState(p.state);
      if (server.isRunning()) server.broadcastCanvasState(p.state);
      return { ok: true };
    }
    case "canvas:rpc-response":
      forwardToShell("canvas:rpc-response", p);
      return { ok: true };

    // Filesystem checks
    case "fs:is-directory":
      return fs.statSync(p.path as string).isDirectory();

    // Workspace management
    case "workspace:list": {
      const cfg = loadConfig();
      return { workspaces: cfg.workspaces, aliases: {} };
    }
    case "workspace:remove": {
      const cfg = loadConfig();
      const idx = p.index as number;
      if (idx < 0 || idx >= cfg.workspaces.length) return { workspaces: cfg.workspaces };
      const removedPath = cfg.workspaces[idx];
      cfg.workspaces.splice(idx, 1);
      saveConfig(cfg);
      forwardToShell("workspace-removed", removedPath);
      return { workspaces: cfg.workspaces };
    }

    // Dialog
    case "dialog:confirm": {
      const win = ctx.mainWindow;
      if (!win) return 0;
      return (
        await dialog.showMessageBox(win, {
          type: "warning",
          message: p.message as string,
          detail: p.detail as string | undefined,
          buttons: (p.buttons as string[]) ?? ["OK", "Cancel"],
        })
      ).response;
    }

    // PTY capture
    case "pty:capture":
      return pty.captureSession(
        p.sessionId as string,
        (p.lines as number) ?? 50,
      );

    // Navigation
    case "navigation:push":
      forwardToShell("navigation:push", p.tileId);
      return { ok: true };
    case "navigation:go-back":
      forwardToShell("navigation:go-back");
      return { ok: true };
    case "navigation:go-forward":
      forwardToShell("navigation:go-forward");
      return { ok: true };

    // Terminal screenshot (Electron-specific, stub for remote)
    case "term:screenshot":
      return { ok: false };

    // Browser tile control (Electron-specific webContents ops, stubbed)
    case "browser:navigate":
    case "browser:screenshot":
    case "browser:snapshot":
    case "browser:click":
    case "browser:type":
    case "browser:scroll":
    case "browser:evaluate":
    case "browser:wait":
    case "browser:info":
      return null;

    // Integrations — plugin offer tracking
    case "integrations:has-offered-plugin": {
      const marker = path.join(os.homedir(), ".collaborator", "canvas-plugin-offered");
      return fs.existsSync(marker);
    }
    case "integrations:mark-plugin-offered": {
      const dir = path.join(os.homedir(), ".collaborator");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "canvas-plugin-offered"),
        new Date().toISOString(),
        "utf-8",
      );
      return { ok: true };
    }

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
