import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { formatCents } from '../money';
import { cutoffIso } from '../constants';

/**
 * PROJECTION layer: rebuilds the double-entry journal, payout states and
 * replay-derived breaks from the RAW tables, deterministically.
 *
 * Replay order is a TOTAL order: (ts_ms, source priority, lifecycle phase,
 * natural key) with priority deposit(0) < funding webhook(1) < payout
 * event(2), and same-instant payout events ordered PREVIEW < CONFIRM <
 * COMPLETED/FAILED < REVERSED (never by event_id string order), so two
 * rebuilds of the same raw facts are byte-identical regardless of the
 * order in which events originally arrived.
 *
 * Accounts (6, actuals only — the reference rate is a check, never a posting):
 *   USDT  usdt_in_transit (A, Dr-normal)   sent on-chain, not yet converted
 *   USDT  usdt_partner_prefund (Eq, Cr)    source of partner funds
 *   USDT  usdt_converted (sink, Dr)        USDT consumed by conversions
 *   BS    bs_funding (Eq, Cr)              Bs created by conversions
 *   BS    bs_provider_available (A, Dr)    spendable balance at the provider
 *   BS    bs_paid_out (A, Dr)              cumulative paid to QRs, net of reversals
 *
 * Payout state machine: PREVIEW -> CONFIRM -> COMPLETED | FAILED,
 * COMPLETED -> REVERSED. Money moves ONLY at COMPLETED (debit) and
 * REVERSED (credit back). Invalid transitions become breaks, never
 * exceptions: we ingest everything and judge afterwards. When the provider
 * says money moved (COMPLETED without CONFIRM, or after FAILED), we book it
 * AND flag it — the ledger follows the money, the breaks report questions
 * it. A second COMPLETED (after COMPLETED/REVERSED) is flagged but NOT
 * booked: that would double-count.
 */

type Phase = 'NONE' | 'PREVIEW' | 'CONFIRM' | 'COMPLETED' | 'FAILED' | 'REVERSED';
interface PayoutState {
  phase: Phase;
  amount: number | null;          // first-seen amount (baseline for drift checks)
  confirmedAmount: number | null; // amount at CONFIRM (exposure while pending)
  bookedAmount: number | null;    // amount actually debited at COMPLETED
  confirmMs: number | null;
  finalMs: number | null;
}
interface Leg { account: string; currency: 'USDT' | 'BS'; side: 'D' | 'C'; amount: number; }
export interface ReplayBreak { code: string; severity: 'high' | 'medium' | 'info'; ref: string; reason: string; }

const PRIORITY = { deposit: 0, webhook: 1, payout: 2 } as const;
const PHASE_RANK: Record<string, number> = { PREVIEW: 0, CONFIRM: 1, COMPLETED: 2, FAILED: 2, REVERSED: 3 };

interface ReplayEvent {
  kind: keyof typeof PRIORITY;
  key: string;
  tsMs: number;
  ts: string;
  row: any;
}

@Injectable()
export class LedgerService {
  constructor(private readonly dbs: DatabaseService) {}

  /** Wipe and rebuild the projection from RAW. Call inside a transaction. */
  rebuild(cutoffMs: number): ReplayBreak[] {
    const db = this.dbs.db;
    db.exec(`DELETE FROM postings; DELETE FROM journal_entries; DELETE FROM payout_states; DELETE FROM breaks;`);

    const events = this.loadOrderedEvents();
    const breaks: ReplayBreak[] = [];
    const payouts = new Map<string, PayoutState>();

    // Running Bs-available balance, to catch *moments* that don't reconcile
    // (money paid out against funds not yet credited).
    let avail = 0;
    let negSince: { ts: string; min: number } | null = null;
    const closeNegWindow = (endTs: string, atCutoff = false) => {
      if (negSince) {
        breaks.push({
          code: 'B11_NEGATIVE_AVAILABLE', severity: 'high',
          ref: `window:${negSince.ts}..${endTs}`,
          reason: `Bs available was negative from ${negSince.ts} to ${endTs}${atCutoff ? ' and is STILL negative at cutoff' : ''} (min ${formatCents(negSince.min)} Bs): pay-outs completed against funds not yet credited`,
        });
        negSince = null;
      }
    };
    const onBalanceChange = (ts: string) => {
      if (avail < 0 && !negSince) negSince = { ts, min: avail };
      else if (avail < 0 && negSince) negSince.min = Math.min(negSince.min, avail);
      else if (avail >= 0) closeNegWindow(ts);
    };

    for (const e of events) {
      if (e.tsMs > cutoffMs) {
        breaks.push({
          code: 'B13_AFTER_CUTOFF', severity: 'medium', ref: `${e.kind}:${e.key}`,
          reason: `event timestamp ${e.ts} is after the report cutoff; excluded from balances`,
        });
        continue;
      }
      switch (e.kind) {
        case 'deposit':
          this.post(`deposit:${e.key}`, e, `USDT deposit ${short(e.key)}`, [
            { account: 'usdt_in_transit', currency: 'USDT', side: 'D', amount: e.row.amount_usdt_cents },
            { account: 'usdt_partner_prefund', currency: 'USDT', side: 'C', amount: e.row.amount_usdt_cents },
          ]);
          break;
        case 'webhook':
          this.post(`funding:${e.key}`, e, `funding ${e.key} converts ${short(e.row.deposit_tx_hash)}`, [
            { account: 'usdt_converted', currency: 'USDT', side: 'D', amount: e.row.amount_usdt_cents },
            { account: 'usdt_in_transit', currency: 'USDT', side: 'C', amount: e.row.amount_usdt_cents },
            { account: 'bs_provider_available', currency: 'BS', side: 'D', amount: e.row.amount_bs_cents },
            { account: 'bs_funding', currency: 'BS', side: 'C', amount: e.row.amount_bs_cents },
          ]);
          avail += e.row.amount_bs_cents;
          onBalanceChange(e.ts);
          break;
        case 'payout': {
          const moved = this.applyPayoutEvent(e, payouts, breaks);
          if (moved !== 0) { avail += moved; onBalanceChange(e.ts); }
          break;
        }
      }
    }
    closeNegWindow(cutoffIso(), true);

    const saveState = this.dbs.db.prepare(
      `INSERT INTO payout_states (payout_id, state, amount_bs_cents, confirm_ms, final_ms) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [id, st] of [...payouts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      saveState.run(id, st.phase, st.bookedAmount ?? st.confirmedAmount ?? st.amount ?? 0, st.confirmMs, st.finalMs);
    }
    return breaks;
  }

  /** Returns the signed effect on bs_provider_available, in cents. */
  private applyPayoutEvent(e: ReplayEvent, payouts: Map<string, PayoutState>, breaks: ReplayBreak[]): number {
    const { payout_id: pid, type, amount_bs_cents: amount } = e.row;
    const ref = `payout:${pid}:${e.key}`;
    const st: PayoutState = payouts.get(pid) ??
      { phase: 'NONE', amount: null, confirmedAmount: null, bookedAmount: null, confirmMs: null, finalMs: null };
    payouts.set(pid, st);

    // Amount drift across one payout's events (REVERSED has a dedicated check below).
    if (st.amount !== null && amount !== st.amount && type !== 'REVERSED') {
      breaks.push({
        code: 'B9_AMOUNT_DRIFT', severity: 'high', ref,
        reason: `amount ${formatCents(amount)} differs from this pay-out's established amount ${formatCents(st.amount)}`,
      });
    }
    if (st.amount === null) st.amount = amount;

    const invalid = (reason: string, apply: () => number = () => 0): number => {
      breaks.push({ code: 'B8_INVALID_TRANSITION', severity: 'high', ref, reason });
      return apply();
    };

    switch (type) {
      case 'PREVIEW':
        if (st.phase !== 'NONE') return invalid(`PREVIEW after ${st.phase}`);
        st.phase = 'PREVIEW';
        return 0;
      case 'CONFIRM':
        if (st.phase === 'NONE') {
          breaks.push({ code: 'B8_INVALID_TRANSITION', severity: 'medium', ref, reason: 'CONFIRM without a prior PREVIEW' });
          st.phase = 'CONFIRM'; st.confirmMs = e.tsMs; st.confirmedAmount = amount;
          return 0;
        }
        if (st.phase !== 'PREVIEW') return invalid(`CONFIRM after ${st.phase}`);
        st.phase = 'CONFIRM'; st.confirmMs = e.tsMs; st.confirmedAmount = amount;
        return 0;
      case 'COMPLETED': {
        const book = (): number => {
          st.phase = 'COMPLETED'; st.finalMs = e.tsMs; st.bookedAmount = amount;
          this.post(`payout:${pid}:completed:${e.key}`, e, `pay-out ${pid} completed`, [
            { account: 'bs_paid_out', currency: 'BS', side: 'D', amount },
            { account: 'bs_provider_available', currency: 'BS', side: 'C', amount },
          ]);
          return -amount;
        };
        if (st.phase === 'CONFIRM') return book();
        if (st.phase === 'PREVIEW' || st.phase === 'NONE') {
          // Provider says money moved: book it (the ledger follows the money) AND flag it.
          return invalid(`COMPLETED without a prior CONFIRM (was ${st.phase})`, book);
        }
        if (st.phase === 'FAILED') {
          // Same doctrine; no double-count risk since FAILED moved no money.
          return invalid('COMPLETED after FAILED; booked because the provider reports the debit', book);
        }
        return invalid(`COMPLETED after terminal state ${st.phase}; not booked (would double-count)`);
      }
      case 'FAILED':
        if (st.phase === 'CONFIRM') { st.phase = 'FAILED'; st.finalMs = e.tsMs; return 0; }
        if (st.phase === 'PREVIEW' || st.phase === 'NONE') {
          return invalid(`FAILED without a prior CONFIRM (was ${st.phase})`, () => {
            st.phase = 'FAILED'; st.finalMs = e.tsMs; return 0;
          });
        }
        return invalid(`FAILED after terminal state ${st.phase}`);
      case 'REVERSED': {
        if (st.phase !== 'COMPLETED') return invalid(`REVERSED without a prior COMPLETED (was ${st.phase}); not booked`);
        if (st.bookedAmount !== null && amount !== st.bookedAmount) {
          breaks.push({
            code: 'B9_AMOUNT_DRIFT', severity: 'high', ref,
            reason: `REVERSED amount ${formatCents(amount)} differs from COMPLETED amount ${formatCents(st.bookedAmount)}; reversal booked at its own amount`,
          });
        }
        st.phase = 'REVERSED'; st.finalMs = e.tsMs;
        this.post(`payout:${pid}:reversed:${e.key}`, e, `pay-out ${pid} reversed`, [
          { account: 'bs_provider_available', currency: 'BS', side: 'D', amount },
          { account: 'bs_paid_out', currency: 'BS', side: 'C', amount },
        ]);
        return amount;
      }
      default:
        return invalid(`unknown event type ${type}`);
    }
  }

  /** Insert one journal entry; asserts sum(D) == sum(C) per currency. */
  private post(sourceKey: string, e: ReplayEvent, description: string, legs: Leg[]): void {
    const perCurrency = new Map<string, number>();
    for (const l of legs) {
      perCurrency.set(l.currency, (perCurrency.get(l.currency) ?? 0) + (l.side === 'D' ? l.amount : -l.amount));
    }
    for (const [ccy, net] of perCurrency) {
      if (net !== 0) throw new Error(`unbalanced entry ${sourceKey}: ${ccy} off by ${net} cents`);
    }
    const { lastInsertRowid } = this.dbs.db
      .prepare(`INSERT INTO journal_entries (source_key, occurred_at, occurred_ms, description) VALUES (?, ?, ?, ?)`)
      .run(sourceKey, e.ts, e.tsMs, description);
    const ins = this.dbs.db
      .prepare(`INSERT INTO postings (entry_id, account, currency, side, amount_cents) VALUES (?, ?, ?, ?, ?)`);
    for (const l of legs) ins.run(lastInsertRowid, l.account, l.currency, l.side, l.amount);
  }

  private loadOrderedEvents(): ReplayEvent[] {
    const db = this.dbs.db;
    const events: ReplayEvent[] = [];
    for (const row of db.prepare(`SELECT * FROM raw_deposits`).all() as any[]) {
      events.push({ kind: 'deposit', key: row.tx_hash, tsMs: row.ts_ms, ts: row.ts, row });
    }
    for (const row of db.prepare(`SELECT * FROM raw_funding_webhooks`).all() as any[]) {
      events.push({ kind: 'webhook', key: row.event_id, tsMs: row.ts_ms, ts: row.ts, row });
    }
    for (const row of db.prepare(`SELECT * FROM raw_payout_events`).all() as any[]) {
      events.push({ kind: 'payout', key: row.event_id, tsMs: row.ts_ms, ts: row.ts, row });
    }
    return events.sort((a, b) =>
      a.tsMs - b.tsMs ||
      PRIORITY[a.kind] - PRIORITY[b.kind] ||
      (a.kind === 'payout' && b.kind === 'payout' ? PHASE_RANK[a.row.type] - PHASE_RANK[b.row.type] : 0) ||
      a.key.localeCompare(b.key));
  }
}

function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…` : hash;
}
