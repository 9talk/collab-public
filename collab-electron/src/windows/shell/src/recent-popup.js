/**
 * Pure model logic for the Cmd+E "recent workspaces" popup.
 * DOM wiring lives in renderer.js; everything here is side-effect free.
 */

import { displayBasename } from "@collab/shared/path-utils";
import { matchWorkspaceAlias } from "@collab/shared/workspace-alias";

/**
 * @typedef {Object} WorkspaceItem
 * @property {"workspace"} kind
 * @property {string} path
 * @property {string} name - alias or folder basename
 * @property {string} subtitle - full path shown as the second line
 */

/**
 * @typedef {Object} TileItem
 * @property {"tile"} kind
 * @property {string} tileId
 * @property {string} name - userTitle or cwd basename
 * @property {string} subtitle - cwd full path, "" when unknown
 */

/** @typedef {WorkspaceItem | TileItem} PopupItem */

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
    kind: "workspace",
    path,
    name: aliases?.[path] || displayBasename(path),
    subtitle: path,
  }));
}

/**
 * Canvas terminal tiles as popup items. Order is MRU-first when
 * `focusOrder` is given (tile ids oldest→newest; tiles never focused fall
 * back to canvas order below the focused ones), else canvas order
 * (top-to-bottom, left-to-right, same as the sidebar tiles list). Only
 * `term` tiles are listed; the name prefers userTitle, then the workspace
 * alias (longest prefix match on cwd), then cwd basename.
 * @param {Array<{id: string, type: string, x?: number, y?: number, cwd?: string, userTitle?: string}>} tiles
 * @param {Record<string, string>} [aliases]
 * @param {string[]} [workspacePaths]
 * @param {string[]} [focusOrder] - 终端聚焦 MRU 顺序（旧→新）
 * @returns {TileItem[]}
 */
export function buildTileItems(tiles, aliases, workspacePaths, focusOrder) {
  const rank = new Map();
  (focusOrder || []).forEach((id, i) => rank.set(id, i));
  return (tiles || [])
    .filter((t) => t.type === "term")
    .slice()
    .sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : -1;
      const rb = rank.has(b.id) ? rank.get(b.id) : -1;
      // rank 越大越近,排前;从未聚焦(-1)的垫底并按画布位置排。
      if (ra !== rb) return rb - ra;
      return (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0);
    })
    .map((t) => ({
      kind: /** @type {const} */ ("tile"),
      tileId: t.id,
      name:
        t.userTitle ||
        matchWorkspaceAlias(t.cwd, aliases, workspacePaths ?? [])?.alias ||
        (t.cwd ? displayBasename(t.cwd) : "Terminal"),
      subtitle: t.cwd || "",
    }));
}

/**
 * Case-insensitive substring filter over name and subtitle (workspace
 * items carry the workspace path as subtitle, tile items the cwd).
 * @param {PopupItem[]} items
 * @param {string} query
 * @returns {PopupItem[]}
 */
export function filterPopupItems(items, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q),
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
