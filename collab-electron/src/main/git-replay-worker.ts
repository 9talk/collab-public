import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import { CACHE_VERSION } from "@collab/shared/replay-types";
import { getDefaultPatterns } from "./file-filter";
import type {
  ReplayCacheData,
  ReplayCommit,
  ReplayFileChange,
  ReplayLinkChange,
  ReplayCheckpoint,
} from "@collab/shared/replay-types";

const execFileAsync = promisify(execFile);

let replayIgnore = ignore().add(getDefaultPatterns());

async function loadWorkspaceIgnore(workspacePath: string): Promise<void> {
  replayIgnore = ignore().add(getDefaultPatterns());
  try {
    const gitignore = await readFile(
      join(workspacePath, ".gitignore"),
      "utf-8",
    );
    replayIgnore.add(gitignore);
  } catch {
    // No .gitignore — use defaults only
  }
}

function isIgnoredPath(filePath: string): boolean {
  return replayIgnore.ignores(filePath);
}

let emptyTreeSha: string | null = null;

async function getEmptyTreeSha(cwd: string): Promise<string> {
  if (emptyTreeSha) return emptyTreeSha;
  const sha = (
    await git(["hash-object", "-t", "tree", "/dev/null"], cwd)
  ).trim();
  emptyTreeSha = sha;
  return sha;
}
const CHECKPOINT_INTERVAL = 50;

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const IMPORT_FROM_RE =
  /(?:import\s+.*\s+from\s+|from\s+\S+\s+import\s+)['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

interface StartCommand {
  cmd: "start";
  workspacePath: string;
  cachePath: string;
}

interface StopCommand {
  cmd: "stop";
}

interface CloseCommand {
  cmd: "close";
}

type WorkerCommand = StartCommand | StopCommand | CloseCommand;

interface RawCommit {
  hash: string;
  isoDate: string;
  author: string;
  subject: string;
  parentHashes: string[];
}

let aborted = false;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

async function readCache(cachePath: string): Promise<ReplayCacheData | null> {
  try {
    const text = await readFile(cachePath, "utf-8");
    const data = JSON.parse(text) as ReplayCacheData;
    if (data.version !== CACHE_VERSION) return null;
    if (!data.lastHash || !Array.isArray(data.commits)) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(
  cachePath: string,
  data: ReplayCacheData,
): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(data));
  } catch (err) {
    console.warn(
      `[git-replay-worker] Failed to write cache: ${(err as Error).message}`,
    );
  }
}

async function hashExists(hash: string, cwd: string): Promise<boolean> {
  try {
    await git(["cat-file", "-t", hash], cwd);
    return true;
  } catch {
    return false;
  }
}

function parseCommitLog(raw: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    const hash = parts[0];
    const isoDate = parts[1];
    const author = parts[2];
    const subject = parts[3];
    const parentField = parts[4] ?? "";
    if (!hash || !isoDate || !author || subject == null) {
      continue;
    }
    const parentHashes = parentField
      ? parentField.split(" ").filter(Boolean)
      : [];
    commits.push({
      hash,
      isoDate,
      author,
      subject,
      parentHashes,
    });
  }
  return commits;
}

function deduplicateAndSort(commits: RawCommit[]): RawCommit[] {
  const seen = new Set<string>();
  const unique: RawCommit[] = [];
  for (const c of commits) {
    if (seen.has(c.hash)) continue;
    seen.add(c.hash);
    unique.push(c);
  }
  unique.sort(
    (a, b) => new Date(a.isoDate).getTime() - new Date(b.isoDate).getTime(),
  );
  return unique;
}

function parseNameStatus(raw: string): ReplayFileChange[] {
  const changes: ReplayFileChange[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const statusField = parts[0];
    if (!statusField) continue;
    const statusCode = statusField[0];
    if (
      statusCode !== "A" &&
      statusCode !== "D" &&
      statusCode !== "M" &&
      statusCode !== "R"
    ) {
      continue;
    }
    if (statusCode === "R") {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (!oldPath || !newPath) continue;
      if (isIgnoredPath(newPath)) continue;
      changes.push({
        path: newPath,
        status: "R",
        oldPath,
      });
    } else {
      const filePath = parts[1];
      if (!filePath) continue;
      if (isIgnoredPath(filePath)) continue;
      changes.push({ path: filePath, status: statusCode });
    }
  }
  return changes;
}

function extractLinksFromDiff(diffOutput: string): ReplayLinkChange[] {
  const links: ReplayLinkChange[] = [];
  let currentFile = "";

  let skipFile = false;

  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      const captured = match?.[1];
      if (captured) {
        currentFile = captured;
        skipFile = isIgnoredPath(captured);
      }
      continue;
    }

    if (skipFile) continue;

    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    const isAdd = line.startsWith("+");
    const isRemove = line.startsWith("-");
    if (!isAdd && !isRemove) continue;

    const action: "add" | "remove" = isAdd ? "add" : "remove";
    const content = line.slice(1);

    for (const m of content.matchAll(WIKILINK_RE)) {
      const target = m[1];
      if (!target) continue;
      links.push({
        source: currentFile,
        target,
        linkType: "wikilink",
        action,
      });
    }

    for (const m of content.matchAll(IMPORT_FROM_RE)) {
      const target = m[1];
      if (!target) continue;
      links.push({
        source: currentFile,
        target,
        linkType: "import",
        action,
      });
    }

    for (const m of content.matchAll(REQUIRE_RE)) {
      const target = m[1];
      if (!target) continue;
      links.push({
        source: currentFile,
        target,
        linkType: "import",
        action,
      });
    }
  }

  return links;
}

interface FileAndLinkState {
  fileSet: Set<string>;
  linkSet: Map<
    string,
    {
      source: string;
      target: string;
      linkType: "wikilink" | "import";
    }
  >;
}

function updateFileAndLinkState(
  state: FileAndLinkState,
  fileChanges: ReplayFileChange[],
  linkChanges: ReplayLinkChange[],
): void {
  for (const fc of fileChanges) {
    if (fc.status === "A") {
      state.fileSet.add(fc.path);
    } else if (fc.status === "D") {
      state.fileSet.delete(fc.path);
    } else if (fc.status === "R" && fc.oldPath) {
      state.fileSet.delete(fc.oldPath);
      state.fileSet.add(fc.path);
    }
  }

  for (const lc of linkChanges) {
    const key = `${lc.source}\0${lc.target}\0${lc.linkType}`;
    if (lc.action === "add") {
      state.linkSet.set(key, {
        source: lc.source,
        target: lc.target,
        linkType: lc.linkType,
      });
    } else {
      state.linkSet.delete(key);
    }
  }
}

async function processCommit(
  raw: RawCommit,
  workspacePath: string,
): Promise<ReplayCommit> {
  const parentRef =
    raw.parentHashes.length > 0
      ? raw.parentHashes[0]!
      : await getEmptyTreeSha(workspacePath);

  let fileChanges: ReplayFileChange[] = [];
  let linkChanges: ReplayLinkChange[] = [];

  try {
    const nameStatusOut = await git(
      ["diff", "--name-status", `${parentRef}..${raw.hash}`],
      workspacePath,
    );
    fileChanges = parseNameStatus(nameStatusOut);

    const diffOut = await git(
      ["diff", `${parentRef}..${raw.hash}`],
      workspacePath,
    );
    linkChanges = extractLinksFromDiff(diffOut);
  } catch (err) {
    console.warn(
      `[git-replay-worker] Skipping commit ${raw.hash}: ${(err as Error).message}`,
    );
  }

  return {
    hash: raw.hash,
    timestamp: new Date(raw.isoDate).getTime(),
    author: raw.author,
    subject: raw.subject,
    fileChanges,
    linkChanges,
  };
}

async function computeReplay(
  workspacePath: string,
  cachePath: string,
): Promise<void> {
  aborted = false;
  await loadWorkspaceIgnore(workspacePath);

  // Try loading cache
  const cached = await readCache(cachePath);
  let cachedCommits: ReplayCommit[] = [];
  let cachedCheckpoints: Record<string, ReplayCheckpoint> = {};
  let lastHash: string | null = null;

  if (cached && (await hashExists(cached.lastHash, workspacePath))) {
    cachedCommits = cached.commits;
    cachedCheckpoints = cached.checkpoints;
    lastHash = cached.lastHash;
  }

  // Emit cached data immediately
  if (cachedCommits.length > 0) {
    process.parentPort.postMessage({
      type: "meta",
      workspacePath,
      data: { totalCommits: cachedCommits.length },
    });

    for (const commit of cachedCommits) {
      if (aborted) return;
      process.parentPort.postMessage({
        type: "commit",
        workspacePath,
        data: commit,
      });
    }

    for (const cp of Object.values(cachedCheckpoints)) {
      if (aborted) return;
      process.parentPort.postMessage({
        type: "checkpoint",
        workspacePath,
        data: cp,
      });
    }
  }

  // Fetch new commits (incremental or full)
  const logArgs = lastHash
    ? [
        "log",
        "--format=%H%x00%aI%x00%an%x00%s%x00%P",
        "--reverse",
        `${lastHash}..HEAD`,
      ]
    : ["log", "--format=%H%x00%aI%x00%an%x00%s%x00%P", "--reverse"];

  let logOutput: string;
  try {
    logOutput = await git(logArgs, workspacePath);
  } catch (err) {
    console.error(
      `[git-replay-worker] Failed to read git log: ${(err as Error).message}`,
    );
    process.parentPort.postMessage({
      type: "complete",
      workspacePath,
    });
    return;
  }

  const rawCommits = deduplicateAndSort(parseCommitLog(logOutput));

  if (rawCommits.length === 0 && cachedCommits.length === 0) {
    process.parentPort.postMessage({
      type: "complete",
      workspacePath,
    });
    return;
  }

  // If we have new commits, send updated total
  if (rawCommits.length > 0) {
    const newTotal = cachedCommits.length + rawCommits.length;
    process.parentPort.postMessage({
      type: "meta",
      workspacePath,
      data: { totalCommits: newTotal },
    });
  }

  // Rebuild file/link state from last cached checkpoint
  const state: FileAndLinkState = {
    fileSet: new Set<string>(),
    linkSet: new Map(),
  };

  const cpKeys = Object.keys(cachedCheckpoints)
    .map(Number)
    .sort((a, b) => a - b);
  const lastCpIndex = cpKeys.length > 0 ? cpKeys[cpKeys.length - 1]! : -1;

  if (lastCpIndex >= 0) {
    const cp = cachedCheckpoints[String(lastCpIndex)]!;
    for (const f of cp.files) state.fileSet.add(f);
    for (const l of cp.links) {
      const key = `${l.source}\0${l.target}\0${l.linkType}`;
      state.linkSet.set(key, {
        source: l.source,
        target: l.target,
        linkType: l.linkType,
      });
    }
    // Apply commits after the checkpoint to get current state
    for (let i = lastCpIndex + 1; i < cachedCommits.length; i++) {
      const c = cachedCommits[i]!;
      updateFileAndLinkState(state, c.fileChanges, c.linkChanges);
    }
  } else {
    // No checkpoint — replay all cached commits to rebuild state
    for (const c of cachedCommits) {
      updateFileAndLinkState(state, c.fileChanges, c.linkChanges);
    }
  }

  // Process new commits
  const allCommits = [...cachedCommits];
  const allCheckpoints = { ...cachedCheckpoints };

  for (let i = 0; i < rawCommits.length; i++) {
    if (aborted) return;

    const commit = await processCommit(rawCommits[i]!, workspacePath);
    allCommits.push(commit);

    process.parentPort.postMessage({
      type: "commit",
      workspacePath,
      data: commit,
    });

    updateFileAndLinkState(state, commit.fileChanges, commit.linkChanges);

    const globalIndex = allCommits.length - 1;
    if ((globalIndex + 1) % CHECKPOINT_INTERVAL === 0) {
      const cp: ReplayCheckpoint = {
        commitIndex: globalIndex,
        files: [...state.fileSet],
        links: [...state.linkSet.values()],
      };
      allCheckpoints[String(globalIndex)] = cp;

      process.parentPort.postMessage({
        type: "checkpoint",
        workspacePath,
        data: cp,
      });

      const newLastHash = allCommits[allCommits.length - 1]!.hash;
      await writeCache(cachePath, {
        version: CACHE_VERSION,
        lastHash: newLastHash,
        commits: allCommits,
        checkpoints: allCheckpoints,
      });
    }
  }

  // Final checkpoint and cache write
  if (rawCommits.length > 0) {
    const finalIndex = allCommits.length - 1;
    const cp: ReplayCheckpoint = {
      commitIndex: finalIndex,
      files: [...state.fileSet],
      links: [...state.linkSet.values()],
    };
    allCheckpoints[String(finalIndex)] = cp;

    process.parentPort.postMessage({
      type: "checkpoint",
      workspacePath,
      data: cp,
    });

    await writeCache(cachePath, {
      version: CACHE_VERSION,
      lastHash: allCommits[finalIndex]!.hash,
      commits: allCommits,
      checkpoints: allCheckpoints,
    });
  }

  process.parentPort.postMessage({
    type: "complete",
    workspacePath,
  });
}

const keepAlive = setInterval(() => {}, 2 ** 31 - 1);

let runningReplay: Promise<void> | null = null;
let currentWorkspace: string | null = null;

process.parentPort.on("message", ({ data }: { data: WorkerCommand }) => {
  if (data.cmd === "start") {
    // Only abort if restarting the same workspace
    if (currentWorkspace === data.workspacePath) {
      aborted = true;
    }
    const prev = runningReplay;
    runningReplay = (async () => {
      if (prev) await prev;
      currentWorkspace = data.workspacePath;
      aborted = false;
      await computeReplay(data.workspacePath, data.cachePath);
      currentWorkspace = null;
      runningReplay = null;
    })();
  } else if (data.cmd === "stop") {
    aborted = true;
  } else if (data.cmd === "close") {
    aborted = true;
    clearInterval(keepAlive);
    process.exit(0);
  }
});
