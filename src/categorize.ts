import { resolvePaths, type AntibudgetPaths } from "./config.js";
import {
  applyCategoryFromRules,
  getOrCreateCategory,
  listAllTransactions,
  openDatabase,
  runInTransaction,
  type AntibudgetDb,
  type ApplyCategoryUpdate,
} from "./db.js";
import {
  ensureDefaultRulesFile,
  findFirstMatchingRule,
  loadRules,
  type RulesFile,
} from "./rules.js";

export interface CategorizeResult {
  rulesLoaded: number;
  transactionsConsidered: number;
  transactionsUpdated: number;
  defaultRulesCreated: boolean;
}

export interface CategorizeOptions {
  paths?: AntibudgetPaths;
  db?: AntibudgetDb;
  rules?: RulesFile;
  createDefaultRules?: boolean;
}

export function categorizeTransactions(options: CategorizeOptions = {}): CategorizeResult {
  const paths = options.paths ?? resolvePaths({ createDirs: true });
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase(paths.dbPath);

  try {
    let defaultRulesCreated = false;
    if (options.createDefaultRules) {
      defaultRulesCreated = ensureDefaultRulesFile(paths.rulesPath);
    }

    const rulesFile = options.rules ?? loadRules(paths);

    const transactions = listAllTransactions(db);
    const updates: ApplyCategoryUpdate[] = [];

    for (const tx of transactions) {
      if (tx.isManualOverride) {
        continue;
      }
      const match = findFirstMatchingRule(rulesFile.rules, {
        payee: tx.payee,
        memo: tx.memo,
        amountCents: tx.amountCents,
      });
      if (!match) {
        continue;
      }
      const categoryId = getOrCreateCategory(db, match.rule.category);
      const needsTransfer = match.rule.markTransfer === true;
      if (tx.categoryId === categoryId && (!needsTransfer || tx.isTransfer)) {
        continue;
      }
      updates.push({
        accountId: tx.accountId,
        fitid: tx.fitid,
        categoryId,
        markTransfer: match.rule.markTransfer === true,
      });
    }

    let transactionsUpdated = 0;
    runInTransaction(db, () => {
      transactionsUpdated = applyCategoryFromRules(db, updates);
    });

    return {
      rulesLoaded: rulesFile.rules.length,
      transactionsConsidered: transactions.length,
      transactionsUpdated,
      defaultRulesCreated,
    };
  } finally {
    if (ownsDb) {
      db.close();
    }
  }
}
