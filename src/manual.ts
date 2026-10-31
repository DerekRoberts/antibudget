import { resolvePaths } from "./config.js";
import {
  getAccountByAcctId,
  getOrCreateCategory,
  openDatabase,
  setTransactionCategoryManual,
} from "./db.js";

export interface SetCategoryOptions {
  acctId: string;
  fitid: string;
  categoryName: string;
  home?: string;
}

export function setManualTransactionCategory(options: SetCategoryOptions): boolean {
  const paths = resolvePaths({ home: options.home, createDirs: false });
  const db = openDatabase(paths.dbPath);
  try {
    const account = getAccountByAcctId(db, options.acctId);
    if (!account) {
      throw new Error(`Unknown account: ${options.acctId}`);
    }
    const categoryId = getOrCreateCategory(db, options.categoryName);
    const updated = setTransactionCategoryManual(db, account.id, options.fitid, categoryId);
    if (!updated) {
      throw new Error(`Transaction not found: ${options.acctId} / ${options.fitid}`);
    }
    return true;
  } finally {
    db.close();
  }
}
