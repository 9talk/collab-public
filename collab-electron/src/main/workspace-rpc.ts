import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { registerMethod } from "./json-rpc-server";
import { loadConfig, saveConfig, type AppConfig } from "./config";
import {
  initWorkspaceFiles,
  startSingleWorkspaceServices,
} from "./ipc-workspace";
import { createFileFilter } from "./file-filter";
import type { FileFilter } from "./file-filter";
import { trackEvent } from "./analytics";

interface WorkspaceRpcContext {
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
  fileFilterRef: { current: FileFilter | null };
}

export function registerWorkspaceRpc(ctx: WorkspaceRpcContext): void {
  registerMethod(
    "workspace.list",
    () => {
      const config = loadConfig();
      const aliases: Record<string, string> = {};
      return { workspaces: config.workspaces, aliases };
    },
    {
      description: "List all workspaces",
      params: {},
    },
  );

  registerMethod(
    "workspace.add",
    (params: unknown) => {
      const p = params as { path: string };
      if (!p.path || typeof p.path !== "string") {
        throw new Error("path is required");
      }

      const chosen = realpathSync(p.path);
      const config = loadConfig();

      if (config.workspaces.includes(chosen)) {
        return { workspaces: config.workspaces };
      }

      const collabDir = join(chosen, ".collaborator");
      const isNew = !existsSync(collabDir);
      if (isNew) {
        initWorkspaceFiles(chosen);
      }

      config.workspaces.push(chosen);
      saveConfig(config);
      trackEvent("workspace_added", { is_new: isNew });

      const userIgnored = Array.isArray(config.ui.ignoredFiles)
        ? (config.ui.ignoredFiles as string[])
        : [];
      startSingleWorkspaceServices(
        chosen,
        (f) => {
          ctx.fileFilterRef.current = f;
        },
        userIgnored,
      );
      ctx.forwardToWebview("nav", "workspace-added", chosen);

      return { workspaces: config.workspaces };
    },
    {
      description: "Add a workspace by path",
      params: { path: "Absolute path to the directory" },
    },
  );
}
