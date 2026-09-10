import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";
import { COLLAB_DIR } from "./paths";
import { isRemoteFlavor } from "./app-flavor";
import { getSnapshot, restoreSnapshot } from "./navigation-history";

const STATE_FILE = join(COLLAB_DIR, "navigation-history.json");

interface HistoryState {
  version: 1;
  history: string[];
  currentIndex: number;
}

// 导航历史持久化与启动聚焦均为 Host 本地功能,镜像(Client)端不读不写。
export async function loadHistory(): Promise<void> {
  if (isRemoteFlavor()) return;
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as HistoryState;
    if (state.version !== 1) return;
    restoreSnapshot(state);
  } catch {
    // 无文件 / 损坏 → 空栈启动
  }
}

export async function saveHistory(): Promise<void> {
  if (isRemoteFlavor()) return;
  try {
    if (!existsSync(COLLAB_DIR)) {
      await mkdir(COLLAB_DIR, { recursive: true });
    }
    const tmp = join(
      tmpdir(),
      `navigation-history-${crypto.randomUUID()}.json`,
    );
    const state: HistoryState = { version: 1, ...getSnapshot() };
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmp, STATE_FILE);
  } catch (err) {
    console.warn("[navigation-history] save failed:", err);
  }
}
