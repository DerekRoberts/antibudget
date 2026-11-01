import type { IncomingMessage } from "node:http";

import type { AntibudgetPaths } from "./config.js";
import { resolvePaths } from "./config.js";
import {
  countTransactions,
  listAccountBalances,
  listCategories,
  openDatabase,
} from "./db.js";
import { handleIngestUpload } from "./upload.js";
import type { AntibudgetDb } from "./db.js";
import { assertSafeMutationRequest } from "./http-guard.js";
import {
  getHistoryStatus,
  redoLedgerMutation,
  undoLedgerMutation,
} from "./history.js";
import { setManualTransactionCategoryInDb } from "./manual.js";
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
  let rejected: ApiError | undefined;

  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      resolve();
    };
    req.on("data", (chunk: Buffer | string) => {
      if (rejected) {
        return;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > MAX_JSON_BODY_BYTES) {
        rejected = new ApiError(413, "Request body too large");
        req.removeAllListeners("data");
        req.on("data", () => {});
        req.resume();
        finish();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", finish);
    req.on("error", (err) => reject(err));
  });

  if (rejected) {
    throw rejected;
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

export function handleGetLedgerMeta(ctx: ApiContext): unknown {
  return withDb(ctx, (db) => ({ transactionCount: countTransactions(db) }));
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
    try {
      setManualTransactionCategoryInDb(db, body);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.startsWith("Unknown account:")) {
          throw new ApiError(404, err.message);
        }
        if (err.message.startsWith("Transaction not found:")) {
          throw new ApiError(404, err.message);
        }
      }
      throw err;
    }
    return {
      updated: true,
      acctId: body.acctId,
      fitid: body.fitid,
      categoryName: body.categoryName,
    };
  });
}

export function handleGetHistoryStatus(ctx: ApiContext): unknown {
  return withDb(ctx, (db) => getHistoryStatus(db));
}

export function handleUndo(ctx: ApiContext): unknown {
  return withDb(ctx, (db) => undoLedgerMutation(db));
}

export function handleRedo(ctx: ApiContext): unknown {
  return withDb(ctx, (db) => redoLedgerMutation(db));
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
    if (method === "GET" && pathname === "/api/ledger/meta") {
      return { status: 200, body: handleGetLedgerMeta(ctx) };
    }
    if (method === "POST" && pathname === "/api/ingest/upload") {
      assertSafeMutationRequest(req);
      const body = await handleIngestUpload(ctx.paths, req);
      return { status: 200, body };
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
      assertSafeMutationRequest(req);
      const raw = await readJsonBody<unknown>(req);
      const body = parseSetCategoryBody(raw);
      return { status: 200, body: handleSetTransactionCategory(ctx, body) };
    }
    if (method === "GET" && pathname === "/api/history/status") {
      return { status: 200, body: handleGetHistoryStatus(ctx) };
    }
    if (method === "POST" && pathname === "/api/history/undo") {
      assertSafeMutationRequest(req);
      return { status: 200, body: handleUndo(ctx) };
    }
    if (method === "POST" && pathname === "/api/history/redo") {
      assertSafeMutationRequest(req);
      return { status: 200, body: handleRedo(ctx) };
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
