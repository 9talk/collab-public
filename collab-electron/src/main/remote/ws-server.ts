// src/main/remote/ws-server.ts
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyToken } from "./auth";

type EventHandler = (client: WebSocket, type: string, data: unknown) => void;
type RPCHandler = (method: string, params: unknown) => Promise<unknown>;

export class RemoteWSServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private eventHandler: EventHandler | null = null;
  private rpcHandler: RPCHandler | null = null;
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  setEventHandler(handler: EventHandler): void {
    this.eventHandler = handler;
  }

  setRPCHandler(handler: RPCHandler): void {
    this.rpcHandler = handler;
  }

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({
      server,
      path: "/__remote/ws",
    });

    this.wss.on("connection", (ws, _req) => {
      const authTimeout = setTimeout(() => {
        ws.close(4001, "Auth timeout");
      }, 5000);

      const onFirstMessage = (data: Buffer) => {
        clearTimeout(authTimeout);
        ws.removeListener("message", onFirstMessage);

        let msg: { type?: string; token?: string };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          ws.close(4001, "Invalid auth message");
          return;
        }

        if (
          msg.type !== "auth" ||
          !msg.token ||
          !verifyToken(msg.token, this.token)
        ) {
          ws.close(4001, "Unauthorized");
          return;
        }

        this.clients.add(ws);

        ws.on("message", (raw) => {
          let parsed: { type?: string; id?: number; method?: string; params?: unknown; data?: unknown };
          try {
            parsed = JSON.parse(raw.toString());
          } catch {
            return;
          }

          // RPC request (has id + method)
          if (parsed.id !== undefined && parsed.method && this.rpcHandler) {
            this.rpcHandler(parsed.method, parsed.params ?? parsed.data)
              .then((result) => {
                ws.send(JSON.stringify({ id: parsed.id, result }));
              })
              .catch((err: Error) => {
                ws.send(JSON.stringify({ id: parsed.id, error: { message: err.message } }));
              });
            return;
          }

          // Server-push event (no id)
          if (this.eventHandler) {
            this.eventHandler(ws, parsed.type ?? parsed.method ?? "unknown", parsed.data ?? parsed);
          }
        });

        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", () => this.clients.delete(ws));

        ws.send(JSON.stringify({ type: "auth:ok" }));
      };

      ws.on("message", onFirstMessage);
    });
  }

  broadcast(type: string, data: unknown, exclude?: WebSocket): void {
    const msg = JSON.stringify({ type, data });
    for (const client of this.clients) {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  send(client: WebSocket, type: string, data: unknown): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type, data }));
    }
  }

  sendBinary(client: WebSocket, data: Buffer): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) {
      client.close(1001, "Server shutdown");
    }
    this.clients.clear();
    this.wss?.close();
  }
}
