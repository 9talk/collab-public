// src/main/remote/ws-server.ts
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyToken } from "./auth";

type EventHandler = (client: WebSocket, type: string, data: unknown) => void;

export class RemoteWSServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private eventHandler: EventHandler | null = null;
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  setEventHandler(handler: EventHandler): void {
    this.eventHandler = handler;
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
          let parsed: { type?: string; id?: number; method?: string; data?: unknown };
          try {
            parsed = JSON.parse(raw.toString());
          } catch {
            return;
          }

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
