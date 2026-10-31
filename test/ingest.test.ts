import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePaths } from "../src/config.js";
import { countTransactions, openDatabase } from "../src/db.js";
import { ingestOfxPaths, listOfxFiles } from "../src/ingest.js";
import { parseOfxContent, parseOfxFile, ofxAmountToCents } from "../src/ofx.js";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const fixturePath = path.join(repoRoot, "fixtures", "sample.ofx");

test("parseOfxFile extracts account, balance, and transactions", () => {
  const parsed = parseOfxFile(fixturePath);
  assert.equal(parsed.account.acctId, "checking-synth-001");
  assert.equal(parsed.account.ledgerBalanceCents, 152_344);
  assert.equal(parsed.transactions.length, 5);
  const amazon = parsed.transactions.find((t) => t.payee?.includes("AMAZON"));
  assert.ok(amazon);
  assert.equal(amazon.amountCents, -8999);
});

test("parseOfxFile handles OFX 2 XML exports", () => {
  const xmlFixture = path.join(repoRoot, "fixtures", "sample-v2.ofx");
  const parsed = parseOfxFile(xmlFixture);
  assert.equal(parsed.account.acctId, "card-synth-4242");
  assert.equal(parsed.account.ledgerBalanceCents, -31_550);
  assert.equal(parsed.transactions.length, 1);
  assert.equal(parsed.transactions[0].payee, "COFFEE SHOP");
});

test("ofxAmountToCents treats decimal comma as cents separator", () => {
  assert.equal(ofxAmountToCents("12,50"), 1250);
  assert.equal(ofxAmountToCents("-12,50"), -1250);
  assert.equal(ofxAmountToCents("1.234,56"), 123_456);
  assert.equal(ofxAmountToCents("1,234.56"), 123_456);
});

test("parseOfxContent rejects multiple ACCTID values", () => {
  assert.throws(
    () =>
      parseOfxContent(`<OFX><ACCTID>a</ACCTID><ACCTID>b</ACCTID></OFX>`),
    /multiple ACCTID/,
  );
});

test("ingest is idempotent when the same OFX is processed twice", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-test-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  const inboxFile = path.join(paths.inbox, "sample.ofx");
  fs.copyFileSync(fixturePath, inboxFile);

  openDatabase(paths.dbPath).close();

  const first = ingestOfxPaths({ paths });
  assert.equal(first.filesProcessed, 1);
  assert.equal(first.transactionsInserted, 5);
  assert.equal(first.transactionsSkipped, 0);
  assert.equal(listOfxFiles(paths.inbox).length, 0);
  assert.ok(fs.existsSync(path.join(paths.archive, "sample.ofx")));

  fs.copyFileSync(fixturePath, inboxFile);
  const db = openDatabase(paths.dbPath);
  assert.equal(countTransactions(db), 5);

  const second = ingestOfxPaths({ paths, db });
  db.close();

  assert.equal(second.filesProcessed, 1);
  assert.equal(second.transactionsInserted, 0);
  assert.equal(second.transactionsSkipped, 5);

  const dbCheck = openDatabase(paths.dbPath);
  assert.equal(countTransactions(dbCheck), 5);
  dbCheck.close();
});
