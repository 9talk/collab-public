/**
 * Pure model logic for the Cmd+E "recent workspaces" popup.
 * DOM wiring lives in renderer.js; everything here is side-effect free.
 */

import { displayBasename } from "@collab/shared/path-utils";

/**
 * @typedef {Object} WorkspaceItem
 * @property {string} path
 * @property {string} name - alias or folder basename
 * @property {string} subtitle - full path shown as the second line
 */

/**
 * Configured workspace paths ordered for display: recently used first
 * (most recent at the top), remaining ones in config order. Stale or
 * duplicated entries in `recent` are dropped.
 * @param {string[]} workspaces
 * @param {string[]} [recent]
 * @returns {string[]}
 */
export function orderWorkspacePaths(workspaces, recent) {
  const configured = new Set(workspaces);
  const seen = new Set();
  const ordered = [];
  for (const path of recent || []) {
    if (!configured.has(path) || seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
  }
  for (const path of workspaces) {
    if (seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
  }
  return ordered;
}

/**
 * @param {string[]} workspaces
 * @param {Record<string, string>} [aliases]
 * @param {string[]} [recent]
 * @returns {WorkspaceItem[]}
 */
export function buildWorkspaceItems(workspaces, aliases, recent) {
  return orderWorkspacePaths(workspaces, recent).map((path) => ({
    path,
    name: aliases?.[path] || displayBasename(path),
    subtitle: path,
  }));
}

/**
 * Case-insensitive substring filter over name and path.
 * @param {WorkspaceItem[]} items
 * @param {string} query
 * @returns {WorkspaceItem[]}
 */
export function filterWorkspaceItems(items, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.path.toLowerCase().includes(q),
  );
}

/**
 * Move the selection index by `delta` with wrap-around.
 * @param {number} index - current index, -1 when nothing is selected
 * @param {number} delta - +1 down, -1 up
 * @param {number} count - number of items
 * @returns {number} new index, or -1 when the list is empty
 */
export function moveSelection(index, delta, count) {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}
