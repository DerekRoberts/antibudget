import type { AntibudgetDb } from "./db.js";
import { listAllTransactions } from "./db.js";
import { findMatchingRules, loadRulesFromPath } from "./rules.js";

export interface MonthlyCategoryRollupRow {
  month: string;
  categoryName: string | null;
  totalCents: number;
  transactionCount: number;
}

export interface MonthlyCashflowRow {
  month: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
}

export interface UncategorizedRow {
  acctId: string;
  fitid: string;
  postedAt: string;
  payee: string | null;
  memo: string | null;
  amountCents: number;
}

export interface MultiHitRow {
  acctId: string;
  fitid: string;
  postedAt: string;
  payee: string | null;
  memo: string | null;
  amountCents: number;
  matchingCategories: string[];
}

export function monthlyCategoryRollup(db: AntibudgetDb, month?: string): MonthlyCategoryRollupRow[] {
  const filter = month
    ? db.prepare(
        `
    SELECT
      strftime('%Y-%m', t.posted_at) AS month,
      c.name AS categoryName,
      SUM(t.amount_cents) AS totalCents,
      COUNT(*) AS transactionCount
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE strftime('%Y-%m', t.posted_at) = ?
    GROUP BY month, c.name
    ORDER BY month, totalCents
  `,
      )
    : db.prepare(
        `
    SELECT
      strftime('%Y-%m', t.posted_at) AS month,
      c.name AS categoryName,
      SUM(t.amount_cents) AS totalCents,
      COUNT(*) AS transactionCount
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    GROUP BY month, c.name
    ORDER BY month, totalCents
  `,
      );

  const rows = (month ? filter.all(month) : filter.all()) as unknown as MonthlyCategoryRollupRow[];
  return rows;
}

export function monthlyIncomeExpenseSeries(db: AntibudgetDb): MonthlyCashflowRow[] {
  const rows = db
    .prepare(
      `
    SELECT
      strftime('%Y-%m', posted_at) AS month,
      SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS incomeCents,
      SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS expenseCents,
      SUM(amount_cents) AS netCents
    FROM transactions
    GROUP BY month
    ORDER BY month
  `,
    )
    .all() as unknown as MonthlyCashflowRow[];
  return rows;
}

export function listUncategorizedTransactions(db: AntibudgetDb): UncategorizedRow[] {
  return db
    .prepare(
      `
    SELECT
      a.acct_id AS acctId,
      t.fitid AS fitid,
      t.posted_at AS postedAt,
      t.payee AS payee,
      t.memo AS memo,
      t.amount_cents AS amountCents
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.category_id IS NULL
    ORDER BY t.posted_at, t.fitid
  `,
    )
    .all() as unknown as UncategorizedRow[];
}

export function listMultiHitTransactions(
  db: AntibudgetDb,
  rulesPath: string,
): MultiHitRow[] {
  const rules = loadRulesFromPath(rulesPath).rules;
  if (rules.length === 0) {
    return [];
  }
  const transactions = listAllTransactions(db);
  const multi: MultiHitRow[] = [];
  for (const tx of transactions) {
    const matches = findMatchingRules(rules, {
      payee: tx.payee,
      memo: tx.memo,
      amountCents: tx.amountCents,
    });
    if (matches.length > 1) {
      multi.push({
        acctId: tx.acctId,
        fitid: tx.fitid,
        postedAt: tx.postedAt,
        payee: tx.payee,
        memo: tx.memo,
        amountCents: tx.amountCents,
        matchingCategories: matches.map((m) => m.rule.category),
      });
    }
  }
  return multi;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars}.${String(remainder).padStart(2, "0")}`;
}

export function printMonthlyCategoryTable(rows: MonthlyCategoryRollupRow[]): void {
  console.log("month\tcategory\ttotal\tcount");
  for (const row of rows) {
    console.log(
      `${row.month}\t${row.categoryName ?? "(uncategorized)"}\t${formatCents(row.totalCents)}\t${row.transactionCount}`,
    );
  }
}

export function printCashflowSeries(rows: MonthlyCashflowRow[]): void {
  console.log("month\tincome\texpenses\tnet");
  for (const row of rows) {
    console.log(
      `${row.month}\t${formatCents(row.incomeCents)}\t${formatCents(row.expenseCents)}\t${formatCents(row.netCents)}`,
    );
  }
}

export function printUncategorized(rows: UncategorizedRow[]): void {
  console.log("account\tfitid\tposted\tpayee\tamount");
  for (const row of rows) {
    console.log(
      `${row.acctId}\t${row.fitid}\t${row.postedAt}\t${row.payee ?? ""}\t${formatCents(row.amountCents)}`,
    );
  }
}

export function printMultiHit(rows: MultiHitRow[]): void {
  console.log("account\tfitid\tposted\tpayee\tmatching_categories");
  for (const row of rows) {
    console.log(
      `${row.acctId}\t${row.fitid}\t${row.postedAt}\t${row.payee ?? ""}\t${row.matchingCategories.join("|")}`,
    );
  }
}
