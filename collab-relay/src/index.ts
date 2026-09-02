import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseFrame, isPassthroughFrame, decodePtyBinary, type RelayFrame } from "./protocol";
import { Rooms, type Peer } from "./rooms";
import { loadState, saveState } from "./persistence";

const HEARTBEAT_INTERVAL_MS = 30_000;
const PERSIST_INTERVAL_MS = 30_000;

interface Options {
  port: number;
  tokens: Set<string>;
  persistDir: string | null;
  tlsKey?: string;
  tlsCert?: string;
  maxClients?: number;
}

function parseTokens(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function parseArgs(argv: string[]): Options {
  // 环境变量作为默认值（容器内用 env 指定参数），显式 CLI 参数优先
  let port = Number(process.env.RELAY_PORT ?? 8787);
  let tokens = parseTokens(process.env.RELAY_DEVICE_TOKENS);
  let persistDir: string | null =
    process.env.RELAY_NO_PERSIST === "1" || process.env.RELAY_NO_PERSIST === "true"
      ? null
      : (process.env.RELAY_PERSIST_DIR ?? "data");
  let tlsKey: string | undefined = process.env.RELAY_TLS_KEY || undefined;
  let tlsCert: string | undefined = process.env.RELAY_TLS_CERT || undefined;
  let maxClients = Number(process.env.RELAY_MAX_CLIENTS ?? 1);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case "--port":
        port = Number(next() ?? 8787);
        break;
      case "--token":
      case "--tokens":
        tokens = parseTokens(next());
        break;
      case "--no-persist":
        persistDir = null;
        break;
      case "--persist-dir":
        persistDir = next() ?? "data";
        break;
      case "--tls-key":
        tlsKey = next();
        break;
      case "--tls-cert":
        tlsCert = next();
        break;
      case "--max-clients":
        maxClients = Number(next() ?? 1);
        break;
      case "--help":
      case "-h":
        console.log(
          `Usage: bun run src/index.ts [--port 8787] [--token t1,t2] [--no-persist] [--persist-dir DIR] [--tls-key FILE --tls-cert FILE] [--max-clients N]`,
        );
        console.log(
          `Env:   RELAY_PORT RELAY_DEVICE_TOKENS RELAY_PERSIST_DIR RELAY_NO_PERSIST RELAY_TLS_KEY RELAY_TLS_CERT RELAY_MAX_CLIENTS`,
        );
        process.exit(0);
        break;
    }
  }
  return { port, tokens, persistDir, tlsKey, tlsCert, maxClients };
}

function deviceIdOfToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function startRelay(opts: Options): WebSocketServer {
  const rooms = new Rooms({ maxClients: opts.maxClients });
  const isAlive = new Map<WebSocket, boolean>();

  if (opts.persistDir) {
    const state = loadState(opts.persistDir);
    console.log(
      `[relay] loaded state codes=${state?.codes.length ?? 0} rooms=${state?.rooms.length ?? 0}`,
    );
    if (state) rooms.restore(state);
  }

  const heartbeat = setInterval(() => {
    for (const ws of isAlive.keys()) {
      if (!isAlive.get(ws)) {
        console.log("[relay] heartbeat timeout, closing connection");
        rooms.drop(ws, "timeout");
        ws.terminate();
        isAlive.delete(ws);
        continue;
      }
      isAlive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const persistTimer =
    opts.persistDir !== null
      ? setInterval(() => {
          saveState(opts.persistDir, rooms.snapshot());
        }, PERSIST_INTERVAL_MS)
      : null;

  // 配对码/房间等关键状态变化时立即落盘，避免 relay 崩溃后配对码丢失
  const persistNow = (): void => {
    if (opts.persistDir !== null) {
      saveState(opts.persistDir, rooms.snapshot());
    }
  };

  const server =
    opts.tlsKey && opts.tlsCert
      ? createHttpsServer({
          key: readFileSync(opts.tlsKey),
          cert: readFileSync(opts.tlsCert),
        })
      : createHttpServer();

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    isAlive.set(ws, true);
    ws.on("pong", () => isAlive.set(ws, true));
    ws.on("error", (err) => {
      console.error("[relay] ws error:", err.message);
      ws.close();
    });
    ws.on("close", () => {
      isAlive.delete(ws);
      rooms.drop(ws, "peer-close");
      persistNow();
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const peer = rooms.getPeer(ws);
        if (!peer) return;
        const peerWs = rooms.peerOf(ws);
        if (!peerWs) return;
        const decoded = decodePtyBinary(Buffer.from(data as Buffer));
        if (decoded) {
          console.log(
            `[relay] pty-data ${peer.role}=${peer.deviceId} session=${decoded.sessionId} bytes=${decoded.payload.length}`,
          );
        }
        peerWs.send(data as Buffer);
        return;
      }

      const raw = data.toString();
      const frame = parseFrame(raw);
      if (!frame) {
        console.log("[relay] malformed frame, closing");
        ws.send(
          JSON.stringify({
            v: 1,
            type: "auth-error",
            code: "malformed",
            message: "malformed frame",
          }),
        );
        ws.close();
        return;
      }

      const peer = rooms.getPeer(ws);

      if (!peer) {
        handleAuth(ws, frame);
        return;
      }

      if (frame.type === "pair-create") {
        if (peer.role !== "host") return;
        const { code, ttlSec } = rooms.createPairCode(peer.deviceId);
        console.log(`[relay] pair-created code=${code} host=${peer.deviceId}`);
        ws.send(JSON.stringify({ v: 1, type: "pair-created", code, ttlSec }));
        persistNow();
        return;
      }

      if (isPassthroughFrame(frame)) {
        const peerWs = rooms.peerOf(ws);
        if (!peerWs) return;
        if (frame.type === "rpc") {
          console.log(`[relay] rpc ${peer.role}=${peer.deviceId} method=${frame.method}`);
        }
        peerWs.send(raw);
        return;
      }
    });
  });

  function handleAuth(ws: WebSocket, frame: RelayFrame): void {
    if (frame.type !== "auth") {
      ws.send(
        JSON.stringify({
          v: 1,
          type: "auth-error",
          code: "malformed",
          message: "first message must be auth",
        }),
      );
      ws.close();
      return;
    }
    if (frame.role === "host") {
      const token = frame.deviceToken ?? "";
      if (!opts.tokens.has(token)) {
        console.log("[relay] auth failed: invalid device token");
        ws.send(
          JSON.stringify({
            v: 1,
            type: "auth-error",
            code: "invalid-token",
            message: "invalid device token",
          }),
        );
        ws.close();
        return;
      }
      const deviceId = deviceIdOfToken(token);
      rooms.registerHost({
        ws,
        deviceId,
        role: "host",
        displayName: frame.deviceName,
      });
      persistNow();
      console.log(
        `[relay] host registered deviceId=${deviceId} displayName=${frame.deviceName ?? "-"}`,
      );
      ws.send(
        JSON.stringify({
          v: 1,
          type: "auth-ok",
          deviceId,
          role: "host",
          displayName: frame.deviceName,
        }),
      );
      return;
    }
    if (frame.role === "client") {
      const code = frame.pairCode ?? "";
      if (rooms.isCodeLocked(code)) {
        ws.send(
          JSON.stringify({
            v: 1,
            type: "auth-error",
            code: "pair-code-expired",
            message: "pair code locked",
          }),
        );
        ws.close();
        return;
      }
      const client: Peer = {
        ws,
        deviceId: `client-${Math.random().toString(36).slice(2, 10)}`,
        role: "client",
        displayName: frame.deviceName,
      };
      const joined = rooms.join(code, client);
      if (!joined.ok) {
        console.log(`[relay] auth failed: ${joined.code}`);
        ws.send(
          JSON.stringify({
            v: 1,
            type: "auth-error",
            code: joined.code,
            message: joined.code,
          }),
        );
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          v: 1,
          type: "auth-ok",
          deviceId: client.deviceId,
          role: "client",
          displayName: frame.deviceName,
        }),
      );
      console.log(`[relay] paired client=${client.deviceId} host=${joined.host.deviceId}`);
      persistNow();
      const toClient = {
        v: 1,
        type: "peer-connected",
        peer: {
          role: "host",
          deviceId: joined.host.deviceId,
          displayName: joined.host.displayName,
        },
      };
      const toHost = {
        v: 1,
        type: "peer-connected",
        peer: {
          role: "client",
          deviceId: client.deviceId,
          displayName: client.displayName,
        },
      };
      ws.send(JSON.stringify(toClient));
      if (joined.host.ws.readyState === joined.host.ws.OPEN) {
        joined.host.ws.send(JSON.stringify(toHost));
      }
      return;
    }
    ws.send(
      JSON.stringify({
        v: 1,
        type: "auth-error",
        code: "malformed",
        message: "unknown role",
      }),
    );
    ws.close();
  }

  server.listen(opts.port, () => {
    console.log(`[relay] listening on :${opts.port}`);
    if (opts.persistDir) {
      console.log(`[relay] persistence dir: ${opts.persistDir}`);
    }
    if (opts.tokens.size === 0) {
      console.warn("[relay] WARNING: no device tokens configured (--token)");
    }
  });

  wss.on("error", (err) => {
    console.error("[relay] server error:", err.message);
  });

  wss.on("close", () => {
    clearInterval(heartbeat);
    if (persistTimer) clearInterval(persistTimer);
  });

  return wss;
}

// CLI entry
if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  const wss = startRelay(opts);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[relay] shutting down");
    for (const client of wss.clients) {
      client.send(
        JSON.stringify({ v: 1, type: "peer-disconnected", reason: "relay-shutdown" }),
      );
      client.close();
    }
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
