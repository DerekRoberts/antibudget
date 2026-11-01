import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createApiContext,
  handleGetHistoryStatus,
  handleRedo,
  handleSetTransactionCategory,
  handleUndo,
} from "../src/api.js";
import { resolvePaths } from "../src/config.js";
import { countTransactions, listAllTransactions, openDatabase } from "../src/db.js";
import {
  getHistoryStatus,
  redoLedgerMutation,
  undoLedgerMutation,
} from "../src/history.js";
import { ingestOfxPaths } from "../src/ingest.js";
import { setManualTransactionCategoryInDb } from "../src/manual.js";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const fixturePath = path.join(repoRoot, "fixtures", "sample.ofx");

function setupHomeWithIngest(): ReturnType<typeof resolvePaths> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-history-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  fs.copyFileSync(fixturePath, path.join(paths.inbox, "sample.ofx"));
  openDatabase(paths.dbPath).close();
  ingestOfxPaths({ paths, recordHistory: true });
  return paths;
}

test("undo and redo manual category change", () => {
  const paths = setupHomeWithIngest();
  const db = openDatabase(paths.dbPath);
  const tx = listAllTransactions(db).find((t) => t.categoryId === null);
  assert.ok(tx);
  db.close();

  const ctx = createApiContext({ home: paths.home });
  handleSetTransactionCategory(ctx, {
    acctId: tx!.acctId,
    fitid: tx!.fitid,
    categoryName: "Test Category",
  });

  let status = handleGetHistoryStatus(ctx) as { canUndo: boolean; canRedo: boolean };
  assert.equal(status.canUndo, true);
  assert.equal(status.canRedo, false);

  const undo = handleUndo(ctx) as { applied: boolean; kind: string };
  assert.equal(undo.applied, true);
  assert.equal(undo.kind, "category");

  const dbAfterUndo = openDatabase(paths.dbPath);
  const row = listAllTransactions(dbAfterUndo).find((t) => t.fitid === tx!.fitid);
  assert.equal(row?.categoryName, null);
  assert.equal(row?.isManualOverride, false);
  dbAfterUndo.close();

  status = handleGetHistoryStatus(ctx) as { canUndo: boolean; canRedo: boolean };
  assert.equal(status.canRedo, true);

  const redo = handleRedo(ctx) as { applied: boolean };
  assert.equal(redo.applied, true);

  const dbAfterRedo = openDatabase(paths.dbPath);
  const row2 = listAllTransactions(dbAfterRedo).find((t) => t.fitid === tx!.fitid);
  assert.equal(row2?.categoryName, "Test Category");
  assert.equal(row2?.isManualOverride, true);
  dbAfterRedo.close();
});

test("undo ingest removes inserted transactions", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-history-ingest-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  fs.copyFileSync(fixturePath, path.join(paths.inbox, "sample.ofx"));
  openDatabase(paths.dbPath).close();
  ingestOfxPaths({ paths, recordHistory: true });
  assert.ok(countTransactions(openDatabase(paths.dbPath)) > 0);
  openDatabase(paths.dbPath).close();

  const db = openDatabase(paths.dbPath);
  const result = undoLedgerMutation(db);
  assert.equal(result.applied, true);
  assert.equal(result.kind, "ingest");
  assert.equal(countTransactions(db), 0);
  db.close();

  const db2 = openDatabase(paths.dbPath);
  const redo = redoLedgerMutation(db2);
  assert.equal(redo.applied, true);
  assert.ok(countTransactions(db2) > 0);
  db2.close();
});

test("undo ingest restores account ledger balance snapshot", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-history-bal-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  fs.copyFileSync(fixturePath, path.join(paths.inbox, "sample.ofx"));
  openDatabase(paths.dbPath).close();
  ingestOfxPaths({ paths, recordHistory: true });
  const db = openDatabase(paths.dbPath);
  const beforeUndo = db
    .prepare("SELECT ledger_balance_cents FROM accounts WHERE acct_id = ?")
    .get("checking-synth-001") as unknown as { ledger_balance_cents: number };
  undoLedgerMutation(db);
  const afterUndo = db
    .prepare("SELECT ledger_balance_cents FROM accounts WHERE acct_id = ?")
    .get("checking-synth-001") as unknown as { ledger_balance_cents: number | null };
  assert.equal(afterUndo.ledger_balance_cents, null);
  redoLedgerMutation(db);
  const afterRedo = db
    .prepare("SELECT ledger_balance_cents FROM accounts WHERE acct_id = ?")
    .get("checking-synth-001") as unknown as { ledger_balance_cents: number };
  assert.equal(afterRedo.ledger_balance_cents, beforeUndo.ledger_balance_cents);
  db.close();
});

test("new mutation after undo-all clears abandoned history branch", () => {
  const paths = setupHomeWithIngest();
  const db = openDatabase(paths.dbPath);
  const txs = listAllTransactions(db).filter((t) => t.categoryId === null);
  assert.ok(txs.length >= 2);
  setManualTransactionCategoryInDb(db, {
    acctId: txs[0].acctId,
    fitid: txs[0].fitid,
    categoryName: "A",
  });
  setManualTransactionCategoryInDb(db, {
    acctId: txs[1].acctId,
    fitid: txs[1].fitid,
    categoryName: "B",
  });
  undoLedgerMutation(db);
  undoLedgerMutation(db);
  assert.equal(getHistoryStatus(db).canRedo, true);
  setManualTransactionCategoryInDb(db, {
    acctId: txs[0].acctId,
    fitid: txs[0].fitid,
    categoryName: "C",
  });
  assert.equal(getHistoryStatus(db).canRedo, false);
  const undo = undoLedgerMutation(db);
  assert.equal(undo.applied, true);
  assert.equal(undo.kind, "category");
  const rowB = listAllTransactions(db).find((t) => t.fitid === txs[1].fitid);
  assert.equal(rowB?.categoryName, null);
  db.close();
});

test("new mutation clears redo branch", () => {
  const paths = setupHomeWithIngest();
  const db = openDatabase(paths.dbPath);
  const txs = listAllTransactions(db).filter((t) => t.categoryId === null);
  assert.ok(txs.length >= 2);
  setManualTransactionCategoryInDb(db, {
    acctId: txs[0].acctId,
    fitid: txs[0].fitid,
    categoryName: "A",
  });
  setManualTransactionCategoryInDb(db, {
    acctId: txs[1].acctId,
    fitid: txs[1].fitid,
    categoryName: "B",
  });
  undoLedgerMutation(db);
  assert.equal(getHistoryStatus(db).canRedo, true);
  setManualTransactionCategoryInDb(db, {
    acctId: txs[0].acctId,
    fitid: txs[0].fitid,
    categoryName: "C",
  });
  assert.equal(getHistoryStatus(db).canRedo, false);
  db.close();
});
