import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import type { AntibudgetPaths } from "./config.js";

export interface CategorizationRule {
  category: string;
  payeeContains?: string;
  payeeRegex?: string;
  memoContains?: string;
  memoRegex?: string;
  /** When set, amount must be positive (credit) or negative (debit). */
  amountSign?: "credit" | "debit";
  /** When true, set is_transfer on matching transactions. */
  markTransfer?: boolean;
}

export interface RulesFile {
  rules: CategorizationRule[];
}

export interface TransactionMatchInput {
  payee: string | null;
  memo: string | null;
  amountCents: number;
}

export interface RuleMatchResult {
  rule: CategorizationRule;
  index: number;
}

const DEFAULT_RULES_YAML = `# Example antibudget rules (synthetic patterns only).
rules:
  - category: Income
    payee_contains: PAYROLL
    amount_sign: credit
  - category: Groceries
    payee_contains: GROCERY
  - category: Shopping
    payee_regex: (?i)amazon
  - category: Housing
    payee_contains: RENT
  - category: Transfers
    payee_contains: CREDIT CARD PAYMENT
    mark_transfer: true
`;

function compileRegex(pattern: string): RegExp {
  if (pattern.startsWith("(?i)")) {
    return new RegExp(pattern.slice(4), "i");
  }
  return new RegExp(pattern);
}

function isValidRegex(pattern: string): boolean {
  try {
    compileRegex(pattern);
    return true;
  } catch {
    return false;
  }
}

function normalizeRule(raw: unknown, index: number): CategorizationRule {
  if (!raw || typeof raw !== "object") {
    throw new Error(`rules[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const category = obj.category;
  if (typeof category !== "string" || !category.trim()) {
    throw new Error(`rules[${index}].category must be a non-empty string`);
  }

  const payeeContains = readOptionalString(obj, "payee_contains", index);
  const payeeRegex = readOptionalString(obj, "payee_regex", index);
  const memoContains = readOptionalString(obj, "memo_contains", index);
  const memoRegex = readOptionalString(obj, "memo_regex", index);
  const amountSign = readAmountSign(obj, index);
  const markTransfer = readOptionalBoolean(obj, "mark_transfer", index);

  if (!payeeContains && !payeeRegex && !memoContains && !memoRegex && !amountSign) {
    throw new Error(
      `rules[${index}] needs at least one of payee_contains, payee_regex, memo_contains, memo_regex, amount_sign`,
    );
  }

  if (payeeRegex && !isValidRegex(payeeRegex)) {
    throw new Error(`rules[${index}].payee_regex is not a valid regular expression`);
  }
  if (memoRegex && !isValidRegex(memoRegex)) {
    throw new Error(`rules[${index}].memo_regex is not a valid regular expression`);
  }

  return {
    category: category.trim(),
    payeeContains,
    payeeRegex,
    memoContains,
    memoRegex,
    amountSign,
    markTransfer,
  };
}

function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  index: number,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`rules[${index}].${key} must be a string`);
  }
  return value;
}

function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  index: number,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`rules[${index}].${key} must be a boolean`);
  }
  return value;
}

function readAmountSign(obj: Record<string, unknown>, index: number): "credit" | "debit" | undefined {
  const value = obj.amount_sign;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "credit" && value !== "debit") {
    throw new Error(`rules[${index}].amount_sign must be "credit" or "debit"`);
  }
  return value;
}

export function parseRulesYaml(content: string): RulesFile {
  const doc = parseYaml(content);
  if (!doc || typeof doc !== "object") {
    throw new Error("rules.yaml root must be a mapping");
  }
  const rulesRaw = (doc as Record<string, unknown>).rules;
  if (!Array.isArray(rulesRaw)) {
    throw new Error("rules.yaml must contain a top-level rules: list");
  }
  const rules = rulesRaw.map((entry, index) => normalizeRule(entry, index));
  return { rules };
}

export function loadRulesFromPath(rulesPath: string): RulesFile {
  if (!fs.existsSync(rulesPath)) {
    return { rules: [] };
  }
  const content = fs.readFileSync(rulesPath, "utf8");
  return parseRulesYaml(content);
}

/** Write example rules when the data-dir file is missing. */
export function ensureDefaultRulesFile(rulesPath: string): boolean {
  if (fs.existsSync(rulesPath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const examplePath = path.join(moduleDir, "..", "..", "fixtures", "rules.example.yaml");
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, rulesPath);
  } else {
    fs.writeFileSync(rulesPath, DEFAULT_RULES_YAML, "utf8");
  }
  return true;
}

export function loadRules(paths: AntibudgetPaths, options?: { createDefault?: boolean }): RulesFile {
  if (options?.createDefault) {
    ensureDefaultRulesFile(paths.rulesPath);
  }
  return loadRulesFromPath(paths.rulesPath);
}

function fieldContains(haystack: string | null, needle: string | undefined): boolean {
  if (!needle) {
    return true;
  }
  if (!haystack) {
    return false;
  }
  return haystack.toUpperCase().includes(needle.toUpperCase());
}

function fieldMatchesRegex(haystack: string | null, pattern: string | undefined): boolean {
  if (!pattern) {
    return true;
  }
  if (!haystack) {
    return false;
  }
  return compileRegex(pattern).test(haystack);
}

function amountSignMatches(amountCents: number, sign: "credit" | "debit" | undefined): boolean {
  if (!sign) {
    return true;
  }
  if (sign === "credit") {
    return amountCents > 0;
  }
  return amountCents < 0;
}

export function ruleMatches(rule: CategorizationRule, tx: TransactionMatchInput): boolean {
  if (!fieldContains(tx.payee, rule.payeeContains)) {
    return false;
  }
  if (!fieldMatchesRegex(tx.payee, rule.payeeRegex)) {
    return false;
  }
  if (!fieldContains(tx.memo, rule.memoContains)) {
    return false;
  }
  if (!fieldMatchesRegex(tx.memo, rule.memoRegex)) {
    return false;
  }
  if (!amountSignMatches(tx.amountCents, rule.amountSign)) {
    return false;
  }
  return true;
}

/** Return all rules that match a transaction (for triage). */
export function findMatchingRules(
  rules: CategorizationRule[],
  tx: TransactionMatchInput,
): RuleMatchResult[] {
  const matches: RuleMatchResult[] = [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (ruleMatches(rule, tx)) {
      matches.push({ rule, index });
    }
  }
  return matches;
}

/** First matching rule in file order. */
export function findFirstMatchingRule(
  rules: CategorizationRule[],
  tx: TransactionMatchInput,
): RuleMatchResult | undefined {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (ruleMatches(rule, tx)) {
      return { rule, index };
    }
  }
  return undefined;
}
