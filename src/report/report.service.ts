import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { formatCents } from '../money';
import { DEFAULT_CUTOFF_ISO } from '../constants';

export interface BalancesReport {
  asOf: string;
  usdtInTransit: string;
  bsProviderAvailable: string;
  bsPaidOutNet: string;
  bsPaidOutGross: string;
  bsReversed: string;
  bsPendingNotFinal: string;
  pendingPayouts: { payoutId: string; amountBs: string }[];
  trialBalance: { currency: string; debits: string; credits: string }[];
}

@Injectable()
export class ReportService {
  constructor(private readonly dbs: DatabaseService) {}

  balances(): BalancesReport {
    const bal = (account: string, side: 'D' | 'C'): number => {
      const row = this.dbs.db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN side = ? THEN amount_cents ELSE -amount_cents END), 0) AS b
         FROM postings WHERE account = ?`,
      ).get(side, account) as { b: number };
      return row.b;
    };
    const sumSide = (account: string, side: 'D' | 'C'): number => {
      const row = this.dbs.db.prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM postings WHERE account = ? AND side = ?`,
      ).get(account, side) as { s: number };
      return row.s;
    };
    const pending = this.dbs.db.prepare(
      `SELECT payout_id, amount_bs_cents FROM payout_states WHERE state = 'CONFIRM' ORDER BY payout_id`,
    ).all() as { payout_id: string; amount_bs_cents: number }[];
    const trial = this.dbs.db.prepare(
      `SELECT currency,
              SUM(CASE WHEN side = 'D' THEN amount_cents ELSE 0 END) AS debits,
              SUM(CASE WHEN side = 'C' THEN amount_cents ELSE 0 END) AS credits
       FROM postings GROUP BY currency ORDER BY currency`,
    ).all() as { currency: string; debits: number; credits: number }[];

    return {
      asOf: process.env.RECON_CUTOFF ?? DEFAULT_CUTOFF_ISO,
      usdtInTransit: formatCents(bal('usdt_in_transit', 'D')),
      bsProviderAvailable: formatCents(bal('bs_provider_available', 'D')),
      bsPaidOutNet: formatCents(bal('bs_paid_out', 'D')),
      bsPaidOutGross: formatCents(sumSide('bs_paid_out', 'D')),
      bsReversed: formatCents(sumSide('bs_paid_out', 'C')),
      bsPendingNotFinal: formatCents(pending.reduce((s, p) => s + p.amount_bs_cents, 0)),
      pendingPayouts: pending.map((p) => ({ payoutId: p.payout_id, amountBs: formatCents(p.amount_bs_cents) })),
      trialBalance: trial.map((t) => ({
        currency: t.currency, debits: formatCents(t.debits), credits: formatCents(t.credits),
      })),
    };
  }

  breaks(): { code: string; severity: string; ref: string; reason: string }[] {
    return this.dbs.db
      .prepare(`SELECT code, severity, ref, reason FROM breaks ORDER BY id`)
      .all() as any[];
  }
}
