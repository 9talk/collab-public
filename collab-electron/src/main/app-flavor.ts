// Build flavor: "full" = Collaborator + Host (被控), "remote" = 独立 Client (控制端).
// Resolution order:
//   1. env COLLAB_FLAVOR — set by dev scripts / injected into child processes
//   2. packaged: resources/flavor.json written by electron-builder (remote only)
//   3. default "full"
// Deliberately avoids importing the electron app module so it stays safe to
// load in non-electron child processes (pty-sidecar runs with
// ELECTRON_RUN_AS_NODE and has no resourcesPath).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AppFlavor = "full" | "remote";

let cached: AppFlavor | null = null;

export function getAppFlavor(): AppFlavor {
  if (cached) return cached;
  const fromEnv = process.env.COLLAB_FLAVOR;
  if (fromEnv === "remote" || fromEnv === "full") {
    cached = fromEnv;
    return cached;
  }
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    try {
      const p = join(resourcesPath, "flavor.json");
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as {
          flavor?: string;
        };
        cached = parsed.flavor === "remote" ? "remote" : "full";
        return cached;
      }
    } catch {
      // Unreadable marker — fall through to full.
    }
  }
  cached = "full";
  return cached;
}

export function isRemoteFlavor(): boolean {
  return getAppFlavor() === "remote";
}

/**
 * Freeze the resolved flavor into the environment so processes spawned
 * later (pty-sidecar etc.) resolve the same flavor without resourcesPath.
 * Call as early as possible after module load in the main process.
 */
export function ensureFlavorEnv(): void {
  if (!process.env.COLLAB_FLAVOR) {
    process.env.COLLAB_FLAVOR = getAppFlavor();
  }
}
