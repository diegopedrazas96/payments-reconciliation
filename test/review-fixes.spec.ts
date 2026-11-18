import { makeHarness, payoutEvent } from './helpers';
import { cutoffMs } from '../src/constants';

const T = (hhmm: string) => `2026-10-05T${hhmm}:00-04:00`;

describe('robustness fixes', () => {
  it('quarantines bad rows as B14 and still ingests the rest of the file', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([
      payoutEvent('ok1', 'PA', 'PREVIEW', 100, T('10:00')),
      payoutEvent('bad1', 'PA', 'EXPIRED', 100, T('10:01')),     // unknown type
      payoutEvent('bad2', 'PB', 'COMPLETED', -500, T('10:02')),  // negative amount
      payoutEvent('ok2', 'PA', 'CONFIRM', 100, T('10:03')),
      payoutEvent('ok3', 'PA', 'COMPLETED', 100, T('10:05')),
    ]);
    h.recon.rebuildAndCheck();
    const b14 = h.report.breaks().filter((b) => b.code === 'B14_BAD_ROW').map((b) => b.ref).sort();
    expect(b14).toEqual(['payout_event:bad1', 'payout_event:bad2']);
    expect(h.report.balances().bsPaidOutNet).toBe('100.00');
  });

  it('flags a changed reference rate for an existing timestamp (B6) instead of silently ignoring it', () => {
    const h = makeHarness();
    h.ingest.ingestReferenceRates([{ timestamp: T('12:00'), usdt_bs: '9.8348' }]);
    h.ingest.ingestReferenceRates([{ timestamp: T('12:00'), usdt_bs: '9.8348' }]); // identical: no-op
    h.recon.rebuildAndCheck();
    expect(h.report.breaks().filter((b) => b.code === 'B6_DUP_PAYLOAD_MISMATCH')).toHaveLength(0);
    h.ingest.ingestReferenceRates([{ timestamp: T('12:00'), usdt_bs: '9.9999' }]);
    h.recon.rebuildAndCheck();
    const b6 = h.report.breaks().filter((b) => b.code === 'B6_DUP_PAYLOAD_MISMATCH');
    expect(b6.map((b) => b.ref)).toEqual([`reference_rate:${T('12:00')}`]);
  });

  it('orders same-instant events of one payout by lifecycle, not event_id', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([
      payoutEvent('zzz', 'PT', 'PREVIEW', 100, T('15:00')),
      payoutEvent('aaa', 'PT', 'CONFIRM', 100, T('15:00')), // sorts first by id
      payoutEvent('mmm', 'PT', 'COMPLETED', 100, T('15:00')),
    ]);
    h.recon.rebuildAndCheck();
    expect(h.report.breaks().filter((b) => b.code === 'B8_INVALID_TRANSITION' || b.code === 'B10_CONFIRM_STUCK')).toEqual([]);
    expect(h.report.balances().bsPaidOutNet).toBe('100.00');
  });

  it('checks a reversal against the amount actually booked at COMPLETED', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([
      payoutEvent('r1', 'PV', 'PREVIEW', 100, T('10:00')),
      payoutEvent('r2', 'PV', 'CONFIRM', 150, T('10:01')),
      payoutEvent('r3', 'PV', 'COMPLETED', 150, T('10:05')),
      payoutEvent('r4', 'PV', 'REVERSED', 150, T('11:00')),
    ]);
    h.recon.rebuildAndCheck();
    const reversalDrift = h.report.breaks().filter((b) => b.code === 'B9_AMOUNT_DRIFT' && /REVERSED/.test(b.reason));
    expect(reversalDrift).toHaveLength(0);
    expect(h.report.balances().bsPaidOutNet).toBe('0.00');
  });

  it('reports pending exposure at the CONFIRMED amount, not the preview amount', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([
      payoutEvent('p1', 'PP', 'PREVIEW', 3900, T('19:10')),
      payoutEvent('p2', 'PP', 'CONFIRM', 4100, T('19:11')),
    ]);
    h.recon.rebuildAndCheck();
    expect(h.report.balances().bsPendingNotFinal).toBe('4100.00');
    expect(h.report.breaks().some((b) => b.code === 'B9_AMOUNT_DRIFT')).toBe(true);
  });

  it('books a COMPLETED that arrives after FAILED, and flags it', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([
      payoutEvent('f1', 'PF', 'PREVIEW', 500, T('11:50')),
      payoutEvent('f2', 'PF', 'CONFIRM', 500, T('11:51')),
      payoutEvent('f3', 'PF', 'FAILED', 500, T('11:54')),
      payoutEvent('f4', 'PF', 'COMPLETED', 500, T('11:58')),
    ]);
    h.recon.rebuildAndCheck();
    expect(h.report.balances().bsPaidOutNet).toBe('500.00');
    expect(h.report.breaks().some((b) => /COMPLETED after FAILED/.test(b.reason))).toBe(true);
  });

  it('labels a negative window still open at cutoff with the local cutoff time', () => {
    const h = makeHarness();
    h.ingest.ingestPayoutEvents([payoutEvent('w1', 'PW', 'COMPLETED', 100, T('19:00'))]);
    h.recon.rebuildAndCheck();
    const b11 = h.report.breaks().find((b) => b.code === 'B11_NEGATIVE_AVAILABLE');
    expect(b11?.ref).toContain('2026-10-05T20:00:00-04:00');
    expect(b11?.ref).not.toContain('Z');
    expect(b11?.reason).toContain('STILL negative at cutoff');
  });

  it('fails fast on a malformed cutoff instead of silently disabling SLA checks', () => {
    const prev = process.env.RECON_CUTOFF;
    process.env.RECON_CUTOFF = 'not-a-date';
    try {
      expect(() => cutoffMs()).toThrow(/invalid RECON_CUTOFF/);
    } finally {
      if (prev === undefined) delete process.env.RECON_CUTOFF; else process.env.RECON_CUTOFF = prev;
    }
  });
});
