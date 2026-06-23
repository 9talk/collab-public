import { utilityProcess, type UtilityProcess } from "electron";
import { accessSync } from "node:fs";
import { join } from "node:path";
import type { ReplayMessage } from "@collab/shared/replay-types";

type NotifyFn = (msg: ReplayMessage) => void;

const MAX_RESTARTS = 3;

let worker: UtilityProcess | null = null;
let notifyFn: NotifyFn | null = null;
let restartCount = 0;
let stopping = false;

function workerPath(): string {
  return join(__dirname, "git-replay-worker.js");
}

export function startWorker(): void {
  if (worker) return;
  stopping = false;

  worker = utilityProcess.fork(workerPath());

  worker.on("message", (data: ReplayMessage) => {
    notifyFn?.(data);
  });

  worker.on("exit", (code) => {
    worker = null;
    if (stopping) return;

    if (restartCount >= MAX_RESTARTS) {
      console.error(
        `[git-replay] Worker exited ${MAX_RESTARTS} times, giving up`,
      );
      return;
    }

    console.warn(`[git-replay] Worker exited with code ${code}, restarting`);
    restartCount++;
    startWorker();
  });
}

export function setNotifyFn(fn: NotifyFn): void {
  notifyFn = fn;
}

export function startReplay(workspacePath: string): boolean {
  try {
    accessSync(join(workspacePath, ".git"));
  } catch {
    return false;
  }
  restartCount = 0;
  if (!worker) startWorker();
  const cachePath = join(workspacePath, ".collaborator", "replay-cache.json");
  worker?.postMessage({ cmd: "start", workspacePath, cachePath });
  return true;
}

export function stopReplay(): void {
  worker?.postMessage({ cmd: "stop" });
}

export function stopWorker(): void {
  if (!worker) return;
  stopping = true;
  worker.postMessage({ cmd: "close" });
  worker.kill();
  worker = null;
}
