import {
  deleteTransactionsByKeys,
  getTransactionClassification,
  insertTransactionIgnore,
  openDatabase,
  restoreTransactionClassification,
  runInTransaction,
  type AntibudgetDb,
  type InsertTransactionInput,
  type TransactionClassification,
  type TransactionKey,
} from "./db.js";

export type HistoryKind = "category" | "ingest";

export interface CategoryHistoryPayload {
  accountId: number;
  fitid: string;
  before: TransactionClassification;
  after: TransactionClassification;
}

export interface IngestHistoryRow extends InsertTransactionInput {
  accountId: number;
}

export interface IngestHistoryPayload {
  rows: IngestHistoryRow[];
}

export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

function getCursorId(db: AntibudgetDb): number {
  const row = db
    .prepare("SELECT cursor_id AS cursorId FROM ledger_history_cursor WHERE singleton = 1")
    .get() as unknown as { cursorId: number };
  return row.cursorId;
}

function setCursorId(db: AntibudgetDb, cursorId: number): void {
  db.prepare("UPDATE ledger_history_cursor SET cursor_id = ? WHERE singleton = 1").run(cursorId);
}

function maxHistoryId(db: AntibudgetDb): number {
  const row = db.prepare("SELECT MAX(id) AS maxId FROM ledger_history").get() as unknown as {
    maxId: number | null;
  };
  return row.maxId ?? 0;
}

function previousHistoryId(db: AntibudgetDb, id: number): number {
  const row = db
    .prepare("SELECT MAX(id) AS prevId FROM ledger_history WHERE id < ?")
    .get(id) as unknown as { prevId: number | null };
  return row.prevId ?? 0;
}

function nextHistoryId(db: AntibudgetDb, id: number): number {
  const row = db
    .prepare("SELECT MIN(id) AS nextId FROM ledger_history WHERE id > ?")
    .get(id) as unknown as { nextId: number | null };
  return row.nextId ?? 0;
}

function loadEvent(
  db: AntibudgetDb,
  id: number,
): { kind: HistoryKind; payload: CategoryHistoryPayload | IngestHistoryPayload } {
  const row = db
    .prepare("SELECT kind, payload FROM ledger_history WHERE id = ?")
    .get(id) as unknown as { kind: HistoryKind; payload: string };
  return { kind: row.kind, payload: JSON.parse(row.payload) as CategoryHistoryPayload | IngestHistoryPayload };
}

function appendEvent(db: AntibudgetDb, kind: HistoryKind, payload: unknown): number {
  const cursor = getCursorId(db);
  const maxId = maxHistoryId(db);
  if (maxId > cursor) {
    db.prepare("DELETE FROM ledger_history WHERE id > ?").run(cursor);
  }
  const insert = db.prepare("INSERT INTO ledger_history (kind, payload) VALUES (?, ?)");
  insert.run(kind, JSON.stringify(payload));
  const row = db.prepare("SELECT last_insert_rowid() AS id").get() as unknown as { id: number };
  const id = Number(row.id);
  setCursorId(db, id);
  return id;
}

function applyCategoryState(
  db: AntibudgetDb,
  accountId: number,
  fitid: string,
  state: TransactionClassification,
): void {
  const updated = restoreTransactionClassification(db, accountId, fitid, state);
  if (!updated) {
    throw new Error(`Transaction not found for history apply: ${accountId} / ${fitid}`);
  }
}

function applyCategoryForward(db: AntibudgetDb, payload: CategoryHistoryPayload): void {
  applyCategoryState(db, payload.accountId, payload.fitid, payload.after);
}

function applyCategoryBackward(db: AntibudgetDb, payload: CategoryHistoryPayload): void {
  applyCategoryState(db, payload.accountId, payload.fitid, payload.before);
}

function applyIngestForward(db: AntibudgetDb, payload: IngestHistoryPayload): void {
  for (const row of payload.rows) {
    insertTransactionIgnore(db, {
      accountId: row.accountId,
      fitid: row.fitid,
      amountCents: row.amountCents,
      postedAt: row.postedAt,
      payee: row.payee,
      memo: row.memo,
    });
  }
}

function applyIngestBackward(db: AntibudgetDb, payload: IngestHistoryPayload): void {
  const keys: TransactionKey[] = payload.rows.map((row) => ({
    accountId: row.accountId,
    fitid: row.fitid,
  }));
  deleteTransactionsByKeys(db, keys);
}

function eventLabel(kind: HistoryKind, payload: CategoryHistoryPayload | IngestHistoryPayload): string {
  if (kind === "category") {
    const p = payload as CategoryHistoryPayload;
    return `Category change (${p.fitid})`;
  }
  const p = payload as IngestHistoryPayload;
  return `Import ${p.rows.length} transaction${p.rows.length === 1 ? "" : "s"}`;
}

export function recordCategoryHistory(
  db: AntibudgetDb,
  accountId: number,
  fitid: string,
  before: TransactionClassification,
  after: TransactionClassification,
): void {
  if (
    before.categoryId === after.categoryId &&
    before.isManualOverride === after.isManualOverride &&
    before.isTransfer === after.isTransfer
  ) {
    return;
  }
  appendEvent(db, "category", { accountId, fitid, before, after } satisfies CategoryHistoryPayload);
}

export function recordIngestHistory(db: AntibudgetDb, rows: IngestHistoryRow[]): void {
  if (rows.length === 0) {
    return;
  }
  appendEvent(db, "ingest", { rows } satisfies IngestHistoryPayload);
}

export function getHistoryStatus(db: AntibudgetDb): HistoryStatus {
  const cursor = getCursorId(db);
  const maxId = maxHistoryId(db);
  const canUndo = cursor > 0;
  const canRedo = cursor < maxId;
  let undoLabel: string | null = null;
  let redoLabel: string | null = null;
  if (canUndo) {
    const { kind, payload } = loadEvent(db, cursor);
    undoLabel = eventLabel(kind, payload);
  }
  if (canRedo) {
    const nextId = nextHistoryId(db, cursor);
    if (nextId > 0) {
      const { kind, payload } = loadEvent(db, nextId);
      redoLabel = eventLabel(kind, payload);
    }
  }
  return { canUndo, canRedo, undoLabel, redoLabel };
}

export interface HistoryMutationResult {
  applied: boolean;
  kind: HistoryKind | null;
  status: HistoryStatus;
}

export function undoLedgerMutation(db: AntibudgetDb): HistoryMutationResult {
  const cursor = getCursorId(db);
  if (cursor <= 0) {
    return { applied: false, kind: null, status: getHistoryStatus(db) };
  }
  const { kind, payload } = loadEvent(db, cursor);
  runInTransaction(db, () => {
    if (kind === "category") {
      applyCategoryBackward(db, payload as CategoryHistoryPayload);
    } else {
      applyIngestBackward(db, payload as IngestHistoryPayload);
    }
    setCursorId(db, previousHistoryId(db, cursor));
  });
  return { applied: true, kind, status: getHistoryStatus(db) };
}

export function redoLedgerMutation(db: AntibudgetDb): HistoryMutationResult {
  const cursor = getCursorId(db);
  const nextId = nextHistoryId(db, cursor);
  if (nextId <= 0) {
    return { applied: false, kind: null, status: getHistoryStatus(db) };
  }
  const { kind, payload } = loadEvent(db, nextId);
  runInTransaction(db, () => {
    if (kind === "category") {
      applyCategoryForward(db, payload as CategoryHistoryPayload);
    } else {
      applyIngestForward(db, payload as IngestHistoryPayload);
    }
    setCursorId(db, nextId);
  });
  return { applied: true, kind, status: getHistoryStatus(db) };
}

/** Opens db, runs fn, closes — for tests and CLI. */
export function withHistoryDb<T>(dbPath: string, fn: (db: AntibudgetDb) => T): T {
  const db = openDatabase(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function captureClassificationAfterManualSet(
  db: AntibudgetDb,
  accountId: number,
  fitid: string,
  _categoryId: number,
): TransactionClassification {
  const state = getTransactionClassification(db, accountId, fitid);
  if (!state) {
    throw new Error(`Transaction not found: ${accountId} / ${fitid}`);
  }
  return state;
}
