/**
 * Longest-prefix workspace match for a path, returning the workspace and its
 * alias when it has one. A path equal to the workspace or nested below it
 * counts as a match (a "/ws-proj" sibling of "/ws" does not); overlapping
 * workspaces resolve to the most specific (longest) one. Backslashes are
 * normalized before comparison.
 */
export function matchWorkspaceAlias(
  path: string | undefined,
  aliases: Record<string, string> | undefined,
  workspacePaths: string[],
): { workspacePath: string; alias: string } | null {
  if (!path || !aliases || workspacePaths.length === 0) return null;
  const normalized = path.replace(/\\/g, "/");
  const matched = [...workspacePaths]
    .sort((a, b) => b.length - a.length)
    .find((wp) => {
      const w = wp.replace(/\\/g, "/");
      return normalized === w || normalized.startsWith(w + "/");
    });
  if (!matched) return null;
  const alias = aliases[matched];
  return alias ? { workspacePath: matched, alias } : null;
}
