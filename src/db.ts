import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  acct_id TEXT NOT NULL UNIQUE,
  name TEXT,
  ledger_balance_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS transactions (
  account_id INTEGER NOT NULL,
  fitid TEXT NOT NULL,
  fitid_hash TEXT,
  amount_cents INTEGER NOT NULL,
  posted_at TEXT NOT NULL,
  payee TEXT,
  memo TEXT,
  category_id INTEGER,
  is_manual_override INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_override IN (0, 1)),
  is_transfer INTEGER NOT NULL DEFAULT 0 CHECK (is_transfer IN (0, 1)),
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, fitid),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_posted_at ON transactions (posted_at);

CREATE TABLE IF NOT EXISTS ledger_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'ingest')),
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_history_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor_id INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO ledger_history_cursor (singleton, cursor_id) VALUES (1, 0);
`;

export type AntibudgetDb = DatabaseSync;

export function openDatabase(dbPath: string): AntibudgetDb {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  return db;
}

export interface AccountRow {
  id: number;
  acct_id: string;
}

export function upsertAccount(
  db: AntibudgetDb,
  acctId: string,
  ledgerBalanceCents: number | null,
): AccountRow {
  const find = db.prepare("SELECT id, acct_id FROM accounts WHERE acct_id = ?");
  const existing = find.get(acctId) as unknown as AccountRow | undefined;
  if (existing) {
    if (ledgerBalanceCents !== null) {
      db.prepare("UPDATE accounts SET ledger_balance_cents = ? WHERE id = ?").run(
        ledgerBalanceCents,
        existing.id,
      );
    }
    return existing;
  }

  const insert = db.prepare(
    "INSERT INTO accounts (acct_id, ledger_balance_cents) VALUES (?, ?)",
  );
  insert.run(acctId, ledgerBalanceCents);
  const row = find.get(acctId) as unknown as AccountRow;
  return row;
}

export interface InsertTransactionInput {
  accountId: number;
  fitid: string;
  amountCents: number;
  postedAt: string;
  payee: string | null;
  memo: string | null;
}

/** Insert one transaction; returns true if a new row was inserted. */
export function insertTransactionIgnore(
  db: AntibudgetDb,
  tx: InsertTransactionInput,
): boolean {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (
      account_id, fitid, fitid_hash, amount_cents, posted_at, payee, memo
    ) VALUES (?, ?, NULL, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    tx.accountId,
    tx.fitid,
    tx.amountCents,
    tx.postedAt,
    tx.payee,
    tx.memo,
  );
  return result.changes > 0;
}

export function countTransactions(db: AntibudgetDb): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as unknown as {
    c: number;
  };
  return row.c;
}

export function getAccountByAcctId(db: AntibudgetDb, acctId: string): AccountRow | undefined {
  return db.prepare("SELECT id, acct_id FROM accounts WHERE acct_id = ?").get(acctId) as unknown as
    | AccountRow
    | undefined;
}

export interface CategoryRow {
  id: number;
  name: string;
}

export function listCategories(db: AntibudgetDb): CategoryRow[] {
  return db
    .prepare("SELECT id, name FROM categories ORDER BY name COLLATE NOCASE")
    .all() as unknown as CategoryRow[];
}

export interface AccountBalanceRow {
  acctId: string;
  name: string | null;
  ledgerBalanceCents: number | null;
}

export function listAccountBalances(db: AntibudgetDb): AccountBalanceRow[] {
  return db
    .prepare(
      `
    SELECT acct_id AS acctId, name, ledger_balance_cents AS ledgerBalanceCents
    FROM accounts
    ORDER BY acct_id
  `,
    )
    .all() as unknown as AccountBalanceRow[];
}

export interface AccountBalanceSnapshot {
  acctId: string;
  ledgerBalanceCents: number | null;
}

export function listAccountBalanceSnapshots(db: AntibudgetDb): AccountBalanceSnapshot[] {
  return listAccountBalances(db).map((row) => ({
    acctId: row.acctId,
    ledgerBalanceCents: row.ledgerBalanceCents,
  }));
}

export function setAccountLedgerBalance(
  db: AntibudgetDb,
  acctId: string,
  ledgerBalanceCents: number | null,
): void {
  db.prepare("UPDATE accounts SET ledger_balance_cents = ? WHERE acct_id = ?").run(
    ledgerBalanceCents,
    acctId,
  );
}

export function getOrCreateCategory(db: AntibudgetDb, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Category name must not be empty");
  }
  const find = db.prepare("SELECT id FROM categories WHERE name = ?");
  const existing = find.get(trimmed) as unknown as { id: number } | undefined;
  if (existing) {
    return existing.id;
  }
  db.prepare("INSERT INTO categories (name) VALUES (?)").run(trimmed);
  return (find.get(trimmed) as unknown as { id: number }).id;
}

export interface TransactionRow {
  accountId: number;
  acctId: string;
  fitid: string;
  amountCents: number;
  postedAt: string;
  payee: string | null;
  memo: string | null;
  categoryId: number | null;
  categoryName: string | null;
  isManualOverride: boolean;
  isTransfer: boolean;
}

export function listAllTransactions(db: AntibudgetDb): TransactionRow[] {
  const rows = db
    .prepare(
      `
    SELECT
      t.account_id AS accountId,
      a.acct_id AS acctId,
      t.fitid AS fitid,
      t.amount_cents AS amountCents,
      t.posted_at AS postedAt,
      t.payee AS payee,
      t.memo AS memo,
      t.category_id AS categoryId,
      c.name AS categoryName,
      t.is_manual_override AS isManualOverride,
      t.is_transfer AS isTransfer
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    ORDER BY t.posted_at, t.fitid
  `,
    )
    .all() as unknown as Array<
    Omit<TransactionRow, "isManualOverride" | "isTransfer"> & {
      isManualOverride: number;
      isTransfer: number;
    }
  >;

  return rows.map((row) => ({
    ...row,
    isManualOverride: row.isManualOverride === 1,
    isTransfer: row.isTransfer === 1,
  }));
}

export function setTransactionCategoryManual(
  db: AntibudgetDb,
  accountId: number,
  fitid: string,
  categoryId: number,
): boolean {
  const result = db
    .prepare(
      `
    UPDATE transactions
    SET category_id = ?, is_manual_override = 1
    WHERE account_id = ? AND fitid = ?
  `,
    )
    .run(categoryId, accountId, fitid);
  return result.changes > 0;
}

export interface InsertTransactionHistoryInput extends InsertTransactionInput {
  categoryId: number | null;
  isManualOverride: boolean;
  isTransfer: boolean;
}

/** Re-insert a transaction with classification (ingest redo). */
export function insertTransactionFromHistory(
  db: AntibudgetDb,
  tx: InsertTransactionHistoryInput,
): boolean {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (
      account_id, fitid, fitid_hash, amount_cents, posted_at, payee, memo,
      category_id, is_manual_override, is_transfer
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    tx.accountId,
    tx.fitid,
    tx.amountCents,
    tx.postedAt,
    tx.payee,
    tx.memo,
    tx.categoryId,
    tx.isManualOverride ? 1 : 0,
    tx.isTransfer ? 1 : 0,
  );
  return result.changes > 0;
}

export interface TransactionClassification {
  categoryId: number | null;
  isManualOverride: boolean;
  isTransfer: boolean;
}

export function getTransactionClassification(
  db: AntibudgetDb,
  accountId: number,
  fitid: string,
): TransactionClassification | undefined {
  const row = db
    .prepare(
      `
    SELECT
      category_id AS categoryId,
      is_manual_override AS isManualOverride,
      is_transfer AS isTransfer
    FROM transactions
    WHERE account_id = ? AND fitid = ?
  `,
    )
    .get(accountId, fitid) as unknown as
    | {
        categoryId: number | null;
        isManualOverride: number;
        isTransfer: number;
      }
    | undefined;
  if (!row) {
    return undefined;
  }
  return {
    categoryId: row.categoryId,
    isManualOverride: row.isManualOverride === 1,
    isTransfer: row.isTransfer === 1,
  };
}

export function restoreTransactionClassification(
  db: AntibudgetDb,
  accountId: number,
  fitid: string,
  state: TransactionClassification,
): boolean {
  const result = db
    .prepare(
      `
    UPDATE transactions
    SET
      category_id = ?,
      is_manual_override = ?,
      is_transfer = ?
    WHERE account_id = ? AND fitid = ?
  `,
    )
    .run(
      state.categoryId,
      state.isManualOverride ? 1 : 0,
      state.isTransfer ? 1 : 0,
      accountId,
      fitid,
    );
  return result.changes > 0;
}

export interface TransactionKey {
  accountId: number;
  fitid: string;
}

export function deleteTransactionsByKeys(db: AntibudgetDb, keys: TransactionKey[]): number {
  const stmt = db.prepare("DELETE FROM transactions WHERE account_id = ? AND fitid = ?");
  let deleted = 0;
  for (const key of keys) {
    const result = stmt.run(key.accountId, key.fitid);
    deleted += Number(result.changes);
  }
  return deleted;
}

export interface StoredTransactionRow extends InsertTransactionHistoryInput {
  accountId: number;
}

export function loadStoredTransactionRows(
  db: AntibudgetDb,
  keys: TransactionKey[],
): StoredTransactionRow[] {
  if (keys.length === 0) {
    return [];
  }
  const stmt = db.prepare(`
    SELECT
      account_id AS accountId,
      fitid,
      amount_cents AS amountCents,
      posted_at AS postedAt,
      payee,
      memo,
      category_id AS categoryId,
      is_manual_override AS isManualOverride,
      is_transfer AS isTransfer
    FROM transactions
    WHERE account_id = ? AND fitid = ?
  `);
  const rows: StoredTransactionRow[] = [];
  for (const key of keys) {
    const row = stmt.get(key.accountId, key.fitid) as unknown as
      | (Omit<StoredTransactionRow, "isManualOverride" | "isTransfer"> & {
          isManualOverride: number;
          isTransfer: number;
        })
      | undefined;
    if (!row) {
      continue;
    }
    rows.push({
      ...row,
      isManualOverride: row.isManualOverride === 1,
      isTransfer: row.isTransfer === 1,
    });
  }
  return rows;
}

export function snapshotTransactionKeys(db: AntibudgetDb): Set<string> {
  const rows = db
    .prepare("SELECT account_id AS accountId, fitid FROM transactions")
    .all() as unknown as TransactionKey[];
  return new Set(rows.map((row) => `${row.accountId}\0${row.fitid}`));
}

export function transactionExists(
  db: AntibudgetDb,
  accountId: number,
  fitid: string,
): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM transactions WHERE account_id = ? AND fitid = ?")
    .get(accountId, fitid) as unknown as { ok: number } | undefined;
  return row !== undefined;
}

export interface ApplyCategoryUpdate {
  accountId: number;
  fitid: string;
  categoryId: number;
  markTransfer: boolean;
}

/** Updates category only when is_manual_override = 0. */
export function applyCategoryFromRules(
  db: AntibudgetDb,
  updates: ApplyCategoryUpdate[],
): number {
  const stmt = db.prepare(`
    UPDATE transactions
    SET
      category_id = ?,
      is_transfer = CASE WHEN ? = 1 THEN 1 ELSE is_transfer END
    WHERE account_id = ? AND fitid = ? AND is_manual_override = 0
  `);
  let changed = 0;
  for (const update of updates) {
    const result = stmt.run(
      update.categoryId,
      update.markTransfer ? 1 : 0,
      update.accountId,
      update.fitid,
    );
    changed += Number(result.changes);
  }
  return changed;
}

/**
 * Future dedup when banks change FITIDs: compute a stable hash from
 * (account_id, posted_at, amount_cents, normalized payee/memo) and
 * INSERT OR IGNORE on fitid_hash when fitid collisions fail. M1 stores NULL.
 */
export function documentFitidHashFallback(): string {
  return "fitid_hash reserved for FITID rotation; M1 dedup uses (account_id, fitid) only.";
}

export function runInTransaction(db: AntibudgetDb, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
