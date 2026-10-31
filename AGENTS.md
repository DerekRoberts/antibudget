# Agent Instructions & Project Guidelines

## Project overview

`justtrack` is a local-first, non-opinionated personal cashflow tracker. It ingests OFX/QFX exports regularly, deduplicates transactions, and (in later milestones) supports categorization and reflection views. It is **not** a zero-based budget app like YNAB.

## Tech stack and constraints

- **Runtime:** Node.js **22.5+** with TypeScript (`strict: true`).
- **Database:** Built-in `node:sqlite` (`DatabaseSync`) only. Do **not** add `sqlite3` or `better-sqlite3`.
- **SQLite:** Open every connection with `PRAGMA journal_mode = DELETE;` and `PRAGMA foreign_keys = ON;` (single-file DB safe for cloud sync folders).
- **Money:** Store amounts as **integer cents** (`INTEGER`), never `REAL`.
- **Data directory:** Default OS user data path (`~/.local/share/justtrack` on Linux; macOS/Windows equivalents). Override with `JUSTTRACK_HOME` for symlinked Drive layouts.
- **CLI / package name:** `justtrack`.

## Core invariants

1. **Idempotent ingestion:** Deduplicate with `PRIMARY KEY (account_id, fitid)` and `INSERT OR IGNORE`. Banks that rotate FITIDs may use a planned `fitid_hash` fallback (M1: column reserved; FITID path must be complete).
2. **Manual override protection (M2+):** Never overwrite `category_id` when `is_manual_override = 1` during rule re-evaluation.
3. **Zero real financial data in git:** Only synthetic fixtures under `fixtures/`. Never commit `.ofx`, `.qfx`, or `.db` from real exports.
4. **Git commits:** Author as the repo owner only. Do **not** add `Co-authored-by:` trailers or generated-by footers.
5. **Verification:** Run `npm test` (or `node --test` after build) before claiming a module is done.

## Layout

- `src/` — config, database, OFX parser, ingest pipeline, CLI.
- `fixtures/` — committed synthetic OFX for tests.
- `test/` — Node native test runner suites.

## Out of scope unless explicitly requested

Web UI, Sankey, rules engine (`rules.yaml` evaluation), net worth, Age of Money, transaction splits, Flatpak/Tauri packaging, bank APIs, importing real user OFX into the repo.
