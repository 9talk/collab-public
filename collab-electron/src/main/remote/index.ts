// src/main/remote/index.ts
import * as path from "node:path";
import { app } from "electron";
import { generateToken, getLocalIP } from "./auth";
import { createHttpServer } from "./http-server";
import { RemoteWSServer } from "./ws-server";
import type { AppConfig } from "../config";
import { handleRemoteRPC } from "./rpc-bridge";

export class RemoteServer {
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private wsServerInternal: RemoteWSServer | null = null;
  private token: string = "";
  private port: number = 9357;
  private started = false;
  private canvasState: unknown = null;
  private tokenGeneratedAt: number = 0;

  get wsServer(): RemoteWSServer | null {
    return this.wsServerInternal;
  }

  getConnectionURL(): string {
    return `http://${getLocalIP()}:${this.port}/?token=${this.token}`;
  }

  getToken(): string {
    return this.token;
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.started;
  }

  isTokenExpired(expiryHours: number): boolean {
    if (expiryHours <= 0 || this.tokenGeneratedAt === 0) return false;
    return Date.now() - this.tokenGeneratedAt > expiryHours * 3600_000;
  }

  getCanvasState(): unknown {
    return this.canvasState;
  }

  setCanvasState(state: unknown): void {
    this.canvasState = state;
  }

  broadcastCanvasState(state: unknown): void {
    this.wsServerInternal?.broadcast("canvas:stateChanged", state);
  }

  broadcastPTYData(sessionId: string, data: string): void {
    this.wsServerInternal?.broadcast(`pty:data:${sessionId}`, {
      sessionId,
      data,
    });
  }

  async start(config: AppConfig, port?: number, forceNewToken = false): Promise<void> {
    if (this.started) await this.stop();

    this.port = port ?? 9357;

    // Load persisted token unless explicitly rotating
    const persistedToken = !forceNewToken
      ? (config.ui["remote.token"] as string | undefined)
      : undefined;
    if (persistedToken && typeof persistedToken === "string" && persistedToken.length === 64) {
      this.token = persistedToken;
      this.tokenGeneratedAt = (config.ui["remote.tokenGeneratedAt"] as number) || Date.now();
    } else {
      this.token = generateToken();
      this.tokenGeneratedAt = Date.now();
      config.ui["remote.token"] = this.token;
      config.ui["remote.tokenGeneratedAt"] = this.tokenGeneratedAt;
      const { saveConfig } = require("../config");
      saveConfig(config);
    }

    const appPath = app.getAppPath();
    const rendererDir = path.join(appPath, "out", "renderer");
    const mainOutDir = path.join(appPath, "out", "main");

    this.wsServerInternal = new RemoteWSServer(this.token);
    this.wsServerInternal.setRPCHandler(handleRemoteRPC);

    this.httpServer = createHttpServer({
      staticDir: rendererDir,
      token: this.token,
      wsPreloadPath: path.join(mainOutDir, "ws-preload.js"),
    });

    this.wsServerInternal.attach(this.httpServer);

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, () => resolve());
      this.httpServer!.on("error", reject);
    });

    this.started = true;
  }

  async rotateToken(config: AppConfig): Promise<string> {
    const port = this.port;
    await this.stop();
    await this.start(config, port, true);
    return this.getConnectionURL();
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    this.wsServerInternal?.close();
    this.wsServerInternal = null;

    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }

    this.started = false;
  }
}

let instance: RemoteServer | null = null;

export function getRemoteServer(): RemoteServer {
  if (!instance) instance = new RemoteServer();
  return instance;
}
