import { ipcMain, shell, type BrowserWindow } from "electron";
import { extname } from "node:path";
import * as wikilinkIndex from "./wikilink-index";
import { buildWorkspaceGraph } from "./workspace-graph";
import * as agentActivity from "./agent-activity";
import { workspaceForFile } from "./ipc-workspace";
import { bindIpc, markForward } from "./ipc-registry";

interface IpcContext {
  mainWindow: () => BrowserWindow | null;
  fileFilter: () => any | null;
  workspaces: () => string[];
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
  trackEvent: (name: string, props?: Record<string, unknown>) => void;
}

export function registerKnowledgeHandlers(ctx: IpcContext): void {
  // Wikilinks
  bindIpc("wikilink:resolve", "handle", (_event, target: string) =>
    wikilinkIndex.resolve(target),
  );

  bindIpc("wikilink:suggest", "handle", (_event, partial: string) =>
    wikilinkIndex.suggest(partial),
  );

  bindIpc("wikilink:backlinks", "handle", (_event, filePath: string) =>
    wikilinkIndex.backlinksWithContext(filePath),
  );

  // Workspace graph
  ipcMain.handle(
    "workspace:get-graph",
    async (_event, params: { workspacePath: string }) =>
      buildWorkspaceGraph(params.workspacePath, ctx.fileFilter()),
  );

  // Navigation
  ipcMain.on("nav:select-file", (_event, path) => {
    if (path) {
      ctx.trackEvent("file_selected", {
        ext: extname(path),
      });
      const workspace = workspaceForFile(path, ctx.workspaces());
      if (workspace) {
        agentActivity.setWorkspacePath(workspace);
      }
    }
    ctx.forwardToWebview("viewer", "file-selected", path);
    ctx.forwardToWebview("nav", "file-selected", path);
  });

  // Close viewer without affecting nav selection state
  ipcMain.on("nav:close-viewer", () => {
    ctx.forwardToWebview("viewer", "file-selected", null);
  });

  ipcMain.on("nav:select-folder", (_event, path: string) => {
    ctx.trackEvent("folder_selected");
    ctx.forwardToWebview("viewer", "folder-selected", path);
  });

  ipcMain.on("nav:open-in-terminal", (_event, path: string) => {
    ctx.trackEvent("file_opened_in_terminal");
    ctx.forwardToWebview("canvas", "open-terminal", path);
  });

  bindIpc("nav:reveal-in-finder", "on", (_event, path: string) => {
    ctx.trackEvent("file_revealed_in_finder");
    shell.showItemInFolder(path);
  });

  bindIpc("nav:locate-terminal", "on", (_event, folderPath: string) => {
    ctx.forwardToWebview("canvas", "locate-terminal", folderPath);
  });

  // ---- remote forwarding whitelist ----
  for (const channel of [
    "wikilink:resolve",
    "wikilink:suggest",
    "wikilink:backlinks",
    "nav:reveal-in-finder",
    "nav:locate-terminal",
  ]) {
    markForward(channel);
  }
}
