import { join } from 'path';
import { makeHarness } from './helpers';

const DATA = join(__dirname, '..', 'data');

describe('full pipeline against the provided files', () => {
  it('produces the expected balances and breaks, and re-ingest is a no-op', () => {
    const h = makeHarness();
    h.recon.reconcile(DATA);
    const first = { balances: h.report.balances(), breaks: h.report.breaks() };

    expect(first.balances.usdtInTransit).toBe('1500.00');
    expect(first.balances.bsProviderAvailable).toBe('12120.95');
    expect(first.balances.bsPaidOutNet).toBe('129505.55');
    expect(first.balances.bsPaidOutGross).toBe('132605.55');
    expect(first.balances.bsReversed).toBe('3100.00');
    expect(first.balances.bsPendingNotFinal).toBe('3900.00');
    expect(first.balances.pendingPayouts).toEqual([{ payoutId: 'P018', amountBs: '3900.00' }]);

    // double-entry invariant: debits == credits per currency
    for (const t of first.balances.trialBalance) expect(t.debits).toBe(t.credits);

    const codes = first.breaks.map((b) => `${b.code}:${b.ref}`).sort();
    expect(codes).toEqual([
      'B10_CONFIRM_STUCK:payout:P018',
      'B11_NEGATIVE_AVAILABLE:window:2026-10-05T16:26:00-04:00..2026-10-05T17:10:00-04:00',
      'B12_REVIEW:payout:P005',
      'B12_REVIEW:payout:P009',
      'B1_DEPOSIT_UNFUNDED:deposit:0x12a750139ca2e4c14287bb6ed9ece9ee75b556a911f19f91c2f0d59ef40e7597',
      'B4_SPREAD:funding_webhook:fw_003',
      'B5_FUNDING_LATE:funding_webhook:fw_004',
      'B7_DUP_IDENTICAL:payout_event:pe_0029',
    ]);

    // idempotency: ingest the same files again -> byte-identical output
    h.recon.reconcile(DATA);
    const second = { balances: h.report.balances(), breaks: h.report.breaks() };
    expect(second).toEqual(first);
  });
});
