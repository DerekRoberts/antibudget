import fs from "node:fs";
import { globSync } from "node:fs";
import os from "node:os";
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
import { loadRules, type RulesFile } from "./rules.js";

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
  /** When ingesting a directory, include OFX/QFX in subdirectories (default: false). */
  recursive?: boolean;
}

const OFX_EXTENSIONS = new Set([".ofx", ".qfx"]);

/** Expands a leading `~` or `~/` to the user home directory. */
export function expandTilde(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function pathContainsGlob(raw: string): boolean {
  if (raw.includes("*") || raw.includes("?") || raw.includes("{")) {
    return true;
  }
  const open = raw.indexOf("[");
  if (open === -1) {
    return false;
  }
  return raw.indexOf("]", open + 1) !== -1;
}

/** Resolves CLI ingest paths: tilde expansion, then absolute path (non-glob). */
export function resolveIngestUserPath(raw: string): string {
  const expanded = expandTilde(raw);
  const resolved = path.resolve(expanded);
  if (pathContainsGlob(expanded) && !fs.existsSync(resolved)) {
    return expanded;
  }
  return resolved;
}

function isOfxExtension(filePath: string): boolean {
  return OFX_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isRegularOfxFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() && isOfxExtension(filePath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function listOfxFiles(dir: string, options?: { recursive?: boolean }): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  if (options?.recursive) {
    return globSync("**/*", { cwd: dir })
      .map((rel) => path.join(dir, rel))
      .filter((filePath) => isRegularOfxFile(filePath))
      .sort();
  }
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((filePath) => isRegularOfxFile(filePath))
    .sort();
}

function listOfxFilesFromGlobPattern(pattern: string): string[] {
  const expanded = expandTilde(pattern);
  const matches = path.isAbsolute(expanded)
    ? globSync(expanded)
    : globSync(expanded, { cwd: process.cwd() });
  const baseDir = path.isAbsolute(expanded) ? undefined : process.cwd();
  return matches
    .map((match) => (baseDir ? path.resolve(baseDir, match) : path.resolve(match)))
    .filter((filePath) => isRegularOfxFile(filePath))
    .sort();
}

export function ingestOfxPaths(options: IngestOptions = {}): IngestResult {
  const paths = options.paths ?? resolvePaths({ createDirs: true });
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase(paths.dbPath);

  try {
    const files = resolveIngestFiles(paths, options.sourcePath, options.recursive);
    const rulesFile: RulesFile | undefined = fs.existsSync(paths.rulesPath)
      ? loadRules(paths)
      : undefined;
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

    if (files.length > 0 && rulesFile) {
      categorizeTransactions({ paths, db, rules: rulesFile });
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

function resolveIngestFiles(
  paths: AntibudgetPaths,
  sourcePath?: string,
  recursive?: boolean,
): string[] {
  if (!sourcePath) {
    return listOfxFiles(paths.inbox);
  }
  const resolved = path.resolve(expandTilde(sourcePath));
  if (pathContainsGlob(sourcePath) && !fs.existsSync(resolved)) {
    return listOfxFilesFromGlobPattern(sourcePath);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Ingest path not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return listOfxFiles(resolved, { recursive: recursive === true });
  }
  if (!isOfxExtension(resolved)) {
    throw new Error(
      `Ingest path is not an OFX/QFX file: ${resolved} (expected .ofx or .qfx)`,
    );
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
