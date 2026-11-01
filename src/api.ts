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
  transactionExists,
} from "./db.js";
import type { AntibudgetDb } from "./db.js";
import {
  listUncategorizedTransactions,
  monthlyCategoryRollup,
  monthlyIncomeExpenseSeries,
} from "./reports.js";

const MAX_JSON_BODY_BYTES = 65_536;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiContext {
  paths: AntibudgetPaths;
}

export function createApiContext(options?: { home?: string }): ApiContext {
  return { paths: resolvePaths({ home: options?.home, createDirs: false }) };
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const contentLength = req.headers["content-length"];
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
      throw new ApiError(413, "Request body too large");
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new ApiError(413, "Request body too large");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new ApiError(400, "Request body required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  return parsed as T;
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

function parseSetCategoryBody(body: unknown): SetCategoryBody {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "JSON object body required");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.acctId !== "string" || typeof record.fitid !== "string") {
    throw new ApiError(400, "acctId and fitid must be strings");
  }
  if (typeof record.categoryName !== "string") {
    throw new ApiError(400, "categoryName must be a string");
  }
  const acctId = record.acctId.trim();
  const fitid = record.fitid.trim();
  const categoryName = record.categoryName.trim();
  if (!acctId || !fitid || !categoryName) {
    throw new ApiError(400, "acctId, fitid, and categoryName are required");
  }
  return { acctId, fitid, categoryName };
}

export function handleSetTransactionCategory(
  ctx: ApiContext,
  body: SetCategoryBody,
): unknown {
  return withDb(ctx, (db) => {
    const account = getAccountByAcctId(db, body.acctId);
    if (!account) {
      throw new ApiError(404, `Unknown account: ${body.acctId}`);
    }
    if (!transactionExists(db, account.id, body.fitid)) {
      throw new ApiError(404, `Transaction not found: ${body.acctId} / ${body.fitid}`);
    }
    const categoryId = getOrCreateCategory(db, body.categoryName);
    const updated = setTransactionCategoryManual(db, account.id, body.fitid, categoryId);
    if (!updated) {
      throw new ApiError(500, "Failed to update transaction category");
    }
    return {
      updated: true,
      acctId: body.acctId,
      fitid: body.fitid,
      categoryName: body.categoryName,
    };
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
      const raw = await readJsonBody<unknown>(req);
      const body = parseSetCategoryBody(raw);
      return { status: 200, body: handleSetTransactionCategory(ctx, body) };
    }
    return { status: 404, body: { error: "Not found" } };
  };

  return route().catch((err: unknown) => {
    if (err instanceof ApiError) {
      return { status: err.status, body: { error: err.message } };
    }
    console.error(err);
    return { status: 500, body: { error: "Internal server error" } };
  });
}
