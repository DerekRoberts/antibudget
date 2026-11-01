import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApiContext, handleApiRequest } from "./api.js";
import { resolvePaths } from "./config.js";
import { openDatabase } from "./db.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
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

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Ensures data dirs exist and the SQLite file is reachable before listening. */
export function assertServePrerequisites(home?: string): void {
  const paths = resolvePaths({ home, createDirs: true });
  try {
    openDatabase(paths.dbPath).close();
  } catch {
    throw new Error(
      `Cannot open database at ${paths.dbPath}. Run "antibudget ingest" first.`,
    );
  }
}

export function createAntibudgetServer(options: ServeOptions = {}): ServeResult {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8080;
  const ctx = createApiContext({ home: options.home });

  const server = http.createServer((req, res) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", `http://${host}:${port}`);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad Request");
        return;
      }

      if (!isLoopbackHost(url.hostname)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      const method = req.method ?? "GET";

      if (url.pathname.startsWith("/api/")) {
        const { status, body } = await handleApiRequest(
          ctx,
          method,
          url.pathname,
          url.searchParams,
          req,
        );
        sendJson(res, status, body);
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

      let data: Buffer;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        data = await fs.readFile(filePath);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME[ext] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": data.length,
      });
      if (method === "HEAD") {
        res.end();
        return;
      }
      res.end(data);
    })().catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
  };
}

export function startAntibudgetServer(options: ServeOptions = {}): Promise<ServeResult> {
  assertServePrerequisites(options.home);
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
