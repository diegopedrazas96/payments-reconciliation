import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DatabaseService } from '../db/database.service';
import { toCents, parseRate } from '../money';

/**
 * RAW layer. Append-only, deduplicated by natural key:
 *  - key unseen                        -> insert
 *  - key seen, identical payload hash  -> no-op; if the duplicate occurs
 *    within the same file/batch it is recorded as DUP_IDENTICAL (info)
 *  - key seen, different payload hash  -> DUP_MISMATCH (high); first wins
 * Re-ingesting the same files therefore changes nothing (anomalies are
 * UNIQUE-deduplicated too).
 *
 * A row that cannot be parsed (unknown type, negative/garbled amount, bad
 * timestamp) is QUARANTINED as a BAD_ROW anomaly (high-severity break) and
 * the rest of the file is still ingested: one bad row must not hide the
 * whole report.
 */
@Injectable()
export class IngestService {
  constructor(private readonly dbs: DatabaseService) {}

  ingestDir(dir: string): void {
    this.ingestDeposits(parseCsv(readFileSync(join(dir, 'usdt_deposits.csv'), 'utf8')));
    this.ingestFundingWebhooks(JSON.parse(readFileSync(join(dir, 'funding_webhooks.json'), 'utf8')));
    this.ingestPayoutEvents(JSON.parse(readFileSync(join(dir, 'payout_events.json'), 'utf8')));
    this.ingestReferenceRates(parseCsv(readFileSync(join(dir, 'reference_rates.csv'), 'utf8')));
  }

  ingestDeposits(rows: Record<string, string>[]): void {
    const insert = this.dbs.db.prepare(
      `INSERT INTO raw_deposits (tx_hash, amount_usdt_cents, ts, ts_ms, payload_hash)
       VALUES (@tx_hash, @amount_usdt_cents, @ts, @ts_ms, @payload_hash)`,
    );
    const existing = this.dbs.db.prepare(`SELECT payload_hash FROM raw_deposits WHERE tx_hash = ?`);
    const seenInBatch = new Set<string>();
    rows.forEach((r, i) => this.guard('deposit', r.tx_hash ?? `row${i + 1}`, r, () => {
      const rec = {
        tx_hash: req(r.tx_hash, 'tx_hash'),
        amount_usdt_cents: amountCents(r.amount_usdt, 'amount_usdt'),
        ts: req(r.timestamp, 'timestamp'),
        ts_ms: parseTs(r.timestamp),
      };
      this.upsert('deposit', rec.tx_hash, rec, insert, existing, seenInBatch);
    }));
  }

  ingestFundingWebhooks(rows: any[]): void {
    const insert = this.dbs.db.prepare(
      `INSERT INTO raw_funding_webhooks
         (event_id, deposit_tx_hash, amount_usdt_cents, rate, amount_bs_cents, ts, ts_ms, payload_hash)
       VALUES (@event_id, @deposit_tx_hash, @amount_usdt_cents, @rate, @amount_bs_cents, @ts, @ts_ms, @payload_hash)`,
    );
    const existing = this.dbs.db.prepare(`SELECT payload_hash FROM raw_funding_webhooks WHERE event_id = ?`);
    const seenInBatch = new Set<string>();
    rows.forEach((r, i) => this.guard('funding_webhook', r?.event_id ?? `row${i + 1}`, r, () => {
      parseRate(req(r.rate, 'rate')); // validate early
      const rec = {
        event_id: req(r.event_id, 'event_id'),
        deposit_tx_hash: req(r.deposit_tx_hash, 'deposit_tx_hash'),
        amount_usdt_cents: amountCents(r.amount_usdt, 'amount_usdt'),
        rate: String(r.rate),
        amount_bs_cents: amountCents(r.amount_bs, 'amount_bs'),
        ts: req(r.timestamp, 'timestamp'),
        ts_ms: parseTs(r.timestamp),
      };
      this.upsert('funding_webhook', rec.event_id, rec, insert, existing, seenInBatch);
    }));
  }

  ingestPayoutEvents(rows: any[]): void {
    const insert = this.dbs.db.prepare(
      `INSERT INTO raw_payout_events (event_id, payout_id, type, amount_bs_cents, ts, ts_ms, payload_hash)
       VALUES (@event_id, @payout_id, @type, @amount_bs_cents, @ts, @ts_ms, @payload_hash)`,
    );
    const existing = this.dbs.db.prepare(`SELECT payload_hash FROM raw_payout_events WHERE event_id = ?`);
    const seenInBatch = new Set<string>();
    const TYPES = new Set(['PREVIEW', 'CONFIRM', 'COMPLETED', 'FAILED', 'REVERSED']);
    rows.forEach((r, i) => this.guard('payout_event', r?.event_id ?? `row${i + 1}`, r, () => {
      if (!TYPES.has(r.type)) throw new Error(`unknown payout event type: ${JSON.stringify(r.type)}`);
      const rec = {
        event_id: req(r.event_id, 'event_id'),
        payout_id: req(r.payout_id, 'payout_id'),
        type: r.type,
        amount_bs_cents: amountCents(r.amount_bs, 'amount_bs'),
        ts: req(r.timestamp, 'timestamp'),
        ts_ms: parseTs(r.timestamp),
      };
      this.upsert('payout_event', rec.event_id, rec, insert, existing, seenInBatch);
    }));
  }

  ingestReferenceRates(rows: Record<string, string>[]): void {
    const insert = this.dbs.db.prepare(`INSERT INTO reference_rates (ts, ts_ms, rate) VALUES (?, ?, ?)`);
    const existing = this.dbs.db.prepare(`SELECT rate FROM reference_rates WHERE ts = ?`);
    rows.forEach((r, i) => this.guard('reference_rate', r.timestamp || `row${i + 1}`, r, () => {
      const ts = req(r.timestamp, 'timestamp');
      const rate = String(parseRate(req(r.usdt_bs, 'usdt_bs')));
      const prior = existing.get(ts) as { rate: string } | undefined;
      if (!prior) insert.run(ts, parseTs(ts), String(r.usdt_bs));
      else if (String(parseRate(prior.rate)) !== rate) {
        this.anomaly('DUP_MISMATCH', `reference_rate:${ts}`,
          `rate ${r.usdt_bs} differs from previously ingested ${prior.rate}; first-seen rate kept`);
      }
    }));
  }

  /** Run one row's parse/insert; on failure quarantine it instead of aborting the batch. */
  private guard(kind: string, key: string, row: unknown, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.anomaly('BAD_ROW', `${kind}:${key}`,
        `row rejected (${(err as Error).message}); quarantined, not booked: ${JSON.stringify(row)}`);
    }
  }

  private anomaly(kind: string, ref: string, detail: string): void {
    this.dbs.db
      .prepare(`INSERT OR IGNORE INTO ingest_anomalies (kind, ref, detail) VALUES (?, ?, ?)`)
      .run(kind, ref, detail);
  }

  private upsert(
    kind: string,
    key: string,
    rec: Record<string, unknown>,
    insert: import('better-sqlite3').Statement,
    existing: import('better-sqlite3').Statement,
    seenInBatch: Set<string>,
  ): void {
    const payload_hash = hashOf(rec);
    const prior = existing.get(key) as { payload_hash: string } | undefined;
    if (!prior) {
      insert.run({ ...rec, payload_hash });
      seenInBatch.add(key);
      return;
    }
    if (prior.payload_hash !== payload_hash) {
      this.anomaly('DUP_MISMATCH', `${kind}:${key}`,
        `same key delivered with a different payload; first-seen record kept`);
    } else if (seenInBatch.has(key)) {
      this.anomaly('DUP_IDENTICAL', `${kind}:${key}`,
        `byte-identical duplicate delivery in the feed; deduplicated`);
    }
    // identical payload from a previous ingest: silent no-op (idempotent re-ingest)
  }
}

/** Money amounts must be present and non-negative (direction comes from the event type). */
function amountCents(v: unknown, field: string): number {
  const cents = toCents(req(v, field), field);
  if (cents < 0) throw new Error(`negative ${field}: ${v}`);
  return cents;
}

function req(v: unknown, field: string): string {
  if (v === undefined || v === null || v === '') throw new Error(`missing field: ${field}`);
  return String(v);
}

function parseTs(v: unknown): number {
  const ms = Date.parse(String(v));
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${JSON.stringify(v)}`);
  return ms;
}

/** Canonical hash of the normalized record (sorted keys). */
function hashOf(rec: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Minimal CSV parser (no quoted fields in these inputs). */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}
