/**
 * All money is handled as integer minor units ("cents", 2 dp) for both USDT
 * and Bs. Rates are kept as decimal strings and applied with BigInt math;
 * products are rounded half-even to the centavo.
 */

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

/** Parse "31515.05" | 31515.05 -> 3151505 (integer cents). */
export function toCents(value: number | string, field = 'amount'): number {
  const s = String(value).trim();
  if (!AMOUNT_RE.test(s)) throw new Error(`invalid ${field}: ${JSON.stringify(value)}`);
  const neg = s.startsWith('-');
  const [intPart, fracRaw = ''] = (neg ? s.slice(1) : s).split('.');
  let cents: bigint;
  if (fracRaw.length <= 2) {
    cents = BigInt(intPart) * 100n + BigInt((fracRaw + '00').slice(0, 2));
  } else {
    // more precision than the minor unit: round half-even at 2 dp
    cents = roundHalfEvenDiv(BigInt(intPart + fracRaw), 10n ** BigInt(fracRaw.length - 2));
  }
  const out = neg ? -cents : cents;
  if (out > BigInt(Number.MAX_SAFE_INTEGER) || out < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`amount overflow: ${s}`);
  }
  return Number(out);
}

/** Rates scaled to a fixed 1e6 integer, e.g. "9.7606" -> 9760600n. */
export const RATE_SCALE = 1_000_000n;
export function parseRate(value: number | string, field = 'rate'): bigint {
  const s = String(value).trim();
  if (!AMOUNT_RE.test(s) || s.startsWith('-')) throw new Error(`invalid ${field}: ${JSON.stringify(value)}`);
  const [intPart, fracRaw = ''] = s.split('.');
  if (fracRaw.length > 6) throw new Error(`${field} precision > 6 dp unsupported: ${s}`);
  return BigInt(intPart) * RATE_SCALE + BigInt((fracRaw + '000000').slice(0, 6));
}

/** Integer division rounded half-to-even. n, d must be non-negative, d > 0. */
export function roundHalfEvenDiv(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error('roundHalfEvenDiv expects n >= 0, d > 0');
  const q = n / d;
  const r2 = (n % d) * 2n;
  if (r2 > d) return q + 1n;
  if (r2 < d) return q;
  return q % 2n === 0n ? q : q + 1n; // exact tie: round to even
}

/** Expected Bs cents for a conversion: usdtCents x rate, half-even to the centavo. */
export function expectedBsCents(usdtCents: number, rateScaled: bigint): number {
  return Number(roundHalfEvenDiv(BigInt(usdtCents) * rateScaled, RATE_SCALE));
}

/** 1212095 -> "12120.95" (pure integer formatting, no floats). */
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}
