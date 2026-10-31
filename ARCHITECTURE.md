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
| **M3** | Local web UI, triage table, Sankey / net worth (deferred) |

Deferred: splits, packaging, bank APIs.

## Milestone 2 (categorization & reports)

| Module | Responsibility |
|--------|----------------|
| `rules.ts` | Load/parse `rules.yaml`, match payee/memo/amount |
| `categorize.ts` | Apply rules; create categories; respect manual overrides |
| `manual.ts` | Set category with `is_manual_override = 1` |
| `reports.ts` | SQL rollups (monthly by category, cashflow series, uncategorized, triage) |

**CLI:** `categorize`, `set-category`, `report monthly|cashflow|uncategorized|triage`. Ingest runs categorization when `rules.yaml` is present.

Example rules: `fixtures/rules.example.yaml` (copy to `ANTIBUDGET_HOME/rules.yaml` or use `antibudget categorize --init-rules`).
