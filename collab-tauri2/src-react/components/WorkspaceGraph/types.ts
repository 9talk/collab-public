import type * as d3 from "d3";

export interface GraphNode {
  id: string;
  title: string;
  path: string;
  weight?: number;
  nodeType?: "file" | "code" | "agent";
  thumbnailUrl?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  linkType?: "wikilink" | "import" | "agent-read" | "agent-write";
  timestamp?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export type ForceNode = GraphNode &
  d3.SimulationNodeDatum & { id: string; __index: number };

export type ForceLink = GraphLink &
  d3.SimulationLinkDatum<ForceNode> & {
    source: string | ForceNode;
    target: string | ForceNode;
  };
