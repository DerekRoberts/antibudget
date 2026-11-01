import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApiContext, handleApiRequest } from "../src/api.js";
import { resolvePaths } from "../src/config.js";
import { countTransactions, openDatabase } from "../src/db.js";
import { parseMultipartFiles } from "../src/upload.js";
import { startAntibudgetServer } from "../src/server.js";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const fixturePath = path.join(repoRoot, "fixtures", "sample.ofx");

function buildMultipart(
  boundary: string,
  files: { filename: string; content: Buffer }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    chunks.push(file.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

class MockIncomingMessage {
  headers: Record<string, string>;
  private readonly body: Buffer;
  private paused = false;
  private listeners: Record<string, ((chunk?: Buffer) => void)[]> = {};

  constructor(headers: Record<string, string>, body: Buffer) {
    this.headers = headers;
    this.body = body;
  }

  on(event: string, listener: (chunk?: Buffer) => void): this {
    this.listeners[event] ??= [];
    this.listeners[event].push(listener);
    if (event === "end" && !this.paused) {
      this.emitBody();
    }
    return this;
  }

  private emitBody(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    queueMicrotask(() => {
      for (const listener of this.listeners.data ?? []) {
        listener(this.body);
      }
      for (const listener of this.listeners.end ?? []) {
        listener();
      }
    });
  }

  removeAllListeners(event: string): this {
    delete this.listeners[event];
    return this;
  }

  resume(): this {
    this.emitBody();
    return this;
  }
}

test("parseMultipartFiles extracts filename and bytes", () => {
  const boundary = "test-boundary-123";
  const body = buildMultipart(boundary, [
    { filename: "a.ofx", content: Buffer.from("OFXHEADER:100") },
    { filename: "b.qfx", content: Buffer.from("second") },
  ]);
  const files = parseMultipartFiles(body, boundary);
  assert.equal(files.length, 2);
  assert.equal(files[0].filename, "a.ofx");
  assert.equal(files[1].filename, "b.qfx");
  assert.equal(files[0].data.toString(), "OFXHEADER:100");
});

test("POST /api/ingest/upload ingests fixture and archives under ANTIBUDGET_HOME", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-upload-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  openDatabase(paths.dbPath).close();

  const boundary = "upload-test";
  const ofxBytes = fs.readFileSync(fixturePath);
  const payload = buildMultipart(boundary, [{ filename: "sample.ofx", content: ofxBytes }]);
  const req = new MockIncomingMessage(
    {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
    },
    payload,
  );

  const ctx = createApiContext({ home: paths.home });
  const { status, body } = await handleApiRequest(
    ctx,
    "POST",
    "/api/ingest/upload",
    new URLSearchParams(),
    req as unknown as import("node:http").IncomingMessage,
  );

  assert.equal(status, 200);
  const result = body as {
    filesProcessed: number;
    transactionsInserted: number;
    transactionsSkipped: number;
  };
  assert.equal(result.filesProcessed, 1);
  assert.ok(result.transactionsInserted >= 1);

  const db = openDatabase(paths.dbPath);
  assert.ok(countTransactions(db) >= 1);
  db.close();
  assert.ok(fs.existsSync(path.join(paths.archive, "sample.ofx")));
});

test("POST /api/ingest/upload rejects non-OFX filenames", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-upload-reject-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  openDatabase(paths.dbPath).close();

  const boundary = "bad-file";
  const payload = buildMultipart(boundary, [
    { filename: "notes.txt", content: Buffer.from("hello") },
  ]);
  const req = new MockIncomingMessage(
    {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
    },
    payload,
  );

  const ctx = createApiContext({ home: paths.home });
  const { status, body } = await handleApiRequest(
    ctx,
    "POST",
    "/api/ingest/upload",
    new URLSearchParams(),
    req as unknown as import("node:http").IncomingMessage,
  );

  assert.equal(status, 400);
  assert.match((body as { error: string }).error, /\.ofx and \.qfx/);
});

test("POST /api/ingest/upload rejects cross-site browser requests", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-upload-csrf-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  openDatabase(paths.dbPath).close();

  const boundary = "csrf-test";
  const payload = buildMultipart(boundary, [
    { filename: "sample.ofx", content: Buffer.from("OFXHEADER:100") },
  ]);
  const req = new MockIncomingMessage(
    {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
      "sec-fetch-site": "cross-site",
      origin: "https://evil.example",
    },
    payload,
  );

  const ctx = createApiContext({ home: paths.home });
  const { status } = await handleApiRequest(
    ctx,
    "POST",
    "/api/ingest/upload",
    new URLSearchParams(),
    req as unknown as import("node:http").IncomingMessage,
  );

  assert.equal(status, 403);
});

test("upload via HTTP on running server updates ledger meta", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-upload-http-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  const started = await startAntibudgetServer({ home: paths.home, port: 0 });
  try {
    const metaBefore = await fetch(`${started.url}/api/ledger/meta`);
    assert.equal(metaBefore.status, 200);
    const before = (await metaBefore.json()) as { transactionCount: number };
    assert.equal(before.transactionCount, 0);

    const boundary = `----form${Date.now()}`;
    const ofxBytes = fs.readFileSync(fixturePath);
    const payload = buildMultipart(boundary, [{ filename: "sample.ofx", content: ofxBytes }]);
    const res = await fetch(`${started.url}/api/ingest/upload`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: new Uint8Array(payload),
    });
    assert.equal(res.status, 200);

    const metaAfter = await fetch(`${started.url}/api/ledger/meta`);
    const after = (await metaAfter.json()) as { transactionCount: number };
    assert.ok(after.transactionCount > before.transactionCount);
  } finally {
    await new Promise<void>((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
