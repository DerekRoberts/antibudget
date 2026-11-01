import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApiContext, handleApiRequest } from "./api.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface ServeOptions {
  host?: string;
  port?: number;
  home?: string;
}

export interface ServeResult {
  server: http.Server;
  host: string;
  port: number;
  url: string;
}

function staticRootDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static");
}

function resolveStaticPath(urlPath: string): string | null {
  const root = staticRootDir();
  let rel = urlPath;
  if (rel === "/" || rel === "") {
    rel = "/index.html";
  }
  if (rel === "/triage") {
    rel = "/triage.html";
  }
  if (rel === "/reflection") {
    rel = "/reflection.html";
  }
  if (!rel.startsWith("/")) {
    return null;
  }
  const filePath = path.normalize(path.join(root, rel.slice(1)));
  if (!filePath.startsWith(root)) {
    return null;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return null;
  }
  return filePath;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createAntibudgetServer(options: ServeOptions = {}): ServeResult {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8080;
  const ctx = createApiContext({ home: options.home });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const method = req.method ?? "GET";

    if (url.pathname.startsWith("/api/")) {
      void handleApiRequest(ctx, method, url.pathname, url.searchParams, req).then(
        ({ status, body }) => {
          sendJson(res, status, body);
        },
      );
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.length,
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    res.end(data);
  });

  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
  };
}

export function startAntibudgetServer(options: ServeOptions = {}): Promise<ServeResult> {
  const created = createAntibudgetServer(options);
  return new Promise((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(created.port, created.host, () => {
      created.server.removeListener("error", reject);
      const addr = created.server.address();
      if (addr && typeof addr === "object") {
        created.port = addr.port;
        created.url = `http://${created.host}:${created.port}`;
      }
      resolve(created);
    });
  });
}
