import { app, ipcMain, dialog, type BrowserWindow } from "electron";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import fm from "front-matter";
import { saveConfig, type AppConfig } from "./config";
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  workspaceConfigPath,
  type WorkspaceConfig,
} from "./workspace-config";
import { createFileFilter, type FileFilter } from "./file-filter";
import { setThumbnailCacheDir } from "./image-service";
import { shouldIncludeEntryWithContent, fsWriteFile } from "./files";
import * as watcher from "./watcher";
import * as wikilinkIndex from "./wikilink-index";
import { trackEvent } from "./analytics";
import { bindIpc, markForward } from "./ipc-registry";
import type { TreeNode } from "@collab/shared/types";

export interface IpcWorkspaceContext {
  mainWindow: () => BrowserWindow | null;
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
}

const wsConfigMap = new Map<string, WorkspaceConfig>();

export function getWsConfig(workspacePath: string): WorkspaceConfig {
  let config = wsConfigMap.get(workspacePath);
  if (!config) {
    config = loadWorkspaceConfig(workspacePath);
    wsConfigMap.set(workspacePath, config);
  }
  return config;
}

function removeWorkspaceAlias(
  appConfig: AppConfig,
  workspacePath: string,
): void {
  const config = wsConfigMap.get(workspacePath);
  if (config?.alias && existsSync(workspaceConfigPath(workspacePath))) {
    config.alias = undefined;
    saveWorkspaceConfig(workspacePath, config);
  }

  const aliases = appConfig.ui["workspace_aliases"];
  if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
    delete (aliases as Record<string, unknown>)[workspacePath];
  }
}

function ensureGitignoreEntry(workspacePath: string): void {
  const gitignorePath = join(workspacePath, ".gitignore");
  if (!existsSync(gitignorePath)) return;

  const content = readFileSync(gitignorePath, "utf-8");
  const lines = content.split("\n");
  const alreadyIgnored = lines.some(
    (l) => l.trim() === ".collaborator" || l.trim() === ".collaborator/",
  );
  if (alreadyIgnored) return;

  const suffix = content.endsWith("\n") ? "" : "\n";
  appendFileSync(gitignorePath, `${suffix}.collaborator\n`, "utf-8");
}

export function initWorkspaceFiles(workspacePath: string): void {
  const collabDir = join(workspacePath, ".collaborator");
  mkdirSync(collabDir, { recursive: true });
  ensureGitignoreEntry(workspacePath);
}

/**
 * Derive which workspace owns a file path by longest prefix match.
 */
export function workspaceForFile(
  filePath: string,
  workspaces: string[],
): string | null {
  // Sort descending by length so a nested workspace (e.g. /a/b) wins
  // over its parent (e.g. /a) when both are registered.
  const sorted = [...workspaces].sort((a, b) => b.length - a.length);
  return (
    sorted.find((ws) => filePath === ws || filePath.startsWith(ws + "/")) ??
    null
  );
}

/**
 * Start workspace-dependent services for every configured workspace.
 */
export function startAllWorkspaceServices(
  workspaces: string[],
  fileFilterSetter: (f: FileFilter) => void,
  ignorePatterns?: string[],
  filterOptions?: { ignorecase?: boolean },
): void {
  for (const ws of workspaces) {
    wsConfigMap.set(ws, loadWorkspaceConfig(ws));
    setThumbnailCacheDir(ws);
    watcher.watchWorkspace(ws);
    void wikilinkIndex.buildIndex(ws);
  }
  fileFilterSetter(createFileFilter(ignorePatterns, filterOptions));
}

/**
 * Start workspace services for a single newly-added workspace.
 */
export function startSingleWorkspaceServices(
  path: string,
  fileFilterSetter: (f: FileFilter) => void,
  ignorePatterns?: string[],
  filterOptions?: { ignorecase?: boolean },
): void {
  wsConfigMap.set(path, loadWorkspaceConfig(path));
  setThumbnailCacheDir(path);
  watcher.watchWorkspace(path);
  fileFilterSetter(createFileFilter(ignorePatterns, filterOptions));
  void wikilinkIndex.buildIndex(path);
}

/**
 * Stop workspace services for a single removed workspace.
 */
export function stopSingleWorkspaceServices(path: string): void {
  watcher.unwatchWorkspace(path);
  wsConfigMap.delete(path);
}

const LEGACY_FM_FIELDS = new Set(["createdAt", "modifiedAt", "author"]);

export async function readTreeRecursive(
  dirPath: string,
  rootPath: string,
  filter: FileFilter | null,
): Promise<TreeNode[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const folders: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (
      !(await shouldIncludeEntryWithContent(
        dirPath,
        entry,
        filter ?? undefined,
        rootPath,
      ))
    ) {
      continue;
    }

    let stats;
    try {
      stats = await stat(fullPath);
    } catch {
      continue;
    }

    const ctime = stats.birthtime.toISOString();
    const mtime = stats.mtime.toISOString();

    if (stats.isDirectory()) {
      const children = await readTreeRecursive(fullPath, rootPath, filter);
      folders.push({
        path: fullPath,
        name: entry.name,
        kind: "folder",
        ctime,
        mtime,
        children,
      });
    } else {
      const stem = basename(entry.name, extname(entry.name));
      const node: TreeNode = {
        path: fullPath,
        name: stem,
        kind: "file",
        ctime,
        mtime,
      };

      if (entry.name.endsWith(".md")) {
        try {
          const fileContent = await readFile(fullPath, "utf-8");
          const parsed = fm<Record<string, unknown>>(fileContent);
          node.frontmatter = parsed.attributes;
          node.preview = parsed.body.slice(0, 200);
        } catch {
          // Skip frontmatter parsing on failure
        }
      }

      files.push(node);
    }
  }

  folders.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  files.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  return [...folders, ...files];
}

export async function updateFrontmatter(
  filePath: string,
  field: string,
  value: unknown,
): Promise<{ ok: boolean; retried?: boolean }> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fileStat = await stat(filePath);
    const expectedMtime = fileStat.mtime.toISOString();

    const content = await readFile(filePath, "utf-8");
    const parsed = fm<Record<string, unknown>>(content);
    const attrs = { ...parsed.attributes, [field]: value };

    for (const key of LEGACY_FM_FIELDS) {
      delete attrs[key];
    }

    const yaml = Object.entries(attrs)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    const output = `---\n${yaml}\n---\n${parsed.body}`;

    const result = await fsWriteFile(filePath, output, expectedMtime);
    if (result.ok) {
      return { ok: true, retried: attempt > 0 };
    }
  }
  return { ok: false };
}

export function registerWorkspaceHandlers(
  ctx: IpcWorkspaceContext,
  appConfig: AppConfig,
  fileFilterRef: { current: FileFilter | null },
): void {
  bindIpc("config:get", "handle", () => appConfig);
  bindIpc("app:version", "handle", () => app.getVersion());
  bindIpc("app:commit-sha", "handle", () => __GIT_COMMIT_SHA__);

  bindIpc(
    "workspace-pref:get",
    "handle",
    (_event, params: { key: string; workspacePath: string }) => {
      if (!params.workspacePath) return null;
      const config = getWsConfig(params.workspacePath);
      if (params.key === "expanded_dirs") return config.expanded_dirs;
      if (params.key === "agent_skip_permissions")
        return config.agent_skip_permissions;
      if (params.key === "alias") return config.alias ?? null;
      return null;
    },
  );

  bindIpc(
    "workspace-pref:set",
    "handle",
    (
      _event,
      params: {
        key: string;
        workspacePath: string;
        value: unknown;
      },
    ) => {
      if (!params.workspacePath) return;
      const config = getWsConfig(params.workspacePath);
      if (params.key === "expanded_dirs") {
        config.expanded_dirs = Array.isArray(params.value) ? params.value : [];
      } else if (params.key === "agent_skip_permissions") {
        config.agent_skip_permissions = params.value === true;
      } else if (params.key === "alias") {
        config.alias =
          typeof params.value === "string" && params.value.length > 0
            ? params.value
            : undefined;
      }
      saveWorkspaceConfig(params.workspacePath, config);
    },
  );

  bindIpc("workspace:list", "handle", () => {
    const aliases: Record<string, string> = {};
    for (const ws of appConfig.workspaces) {
      const cfg = getWsConfig(ws);
      if (cfg.alias) aliases[ws] = cfg.alias;
    }
    return { workspaces: appConfig.workspaces, aliases };
  });

  bindIpc("workspace:add", "handle", async () => {
    const win = ctx.mainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const chosen = realpathSync(result.filePaths[0]!);

    if (appConfig.workspaces.includes(chosen)) {
      return { workspaces: appConfig.workspaces };
    }

    const collabDir = join(chosen, ".collaborator");
    const isNew = !existsSync(collabDir);
    if (isNew) {
      initWorkspaceFiles(chosen);
    }

    appConfig.workspaces.push(chosen);
    saveConfig(appConfig);
    trackEvent("workspace_added", { is_new: isNew });

    const userIgnored = Array.isArray(appConfig.ui.ignoredFiles)
      ? (appConfig.ui.ignoredFiles as string[])
      : [];
    startSingleWorkspaceServices(
      chosen,
      (f) => {
        fileFilterRef.current = f;
      },
      userIgnored,
    );
    ctx.forwardToWebview("nav", "workspace-added", chosen);

    return { workspaces: appConfig.workspaces };
  });

  bindIpc(
    "workspace:add-by-path",
    "handle",
    async (_event, folderPath: string) => {
      if (!folderPath || typeof folderPath !== "string") return null;
      const chosen = realpathSync(folderPath);

      if (appConfig.workspaces.includes(chosen)) {
        return { workspaces: appConfig.workspaces };
      }

      const collabDir = join(chosen, ".collaborator");
      const isNew = !existsSync(collabDir);
      if (isNew) {
        initWorkspaceFiles(chosen);
      }

      appConfig.workspaces.push(chosen);
      saveConfig(appConfig);
      trackEvent("workspace_added", { is_new: isNew });

      const userIgnored = Array.isArray(appConfig.ui.ignoredFiles)
        ? (appConfig.ui.ignoredFiles as string[])
        : [];
      startSingleWorkspaceServices(
        chosen,
        (f) => {
          fileFilterRef.current = f;
        },
        userIgnored,
      );
      ctx.forwardToWebview("nav", "workspace-added", chosen);

      return { workspaces: appConfig.workspaces };
    },
  );

  bindIpc("workspace:remove", "handle", (_event, index: number) => {
    if (index < 0 || index >= appConfig.workspaces.length) {
      return { workspaces: appConfig.workspaces };
    }

    const removedPath = appConfig.workspaces[index]!;
    appConfig.workspaces.splice(index, 1);
    removeWorkspaceAlias(appConfig, removedPath);
    saveConfig(appConfig);
    trackEvent("workspace_removed");

    stopSingleWorkspaceServices(removedPath);
    ctx.forwardToWebview("nav", "workspace-removed", removedPath);

    return { workspaces: appConfig.workspaces };
  });

  bindIpc("workspace:remove-by-path", "handle", (_event, path: string) => {
    const index = appConfig.workspaces.indexOf(path);
    if (index === -1) {
      return { workspaces: appConfig.workspaces };
    }

    appConfig.workspaces.splice(index, 1);
    removeWorkspaceAlias(appConfig, path);
    saveConfig(appConfig);
    trackEvent("workspace_removed");

    stopSingleWorkspaceServices(path);
    ctx.forwardToWebview("nav", "workspace-removed", path);

    return { workspaces: appConfig.workspaces };
  });

  bindIpc(
    "workspace:read-tree",
    "handle",
    async (_event, params: { root: string }): Promise<TreeNode[]> => {
      return readTreeRecursive(params.root, params.root, fileFilterRef.current);
    },
  );

  bindIpc(
    "workspace:update-frontmatter",
    "handle",
    async (
      _event,
      filePath: string,
      field: string,
      value: unknown,
    ): Promise<{ ok: boolean; retried?: boolean }> => {
      return updateFrontmatter(filePath, field, value);
    },
  );

  // ---- remote forwarding whitelist ----
  for (const channel of [
    "config:get",
    "app:version",
    "app:commit-sha",
    "workspace-pref:get",
    "workspace-pref:set",
    "workspace:list",
    "workspace:add",
    "workspace:add-by-path",
    "workspace:remove",
    "workspace:remove-by-path",
    "workspace:read-tree",
    "workspace:update-frontmatter",
  ]) {
    markForward(channel);
  }
}
