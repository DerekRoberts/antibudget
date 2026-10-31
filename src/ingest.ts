import fs from "node:fs";
import path from "node:path";

import { categorizeTransactions } from "./categorize.js";
import { resolvePaths, type AntibudgetPaths } from "./config.js";
import {
  countTransactions,
  insertTransactionIgnore,
  openDatabase,
  runInTransaction,
  upsertAccount,
  type AntibudgetDb,
} from "./db.js";
import { parseOfxFile, type ParsedOfxStatement } from "./ofx.js";

export interface IngestResult {
  filesProcessed: number;
  transactionsInserted: number;
  transactionsSkipped: number;
}

export interface IngestOptions {
  paths?: AntibudgetPaths;
  db?: AntibudgetDb;
  /** When set, ingest only this file or directory instead of inbox. */
  sourcePath?: string;
}

const OFX_EXTENSIONS = new Set([".ofx", ".qfx"]);

export function listOfxFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => OFX_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(dir, name))
    .sort();
}

export function ingestOfxPaths(options: IngestOptions = {}): IngestResult {
  const paths = options.paths ?? resolvePaths({ createDirs: true });
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase(paths.dbPath);

  try {
    const files = resolveIngestFiles(paths, options.sourcePath);
    let transactionsInserted = 0;
    let transactionsSkipped = 0;

    for (const filePath of files) {
      const parsed = parseOfxFile(filePath);
      const before = countTransactions(db);
      ingestParsedStatement(db, parsed);
      const after = countTransactions(db);
      const inserted = after - before;
      transactionsInserted += inserted;
      transactionsSkipped += parsed.transactions.length - inserted;

      archiveFile(filePath, paths.archive);
    }

    if (files.length > 0) {
      categorizeTransactions({ paths, db });
    }

    return {
      filesProcessed: files.length,
      transactionsInserted,
      transactionsSkipped,
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}

function resolveIngestFiles(paths: AntibudgetPaths, sourcePath?: string): string[] {
  if (!sourcePath) {
    return listOfxFiles(paths.inbox);
  }
  const resolved = path.resolve(sourcePath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return listOfxFiles(resolved);
  }
  return [resolved];
}

function ingestParsedStatement(db: AntibudgetDb, parsed: ParsedOfxStatement): void {
  runInTransaction(db, () => {
    const account = upsertAccount(
      db,
      parsed.account.acctId,
      parsed.account.ledgerBalanceCents,
    );

    for (const tx of parsed.transactions) {
      insertTransactionIgnore(db, {
        accountId: account.id,
        fitid: tx.fitid,
        amountCents: tx.amountCents,
        postedAt: tx.postedAt,
        payee: tx.payee,
        memo: tx.memo,
      });
    }
  });
}

function archiveFile(filePath: string, archiveDir: string): void {
  fs.mkdirSync(archiveDir, { recursive: true });
  const base = path.basename(filePath);
  const dest = uniqueArchivePath(archiveDir, base);
  try {
    fs.renameSync(filePath, dest);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
  }
}

function uniqueArchivePath(archiveDir: string, baseName: string): string {
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let candidate = path.join(archiveDir, baseName);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(archiveDir, `${stem}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}
