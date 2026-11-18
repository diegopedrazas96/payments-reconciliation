import { makeHarness, payoutEvent } from './helpers';

describe('ledger projection', () => {
  it('is insensitive to arrival order (replay is a deterministic total order)', () => {
    const events = [
      payoutEvent('e1', 'PX', 'PREVIEW', 500, '2026-10-05T10:00:00-04:00'),
      payoutEvent('e2', 'PX', 'CONFIRM', 500, '2026-10-05T10:01:00-04:00'),
      payoutEvent('e3', 'PX', 'COMPLETED', 500, '2026-10-05T10:05:00-04:00'),
      payoutEvent('e4', 'PX', 'REVERSED', 500, '2026-10-05T11:00:00-04:00'),
    ];
    const webhook = {
      event_id: 'fw_x', deposit_tx_hash: '0xabc', amount_usdt: 100, rate: '9.8000',
      amount_bs: 980, timestamp: '2026-10-05T09:00:00-04:00',
    };
    const run = (order: typeof events) => {
      const h = makeHarness();
      h.ingest.ingestDeposits([{ tx_hash: '0xabc', amount_usdt: '100', timestamp: '2026-10-05T08:55:00-04:00' }]);
      h.ingest.ingestFundingWebhooks([webhook]);
      h.ingest.ingestPayoutEvents(order);
      h.ingest.ingestReferenceRates([{ timestamp: '2026-10-05T09:00:00-04:00', usdt_bs: '9.8000' }]);
      h.recon.rebuildAndCheck();
      return { balances: h.report.balances(), breaks: h.report.breaks() };
    };
    const sorted = run(events);
    const shuffled = run([events[3], events[0], events[2], events[1]]);
    expect(shuffled).toEqual(sorted);
    expect(sorted.breaks.filter((b) => b.code === 'B8_INVALID_TRANSITION')).toHaveLength(0);
    expect(sorted.balances.bsPaidOutNet).toBe('0.00'); // completed then reversed
  });

  it('flags same key with a different payload (B6) and keeps the first record', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([
      payoutEvent('dup', 'PY', 'PREVIEW', 100, '2026-10-05T10:00:00-04:00'),
      payoutEvent('dup', 'PY', 'PREVIEW', 999, '2026-10-05T10:00:00-04:00'),
    ]);
    h.recon.rebuildAndCheck();
    const b6 = h.report.breaks().filter((b) => b.code === 'B6_DUP_PAYLOAD_MISMATCH');
    expect(b6).toHaveLength(1);
    expect(b6[0].ref).toBe('payout_event:dup');
    const state = h.dbs.db.prepare(`SELECT amount_bs_cents FROM payout_states WHERE payout_id = 'PY'`).get() as any;
    expect(state.amount_bs_cents).toBe(10000); // first wins
  });

  it('books a COMPLETED without CONFIRM (money moved) but flags B8', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([payoutEvent('o1', 'PZ', 'COMPLETED', 700, '2026-10-05T10:00:00-04:00')]);
    h.recon.rebuildAndCheck();
    expect(h.report.balances().bsPaidOutNet).toBe('700.00');
    const b8 = h.report.breaks().filter((b) => b.code === 'B8_INVALID_TRANSITION');
    expect(b8).toHaveLength(1);
    expect(b8[0].reason).toMatch(/COMPLETED without a prior CONFIRM/);
  });

  it('does NOT book a REVERSED without a COMPLETED, and flags it', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([payoutEvent('r1', 'PR', 'REVERSED', 700, '2026-10-05T10:00:00-04:00')]);
    h.recon.rebuildAndCheck();
    expect(h.report.balances().bsProviderAvailable).toBe('0.00');
    expect(h.report.balances().bsPaidOutNet).toBe('0.00');
    expect(h.report.breaks().some((b) => b.code === 'B8_INVALID_TRANSITION' && /REVERSED without/.test(b.reason))).toBe(true);
  });

  it('detects moments where Bs available goes negative (B11)', () => {
    const h = makeHarness();
    // payout completes at 10:00, funding only arrives at 12:00
    h.ingest.ingestDeposits([{ tx_hash: '0xd', amount_usdt: '100', timestamp: '2026-10-05T08:00:00-04:00' }]);
    h.ingest.ingestFundingWebhooks([{
      event_id: 'fw_l', deposit_tx_hash: '0xd', amount_usdt: 100, rate: '9.8000',
      amount_bs: 980, timestamp: '2026-10-05T12:00:00-04:00',
    }]);
    h.ingest.ingestPayoutEvents([
      payoutEvent('n1', 'PN', 'PREVIEW', 500, '2026-10-05T09:50:00-04:00'),
      payoutEvent('n2', 'PN', 'CONFIRM', 500, '2026-10-05T09:55:00-04:00'),
      payoutEvent('n3', 'PN', 'COMPLETED', 500, '2026-10-05T10:00:00-04:00'),
    ]);
    h.ingest.ingestReferenceRates([{ timestamp: '2026-10-05T08:00:00-04:00', usdt_bs: '9.8000' }]);
    h.recon.rebuildAndCheck();
    const b11 = h.report.breaks().filter((b) => b.code === 'B11_NEGATIVE_AVAILABLE');
    expect(b11).toHaveLength(1);
    expect(b11[0].reason).toMatch(/min -500\.00 Bs/);
    expect(b11[0].ref).toContain('10:00');
    expect(b11[0].ref).toContain('12:00');
    // end state is fine — only the moment was broken
    expect(h.report.balances().bsProviderAvailable).toBe('480.00');
  });

  it('applies the latest reference rate at or before the webhook for the spread check (B4)', () => {
    const h = makeHarness();
    h.ingest.ingestDeposits([{ tx_hash: '0xs', amount_usdt: '100', timestamp: '2026-10-05T09:58:00-04:00' }]);
    h.ingest.ingestFundingWebhooks([{
      event_id: 'fw_s', deposit_tx_hash: '0xs', amount_usdt: 100, rate: '9.7000',
      amount_bs: 970, timestamp: '2026-10-05T10:05:00-04:00',
    }]);
    // 10:00 rate applies (not 09:00): spread vs 9.8000 = 1.02% -> break
    h.ingest.ingestReferenceRates([
      { timestamp: '2026-10-05T09:00:00-04:00', usdt_bs: '9.7100' },
      { timestamp: '2026-10-05T10:00:00-04:00', usdt_bs: '9.8000' },
      { timestamp: '2026-10-05T11:00:00-04:00', usdt_bs: '9.7000' },
    ]);
    h.recon.rebuildAndCheck();
    const b4 = h.report.breaks().filter((b) => b.code === 'B4_SPREAD');
    expect(b4).toHaveLength(1);
    expect(b4[0].reason).toContain('9.8000');
    expect(b4[0].reason).toContain('1.02%');
  });
});
