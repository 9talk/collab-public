// @ts-nocheck
import { useState, useCallback, useEffect, useRef } from "react";
import "@collab/components/TreeView/TreeView.css";
import { TreeView } from "@collab/components/TreeView/TreeView";
import { useWorkspaceFileTree } from "@collab/components/TreeView/useWorkspaceFileTree";
import type { SortMode } from "@collab/components/TreeView/types";
import { invoke } from "@tauri-apps/api/core";

interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

interface NavPanelProps {
  theme: string;
  onFileSelected?: (path: string) => void;
  onOpenWorkspace?: () => void;
}

export default function NavPanel({ theme, onFileSelected, onOpenWorkspace }: NavPanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceConfig[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("alpha");

  const border = theme === "light" ? "#e5e7eb" : "#374151";
  const bg = theme === "light" ? "#ffffff" : "#111827";
  const hoverBg = theme === "light" ? "#f3f4f6" : "#1f2937";
  const selectedBg = theme === "light" ? "#dbeafe" : "#1e3a5f";
  const selectedColor = theme === "light" ? "#1e40af" : "#93c5fd";
  const mutedColor = theme === "light" ? "#6b7280" : "#9ca3af";

  // Load workspaces on mount
  useEffect(() => {
    invoke<Array<WorkspaceConfig>>("workspace_list")
      .then((ws) => {
        setWorkspaces(ws);
        if (ws.length > 0 && !activeWorkspace) {
          setActiveWorkspace(ws[0].path);
        }
      })
      .catch((e) => console.error("[NavPanel] Failed to load workspaces:", e));
  }, []);

  // Tree hook for active workspace
  const tree = useWorkspaceFileTree(activeWorkspace || "", sortMode);

  const handleItemClick = useCallback(
    (path: string, e: { metaKey: boolean; shiftKey: boolean }) => {
      setSelectedPath(path);
      if (!e.metaKey) {
        onFileSelected?.(path);
      }
    },
    [onFileSelected],
  );

  const handleToggleFolder = useCallback(
    (path: string, recursive: boolean) => {
      tree.toggleExpand(path, recursive);
    },
    [tree],
  );

  const handleCreateFile = useCallback(async (folderPath: string, name: string) => {
    const fileName = name || prompt("New file name:") || "";
    if (!fileName) return;
    const fullPath = `${folderPath}/${fileName}`;
    await invoke("write_file", { path: fullPath, content: "" });
    // The file watcher will reload the tree automatically
  }, []);

  const handleDeleteFile = useCallback(async (path: string) => {
    try {
      await invoke("trash_file", { path });
    } catch (e) {
      console.error("[NavPanel] Failed to trash file:", e);
    }
  }, []);

  const handleCycleSortMode = useCallback(() => {
    const modes: SortMode[] = ["alpha", "alpha-reverse", "newest", "oldest"];
    const idx = modes.indexOf(sortMode);
    setSortMode(modes[(idx + 1) % modes.length]);
  }, [sortMode]);

  const handleRemoveWorkspace = useCallback(async (id: string) => {
    await invoke("workspace_remove", { id });
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    if (activeWorkspace) {
      const remaining = workspaces.filter((w) => w.id !== id);
      setActiveWorkspace(remaining.length > 0 ? remaining[0].path : null);
    }
  }, [activeWorkspace, workspaces]);

  const handleAddWorkspace = useCallback(async () => {
    try {
      const result = await invoke<string>("dialog_open_folder");
      if (!result) return;
      const name = result.split("/").pop() || result;
      const ws = await invoke<WorkspaceConfig>("workspace_add", { name, path: result });
      setWorkspaces((prev) => [...prev, ws]);
      setActiveWorkspace(ws.path);
    } catch (e) {
      console.error("[NavPanel] Failed to add workspace:", e);
    }
  }, []);

  // Rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: any) => {
    if (!item) return;
    // Simple rename on context menu for now
    setRenamingPath(item.path);
    setRenameValue(item.name);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (!renamingPath || !renameValue) {
      setRenamingPath(null);
      return;
    }
    try {
      const parent = renamingPath.split("/").slice(0, -1).join("/");
      const newPath = `${parent}/${renameValue}`;
      await invoke("rename_file", { oldPath: renamingPath, newTitle: renameValue });
      onFileSelected?.(newPath);
    } catch (e) {
      console.error("[NavPanel] Failed to rename:", e);
    }
    setRenamingPath(null);
    setRenameValue("");
  }, [renamingPath, renameValue, onFileSelected]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
    setRenameValue("");
  }, []);

  const handleRenameChange = useCallback((value: string) => {
    setRenameValue(value);
  }, []);

  if (workspaces.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ padding: "16px", borderBottom: `1px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "13px", fontWeight: 600 }}>Explorer</span>
          <button
            onClick={handleAddWorkspace}
            style={{
              borderRadius: "4px", padding: "4px 8px", fontSize: "12px",
              backgroundColor: "#2563eb", color: "#fff", border: "none", cursor: "pointer",
            }}
          >
            + Add Workspace
          </button>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: mutedColor, fontSize: "13px", padding: "16px" }}>
          No workspaces added yet
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: bg }}>
      {/* Header: workspace tabs */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${border}`, padding: "4px 8px", gap: "4px", flexShrink: 0 }}>
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            onClick={() => setActiveWorkspace(ws.path)}
            style={{
              display: "flex", alignItems: "center", gap: "4px",
              padding: "4px 8px", borderRadius: "4px", fontSize: "12px",
              cursor: "pointer",
              backgroundColor: activeWorkspace === ws.path ? (theme === "light" ? "#e5e7eb" : "#374151") : "transparent",
              color: activeWorkspace === ws.path ? (theme === "light" ? "#111827" : "#ffffff") : mutedColor,
            }}
          >
            <span style={{ maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ws.name}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); handleRemoveWorkspace(ws.id); }}
              style={{
                padding: "0 2px", fontSize: "10px", background: "none", border: "none",
                color: mutedColor, cursor: "pointer", lineHeight: 1,
              }}
              title="Remove workspace"
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={handleAddWorkspace}
          style={{
            padding: "4px 6px", fontSize: "12px", background: "none", border: "none",
            color: mutedColor, cursor: "pointer", borderRadius: "4px",
          }}
          title="Add workspace"
        >
          +
        </button>
      </div>

      {/* File tree */}
      {activeWorkspace && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <TreeView
            flatItems={tree.flatItems}
            selectedPath={selectedPath}
            selectedPaths={selectedPath ? new Set([selectedPath]) : new Set()}
            onItemClick={handleItemClick}
            onToggleFolder={handleToggleFolder}
            onCreateFile={handleCreateFile}
            onContextMenu={handleContextMenu}
            onDeleteFile={handleDeleteFile}
            sortMode={sortMode}
            onCycleSortMode={handleCycleSortMode}
            renamingPath={renamingPath}
            renameValue={renameValue}
            renameInputRef={renameInputRef}
            onRenameChange={handleRenameChange}
            onRenameConfirm={handleRenameConfirm}
            onRenameCancel={handleRenameCancel}
            workspacePath={activeWorkspace}
          />
        </div>
      )}
    </div>
  );
}
