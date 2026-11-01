import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AntibudgetPaths {
  home: string;
  inbox: string;
  archive: string;
  dbPath: string;
  rulesPath: string;
}

const APP_DIR_NAME = "antibudget";

function defaultHomeDir(): string {
  const override = process.env.ANTIBUDGET_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(local, APP_DIR_NAME);
  }
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, APP_DIR_NAME);
}

/** Resolve data-directory paths; creates inbox/archive when `createDirs` is true. */
export function resolvePaths(options?: {
  home?: string;
  createDirs?: boolean;
}): AntibudgetPaths {
  const home = options?.home ? path.resolve(options.home) : defaultHomeDir();
  const paths: AntibudgetPaths = {
    home,
    inbox: path.join(home, "inbox"),
    archive: path.join(home, "archive"),
    dbPath: path.join(home, "antibudget.db"),
    rulesPath: path.join(home, "rules.yaml"),
  };

  if (options?.createDirs) {
    fs.mkdirSync(paths.inbox, { recursive: true });
    fs.mkdirSync(paths.archive, { recursive: true });
  }

  return paths;
}

/** Path to committed `fixtures/rules.example.yaml` (present in a git checkout / npm link). */
export function repositoryExampleRulesPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "..", "..", "fixtures", "rules.example.yaml");
}
