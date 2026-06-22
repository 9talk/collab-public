// src/main/remote/index.ts
import * as path from "node:path";
import { app } from "electron";
import { generateToken, getLocalIP } from "./auth";
import { createHttpServer } from "./http-server";
import { RemoteWSServer } from "./ws-server";
import type { AppConfig } from "../config";

export class RemoteServer {
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private wsServerInternal: RemoteWSServer | null = null;
  private token: string = "";
  private port: number = 9357;
  private started = false;

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

  async start(_config: AppConfig, _password: string, port?: number): Promise<void> {
    if (this.started) await this.stop();

    this.port = port ?? 9357;
    this.token = generateToken();

    const appPath = app.getAppPath();
    const rendererDir = path.join(appPath, "out", "renderer");
    const mainOutDir = path.join(appPath, "out", "main");

    this.wsServerInternal = new RemoteWSServer(this.token);

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
