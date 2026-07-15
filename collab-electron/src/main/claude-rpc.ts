import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { COLLAB_DIR } from "./paths";
import { registerMethod } from "./json-rpc-server";

const DATA_FILE = join(COLLAB_DIR, "claude-tiles.json");

interface ClaudeTiles {
  [tileId: string]: string; // sessionId
}

function readData(): ClaudeTiles {
  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
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

export function registerClaudeRpc(): void {
  registerMethod(
    "claude.bind",
    (params: unknown) => {
      const p = params as { tileId: string; sessionId: string };
      if (!p.tileId || typeof p.tileId !== "string") {
        throw new Error("tileId is required");
      }
      if (!p.sessionId || typeof p.sessionId !== "string") {
        throw new Error("sessionId is required");
      }
      const data = readData();
      data[p.tileId] = p.sessionId;
      writeData(data);
      return { ok: true };
    },
    {
      description: "Bind a Claude Code session to a canvas tile",
      params: {
        tileId: "string (required)",
        sessionId: "string (required)",
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
      const sessionId = data[p.tileId] ?? null;
      return { tileId: p.tileId, sessionId };
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
      return readData();
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
