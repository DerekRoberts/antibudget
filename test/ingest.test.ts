import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePaths } from "../src/config.js";
import { countTransactions, openDatabase } from "../src/db.js";
import { ingestOfxPaths, listOfxFiles, expandTilde, resolveIngestUserPath } from "../src/ingest.js";
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

test("expandTilde maps ~ and ~/ to the user home directory", () => {
  const home = os.homedir();
  assert.equal(expandTilde("~"), home);
  assert.equal(expandTilde("~/Documents"), path.join(home, "Documents"));
});

test("listOfxFiles ignores non-OFX files and matches extension case", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-list-ofx-"));
  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.copyFileSync(fixturePath, path.join(dir, "a.ofx"));
    fs.copyFileSync(fixturePath, path.join(dir, "b.QFX"));
    assert.deepEqual(listOfxFiles(dir), [
      path.join(dir, "a.ofx"),
      path.join(dir, "b.QFX"),
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listOfxFiles with recursive scans subdirectories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-list-rec-"));
  try {
    const nested = path.join(dir, "nested");
    fs.mkdirSync(nested);
    fs.copyFileSync(fixturePath, path.join(dir, "top.ofx"));
    fs.copyFileSync(fixturePath, path.join(nested, "deep.qfx"));
    assert.deepEqual(listOfxFiles(dir), [path.join(dir, "top.ofx")]);
    assert.deepEqual(listOfxFiles(dir, { recursive: true }).sort(), [
      path.join(dir, "top.ofx"),
      path.join(nested, "deep.qfx"),
    ].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ingest from a directory archives into ANTIBUDGET_HOME and clears the source dir", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-ingest-dir-"));
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-export-dir-"));
  try {
    const paths = resolvePaths({ home: tmpHome, createDirs: true });
    fs.copyFileSync(fixturePath, path.join(exportDir, "one.ofx"));
    fs.copyFileSync(fixturePath, path.join(exportDir, "two.qfx"));
    openDatabase(paths.dbPath).close();

    const result = ingestOfxPaths({ paths, sourcePath: exportDir });
    assert.equal(result.filesProcessed, 2);
    assert.equal(listOfxFiles(exportDir).length, 0);
    assert.ok(fs.existsSync(path.join(paths.archive, "one.ofx")));
    assert.ok(fs.existsSync(path.join(paths.archive, "two.qfx")));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});

test("ingest from a glob pattern resolves multiple files", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-ingest-glob-home-"));
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-ingest-glob-"));
  try {
    const paths = resolvePaths({ home: tmpHome, createDirs: true });
    fs.copyFileSync(fixturePath, path.join(exportDir, "a.ofx"));
    fs.copyFileSync(fixturePath, path.join(exportDir, "b.ofx"));
    fs.writeFileSync(path.join(exportDir, "skip.txt"), "");
    openDatabase(paths.dbPath).close();

    const pattern = resolveIngestUserPath(path.join(exportDir, "*.ofx"));
    const result = ingestOfxPaths({ paths, sourcePath: pattern });
    assert.equal(result.filesProcessed, 2);
    assert.equal(listOfxFiles(exportDir).length, 0);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});

test("ingest rejects missing explicit path", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-ingest-missing-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  assert.throws(
    () => ingestOfxPaths({ paths, sourcePath: path.join(tmpHome, "no-such.ofx") }),
    /Ingest path not found/,
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
