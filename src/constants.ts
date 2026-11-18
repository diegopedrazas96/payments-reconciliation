/** Report cutoff: state as of 2026-10-05 20:00 Bolivia time (UTC-4). */
export const DEFAULT_CUTOFF_ISO = '2026-10-05T20:00:00-04:00';
export const cutoffIso = (): string => process.env.RECON_CUTOFF ?? DEFAULT_CUTOFF_ISO;
/** Fails fast: a malformed cutoff would silently disable every SLA check. */
export const cutoffMs = (): number => {
  const ms = Date.parse(cutoffIso());
  if (Number.isNaN(ms)) throw new Error(`invalid RECON_CUTOFF: ${JSON.stringify(cutoffIso())}`);
  return ms;
};

/** Provider SLAs and policy limits (from the brief). */
export const FUNDING_SLA_MIN = 10;   // webhook normally within 10 min of deposit
export const PAYOUT_SLA_MIN = 15;    // final state normally within 15 min of CONFIRM
export const SPREAD_CAP_BP = 50n;    // spread of up to 0.5% (50 basis points)
export const AMOUNT_TOLERANCE_CENTS = 1; // |amount_bs - usdt*rate| tolerance

export const DATA_DIR_DEFAULT = 'data';
