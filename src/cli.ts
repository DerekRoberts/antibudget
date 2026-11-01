#!/usr/bin/env -S node --experimental-sqlite
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { categorizeTransactions } from "./categorize.js";
import { resolvePaths } from "./config.js";
import { countTransactions, openDatabase } from "./db.js";
import { ingestOfxPaths } from "./ingest.js";
import { setManualTransactionCategory } from "./manual.js";
import {
  listMultiHitTransactions,
  listUncategorizedTransactions,
  monthlyCategoryRollup,
  monthlyIncomeExpenseSeries,
  printCashflowSeries,
  printMonthlyCategoryTable,
  printMultiHit,
  printUncategorized,
} from "./reports.js";

import { startAntibudgetServer } from "./server.js";

function printUsage(): void {
  console.error(`Usage:
  antibudget ingest [file-or-directory]
  antibudget categorize [--init-rules]
  antibudget set-category <acct-id> <fitid> <category-name>
  antibudget report monthly [--month YYYY-MM]
  antibudget report cashflow
  antibudget report uncategorized
  antibudget report triage
  antibudget serve [--port PORT] [--host HOST]

Environment:
  ANTIBUDGET_HOME   Override data directory (default: OS user data path)
`);
}

const REPORT_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const REPORT_KINDS = ["monthly", "cashflow", "uncategorized", "triage"] as const;
type ReportKind = (typeof REPORT_KINDS)[number];
const REPORT_KIND_SET = new Set<string>(REPORT_KINDS);

function noTransactionsGuidance(paths: ReturnType<typeof resolvePaths>): string {
  return `No transactions in ${paths.dbPath}. Run "antibudget ingest" after adding OFX/QFX to ${paths.inbox}.`;
}

function assertReportDatabaseReady(paths: ReturnType<typeof resolvePaths>): void {
  if (!fs.existsSync(paths.home)) {
    throw new Error(noTransactionsGuidance(paths));
  }
  if (!fs.existsSync(paths.dbPath)) {
    throw new Error(noTransactionsGuidance(paths));
  }
}

function parseReportArgs(args: string[]): { kind: string; month?: string } {
  const kind = args[1];
  if (!kind) {
    throw new Error(
      `report requires a subcommand: ${REPORT_KINDS.join(", ")}`,
    );
  }
  let month: string | undefined;
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--month") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--month requires a YYYY-MM value");
      }
      if (!REPORT_MONTH_RE.test(value)) {
        throw new Error(`Invalid --month: ${value} (expected YYYY-MM with month 01-12)`);
      }
      month = value;
      i += 1;
    }
  }
  return { kind, month };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command === "ingest") {
    const sourcePath = args[1] ? path.resolve(args[1]) : undefined;
    const paths = resolvePaths({ createDirs: true });
    const result = ingestOfxPaths({ paths, sourcePath });
    if (result.filesProcessed === 0) {
      const target = sourcePath ?? paths.inbox;
      console.error(
        `No .ofx or .qfx files found in ${target}. Drop bank exports there or pass a file path.`,
      );
    }
    console.log(
      JSON.stringify(
        {
          filesProcessed: result.filesProcessed,
          transactionsInserted: result.transactionsInserted,
          transactionsSkipped: result.transactionsSkipped,
          inbox: paths.inbox,
          archive: paths.archive,
          db: paths.dbPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "categorize") {
    const initRules = args.includes("--init-rules");
    const paths = resolvePaths({ createDirs: true });
    const result = categorizeTransactions({
      paths,
      createDefaultRules: initRules,
      initRulesOnly: initRules,
    });
    if (!initRules && result.rulesLoaded === 0 && !fs.existsSync(paths.rulesPath)) {
      console.error(
        `No rules.yaml at ${paths.rulesPath}. From a git checkout, copy fixtures/rules.example.yaml there and edit payees before ingest (ingest auto-categorizes when the file exists). From npm, run "antibudget categorize --init-rules" to write built-in starter rules, then edit before ingest.`,
      );
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "set-category") {
    const acctId = args[1];
    const fitid = args[2];
    const categoryName = args[3];
    if (!acctId || !fitid || !categoryName) {
      console.error("set-category requires: <acct-id> <fitid> <category-name>");
      process.exit(1);
    }
    setManualTransactionCategory({ acctId, fitid, categoryName });
    console.log(JSON.stringify({ updated: true, acctId, fitid, category: categoryName }, null, 2));
    return;
  }

  if (command === "report") {
    const { kind, month } = parseReportArgs(args);
    if (!REPORT_KIND_SET.has(kind)) {
      throw new Error(`Unknown report subcommand: ${kind}`);
    }
    const paths = resolvePaths({ createDirs: false });
    assertReportDatabaseReady(paths);
    const db = openDatabase(paths.dbPath);
    try {
      if (countTransactions(db) === 0) {
        throw new Error(noTransactionsGuidance(paths));
      }
      const reportKind = kind as ReportKind;
      switch (reportKind) {
        case "monthly":
          printMonthlyCategoryTable(monthlyCategoryRollup(db, month));
          break;
        case "cashflow":
          printCashflowSeries(monthlyIncomeExpenseSeries(db));
          break;
        case "uncategorized":
          printUncategorized(listUncategorizedTransactions(db));
          break;
        case "triage":
          printMultiHit(listMultiHitTransactions(db, paths.rulesPath));
          break;
        default: {
          const _exhaustive: never = reportKind;
          throw new Error(`Unknown report subcommand: ${_exhaustive}`);
        }
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === "serve") {
    let port = 8080;
    let host = "127.0.0.1";
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === "--port") {
        const value = args[i + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("--port requires a number");
        }
        if (!/^\d+$/.test(value)) {
          throw new Error(`Invalid --port: ${value}`);
        }
        const parsed = Number(value);
        if (parsed < 1 || parsed > 65535) {
          throw new Error(`Invalid --port: ${value}`);
        }
        port = parsed;
        i += 1;
      } else if (args[i] === "--host") {
        const value = args[i + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("--host requires a hostname or address");
        }
        host = value;
        i += 1;
      }
    }
    const started = await startAntibudgetServer({ host, port });
    console.log(`antibudget UI at ${started.url} (localhost only)`);
    console.log("Press Ctrl+C to stop.");
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

function isCliMain(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  const entryPath = path.resolve(process.argv[1]);
  try {
    return fs.realpathSync(modulePath) === fs.realpathSync(entryPath);
  } catch {
    return modulePath === entryPath;
  }
}

if (isCliMain()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
