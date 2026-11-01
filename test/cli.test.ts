import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { resolvePaths } from "../src/config.js";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const cliPath = path.join(repoRoot, "dist", "src", "cli.js");

function runCli(home: string, args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--experimental-sqlite", cliPath, ...args],
    {
      env: { ...process.env, ANTIBUDGET_HOME: home },
      encoding: "utf8",
    },
  );
  return { status: result.status, stderr: result.stderr };
}

test("report with unknown subcommand errors before empty-db ingest hint", (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "antibudget-cli-report-"));
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });
  const paths = resolvePaths({ home: tmpHome, createDirs: true });
  openDatabase(paths.dbPath).close();

  const { status, stderr } = runCli(tmpHome, ["report", "not-a-command"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /Unknown report subcommand/);
  assert.doesNotMatch(stderr, /Run "antibudget ingest"/);
});

test("report before data directory exists prints ingest guidance", () => {
  const missingHome = path.join(
    os.tmpdir(),
    `antibudget-cli-no-home-${process.pid}-${Date.now()}`,
  );
  assert.equal(fs.existsSync(missingHome), false);

  const { status, stderr } = runCli(missingHome, ["report", "cashflow"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /antibudget ingest/);
});
