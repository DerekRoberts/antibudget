# justtrack

Local-first personal **cashflow** tracker: drop bank OFX/QFX exports, deduplicate transactions in SQLite, and (in later milestones) categorize and reflect on spending. This is **not** a zero-based budget app.

## Requirements

- **Node.js 22.5+** (uses built-in `node:sqlite` and the native test runner)
- npm

## Quick start

```bash
npm install
npm test
npm run build
npx justtrack ingest   # reads ~/.local/share/justtrack/inbox (or JUSTTRACK_HOME)
```

Copy synthetic exports from `fixtures/` into your inbox for a dry run. **Never commit real `.ofx`, `.qfx`, or `.db` files** — see `.gitignore`.

### Data directory

| Platform | Default path |
|----------|----------------|
| Linux | `~/.local/share/justtrack` |
| macOS | `~/Library/Application Support/justtrack` |
| Windows | `%LOCALAPPDATA%\justtrack` |

Override with **`JUSTTRACK_HOME`** (useful for a symlink into Google Drive):

```bash
export JUSTTRACK_HOME="$HOME/Drive/justtrack-data"
mkdir -p "$JUSTTRACK_HOME/inbox"
cp fixtures/sample.ofx "$JUSTTRACK_HOME/inbox/"
npx justtrack ingest
```

Layout: `inbox/` (new exports) → ingest → `archive/` + `justtrack.db`. A `rules.yaml` path is reserved for Milestone 2.

## Privacy

This repository is public and educational. Use only **`fixtures/sample.ofx`** in git. Keep real financial exports and databases on your machine.

## Docs

- [AGENTS.md](./AGENTS.md) — constraints for AI-assisted development
- [ARCHITECTURE.md](./ARCHITECTURE.md) — schema and milestone map

## License

MIT
