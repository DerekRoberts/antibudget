import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePaths } from "../src/config.js";
import { getOrCreateCategory, openDatabase } from "../src/db.js";
import { parseRulesYaml } from "../src/rules.js";

test("parseRulesYaml rejects invalid regex", () => {
  assert.throws(
    () =>
      parseRulesYaml(`
rules:
  - category: X
    payee_regex: "[invalid"
`),
    /valid regular expression/,
  );
});

test("parseRulesYaml requires at least one matcher", () => {
  assert.throws(
    () =>
      parseRulesYaml(`
rules:
  - category: Empty
`),
    /at least one of/,
  );
});

test("getOrCreateCategory rejects empty names", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-cat-empty-"));
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  const db = openDatabase(paths.dbPath);
  assert.throws(() => getOrCreateCategory(db, "   "), /must not be empty/);
  db.close();
});
