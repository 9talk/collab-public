import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { registerMethod } from "./json-rpc-server";
import { saveConfig, type AppConfig } from "./config";
import {
  initWorkspaceFiles,
  startSingleWorkspaceServices,
} from "./ipc-workspace";
import { createFileFilter } from "./file-filter";
import type { FileFilter } from "./file-filter";
import { trackEvent } from "./analytics";

interface WorkspaceRpcContext {
  appConfig: AppConfig;
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
      const aliases: Record<string, string> = {};
      return { workspaces: ctx.appConfig.workspaces, aliases };
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

      if (ctx.appConfig.workspaces.includes(chosen)) {
        return { workspaces: ctx.appConfig.workspaces };
      }

      const collabDir = join(chosen, ".collaborator");
      const isNew = !existsSync(collabDir);
      if (isNew) {
        initWorkspaceFiles(chosen);
      }

      ctx.appConfig.workspaces.push(chosen);
      saveConfig(ctx.appConfig);
      trackEvent("workspace_added", { is_new: isNew });

      const userIgnored = Array.isArray(ctx.appConfig.ui.ignoredFiles)
        ? (ctx.appConfig.ui.ignoredFiles as string[])
        : [];
      startSingleWorkspaceServices(
        chosen,
        (f) => {
          ctx.fileFilterRef.current = f;
        },
        userIgnored,
      );
      ctx.forwardToWebview("nav", "workspace-added", chosen);

      return { workspaces: ctx.appConfig.workspaces };
    },
    {
      description: "Add a workspace by path",
      params: { path: "Absolute path to the directory" },
    },
  );
}
