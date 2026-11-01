# antibudget

Local-first personal **cashflow** tracker: drop bank OFX/QFX exports, deduplicate transactions in SQLite, and (in later milestones) categorize and reflect on spending. **Not** a zero-based budget app — more “where did the money go?” than “give every dollar a job.”

## Requirements

- **Node.js 22.5+** (built-in `node:sqlite` and the native test runner). CI runs latest **22.x** and **25**; **Node 25** is the primary dry-run target.
- npm

## Quick start

```bash
npm install
npm test
npm run build
```

Run the CLI from the build output (Node needs `--experimental-sqlite` until the flag is default):

```bash
node --experimental-sqlite dist/src/cli.js ingest
```

Optional: link the package so `antibudget` is on your `PATH` after each build:

```bash
npm link
antibudget ingest
```

(`npx antibudget` runs the published npm package, not an unlinked git checkout — use `npm link` or `node …/dist/src/cli.js` for local development.)

Copy synthetic exports from `fixtures/` into your inbox for a dry run. **Never commit real `.ofx`, `.qfx`, or `.db` files** — see `.gitignore`.

## First real-data dry run (Node 25)

Use your own OFX/QFX exports locally; keep them out of git.

```bash
git clone https://github.com/MinionTech/antibudget.git
cd antibudget
npm install
npm run build

export ANTIBUDGET_HOME="$HOME/antibudget-data"   # or your Drive symlink
mkdir -p "$ANTIBUDGET_HOME/inbox"
cp fixtures/rules.example.yaml "$ANTIBUDGET_HOME/rules.yaml"
# Edit rules.yaml for your payees before ingesting (ingest auto-categorizes when rules exist)
# Copy real exports into inbox/ (not into the repo)

node --experimental-sqlite dist/src/cli.js ingest
node --experimental-sqlite dist/src/cli.js categorize   # re-apply after rule edits

node --experimental-sqlite dist/src/cli.js serve          # http://127.0.0.1:8080 (127.0.0.1 only; creates an empty DB if needed)
```

Ingest all `.ofx`/`.qfx` in a folder (non-recursive; `~` expands to your home directory). Processed files are moved into `$ANTIBUDGET_HOME/archive`:

```bash
node --experimental-sqlite dist/src/cli.js ingest ~/Documents
```

Use `--recursive` to include subfolders. Shell-style globs work when the path contains `*`, `?`, or a `[...]` character class — quote the pattern so the shell does not expand it first (for example `'~/Downloads/*.qfx'`).

If ingest finds no files, it prints where to drop exports or which path was scanned. **`serve` creates the data directory layout and an empty SQLite database when none exists yet**, so you can open the UI before your first OFX import; the triage page explains how to ingest. **Reports and other transaction-dependent CLI commands** (not `ingest` or `categorize --init-rules`) still require at least one ingested transaction. With no `rules.yaml`, copy `fixtures/rules.example.yaml` to `$ANTIBUDGET_HOME/rules.yaml` and edit it before ingest (or run `categorize --init-rules` only on an empty data dir with no transactions yet).

### Data directory

| Platform | Default path |
|----------|----------------|
| Linux | `~/.local/share/antibudget` |
| macOS | `~/Library/Application Support/antibudget` |
| Windows | `%LOCALAPPDATA%\antibudget` |

Override with **`ANTIBUDGET_HOME`** (useful for a symlink into Google Drive):

```bash
export ANTIBUDGET_HOME="$HOME/Drive/antibudget-data"
mkdir -p "$ANTIBUDGET_HOME/inbox"
cp fixtures/sample.ofx "$ANTIBUDGET_HOME/inbox/"
node --experimental-sqlite dist/src/cli.js ingest
```

Layout: `inbox/` → ingest → `archive/` + `antibudget.db`. Copy `fixtures/rules.example.yaml` to your data dir as `rules.yaml` (or run `node --experimental-sqlite dist/src/cli.js categorize --init-rules`).

```bash
node --experimental-sqlite dist/src/cli.js categorize
node --experimental-sqlite dist/src/cli.js set-category ACCT FITID CategoryName
node --experimental-sqlite dist/src/cli.js report monthly --month 2026-01
node --experimental-sqlite dist/src/cli.js report cashflow
node --experimental-sqlite dist/src/cli.js report uncategorized
node --experimental-sqlite dist/src/cli.js serve
```

## Local with Podman / Docker Compose

From the repo root, build and run the **`dev`** service (web UI on **127.0.0.1:8080** only).

**First run** (empty data volume — `serve` / `compose up` creates an empty DB; ingest when you have exports):

```bash
podman compose up --build
# optional demo data first:
# podman compose run --build --rm dev ingest /app/fixtures/sample.ofx
# or: docker compose up --build
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080).

The fixture ingest above is a **demo dry run** into the persistent `antibudget-data` volume. Before importing real exports, reset demo data with `podman compose down -v` (recreates an empty volume on the next `up`).

**Data:** `ANTIBUDGET_HOME` is `/data` in the container (see `compose.yml`). To import real exports into the named volume:

```bash
podman compose create
podman cp statement.ofx antibudget-dev:/data/inbox/
podman compose run --rm dev ingest
podman compose up -d
```

Or uncomment a host **inbox bind mount** in `compose.yml` (Podman `:U,z` or Docker `:rw` — see comments there), then:

```bash
podman compose run --rm dev ingest
```

Other CLI commands: `podman compose run --rm dev categorize`, etc. Use **`fixtures/`** only for synthetic data in git — never commit real exports.

## Privacy

This repository is public and educational. Use only **`fixtures/sample.ofx`** in git. Keep real financial exports and databases on your machine.

## Docs

- [AGENTS.md](./AGENTS.md) — constraints for AI-assisted development
- [ARCHITECTURE.md](./ARCHITECTURE.md) — schema and milestone map

## License

MIT
