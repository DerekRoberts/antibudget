import type { IncomingMessage } from "node:http";

import type { AntibudgetPaths } from "./config.js";
import { resolvePaths } from "./config.js";
import {
  getAccountByAcctId,
  getOrCreateCategory,
  listAccountBalances,
  listCategories,
  openDatabase,
  setTransactionCategoryManual,
} from "./db.js";
import type { AntibudgetDb } from "./db.js";
import {
  listUncategorizedTransactions,
  monthlyCategoryRollup,
  monthlyIncomeExpenseSeries,
} from "./reports.js";

export interface ApiContext {
  paths: AntibudgetPaths;
}

export function createApiContext(options?: { home?: string }): ApiContext {
  return { paths: resolvePaths({ home: options?.home, createDirs: false }) };
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("Request body required");
  }
  return JSON.parse(text) as T;
}

function withDb<T>(ctx: ApiContext, fn: (db: AntibudgetDb) => T): T {
  const db = openDatabase(ctx.paths.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function handleGetCategories(ctx: ApiContext): unknown {
  return withDb(ctx, (db) => ({ categories: listCategories(db) }));
}

export function handleGetUncategorized(
  ctx: ApiContext,
  query: URLSearchParams,
): unknown {
  const payee = query.get("payee") ?? undefined;
  return withDb(ctx, (db) => ({
    transactions: listUncategorizedTransactions(db, payee),
  }));
}

export interface SetCategoryBody {
  acctId: string;
  fitid: string;
  categoryName: string;
}

export function handleSetTransactionCategory(
  ctx: ApiContext,
  body: SetCategoryBody,
): unknown {
  const acctId = body.acctId?.trim();
  const fitid = body.fitid?.trim();
  const categoryName = body.categoryName?.trim();
  if (!acctId || !fitid || !categoryName) {
    throw new Error("acctId, fitid, and categoryName are required");
  }
  return withDb(ctx, (db) => {
    const account = getAccountByAcctId(db, acctId);
    if (!account) {
      throw new Error(`Unknown account: ${acctId}`);
    }
    const categoryId = getOrCreateCategory(db, categoryName);
    const updated = setTransactionCategoryManual(db, account.id, fitid, categoryId);
    if (!updated) {
      throw new Error(`Transaction not found: ${acctId} / ${fitid}`);
    }
    return { updated: true, acctId, fitid, categoryName };
  });
}

export function handleGetMonthlyReport(
  ctx: ApiContext,
  query: URLSearchParams,
): unknown {
  const month = query.get("month") ?? undefined;
  return withDb(ctx, (db) => ({
    month: month ?? null,
    rows: monthlyCategoryRollup(db, month ?? undefined),
  }));
}

export function handleGetCashflowReport(ctx: ApiContext): unknown {
  return withDb(ctx, (db) => ({
    rows: monthlyIncomeExpenseSeries(db),
  }));
}

export function handleGetNetWorth(ctx: ApiContext): unknown {
  return withDb(ctx, (db) => {
    const accounts = listAccountBalances(db);
    const withBalance = accounts.filter((a) => a.ledgerBalanceCents !== null);
    const totalCents = withBalance.reduce(
      (sum, a) => sum + (a.ledgerBalanceCents ?? 0),
      0,
    );
    return {
      totalCents: withBalance.length > 0 ? totalCents : null,
      accounts,
      ageOfMoney: {
        available: false,
        reason:
          "Age of Money needs a rolling inflow/outflow model; deferred until balance history is richer.",
      },
    };
  });
}

export function handleApiRequest(
  ctx: ApiContext,
  method: string,
  pathname: string,
  query: URLSearchParams,
  req: IncomingMessage,
): Promise<{ status: number; body: unknown }> {
  const route = async (): Promise<{ status: number; body: unknown }> => {
    if (method === "GET" && pathname === "/api/categories") {
      return { status: 200, body: handleGetCategories(ctx) };
    }
    if (method === "GET" && pathname === "/api/transactions/uncategorized") {
      return { status: 200, body: handleGetUncategorized(ctx, query) };
    }
    if (method === "GET" && pathname === "/api/reports/monthly") {
      return { status: 200, body: handleGetMonthlyReport(ctx, query) };
    }
    if (method === "GET" && pathname === "/api/reports/cashflow") {
      return { status: 200, body: handleGetCashflowReport(ctx) };
    }
    if (method === "GET" && pathname === "/api/reports/net-worth") {
      return { status: 200, body: handleGetNetWorth(ctx) };
    }
    if (method === "PUT" && pathname === "/api/transactions/category") {
      const body = await readJsonBody<SetCategoryBody>(req);
      return { status: 200, body: handleSetTransactionCategory(ctx, body) };
    }
    return { status: 404, body: { error: "Not found" } };
  };

  return route().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, body: { error: message } };
  });
}
