# antibudget

Local-first personal **cashflow** tracker: drop bank OFX/QFX exports, deduplicate transactions in SQLite, and (in later milestones) categorize and reflect on spending. **Not** a zero-based budget app — more “where did the money go?” than “give every dollar a job.”

## Requirements

- **Node.js 22.5+** (uses built-in `node:sqlite` and the native test runner)
- npm

## Quick start

```bash
npm install
npm test
npm run build
npx antibudget ingest   # reads ~/.local/share/antibudget/inbox (or ANTIBUDGET_HOME)
```

Copy synthetic exports from `fixtures/` into your inbox for a dry run. **Never commit real `.ofx`, `.qfx`, or `.db` files** — see `.gitignore`.

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
npx antibudget ingest
```

Layout: `inbox/` → ingest → `archive/` + `antibudget.db`. Copy `fixtures/rules.example.yaml` to your data dir as `rules.yaml` (or run `npx antibudget categorize --init-rules`).

```bash
npx antibudget categorize              # apply rules to existing transactions
npx antibudget set-category ACCT FITID CategoryName
npx antibudget report monthly --month 2026-01
npx antibudget report cashflow
npx antibudget report uncategorized
npx antibudget serve              # http://127.0.0.1:8080 — triage + reflection UI
```

## Privacy

This repository is public and educational. Use only **`fixtures/sample.ofx`** in git. Keep real financial exports and databases on your machine.

## Docs

- [AGENTS.md](./AGENTS.md) — constraints for AI-assisted development
- [ARCHITECTURE.md](./ARCHITECTURE.md) — schema and milestone map

## License

MIT
