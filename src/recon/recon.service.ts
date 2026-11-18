import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { IngestService } from '../ingest/ingest.service';
import { LedgerService, ReplayBreak } from '../ledger/ledger.service';
import { expectedBsCents, formatCents, parseRate } from '../money';
import {
  AMOUNT_TOLERANCE_CENTS, FUNDING_SLA_MIN, PAYOUT_SLA_MIN, SPREAD_CAP_BP, cutoffMs,
} from '../constants';

/**
 * Cross-record reconciliation checks (the ledger only books facts; this
 * service judges them) + orchestration of ingest -> rebuild -> checks in
 * one transaction.
 */
@Injectable()
export class ReconService {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly ingest: IngestService,
    private readonly ledger: LedgerService,
  ) {}

  /** Full pipeline. Idempotent: same files in => identical projection out. */
  reconcile(dataDir: string): void {
    const cutoff = cutoffMs();
    this.dbs.tx(() => {
      this.ingest.ingestDir(dataDir);
      const replayBreaks = this.ledger.rebuild(cutoff);
      const checkBreaks = this.runChecks(cutoff);
      this.saveBreaks([...replayBreaks, ...checkBreaks]);
    });
  }

  /** For tests that ingest synthetic rows directly. */
  rebuildAndCheck(): void {
    const cutoff = cutoffMs();
    this.dbs.tx(() => {
      const replayBreaks = this.ledger.rebuild(cutoff);
      this.saveBreaks([...replayBreaks, ...this.runChecks(cutoff)]);
    });
  }

  private runChecks(cutoff: number): ReplayBreak[] {
    const db = this.dbs.db;
    const breaks: ReplayBreak[] = [];
    const deposits = db.prepare(`SELECT * FROM raw_deposits WHERE ts_ms <= ? ORDER BY tx_hash`).all(cutoff) as any[];
    const webhooks = db.prepare(`SELECT * FROM raw_funding_webhooks WHERE ts_ms <= ? ORDER BY event_id`).all(cutoff) as any[];
    const byTx = new Map<string, any[]>();
    for (const w of webhooks) {
      byTx.set(w.deposit_tx_hash, [...(byTx.get(w.deposit_tx_hash) ?? []), w]);
    }

    // B1: deposit never funded (judged against the cutoff clock, not "now")
    for (const d of deposits) {
      if (byTx.has(d.tx_hash)) continue;
      const ageMin = (cutoff - d.ts_ms) / 60_000;
      if (ageMin > FUNDING_SLA_MIN) {
        breaks.push({
          code: 'B1_DEPOSIT_UNFUNDED', severity: 'high', ref: `deposit:${d.tx_hash}`,
          reason: `${formatCents(d.amount_usdt_cents)} USDT deposited at ${d.ts} has no funding webhook ${Math.round(ageMin)} min later (SLA ${FUNDING_SLA_MIN} min); funds sit unconverted`,
        });
      }
    }

    const depositByTx = new Map(deposits.map((d) => [d.tx_hash, d]));
    for (const [tx, ws] of byTx) {
      // B2: double funding of one deposit
      if (ws.length > 1) {
        breaks.push({
          code: 'B2_FUNDING_MISMATCH', severity: 'high', ref: `deposit:${tx}`,
          reason: `deposit funded by ${ws.length} webhooks (${ws.map((w: any) => w.event_id).join(', ')}); possible double credit`,
        });
      }
      for (const w of ws) {
        const d = depositByTx.get(tx);
        // B2: webhook without a deposit / amount mismatch
        if (!d) {
          breaks.push({
            code: 'B2_FUNDING_MISMATCH', severity: 'high', ref: `funding_webhook:${w.event_id}`,
            reason: `funding webhook references unknown deposit ${w.deposit_tx_hash}`,
          });
        } else if (d.amount_usdt_cents !== w.amount_usdt_cents) {
          breaks.push({
            code: 'B2_FUNDING_MISMATCH', severity: 'high', ref: `funding_webhook:${w.event_id}`,
            reason: `webhook USDT amount ${formatCents(w.amount_usdt_cents)} != on-chain deposit amount ${formatCents(d.amount_usdt_cents)}`,
          });
        }
        // B5: funding latency
        if (d) {
          const latencyMin = (w.ts_ms - d.ts_ms) / 60_000;
          if (latencyMin > FUNDING_SLA_MIN) {
            breaks.push({
              code: 'B5_FUNDING_LATE', severity: 'medium', ref: `funding_webhook:${w.event_id}`,
              reason: `funding webhook arrived ${Math.round(latencyMin)} min after the deposit (SLA ${FUNDING_SLA_MIN} min); the applied rate drifted with the delay`,
            });
          }
        }
        this.checkConversion(w, breaks);
      }
    }

    // B10 / B12: payout states at cutoff
    const states = db.prepare(`SELECT * FROM payout_states ORDER BY payout_id`).all() as any[];
    for (const s of states) {
      if (s.state === 'CONFIRM' && s.confirm_ms !== null) {
        const waitedMin = (cutoff - s.confirm_ms) / 60_000;
        if (waitedMin > PAYOUT_SLA_MIN) {
          breaks.push({
            code: 'B10_CONFIRM_STUCK', severity: 'medium', ref: `payout:${s.payout_id}`,
            reason: `confirmed ${Math.round(waitedMin)} min before cutoff with no final state (SLA ${PAYOUT_SLA_MIN} min); ${formatCents(s.amount_bs_cents)} Bs in limbo`,
          });
        }
      }
      if (s.state === 'PREVIEW') {
        breaks.push({
          code: 'B12_REVIEW', severity: 'info', ref: `payout:${s.payout_id}`,
          reason: `PREVIEW (${formatCents(s.amount_bs_cents)} Bs) was never confirmed; expires with no financial effect`,
        });
      }
      if (s.state === 'REVERSED') {
        breaks.push({
          code: 'B12_REVIEW', severity: 'info', ref: `payout:${s.payout_id}`,
          reason: `pay-out of ${formatCents(s.amount_bs_cents)} Bs was COMPLETED and later REVERSED; funds returned — confirm with the provider why`,
        });
      }
    }

    // B6 / B7 from the raw layer
    const anomalies = db.prepare(`SELECT * FROM ingest_anomalies ORDER BY kind, ref`).all() as any[];
    for (const a of anomalies) {
      if (a.kind === 'DUP_MISMATCH') breaks.push({ code: 'B6_DUP_PAYLOAD_MISMATCH', severity: 'high', ref: a.ref, reason: a.detail });
      else if (a.kind === 'BAD_ROW') breaks.push({ code: 'B14_BAD_ROW', severity: 'high', ref: a.ref, reason: a.detail });
      else breaks.push({ code: 'B7_DUP_IDENTICAL', severity: 'info', ref: a.ref, reason: a.detail });
    }
    return breaks;
  }

  /** B3 (arithmetic) and B4 (spread vs reference) for one funding webhook. */
  private checkConversion(w: any, breaks: ReplayBreak[]): void {
    const rate = parseRate(w.rate);
    const expected = expectedBsCents(w.amount_usdt_cents, rate);
    if (Math.abs(w.amount_bs_cents - expected) > AMOUNT_TOLERANCE_CENTS) {
      breaks.push({
        code: 'B3_CONVERSION_ARITHMETIC', severity: 'high', ref: `funding_webhook:${w.event_id}`,
        reason: `amount_bs ${formatCents(w.amount_bs_cents)} != amount_usdt x rate = ${formatCents(expected)}`,
      });
    }
    const ref = this.dbs.db
      .prepare(`SELECT rate FROM reference_rates WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1`)
      .get(w.ts_ms) as { rate: string } | undefined;
    if (!ref) {
      breaks.push({
        code: 'B4_SPREAD', severity: 'medium', ref: `funding_webhook:${w.event_id}`,
        reason: `no reference rate at or before ${w.ts}; spread cannot be verified`,
      });
      return;
    }
    const refRate = parseRate(ref.rate);
    if (rate > refRate) {
      breaks.push({
        code: 'B4_SPREAD', severity: 'high', ref: `funding_webhook:${w.event_id}`,
        reason: `applied rate ${w.rate} is ABOVE the reference ${ref.rate}; provider credited more than market — needs review`,
      });
    } else if ((refRate - rate) * 10_000n > SPREAD_CAP_BP * refRate) {
      const spreadPct = (Number(refRate - rate) / Number(refRate)) * 100;
      breaks.push({
        code: 'B4_SPREAD', severity: 'high', ref: `funding_webhook:${w.event_id}`,
        reason: `spread ${spreadPct.toFixed(2)}% vs reference ${ref.rate} exceeds the 0.5% cap (applied rate ${w.rate}); under-credited vs policy`,
      });
    }
  }

  private saveBreaks(breaks: ReplayBreak[]): void {
    const severityRank = { high: 0, medium: 1, info: 2 } as const;
    const ins = this.dbs.db.prepare(`INSERT INTO breaks (code, severity, ref, reason) VALUES (?, ?, ?, ?)`);
    for (const b of [...breaks].sort((a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref))) {
      ins.run(b.code, b.severity, b.ref, b.reason);
    }
  }
}
