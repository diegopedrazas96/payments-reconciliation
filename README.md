# Payments Reconciliation

A small NestJS service that ingests one day of USDT→Bs operations, records every
movement in a **double-entry ledger**, and surfaces everything that doesn't
reconcile. See [PRD.md](PRD.md) for the full design; this file covers how to run
it and the decisions you'll want to probe.

## Run it

```bash
npm install
npm test            # 19 tests: money math, state machine, replay, robustness, full pipeline
npm run reconcile   # CLI: ingests data/, prints the report, writes output/run.json
npm start           # HTTP: POST /ingest · GET /balances · GET /breaks (port 3000)
```

`npm run reconcile` twice in a row produces byte-identical output (the SQLite db
`recon.db` persists between runs — that's the point). Delete `recon.db` to start
fresh. Output of a real run is committed at [`output/run.json`](output/run.json).

## Result on the provided files

Balances as of 2026-10-05 20:00 (UTC−4):

| Figure | Amount |
|---|---|
| USDT sent, not yet converted | **1,500.00** |
| Bs available at provider | **12,120.95** |
| Bs paid out (net of reversals) | **129,505.55** (gross 132,605.55, reversed 3,100.00) |
| Bs in pay-outs not yet final | **3,900.00** (P018) |

8 breaks, including: a 1,500 USDT deposit never funded (B1); `fw_003` converted at a
1.20% spread, over the 0.5% cap (B4); `fw_004` arrived 145 min
late (B5); and — the interesting one — **Bs available was negative from 16:26 to
17:10** (min −2,480.55): pay-out P014 (31,515.05 Bs) completed before the delayed
funding webhook credited the balance (B11). End-of-day balances look fine; only a
running replay catches that moment.

## Ledger model

Two layers, one idea: **facts first, judgement second.**

1. **Raw layer** — one append-only table per input file, keyed by natural key
   (`tx_hash`, `event_id`) with a payload hash. Re-delivery of an identical
   payload is a no-op; the same key with a *different* payload is a high-severity
   break (first record wins). Re-ingesting the same files changes nothing, by
   construction.
2. **Projection layer** — journal, pay-out states and breaks are **wiped and
   rebuilt deterministically** from the raw layer on every ingest, in one
   transaction. Replay follows a *total* order: `(timestamp, source priority
   deposit < funding < payout, lifecycle phase, natural key)` — so arrival order
   never matters, and same-instant events of one pay-out replay as PREVIEW <
   CONFIRM < COMPLETED/FAILED < REVERSED rather than by event_id.

Six accounts; every entry balances per currency (asserted in code and by a trial
balance test):

| Event | Posting |
|---|---|
| USDT deposit | Dr `usdt_in_transit` / Cr `usdt_partner_prefund` |
| Funding webhook | Dr `usdt_converted` / Cr `usdt_in_transit` + Dr `bs_provider_available` / Cr `bs_funding` |
| Pay-out COMPLETED | Dr `bs_paid_out` / Cr `bs_provider_available` |
| Pay-out REVERSED | Dr `bs_provider_available` / Cr `bs_paid_out` |
| PREVIEW · CONFIRM · FAILED | no entry — the provider reserves nothing before COMPLETED |

Deliberate choices:

- **Only actuals are booked.** The reference rate and the 0.5% spread cap are
  reconciliation *checks* (breaks B3/B4), never postings — a stale reference rate
  must be able to corrupt a report, not the books.
- **"Bs pending" is a query, not an account** (pay-outs whose latest state at the
  cutoff is CONFIRM). Nothing is reserved, so nothing is posted.
- **Money is integer minor units** (centavos) end to end; products round
  half-to-even at the centavo; mismatch tolerance is 1 centavo.
- **Invalid transitions are breaks, not exceptions.** A COMPLETED with no CONFIRM
  (or after FAILED) is still booked — the provider says money moved, so the
  ledger follows the money and the breaks report questions it. A second
  COMPLETED is *not* booked (it would double-count), nor is a REVERSED with no
  COMPLETED — there is nothing to return. Reversals are checked against the
  amount actually booked; pending exposure uses the confirmed amount.
- **Bad input rows are quarantined, not fatal.** An unknown event type or a
  negative/garbled amount becomes a B14 break and the rest of the file is still
  ingested. A malformed `RECON_CUTOFF` fails fast — silently disabling the SLA
  checks would be worse than crashing.

## Duplicates & out-of-order events

- Duplicate delivery, identical payload → deduped at the raw layer; reported
  info-level (`pe_0029` in the data).
- Duplicate key, different payload → high-severity break; first-seen wins. This
  includes reference rates: a re-published rate for an existing hour is flagged,
  never silently ignored.
- Out-of-order arrival → irrelevant: the projection replays everything in the
  total order above. The pay-out state machine (PREVIEW → CONFIRM → COMPLETED |
  FAILED; COMPLETED → REVERSED) is applied in event-time order, and shuffling the
  input is covered by a test.

## Scaling path

The design already separates the parts that scale independently, so growing it
is additive, not a rewrite:

- **Storage** — the two-layer model maps 1:1 onto Postgres; the raw tables
  become the write path of signed webhook endpoints (idempotency keys already
  exist as natural keys), with an outbox feeding downstream consumers.
- **Projection** — full rebuild stays as the audit/repair path; high-volume
  operation adds an incremental, event-versioned projection on top of the same
  replay order.
- **Dimensions** — cutoff and business day become request parameters; accounts
  gain partner and provider dimensions for multi-day, multi-counterparty books.
- **Operations** — high-severity breaks feed alerting and an assign/resolve
  workflow; every ingest batch is recorded for audit.
- **Money at the edges** — integer minor units internally already; API
  boundaries add a decimal type (`decimal.js` / DB numerics), and the money math
  gains property-based tests.
