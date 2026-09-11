import type { TreeNode } from "@collab/shared/types";
import { isSubpath } from "@collab/shared/path-utils";
import type { SortMode } from "./types";

export interface FlatItem {
  id: string;
  kind: "folder" | "file" | "workspace";
  level: number;
  name: string;
  path: string;
  alias?: string;
  isExpanded?: boolean;
  ctime?: string;
  mtime?: string;
  childCount?: number;
  workspacePath?: string;
  isSymlink?: boolean;
  linkTarget?: string;
  /** 链接指向模板库内时的来源模板名 */
  templateName?: string;
  /** 悬空软链接（断链） */
  broken?: boolean;
  /** 位于某个软链接节点内部（含其下所有层级）——禁止作为挂载放置目标 */
  linkAncestor?: boolean;
}

export function saveExpandedDirs(
  expanded: Set<string>,
  workspacePath?: string,
) {
  if (!workspacePath) return;
  const filtered = [...expanded].filter(
    (p) => p === workspacePath || isSubpath(workspacePath, p),
  );
  window.api.setWorkspacePref("expanded_dirs", filtered, workspacePath);
}

export function saveExpandedWorkspaces(expanded: Set<string>) {
  window.api.setPref("expanded_workspaces", [...expanded]);
}

function sortFiles(files: TreeNode[], sortMode: SortMode): TreeNode[] {
  if (sortMode.startsWith("alpha")) {
    const isDesc = sortMode === "alpha-desc";
    return [...files].sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      return isDesc ? -cmp : cmp;
    });
  }

  const useModified = sortMode.startsWith("modified");
  const isDesc = sortMode.endsWith("desc");

  return [...files].sort((a, b) => {
    const getTs = (n: TreeNode) => {
      const raw = useModified ? n.mtime : n.ctime;
      if (!raw) return 0;
      return new Date(raw).getTime();
    };
    const ta = getTs(a);
    const tb = getTs(b);
    return isDesc ? tb - ta : ta - tb;
  });
}

function copyLinkFields(item: FlatItem, node: TreeNode): FlatItem {
  if (!node.isSymlink) return item;
  item.isSymlink = true;
  if (node.linkTarget !== undefined) item.linkTarget = node.linkTarget;
  if (node.templateName !== undefined) item.templateName = node.templateName;
  if (node.broken) item.broken = true;
  return item;
}

export function flattenTree(
  nodes: TreeNode[],
  expanded: Set<string>,
  level: number,
  sortMode: SortMode,
  levelOffset = 0,
  insideLink = false,
): FlatItem[] {
  const effectiveLevel = level + levelOffset;
  const items: FlatItem[] = [];
  const dirs = nodes.filter((n) => n.kind === "folder");
  const files = nodes.filter((n) => n.kind === "file");

  for (const dir of dirs) {
    const isOpen = expanded.has(dir.path);
    const item: FlatItem = copyLinkFields(
      {
        id: dir.path,
        kind: "folder",
        level: effectiveLevel,
        name: dir.name,
        path: dir.path,
        isExpanded: isOpen,
        childCount: countFilesInNode(dir),
      },
      dir,
    );
    if (insideLink) item.linkAncestor = true;
    items.push(item);
    if (isOpen && (dir.children ?? []).length > 0) {
      items.push(
        ...flattenTree(
          dir.children ?? [],
          expanded,
          level + 1,
          sortMode,
          levelOffset,
          insideLink || !!dir.isSymlink,
        ),
      );
    }
  }

  const sorted = sortFiles(files, sortMode);
  for (const file of sorted) {
    const item: FlatItem = copyLinkFields(
      {
        id: file.path,
        kind: "file",
        level: effectiveLevel,
        name: file.name,
        path: file.path,
        ctime: file.ctime,
        mtime: file.mtime,
      },
      file,
    );
    if (insideLink) item.linkAncestor = true;
    items.push(item);
  }

  return items;
}

export function hydrateNode(
  node: TreeNode,
  dirContents: Map<string, TreeNode[]>,
): TreeNode {
  if (node.kind !== "folder") return node;

  const children = dirContents.get(node.path);
  if (!children) return node;

  const hydratedChildren = children.map((child) =>
    hydrateNode(child, dirContents),
  );
  return {
    ...node,
    children: hydratedChildren,
  };
}

export function treesEqual(left: TreeNode[], right: TreeNode[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    if (
      a.path !== b.path ||
      a.name !== b.name ||
      a.kind !== b.kind ||
      a.ctime !== b.ctime ||
      a.mtime !== b.mtime ||
      a.fileCount !== b.fileCount ||
      a.isSymlink !== b.isSymlink ||
      a.linkTarget !== b.linkTarget
    ) {
      return false;
    }
  }

  return true;
}

function countFilesInTree(nodes: TreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += countFilesInNode(node);
  }
  return count;
}

function countFilesInNode(node: TreeNode): number {
  if (node.kind === "file") {
    return 1;
  }

  if (node.children === undefined) {
    return node.fileCount ?? 0;
  }

  return countFilesInTree(node.children);
}
