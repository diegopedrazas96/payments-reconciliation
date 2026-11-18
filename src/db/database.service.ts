import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';

/**
 * Two layers:
 *  - RAW (facts): append-only, deduplicated by natural key + payload hash.
 *    Survives across ingests; INSERT OR IGNORE makes re-ingest a no-op.
 *  - PROJECTION (judgement): journal/postings/payout_states/breaks are
 *    rebuilt deterministically from RAW on every ingest, inside one
 *    transaction. Same raw facts => byte-identical projection.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_deposits (
  tx_hash           TEXT PRIMARY KEY,
  amount_usdt_cents INTEGER NOT NULL,
  ts                TEXT NOT NULL,
  ts_ms             INTEGER NOT NULL,
  payload_hash      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_funding_webhooks (
  event_id          TEXT PRIMARY KEY,
  deposit_tx_hash   TEXT NOT NULL,
  amount_usdt_cents INTEGER NOT NULL,
  rate              TEXT NOT NULL,
  amount_bs_cents   INTEGER NOT NULL,
  ts                TEXT NOT NULL,
  ts_ms             INTEGER NOT NULL,
  payload_hash      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_payout_events (
  event_id        TEXT PRIMARY KEY,
  payout_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  amount_bs_cents INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL,
  payload_hash    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reference_rates (
  ts    TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  rate  TEXT NOT NULL
);
-- Raw-layer findings (duplicate deliveries); UNIQUE dedups across re-ingests.
CREATE TABLE IF NOT EXISTS ingest_anomalies (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind   TEXT NOT NULL,
  ref    TEXT NOT NULL,
  detail TEXT NOT NULL,
  UNIQUE (kind, ref, detail)
);
-- Projection layer (wiped + rebuilt on every ingest).
CREATE TABLE IF NOT EXISTS journal_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key  TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  occurred_ms INTEGER NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS postings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account      TEXT NOT NULL,
  currency     TEXT NOT NULL CHECK (currency IN ('USDT','BS')),
  side         TEXT NOT NULL CHECK (side IN ('D','C')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);
CREATE TABLE IF NOT EXISTS payout_states (
  payout_id       TEXT PRIMARY KEY,
  state           TEXT NOT NULL,
  amount_bs_cents INTEGER NOT NULL,
  confirm_ms      INTEGER,
  final_ms        INTEGER
);
CREATE TABLE IF NOT EXISTS breaks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high','medium','info')),
  ref      TEXT NOT NULL,
  reason   TEXT NOT NULL
);
`;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: Database.Database;

  constructor(path?: string) {
    this.db = new Database(path ?? process.env.RECON_DB ?? 'recon.db');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** Run fn inside a single SQLite transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
