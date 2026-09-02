import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLLAB_DIR } from "./paths";
import {
  cleanupEndpoint,
  makeEndpointPath,
  prepareEndpoint,
} from "./ipc-endpoint";
import { registerTodosRpc } from "./todos-rpc";
import { registerClaudeRpc } from "./claude-rpc";
import { registerServiceRpc } from "./service-rpc";

const SOCKET_PATH = makeEndpointPath("ipc");
// Write the breadcrumb to COLLAB_DIR (instance-isolated in dev worktrees so
// multiple instances on one machine never clobber each other) so the hook
// script can discover the socket in both dev and prod mode.
const SOCKET_PATH_FILE = join(COLLAB_DIR, "socket-path");
const NODE_PATH_FILE = join(COLLAB_DIR, "node-path");

type MethodHandler = (params: unknown) => unknown | Promise<unknown>;

interface MethodEntry {
  handler: MethodHandler;
  description: string;
  params?: Record<string, string>;
}

interface MethodInfo {
  name: string;
  description: string;
  params?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type CallResult =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string };

export interface MethodTable {
  register(
    method: string,
    handler: MethodHandler,
    meta?: { description?: string; params?: Record<string, string> },
  ): void;
  call(method: string, params: unknown): Promise<CallResult>;
  handleMessage(raw: string): Promise<JsonRpcResponse | null>;
  discover(): MethodInfo[];
  has(method: string): boolean;
}

export function createMethodTable(): MethodTable {
  const methods = new Map<string, MethodEntry>();

  function discover(): MethodInfo[] {
    return [...methods.entries()].map(([name, entry]) => ({
      name,
      description: entry.description,
      ...(entry.params ? { params: entry.params } : {}),
    }));
  }

  function register(
    method: string,
    handler: MethodHandler,
    meta?: { description?: string; params?: Record<string, string> },
  ): void {
    methods.set(method, {
      handler,
      description: meta?.description ?? "",
      ...(meta?.params ? { params: meta.params } : {}),
    });
  }

  async function call(method: string, params: unknown): Promise<CallResult> {
    const entry = methods.get(method);
    if (!entry) {
      return {
        ok: false,
        code: -32601,
        message: `Method not found: ${method}`,
      };
    }
    try {
      const result = await entry.handler(params);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: -32000, message };
    }
  }

  function isJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
    if (typeof obj !== "object" || obj === null) return false;
    const rec = obj as Record<string, unknown>;
    return (
      rec.jsonrpc === "2.0" &&
      (typeof rec.id === "number" || typeof rec.id === "string") &&
      typeof rec.method === "string"
    );
  }

  async function handleMessage(raw: string): Promise<JsonRpcResponse | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
    }

    if (!isJsonRpcRequest(parsed)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      };
    }

    const result = await call(parsed.method, parsed.params);
    if (result.ok) {
      return { jsonrpc: "2.0", id: parsed.id, result: result.result };
    }
    return {
      jsonrpc: "2.0",
      id: parsed.id,
      error: { code: result.code, message: result.message },
    };
  }

  return {
    register,
    call,
    handleMessage,
    discover,
    has: (m) => methods.has(m),
  };
}

const localTable = createMethodTable();

/** Register a method on the local Unix-socket JSON-RPC server. */
export function registerMethod(
  method: string,
  handler: MethodHandler,
  meta?: { description?: string; params?: Record<string, string> },
): void {
  localTable.register(method, handler, meta);
}

let server: Server | null = null;
const connections = new Set<Socket>();

function handleConnection(socket: Socket): void {
  connections.add(socket);
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();

    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length > 0) {
        void localTable.handleMessage(line).then((response) => {
          if (response && !socket.destroyed) {
            socket.write(JSON.stringify(response) + "\n");
          }
        });
      }

      newlineIdx = buffer.indexOf("\n");
    }
  });

  socket.on("close", () => {
    connections.delete(socket);
  });

  socket.on("error", (err) => {
    console.error("[json-rpc] Socket error:", err.message);
    connections.delete(socket);
  });
}

export function startJsonRpcServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    prepareEndpoint(SOCKET_PATH);
    mkdirSync(COLLAB_DIR, { recursive: true });

    server = createServer(handleConnection);

    server.on("error", (err) => {
      console.error("[json-rpc] Server error:", err.message);
      reject(err);
    });

    registerMethod("rpc.discover", () => ({ methods: localTable.discover() }), {
      description: "List all available RPC methods",
    });

    registerTodosRpc();
    registerClaudeRpc();
    registerServiceRpc();

    server.listen(SOCKET_PATH, () => {
      writeFileSync(SOCKET_PATH_FILE, SOCKET_PATH, "utf-8");
      writeFileSync(NODE_PATH_FILE, process.execPath, "utf-8");
      console.log(`[json-rpc] Listening on ${SOCKET_PATH}`);
      resolve();
    });
  });
}

export function stopJsonRpcServer(): void {
  for (const socket of connections) {
    socket.destroy();
  }
  connections.clear();

  if (server) {
    server.close();
    server = null;
  }

  cleanupEndpoint(SOCKET_PATH);

  for (const f of [SOCKET_PATH_FILE, NODE_PATH_FILE]) {
    try {
      unlinkSync(f);
    } catch {
      // File already gone
    }
  }
}
