import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ReplayCommit,
  ReplayCheckpoint,
} from "@collab/shared/types";
import type { GraphData, GraphNode, GraphLink } from "./types";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".pyi",
]);

/**
 * Determine nodeType from a file path extension.
 * Matches the main-process heuristic in workspace-graph.ts.
 */
function nodeTypeForPath(
  path: string,
): "file" | "code" {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "file";
  const ext = path.slice(dot);
  return CODE_EXTENSIONS.has(ext) ? "code" : "file";
}

/** Derive a short display title from a file path. */
function titleForPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Composite key for deduplicating links in a Set. */
function linkKey(
  source: string,
  target: string,
  linkType: string,
): string {
  return `${source}|${target}|${linkType}`;
}

interface LinkEntry {
  source: string;
  target: string;
  linkType: "wikilink" | "import";
}

/**
 * Build a GraphData snapshot by starting from a checkpoint
 * and applying commits forward to the target index.
 */
function buildGraphAtIndex(
  targetIndex: number,
  commits: ReplayCommit[],
  checkpoints: Map<number, ReplayCheckpoint>,
): GraphData {
  let nearestIdx = -1;
  for (const idx of checkpoints.keys()) {
    if (idx <= targetIndex && idx > nearestIdx) {
      nearestIdx = idx;
    }
  }

  const files = new Set<string>();
  const links = new Map<string, LinkEntry>();

  if (nearestIdx >= 0) {
    const cp = checkpoints.get(nearestIdx)!;
    for (const f of cp.files) files.add(f);
    for (const l of cp.links) {
      const key = linkKey(l.source, l.target, l.linkType);
      links.set(key, l);
    }
  }

  const startIdx = nearestIdx >= 0 ? nearestIdx + 1 : 0;
  for (let i = startIdx; i <= targetIndex; i++) {
    const commit = commits[i];
    if (!commit) continue;
    applyCommitChanges(commit, files, links);
  }

  const nodes: GraphNode[] = [];
  for (const path of files) {
    nodes.push({
      id: path,
      title: titleForPath(path),
      path,
      nodeType: nodeTypeForPath(path),
    });
  }

  const graphLinks: GraphLink[] = [];
  for (const entry of links.values()) {
    if (files.has(entry.source) && files.has(entry.target)) {
      graphLinks.push({
        source: entry.source,
        target: entry.target,
        linkType: entry.linkType,
      });
    }
  }

  return { nodes, links: graphLinks };
}

/** Apply a single commit's file and link changes to mutable state. */
function applyCommitChanges(
  commit: ReplayCommit,
  files: Set<string>,
  links: Map<string, LinkEntry>,
): void {
  for (const fc of commit.fileChanges) {
    switch (fc.status) {
      case "A":
        files.add(fc.path);
        break;
      case "D":
        files.delete(fc.path);
        break;
      case "M":
        break;
      case "R":
        if (fc.oldPath) files.delete(fc.oldPath);
        files.add(fc.path);
        break;
    }
  }
  for (const lc of commit.linkChanges) {
    const key = linkKey(lc.source, lc.target, lc.linkType);
    if (lc.action === "add") {
      links.set(key, {
        source: lc.source,
        target: lc.target,
        linkType: lc.linkType,
      });
    } else {
      links.delete(key);
    }
  }
}

export interface ReplayEngine {
  commits: ReplayCommit[];
  currentIndex: number;
  isPlaying: boolean;
  isLoading: boolean;
  isGitRepo: boolean;
  totalCommits: number | null;

  currentGraphData: GraphData | null;
  modifiedFiles: Set<string>;
  timeRange: [number, number] | null;

  play(): void;
  pause(): void;
  seekTo(index: number): void;
  seekToLive(): void;

  start(workspacePath: string): void;
  stop(): void;
}

export function useReplayEngine(): ReplayEngine {
  const [commits, setCommits] = useState<ReplayCommit[]>([]);
  const [checkpoints, setCheckpoints] = useState<
    Map<number, ReplayCheckpoint>
  >(new Map());
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [totalCommits, setTotalCommits] = useState<
    number | null
  >(null);

  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  const currentIndexRef = useRef(currentIndex);
  const isLoadingRef = useRef(isLoading);
  const isPlayingRef = useRef(isPlaying);

  const unsubRef = useRef<(() => void) | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
    window.api.stopReplay().catch((err: unknown) => {
      console.warn("stopReplay failed:", err);
    });
    isLoadingRef.current = false;
    setIsLoading(false);
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const start = useCallback(
    (workspacePath: string) => {
      // Clean up previous listener without stopping the worker —
      // other tabs may still be loading their own workspace.
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      isPlayingRef.current = false;
      setIsPlaying(false);

      commitsRef.current = [];
      setCommits([]);
      setCheckpoints(new Map());
      currentIndexRef.current = -1;
      setCurrentIndex(-1);
      setTotalCommits(null);
      setIsGitRepo(false);

      window.api.startReplay({ workspacePath }).then(
        (isGit) => {
          if (!isGit) {
            isLoadingRef.current = false;
            setIsLoading(false);
            return;
          }
          setIsGitRepo(true);
          isLoadingRef.current = true;
          setIsLoading(true);

          unsubRef.current = window.api.onReplayData(
            (msg) => {
              if (msg.workspacePath !== workspacePath) return;

              switch (msg.type) {
                case "meta":
                  setTotalCommits(msg.data.totalCommits);
                  break;
                case "commit":
                  setCommits((prev) => [...prev, msg.data]);
                  break;
                case "checkpoint":
                  setCheckpoints((prev) => {
                    const next = new Map(prev);
                    next.set(msg.data.commitIndex, msg.data);
                    return next;
                  });
                  break;
                case "complete":
                  setCommits((prev) =>
                    [...prev].sort(
                      (a, b) => a.timestamp - b.timestamp,
                    ),
                  );
                  isLoadingRef.current = false;
                  setIsLoading(false);
                  break;
              }
            },
          );
        },
        (err: unknown) => {
          console.warn("startReplay failed:", err);
        },
      );
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      window.api.stopReplay().catch((err: unknown) => {
        console.warn("stopReplay failed:", err);
      });
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const currentGraphData = useMemo(() => {
    if (currentIndex < 0) return null;
    if (commits.length === 0) return null;
    const clamped = Math.min(
      currentIndex,
      commits.length - 1,
    );
    return buildGraphAtIndex(clamped, commits, checkpoints);
  }, [currentIndex, commits, checkpoints]);

  const modifiedFiles = useMemo(() => {
    if (currentIndex < 0 || currentIndex >= commits.length) {
      return new Set<string>();
    }
    const commit = commits[currentIndex];
    if (!commit) return new Set<string>();
    const paths = new Set<string>();
    for (const fc of commit.fileChanges) {
      if (fc.status === "M") paths.add(fc.path);
    }
    return paths;
  }, [currentIndex, commits]);

  const liveTimeRange = useMemo((): [number, number] | null => {
    if (commits.length === 0) return null;
    return [
      commits[0]!.timestamp,
      commits[commits.length - 1]!.timestamp,
    ];
  }, [commits]);

  // Freeze timeRange during playback so commit positions don't
  // shift when new commits stream in (expanding the denominator
  // would move the playhead backward visually).
  const stableTimeRange = useRef(liveTimeRange);
  if (!isPlaying || stableTimeRange.current === null) {
    stableTimeRange.current = liveTimeRange;
  }
  const timeRange = stableTimeRange.current;

  const seekTo = useCallback(
    (index: number) => {
      if (commitsRef.current.length === 0) return;
      const max = commitsRef.current.length - 1;
      const clamped = Math.max(0, Math.min(index, max));
      currentIndexRef.current = clamped;
      setCurrentIndex(clamped);
    },
    [],
  );

  const seekToLive = useCallback(() => {
    currentIndexRef.current = -1;
    setCurrentIndex(-1);
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const play = useCallback(() => {
    const c = commitsRef.current;
    if (c.length === 0) return;

    let startIdx = currentIndexRef.current;
    if (startIdx < 0) startIdx = 0;
    if (startIdx >= c.length - 1 && !isLoadingRef.current) {
      startIdx = 0;
    }
    currentIndexRef.current = startIdx;
    setCurrentIndex(startIdx);
    isPlayingRef.current = true;
    setIsPlaying(true);

    const totalSpan =
      c.length >= 2
        ? c[c.length - 1]!.timestamp - c[0]!.timestamp
        : 1;
    const speedMultiplier = Math.max(totalSpan / 10000, 1);

    let lastFrameTime: number | null = null;
    let accumulated = 0;
    let prevTickIdx = startIdx;
    let prevTickTimestamp = c[startIdx]?.timestamp ?? 0;

    function tick(now: number) {
      if (!isPlayingRef.current) return;

      const idx = currentIndexRef.current;
      const allCommits = commitsRef.current;

      if (idx !== prevTickIdx) {
        prevTickIdx = idx;
        prevTickTimestamp = allCommits[idx]?.timestamp ?? 0;
      }

      if (idx >= allCommits.length - 1) {
        if (isLoadingRef.current) {
          isPlayingRef.current = false;
          setIsPlaying(false);
          rafRef.current = null;
          return;
        }
        currentIndexRef.current = -1;
        setCurrentIndex(-1);
        isPlayingRef.current = false;
        setIsPlaying(false);
        rafRef.current = null;
        return;
      }

      if (lastFrameTime === null) {
        lastFrameTime = now;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const elapsed = now - lastFrameTime;
      lastFrameTime = now;
      accumulated += elapsed;

      const current = allCommits[idx];
      const next = allCommits[idx + 1];
      if (!current || !next) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const realGap = Math.abs(
        next.timestamp - current.timestamp,
      );
      const delay = Math.min(
        2000,
        Math.max(16, realGap / speedMultiplier),
      );

      if (accumulated >= delay) {
        accumulated = 0;
        currentIndexRef.current = idx + 1;
        setCurrentIndex(idx + 1);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  return {
    commits,
    currentIndex,
    isPlaying,
    isLoading,
    isGitRepo,
    totalCommits,
    currentGraphData,
    modifiedFiles,
    timeRange,
    play,
    pause,
    seekTo,
    seekToLive,
    start,
    stop,
  };
}
