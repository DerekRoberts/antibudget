import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { categorizeTransactions } from "../src/categorize.js";
import { resolvePaths } from "../src/config.js";
import { countTransactions, listAllTransactions, openDatabase } from "../src/db.js";
import { ingestOfxPaths } from "../src/ingest.js";
import { setManualTransactionCategory } from "../src/manual.js";
import { monthlyCategoryRollup } from "../src/reports.js";
import {
  findFirstMatchingRule,
  findMatchingRules,
  loadRulesFromPath,
  parseRulesYaml,
  ruleMatches,
} from "../src/rules.js";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const fixturePath = path.join(repoRoot, "fixtures", "sample.ofx");
const rulesExamplePath = path.join(repoRoot, "fixtures", "rules.example.yaml");

function setupHomeWithIngest(rules = true): {
  paths: ReturnType<typeof resolvePaths>;
} {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-m2-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  fs.copyFileSync(fixturePath, path.join(paths.inbox, "sample.ofx"));
  if (rules) {
    fs.copyFileSync(rulesExamplePath, paths.rulesPath);
  }
  openDatabase(paths.dbPath).close();
  ingestOfxPaths({ paths });
  return { paths };
}

test("parseRulesYaml loads example fixture rules", () => {
  const content = fs.readFileSync(rulesExamplePath, "utf8");
  const parsed = parseRulesYaml(content);
  assert.ok(parsed.rules.length >= 4);
  const amazon = parsed.rules.find((r) => r.payeeRegex?.includes("amazon"));
  assert.ok(amazon);
  assert.equal(amazon.category, "Shopping");
});

test("ruleMatches payee_contains and amount_sign", () => {
  const rules = loadRulesFromPath(rulesExamplePath).rules;
  const incomeRule = rules.find((r) => r.category === "Income");
  assert.ok(incomeRule);
  assert.ok(
    ruleMatches(incomeRule, {
      payee: "EMPLOYER PAYROLL",
      memo: "Direct deposit",
      amountCents: 250_000,
    }),
  );
  assert.ok(
    !ruleMatches(incomeRule, {
      payee: "EMPLOYER PAYROLL",
      memo: "Reversal",
      amountCents: -250_000,
    }),
  );
});

test("findFirstMatchingRule prefers earlier rule in file order", () => {
  const rules = parseRulesYaml(`
rules:
  - category: A
    payee_contains: SHOP
  - category: B
    payee_regex: (?i)shop
`).rules;
  const match = findFirstMatchingRule(rules, {
    payee: "COFFEE SHOP",
    memo: null,
    amountCents: -500,
  });
  assert.equal(match?.rule.category, "A");
  const multi = findMatchingRules(rules, {
    payee: "COFFEE SHOP",
    memo: null,
    amountCents: -500,
  });
  assert.equal(multi.length, 2);
});

test("ingest post-step applies rules when rules.yaml exists", () => {
  const { paths } = setupHomeWithIngest(true);
  const db = openDatabase(paths.dbPath);
  const categorized = listAllTransactions(db).filter((t) => t.categoryId !== null);
  assert.equal(categorized.length, 5);
  const amazon = listAllTransactions(db).find((t) => t.payee?.includes("AMAZON"));
  assert.ok(amazon);
  assert.equal(amazon.categoryName, "Shopping");
  db.close();
});

test("categorize re-apply is idempotent", () => {
  const { paths } = setupHomeWithIngest(true);
  const second = categorizeTransactions({ paths });
  assert.equal(second.transactionsUpdated, 0);
});

test("manual override prevents rule re-apply from changing category", () => {
  const { paths } = setupHomeWithIngest(true);

  setManualTransactionCategory({
    acctId: "checking-synth-001",
    fitid: "20260112-amazon-001",
    categoryName: "Manual Gifts",
    home: paths.home,
  });

  const db = openDatabase(paths.dbPath);
  let amazon = listAllTransactions(db).find((t) => t.fitid === "20260112-amazon-001");
  assert.equal(amazon?.categoryName, "Manual Gifts");
  assert.equal(amazon?.isManualOverride, true);
  db.close();

  categorizeTransactions({ paths });

  const db2 = openDatabase(paths.dbPath);
  amazon = listAllTransactions(db2).find((t) => t.fitid === "20260112-amazon-001");
  assert.equal(amazon?.categoryName, "Manual Gifts");
  db2.close();
});

test("monthlyCategoryRollup groups categorized spending", () => {
  const { paths } = setupHomeWithIngest(true);
  const db = openDatabase(paths.dbPath);
  const rows = monthlyCategoryRollup(db, "2026-01");
  assert.ok(rows.some((r) => r.categoryName === "Income" && r.totalCents === 250_000));
  assert.ok(rows.some((r) => r.categoryName === "Shopping" && r.totalCents === -8999));
  db.close();
});

test("missing rules.yaml leaves transactions uncategorized", () => {
  const { paths } = setupHomeWithIngest(false);
  const db = openDatabase(paths.dbPath);
  const uncategorized = listAllTransactions(db).filter((t) => t.categoryId === null);
  assert.equal(uncategorized.length, 5);
  db.close();
  const result = categorizeTransactions({ paths });
  assert.equal(result.rulesLoaded, 0);
  assert.equal(result.transactionsUpdated, 0);
  assert.equal(countTransactions(openDatabase(paths.dbPath)), 5);
});
