export const DISABLE_GIT_REPLAY = false;

export const CACHE_VERSION = 2;

export interface ReplayFileChange {
	path: string;
	status: "A" | "D" | "M" | "R";
	oldPath?: string;
}

export interface ReplayLinkChange {
	source: string;
	target: string;
	linkType: "wikilink" | "import";
	action: "add" | "remove";
}

export interface ReplayCommit {
	hash: string;
	timestamp: number;
	author: string;
	subject: string;
	fileChanges: ReplayFileChange[];
	linkChanges: ReplayLinkChange[];
}

export interface ReplayCheckpoint {
	commitIndex: number;
	files: string[];
	links: Array<{
		source: string;
		target: string;
		linkType: "wikilink" | "import";
	}>;
}

export interface ReplayCacheData {
	version: number;
	lastHash: string;
	commits: ReplayCommit[];
	checkpoints: Record<string, ReplayCheckpoint>;
}

export type ReplayMessage =
	| { type: "meta"; workspacePath: string; data: { totalCommits: number } }
	| { type: "commit"; workspacePath: string; data: ReplayCommit }
	| { type: "checkpoint"; workspacePath: string; data: ReplayCheckpoint }
	| { type: "complete"; workspacePath: string };
