import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { COLLAB_DIR } from "./paths";
import { registerMethod } from "./json-rpc-server";
import { ipcMain } from "electron";
import { loadConfig, getPref } from "./config";

const DATA_FILE = join(COLLAB_DIR, "claude-tiles.json");

interface ClaudeTileEntry {
  sessionId: string;
  updatedAt: number; // Unix timestamp ms
}

// 兼容旧格式：旧数据 value 是纯 string，新数据是 ClaudeTileEntry
type ClaudeTiles = Record<string, ClaudeTileEntry | string>;

function readData(): ClaudeTiles {
  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      // 迁移旧格式：纯 string → { sessionId, updatedAt: 0 }
      for (const key of Object.keys(parsed)) {
        if (typeof parsed[key] === "string") {
          parsed[key] = { sessionId: parsed[key], updatedAt: 0 };
        }
      }
      return parsed as ClaudeTiles;
    }
    return {};
  } catch {
    return {};
  }
}

function writeData(data: ClaudeTiles): void {
  mkdirSync(COLLAB_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, DATA_FILE);
}

/**
 * 清除过期条目：
 * - updatedAt === 0（旧格式迁移）视为已过期
 * - 超过 timeoutDays 的视为已过期
 */
function cleanupExpired(): void {
  const cfg = loadConfig();
  const timeoutDays = (getPref(cfg, "claudeTimeout") as number) ?? 7;
  const maxAge = timeoutDays * 86400000;
  const data = readData();
  let changed = false;
  for (const key of Object.keys(data)) {
    const entry = data[key];
    if (typeof entry === "string") {
      // 旧格式纯 string → 删除
      delete data[key];
      changed = true;
    } else if (entry.updatedAt === 0 || Date.now() - entry.updatedAt > maxAge) {
      delete data[key];
      changed = true;
    }
  }
  if (changed) {
    writeData(data);
  }
}

export function registerClaudeRpc(): void {
  registerMethod(
    "claude.bind",
    (params: unknown) => {
      const p = params as {
        tileId: string;
        sessionId: string;
        updatedAt?: number;
      };
      if (!p.tileId || typeof p.tileId !== "string") {
        throw new Error("tileId is required");
      }
      if (!p.sessionId || typeof p.sessionId !== "string") {
        throw new Error("sessionId is required");
      }
      // 绑定前先清理过期条目
      cleanupExpired();
      const data = readData();
      data[p.tileId] = {
        sessionId: p.sessionId,
        updatedAt: p.updatedAt ?? Date.now(),
      };
      writeData(data);
      return { ok: true };
    },
    {
      description: "Bind a Claude Code session to a canvas tile",
      params: {
        tileId: "string (required)",
        sessionId: "string (required)",
        updatedAt: "number (optional, defaults to now)",
      },
    },
  );

  registerMethod(
    "claude.get",
    (params: unknown) => {
      const p = params as { tileId: string };
      if (!p.tileId || typeof p.tileId !== "string") {
        throw new Error("tileId is required");
      }
      const data = readData();
      const entry = data[p.tileId];
      if (!entry) return { tileId: p.tileId, sessionId: null, updatedAt: null };
      const sessionId = typeof entry === "string" ? entry : entry.sessionId;
      const updatedAt = typeof entry === "string" ? null : entry.updatedAt;
      return { tileId: p.tileId, sessionId, updatedAt };
    },
    {
      description: "Get the Claude Code session bound to a tile",
      params: {
        tileId: "string (required)",
      },
    },
  );

  registerMethod(
    "claude.list",
    () => {
      const raw = readData();
      // 统一返回 ClaudeTileEntry 格式
      const result: Record<string, ClaudeTileEntry> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") {
          result[key] = { sessionId: value, updatedAt: 0 };
        } else {
          result[key] = value;
        }
      }
      return result;
    },
    {
      description: "List all Claude Code session-to-tile bindings",
      params: {},
    },
  );

  registerMethod(
    "claude.unbind",
    (params: unknown) => {
      const p = params as { tileId: string };
      if (!p.tileId || typeof p.tileId !== "string") {
        throw new Error("tileId is required");
      }
      const data = readData();
      delete data[p.tileId];
      writeData(data);
      return { ok: true };
    },
    {
      description: "Remove a Claude Code session binding for a tile",
      params: {
        tileId: "string (required)",
      },
    },
  );
}

/**
 * 为 terminal-tile webview 提供 IPC handler 以查询绑定
 */
export function registerClaudeIpc(): void {
  ipcMain.handle("claude:get-binding", (_event, tileId: string) => {
    if (!tileId || typeof tileId !== "string") return null;
    const data = readData();
    const entry = data[tileId];
    if (!entry) return null;
    const sessionId = typeof entry === "string" ? entry : entry.sessionId;
    const updatedAt = typeof entry === "string" ? 0 : entry.updatedAt;
    return { tileId, sessionId, updatedAt };
  });
}
