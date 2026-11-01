import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ApiError,
  createApiContext,
  handleGetCashflowReport,
  handleGetUncategorized,
  handleSetTransactionCategory,
} from "../src/api.js";
import { resolvePaths } from "../src/config.js";
import { listAllTransactions, listCategories, openDatabase } from "../src/db.js";
import { ingestOfxPaths } from "../src/ingest.js";
import { startAntibudgetServer } from "../src/server.js";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const fixturePath = path.join(repoRoot, "fixtures", "sample.ofx");

function setupHomeWithoutRules(): ReturnType<typeof resolvePaths> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-m3-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  fs.copyFileSync(fixturePath, path.join(paths.inbox, "sample.ofx"));
  openDatabase(paths.dbPath).close();
  ingestOfxPaths({ paths });
  return paths;
}

test("startAntibudgetServer rejects empty database", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-m3-empty-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  openDatabase(paths.dbPath).close();
  await assert.rejects(
    () => startAntibudgetServer({ home: paths.home, port: 0 }),
    /ingest/,
  );
});

test("startAntibudgetServer binds localhost and serves triage page", async () => {
  const paths = setupHomeWithoutRules();
  const started = await startAntibudgetServer({ home: paths.home, port: 0 });
  try {
    assert.equal(started.host, "127.0.0.1");
    const res = await fetch(`${started.url}/triage`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Quick Triage/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("API set category sets is_manual_override", () => {
  const paths = setupHomeWithoutRules();
  const ctx = createApiContext({ home: paths.home });
  const uncategorized = handleGetUncategorized(ctx, new URLSearchParams()) as {
    transactions: { acctId: string; fitid: string }[];
  };
  assert.ok(uncategorized.transactions.length >= 1);
  const tx = uncategorized.transactions[0];
  handleSetTransactionCategory(ctx, {
    acctId: tx.acctId,
    fitid: tx.fitid,
    categoryName: "Web Triage",
  });
  const db = openDatabase(paths.dbPath);
  const row = listAllTransactions(db).find((t) => t.fitid === tx.fitid);
  assert.equal(row?.categoryName, "Web Triage");
  assert.equal(row?.isManualOverride, true);
  db.close();
});

test("API cashflow report returns monthly series", () => {
  const paths = setupHomeWithoutRules();
  const ctx = createApiContext({ home: paths.home });
  const report = handleGetCashflowReport(ctx) as {
    rows: { month: string; incomeCents: number }[];
  };
  assert.ok(report.rows.length >= 1);
  assert.ok(report.rows.some((r) => r.incomeCents > 0));
});

test("uncategorized payee filter matches AMAZON", () => {
  const paths = setupHomeWithoutRules();
  const ctx = createApiContext({ home: paths.home });
  const filtered = handleGetUncategorized(ctx, new URLSearchParams({ payee: "amazon" })) as {
    transactions: { payee: string | null }[];
  };
  assert.equal(filtered.transactions.length, 1);
  assert.match(filtered.transactions[0].payee ?? "", /AMAZON/i);
});

test("set category on missing transaction does not create category", () => {
  const paths = setupHomeWithoutRules();
  const ctx = createApiContext({ home: paths.home });
  try {
    handleSetTransactionCategory(ctx, {
      acctId: "checking-synth-001",
      fitid: "no-such-fitid",
      categoryName: "Orphan",
    });
    assert.fail("expected ApiError");
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
  }
  const db = openDatabase(paths.dbPath);
  assert.equal(listCategories(db).some((c) => c.name === "Orphan"), false);
  db.close();
});
