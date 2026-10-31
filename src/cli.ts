#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePaths } from "./config.js";
import { ingestOfxPaths } from "./ingest.js";

function printUsage(): void {
  console.error(`Usage: justtrack ingest [file-or-directory]

Environment:
  JUSTTRACK_HOME   Override data directory (default: OS user data path)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command !== "ingest") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const sourcePath = args[1] ? path.resolve(args[1]) : undefined;
  const paths = resolvePaths({ createDirs: true });
  const result = ingestOfxPaths({ paths, sourcePath });

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
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
