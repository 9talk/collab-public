import type { AppConfig } from "./config";

const RECENT_LIMIT = 20;

function readStored(config: AppConfig): unknown[] {
  const raw = config.ui.recentWorkspaces;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Most-recently-used workspace paths, filtered to currently configured
 * workspaces and deduped. Entries for removed workspaces are invisible here
 * and get pruned from storage on the next {@link noteWorkspaceUse}.
 */
export function getRecentOrder(config: AppConfig): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of readStored(config)) {
    if (typeof entry !== "string" || seen.has(entry)) continue;
    if (!config.workspaces.includes(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Move a workspace to the front of the MRU order. Mutates `config.ui`;
 * returns true when the stored order changed, in which case the caller
 * is responsible for persisting the config.
 */
export function noteWorkspaceUse(
  config: AppConfig,
  workspacePath: string | null | undefined,
): boolean {
  if (!workspacePath || !config.workspaces.includes(workspacePath))
    return false;
  const current = getRecentOrder(config);
  if (current[0] === workspacePath) return false;
  config.ui.recentWorkspaces = [
    workspacePath,
    ...current.filter((p) => p !== workspacePath),
  ].slice(0, RECENT_LIMIT);
  return true;
}
