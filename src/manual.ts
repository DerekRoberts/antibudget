import { resolvePaths } from "./config.js";
import {
  getAccountByAcctId,
  getOrCreateCategory,
  getTransactionClassification,
  openDatabase,
  runInTransaction,
  setTransactionCategoryManual,
  type AntibudgetDb,
} from "./db.js";
import { recordCategoryHistory } from "./history.js";

export interface SetCategoryOptions {
  acctId: string;
  fitid: string;
  categoryName: string;
  home?: string;
  recordHistory?: boolean;
}

export function setManualTransactionCategoryInDb(
  db: AntibudgetDb,
  options: Omit<SetCategoryOptions, "home">,
): boolean {
  const account = getAccountByAcctId(db, options.acctId);
  if (!account) {
    throw new Error(`Unknown account: ${options.acctId}`);
  }
  const before = getTransactionClassification(db, account.id, options.fitid);
  if (!before) {
    throw new Error(`Transaction not found: ${options.acctId} / ${options.fitid}`);
  }
  const categoryId = getOrCreateCategory(db, options.categoryName);
  let updated = false;
  runInTransaction(db, () => {
    updated = setTransactionCategoryManual(db, account.id, options.fitid, categoryId);
    if (!updated) {
      throw new Error(`Transaction not found: ${options.acctId} / ${options.fitid}`);
    }
    if (options.recordHistory !== false) {
      const after = getTransactionClassification(db, account.id, options.fitid);
      if (!after) {
        throw new Error(`Transaction not found: ${options.acctId} / ${options.fitid}`);
      }
      recordCategoryHistory(db, account.id, options.fitid, before, after);
    }
  });
  return updated;
}

export function setManualTransactionCategory(options: SetCategoryOptions): boolean {
  const paths = resolvePaths({ home: options.home, createDirs: false });
  const db = openDatabase(paths.dbPath);
  try {
    return setManualTransactionCategoryInDb(db, options);
  } finally {
    db.close();
  }
}
