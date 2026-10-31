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
`;

export type JusttrackDb = DatabaseSync;

export function openDatabase(dbPath: string): JusttrackDb {
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
  db: JusttrackDb,
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
  db: JusttrackDb,
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

export function countTransactions(db: JusttrackDb): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as unknown as {
    c: number;
  };
  return row.c;
}

/**
 * Future dedup when banks change FITIDs: compute a stable hash from
 * (account_id, posted_at, amount_cents, normalized payee/memo) and
 * INSERT OR IGNORE on fitid_hash when fitid collisions fail. M1 stores NULL.
 */
export function documentFitidHashFallback(): string {
  return "fitid_hash reserved for FITID rotation; M1 dedup uses (account_id, fitid) only.";
}
