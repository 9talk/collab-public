import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAppFlavor } from "./app-flavor";

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
  // packaged remote: userData is derived from productName (Collaborator
  // Remote) so it is naturally separate from the full app.
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
