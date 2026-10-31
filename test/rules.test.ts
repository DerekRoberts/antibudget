import assert from "node:assert/strict";
import test from "node:test";

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
