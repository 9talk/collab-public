import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ForceDirectedGraph, type ForceDirectedGraphRef } from "@collab/components/WorkspaceGraph/ForceDirectedGraph";

interface GraphTileProps {
  tileId: string;
  folderPath?: string;
  theme?: string;
}

interface GraphNode {
  id: string;
  title: string;
  path: string;
  node_type?: string;
  weight?: number;
}

interface GraphLink {
  source: string;
  target: string;
  link_type?: string;
}

export default function GraphTile({ folderPath, theme = "dark" }: GraphTileProps) {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const graphRef = useRef<ForceDirectedGraphRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const bg = theme === "light" ? "#ffffff" : "#111827";
  const border = theme === "light" ? "#e5e7eb" : "#374151";
  const muted = theme === "light" ? "#6b7280" : "#9ca3af";

  // Measure container
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Load graph data
  const loadGraph = useCallback(() => {
    if (!folderPath) {
      setError("No workspace folder selected");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    invoke<{ nodes: GraphNode[]; links: GraphLink[] }>("workspace_get_graph", {
      workspacePath: folderPath,
    })
      .then((data) => {
        setNodes(data.nodes);
        setLinks(data.links);
        setLoading(false);
      })
      .catch((e) => {
        setError(`Failed to load graph: ${e}`);
        setLoading(false);
      });
  }, [folderPath]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNode((prev) => prev === nodeId ? null : nodeId);
    // Highlight connected nodes
    if (graphRef.current) {
      graphRef.current.highlightNode(nodeId);
    }
  }, []);

  // Header
  const renderHeader = () => (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px",
      padding: "6px 12px", borderBottom: `1px solid ${border}`,
      fontSize: "12px", flexShrink: 0,
    }}>
      <span style={{ fontWeight: 600, color: theme === "light" ? "#111827" : "#ffffff" }}>
        Graph
      </span>
      <span style={{ color: muted }}>
        {nodes.length} nodes, {links.length} links
      </span>
      <div style={{ flex: 1 }} />
      <button
        onClick={loadGraph}
        style={{
          padding: "2px 8px", borderRadius: "4px", fontSize: "11px",
          backgroundColor: theme === "light" ? "#e5e7eb" : "#374151",
          color: theme === "light" ? "#111827" : "#ffffff",
          border: "none", cursor: "pointer",
        }}
      >
        Refresh
      </button>
    </div>
  );

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: bg }}>
        {renderHeader()}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: muted }}>
          Loading graph...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: bg }}>
        {renderHeader()}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#ef4444", fontSize: "13px", padding: "16px" }}>
          {error}
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: bg }}>
        {renderHeader()}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: muted, fontSize: "13px", padding: "16px", textAlign: "center" }}>
          <div>
            <p>No files found in this workspace.</p>
            <p style={{ fontSize: "11px", marginTop: "4px" }}>Add markdown files with wikilinks [[like-this]] to build a graph.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: bg }}>
      {renderHeader()}
      <div ref={containerRef} style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <ForceDirectedGraph
          ref={graphRef}
          nodes={nodes as any}
          links={links as any}
          width={dimensions.width}
          height={dimensions.height}
          theme={theme as "light" | "dark"}
          onNodeClick={handleNodeClick}
        />
      </div>
      {/* Selected node info */}
      {selectedNode && (
        <div style={{
          padding: "6px 12px", borderTop: `1px solid ${border}`,
          fontSize: "11px", color: muted, display: "flex", gap: "8px",
        }}>
          <span style={{ color: theme === "light" ? "#111827" : "#ffffff", fontWeight: 500 }}>
            {nodes.find((n) => n.id === selectedNode)?.title || selectedNode}
          </span>
          <span>{nodes.find((n) => n.id === selectedNode)?.path}</span>
        </div>
      )}
    </div>
  );
}
