# Architecture

## Purpose

Local-first cashflow tracking from recurring OFX/QFX dumps. Milestone 1 covers storage, parsing, and idempotent CLI ingest. Later milestones add rules, SQL rollups, and a localhost UI.

## Data directory layout

Resolved by `src/config.ts` (default under OS user data; override `ANTIBUDGET_HOME`):

```
<ANTIBUDGET_HOME>/
  antibudget.db         # SQLite (journal_mode=DELETE)
  inbox/                # Drop new .ofx / .qfx here
  archive/              # Processed exports moved here
  rules.yaml            # Categorization rules (see fixtures/rules.example.yaml)
```

## SQLite schema (M1)

| Table | Role |
|-------|------|
| `accounts` | One row per bank `ACCTID` from OFX |
| `categories` | Stub names for future categorization |
| `transactions` | Ledger lines keyed by `(account_id, fitid)` |

**Transactions (high level):**

- `amount_cents` — signed integer cents from OFX `TRNAMT`
- `posted_at` — normalized posting datetime (ISO-8601 UTC string)
- `payee` / `memo` — from NAME/MEMO
- `category_id` — set by rules or manual override
- `is_manual_override`, `is_transfer` — flags for later behavior
- `fitid_hash` — optional future dedup when FITIDs change (M1: stored null; documented fallback)

**Dedup:** `PRIMARY KEY (account_id, fitid)` + `INSERT OR IGNORE`.

## Source modules

| Module | Responsibility |
|--------|----------------|
| `config.ts` | Paths for home, inbox, archive, db, rules file |
| `db.ts` | Schema migration/init, typed helpers |
| `ofx.ts` | OFX v1 SGML + v2 XML parsing |
| `ingest.ts` | Parse files, insert rows, archive inputs, optional post-ingest categorize |
| `cli.ts` | `ingest`, `categorize`, `set-category`, `report` subcommands |

## Milestone map

| Milestone | Delivered |
|-----------|-----------|
| **M1** | Schema, OFX ingest CLI, fixtures, double-import test |
| **M2** | `rules.yaml` engine, categorization SQL, manual override rules, text reports |
| **M3** | `antibudget serve` (127.0.0.1), triage + reflection UI, JSON API |

Deferred: Age of Money computation, full Sankey library, splits, packaging, bank APIs.

## Milestone 2 (categorization & reports)

| Module | Responsibility |
|--------|----------------|
| `rules.ts` | Load/parse `rules.yaml`, match payee/memo/amount |
| `categorize.ts` | Apply rules; create categories; respect manual overrides |
| `manual.ts` | Set category with `is_manual_override = 1` |
| `reports.ts` | SQL rollups (monthly by category, cashflow series, uncategorized, triage) |
| `api.ts` | JSON handlers for UI (categories, triage updates, reports) |
| `server.ts` | Localhost HTTP server and static UI (`static/`) |

**CLI:** `categorize`, `set-category`, `report monthly|cashflow|uncategorized|triage`, **`serve [--port PORT]`**. Ingest runs categorization when `rules.yaml` is present.

## Milestone 3 (localhost UI)

- **`antibudget serve`** — binds **`127.0.0.1`** only (default port **8080**; override with `--port`). Serves `static/` and `/api/*` JSON from existing SQL modules.
- **Quick Triage** (`/triage`) — uncategorized transactions with optional payee filter; category pick persists via `manual.ts` (`is_manual_override = 1`).
- **Reflection** (`/reflection`) — monthly category table, income vs expense bars, lightweight SVG flow for the selected month. **Net worth** uses summed `accounts.ledger_balance_cents` when OFX provides `LEDGERBAL`. **Age of Money** is not computed (stub card + note here).
- **Sankey:** M3 ships a small inline SVG flow chart, not a full Sankey library; richer diagrams remain follow-up work.

Example rules: `fixtures/rules.example.yaml` (copy to `ANTIBUDGET_HOME/rules.yaml` or use `antibudget categorize --init-rules`).
