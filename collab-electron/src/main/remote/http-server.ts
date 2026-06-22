// src/main/remote/http-server.ts
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { verifyToken } from "./auth";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface HttpServerOptions {
  staticDir: string;
  token: string;
  wsPreloadPath: string;
}

export function createHttpServer(opts: HttpServerOptions): http.Server {
  const wsPreloadTag = `<script src="/__remote/ws-preload.js"></script>`;

  return http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    // WebSocket upgrade — let ws-server handle it
    if (url.pathname === "/__remote/ws") {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("WebSocket upgrade expected");
      return;
    }

    // Token check (skip for ws-preload itself)
    if (url.pathname !== "/__remote/ws-preload.js") {
      const tokenParam = url.searchParams.get("token");
      if (!tokenParam || !verifyToken(tokenParam, opts.token)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
    }

    // Route: ws-preload script
    if (url.pathname === "/__remote/ws-preload.js") {
      serveFile(res, opts.wsPreloadPath, "application/javascript; charset=utf-8");
      return;
    }

    // Route: static files
    let filePath = path.join(opts.staticDir, url.pathname);

    // SPA fallback: serve shell/index.html for unknown paths
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA paths (terminal-tile, viewer, etc.) — serve their index.html
      const indexPath = path.join(opts.staticDir, url.pathname, "index.html");
      if (fs.existsSync(indexPath)) {
        serveFile(res, indexPath, "text/html; charset=utf-8", wsPreloadTag);
        return;
      }
      // Root fallback: serve shell
      filePath = path.join(opts.staticDir, "shell/index.html");
      serveFile(res, filePath, "text/html; charset=utf-8", wsPreloadTag);
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    const inject = ext === ".html" ? wsPreloadTag : undefined;
    serveFile(res, filePath, contentType, inject);
  });
}

function serveFile(
  res: http.ServerResponse,
  filePath: string,
  contentType: string,
  wsPreloadTag?: string,
): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });

    // Inject ws-preload into HTML files for the remote bridge
    if (wsPreloadTag && contentType.startsWith("text/html")) {
      let html = content.toString("utf-8");
      html = html.replace("<head>", `<head>\n    ${wsPreloadTag}`);
      res.end(html);
    } else {
      res.end(content);
    }
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}
