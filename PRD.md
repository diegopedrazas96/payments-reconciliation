# PRD — Payments Reconciliation Service

**Owner:** Diego Pedrazas · **Date:** 2026-11-17

## 1. Problem

A partner prefunds Rampa in **USDT**. A local provider converts it to **Bolivianos (Bs)** (market reference rate at webhook time, minus a spread of up to 0.5%) and holds a Bs balance used to pay Bolivian QR codes. Every movement must be accounted for in a double-entry ledger, and anything that doesn't match must surface in a breaks report. Webhooks can be duplicated and arrive out of order; re-ingesting the same files must change nothing.

## 2. Goals / Non-goals

**Goals**
- Ingest the four input files idempotently (re-ingest ⇒ identical balances and report).
- Record every movement in a double-entry ledger covering USDT and Bs.
- Report, as of **2026-10-05 20:00 (UTC−4)**: USDT sent but not converted; Bs available; Bs paid out; Bs in pay-outs not yet final.
- Produce a breaks report: every event, record or *moment* that doesn't reconcile, with the reason.

**Non-goals (timebox):** auth, live webhook endpoints, multi-day/multi-partner, persistence beyond SQLite, FX spread P&L accounting (spread is a *reconciliation check*, not a bookkeeping fact).

## 3. Inputs

| File | Key | Content |
|---|---|---|
| `data/usdt_deposits.csv` | `tx_hash` | on-chain USDT transfers to provider wallet |
| `data/funding_webhooks.json` | `event_id` | provider confirms deposit converted (`rate`, `amount_bs`) |
| `data/payout_events.json` | `event_id` | pay-out lifecycle events (PREVIEW/CONFIRM/COMPLETED/FAILED/REVERSED) |
| `data/reference_rates.csv` | `timestamp` | hourly market rate; use latest at or before an event |

## 4. Architecture

NestJS + **SQLite** (`better-sqlite3`, raw SQL, no ORM). Two layers:

1. **Raw layer (facts):** append-only tables, one per file, deduplicated by natural key with a `payload_hash`. `INSERT OR IGNORE`: a byte-identical duplicate is a silent no-op (noted info-level); the same key with a *different* payload is a high-severity break and the first-seen record wins.
2. **Projection layer (judgement):** on every ingest the journal, payout states and breaks are **rebuilt deterministically** from the raw layer inside one transaction. Same raw facts ⇒ byte-identical ledger ⇒ idempotency by construction. Out-of-order delivery is solved once at replay time, not per-handler.

**Replay order (total order):** `(timestamp, source priority: deposit < funding webhook < payout event, lifecycle phase PREVIEW < CONFIRM < COMPLETED/FAILED < REVERSED, natural key)` — same-instant events never depend on event_id string order.

**Bad rows** (unknown type, negative or garbled amount, bad timestamp) are quarantined as a high-severity break and the rest of the file is still ingested. A changed reference rate for an already-ingested timestamp is treated like any other same-key/different-payload delivery (B6).

Modules: `db` (schema + tx helpers) · `ingest` (parsers, raw store) · `ledger` (replay, postings, payout state machine) · `recon` (breaks) · `report` (balances, HTTP). Surfaces: `POST /ingest`, `GET /balances`, `GET /breaks`, plus a thin CLI (`npm run reconcile`) that ingests `data/` and writes `output/run.json`.

## 5. Money representation

Integer **minor units** (centavos, 2 dp) for both USDT and Bs; rates kept as decimal strings, applied with integer math. Expected Bs for a conversion = round-half-even(`amount_usdt` × `rate`); mismatch break when |actual − expected| > 1 centavo.

## 6. Ledger model

Each journal entry is keyed by a unique `source_key` and must satisfy **Σ debits = Σ credits per currency** (asserted in code; trial balance test).

| Event | Posting |
|---|---|
| USDT deposit | Dr `usdt_in_transit` / Cr `usdt_partner_prefund` (USDT) |
| Funding webhook | Dr `usdt_converted` / Cr `usdt_in_transit` (USDT) **and** Dr `bs_provider_available` / Cr `bs_funding` (Bs, actual `amount_bs`) |
| Pay-out COMPLETED | Dr `bs_paid_out` / Cr `bs_provider_available` |
| Pay-out REVERSED | Dr `bs_provider_available` / Cr `bs_paid_out` |
| PREVIEW / CONFIRM / FAILED | **no entry** — the provider reserves nothing before COMPLETED |

Only actual amounts are booked. The reference rate and 0.5% spread cap are *checks* (breaks), never ledger postings — a stale reference rate must be able to corrupt a report, not the books.

**Pay-out state machine:** PREVIEW → CONFIRM → COMPLETED | FAILED; COMPLETED → REVERSED. Applied in replay order; an invalid transition produces a break, never an exception ("ingest everything, judge afterwards").

## 7. Balances (as of cutoff 20:00)

| Figure | Source |
|---|---|
| USDT sent, not converted | balance of `usdt_in_transit` |
| Bs available at provider | balance of `bs_provider_available` |
| Bs paid out | balance of `bs_paid_out` (**net of reversals**; gross and reversed shown as sub-lines) |
| Bs in pay-outs not yet final | query: Σ `amount_bs` of pay-outs whose latest state at cutoff is CONFIRM (not a ledger account — nothing is reserved) |

## 8. Breaks catalogue

| # | Rule | Severity |
|---|---|---|
| B1 | Deposit with no funding webhook after 10 min (evaluated against the cutoff clock) | high |
| B2 | Funding webhook with no matching deposit / USDT amount mismatch / 2nd webhook for same tx | high |
| B3 | `amount_bs` ≠ `amount_usdt` × `rate` (> 1 centavo) | high |
| B4 | Rate spread vs reference (latest ≤ webhook ts) > 0.5%, or rate above reference | high |
| B5 | Funding latency > 10 min | medium |
| B6 | Same key, different payload | high |
| B7 | Byte-identical duplicate event (deduped) | info |
| B8 | Invalid pay-out transition (final w/o CONFIRM, two finals, REVERSED w/o COMPLETED, event after final) | high |
| B9 | Amount drift across one pay-out's events / REVERSED amount ≠ COMPLETED amount | high |
| B10 | CONFIRM with no final state > 15 min at cutoff | medium |
| B11 | **Bs available negative at any moment** (running-balance replay) | high |
| B12 | REVERSED after COMPLETED (valid but needs human review) / PREVIEW expired unconfirmed | info |
| B13 | Event timestamp after the 20:00 cutoff (excluded from balances) | medium |
| B14 | Input row rejected at ingest (unknown type, negative/garbled amount, bad timestamp) — quarantined, not booked | high |

## 9. Acceptance (expected output on `data/`)

Balances: USDT in transit **1,500.00** · Bs available **12,120.95** · Bs paid out net **129,505.55** (gross 132,605.55, reversed 3,100.00) · Bs pending **3,900.00**.
Breaks: `0x12a7…` unfunded 1,500 USDT (B1); `fw_003` spread 1.20% (B4); `fw_004` latency 145 min (B5); duplicate `pe_0029` (B7); `P018` stuck at CONFIRM 49 min (B10); **available −2,480.55 Bs from 16:26 to 17:10** (B11 — P014 completed before late `fw_004` credit); `P005` reversal and `P009` expired preview (B12). Nothing else.

## 10. Tests

Re-ingest twice ⇒ identical output · same-key-different-payload ⇒ B6 · shuffled event order ⇒ same result · same-instant lifecycle ordering · negative-available detection · per-currency trial balance = 0 · rate lookup & rounding tolerance · bad-row quarantine · reversal checked against booked amount · pending at confirmed amount · malformed cutoff fails fast.

## 11. Scaling path

Postgres with the same two-layer model; real signed webhook endpoints + outbox; incremental projection with event versioning instead of full rebuild; decimal library at API edges; multi-day/multi-partner account dimensions; alerting on high-severity breaks; audit trail of ingests.
