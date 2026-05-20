import fm from "front-matter";
import type {
  ViewerItem,
  Quote,
  Concept,
  ItemSource,
} from "./types";

interface FrontMatterAttributes {
  title?: string;
  type?: string;
  url?: string;
  summary?: string;
  quotes?: Array<string | { text: string }>;
  quotesTitle?: string;
  concepts?: Array<{
    id: string;
    title: string;
    similarityScore?: string;
    degree?: number;
  }>;
  sources?: ItemSource[];
  collab_reviewed?: boolean;
}

function filenameFromPath(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last.replace(/\.[^.]+$/, "");
}

function isSkillPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  if (p.includes("/.claude/skills/")) return true;
  const idx = p.indexOf("/.claude/plugins/");
  return idx >= 0 && p.includes("/skills/", idx);
}

function typeFromExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "FILE";
  return path.slice(dot + 1).toUpperCase();
}

export function parseFileToViewerItem(
  path: string,
  content: string,
  stats?: { ctime: string; mtime: string },
): ViewerItem {
  let attributes: FrontMatterAttributes = {};
  let body = content;

  try {
    const result = fm<FrontMatterAttributes>(content);
    attributes = result.attributes;
    body = result.body;
  } catch {
    // If frontmatter parsing fails, treat entire content as body
  }

  const quotes: Quote[] | undefined =
    attributes.quotes?.map((q) =>
      typeof q === "string" ? { text: q } : q,
    );

  const concepts: Concept[] | undefined =
    attributes.concepts;

  return {
    id: path,
    title: filenameFromPath(path),
    type: isSkillPath(path)
      ? "skill"
      : (attributes.type ?? typeFromExtension(path)),
    isEditable: true,
    isTitleEditable: true,
    url: attributes.url,
    summary: attributes.summary,
    quotes,
    quotesTitle: attributes.quotesTitle,
    text: body,
    createdAt: stats ? new Date(stats.ctime).getTime() : Date.now(),
    modifiedAt: stats ? new Date(stats.mtime).getTime() : Date.now(),
    relatedConcepts: concepts,
    sources: attributes.sources,
    collab_reviewed: attributes.collab_reviewed,
    frontmatter: Object.keys(attributes).length > 0
      ? (attributes as Record<string, unknown>)
      : undefined,
  };
}

/** Fields to strip from front-matter on save. */
const STRIPPED_FIELDS = new Set([
  "createdAt",
  "modifiedAt",
  "author",
]);

export function serializeViewerItem(
  item: ViewerItem,
  body: string,
): string {
  const attrs: Record<string, unknown> = {};
  const hadExplicitType = item.frontmatter?.type != null;
  if (hadExplicitType && item.type !== "skill")
    attrs.type = item.type;
  if (item.url) attrs.url = item.url;
  if (item.summary) attrs.summary = item.summary;
  if (item.quotes?.length) attrs.quotes = item.quotes;
  if (item.quotesTitle) attrs.quotesTitle = item.quotesTitle;
  if (item.relatedConcepts?.length)
    attrs.concepts = item.relatedConcepts;
  if (item.sources?.length) attrs.sources = item.sources;
  if (item.collab_reviewed != null)
    attrs.collab_reviewed = item.collab_reviewed;

  // Strip legacy fields that may have been carried forward
  for (const key of STRIPPED_FIELDS) {
    delete attrs[key];
  }

  const hasAttrs = Object.keys(attrs).length > 0;
  if (!hasAttrs) return body;

  const yaml = Object.entries(attrs)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}
