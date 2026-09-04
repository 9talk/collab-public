import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAppFlavor } from "./app-flavor";

// Packaged userData derives from the asar package.json name
// ("@collaborator/electron") for BOTH flavors, so the standalone Remote app
// would share the Host app's userData — and its single-instance lock (the
// Remote quits instantly while the Host is running). Relocate Remote's
// userData to its own directory before any consumer below (single-instance
// lock in index.ts, COLLAB_DIR) reads it. Dev already keeps per-worktree
// userData (index.ts), so it is left untouched here.
function relocateRemoteUserData(): void {
  try {
    const { app } = require("electron") as typeof import("electron");
    if (!app.isPackaged || getAppFlavor() !== "remote") return;
    const current = app.getPath("userData");
    // Host userData = <App Support>/@collaborator/electron; Remote 移到
    // <App Support>/Collaborator Remote(与 Host 完全分树)。
    const target = resolve(dirname(current), "..", "Collaborator Remote");
    if (current !== target) {
      app.setPath("userData", target);
    }
  } catch {
    // Non-electron child processes (pty-sidecar): no userData to relocate.
  }
}
relocateRemoteUserData();

const BASE = join(homedir(), ".collab");

function normalizeWindowsPath(path: string): string {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

function getDevWorktreeRoot(): string {
  const root = process.env["COLLAB_DEV_WORKTREE_ROOT"] || process.cwd();
  return resolve(normalizeWindowsPath(root));
}

function getDevWorktreeId(): string {
  return createHash("sha256")
    .update(getDevWorktreeRoot())
    .digest("hex")
    .slice(0, 12);
}

export const DEV_WORKTREE_ID = import.meta.env?.DEV
  ? `worktree-${getDevWorktreeId()}`
  : null;

function remoteUserDataCollabDir(): string {
  // packaged remote: userData 已被上面 relocateRemoteUserData() 重定位到
  // <Application Support>/Collaborator Remote,与 full 版彻底隔离。
  try {
    const { app } = require("electron") as typeof import("electron");
    return join(app.getPath("userData"), "collab");
  } catch {
    // Non-electron child processes never reach here: their COLLAB_DIR is
    // pinned by the COLLAB_DIR env override the parent injects on spawn.
    return join(BASE, "remote");
  }
}

// COLLAB_DIR env override keeps child processes (pty-sidecar) on the exact
// same directory as the parent main process regardless of flavor resolution.
export const COLLAB_DIR = process.env.COLLAB_DIR
  ? process.env.COLLAB_DIR
  : import.meta.env?.DEV
    ? join(
        BASE,
        "dev",
        `${DEV_WORKTREE_ID ?? "worktree-unknown"}${getAppFlavor() === "remote" ? "-remote" : ""}`,
      )
    : getAppFlavor() === "remote"
      ? remoteUserDataCollabDir()
      : BASE;
