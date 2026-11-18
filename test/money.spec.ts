import { expectedBsCents, formatCents, parseRate, roundHalfEvenDiv, toCents } from '../src/money';

describe('money (integer minor units)', () => {
  it('parses amounts to integer cents without float drift', () => {
    expect(toCents('31515.05')).toBe(3151505);
    expect(toCents(9990.0)).toBe(999000);
    expect(toCents('4350.5')).toBe(435050);
    expect(toCents('0.1')).toBe(10);
    expect(() => toCents('12,50')).toThrow(/invalid/);
  });

  it('rounds half-to-even at the centavo', () => {
    expect(roundHalfEvenDiv(25n, 10n)).toBe(2n);  // 2.5 -> 2 (even)
    expect(roundHalfEvenDiv(35n, 10n)).toBe(4n);  // 3.5 -> 4 (even)
    expect(roundHalfEvenDiv(26n, 10n)).toBe(3n);
    expect(toCents('1.005')).toBe(100);           // tie at 2dp -> even
    expect(toCents('1.015')).toBe(102);
  });

  it('computes expected Bs from usdt x rate exactly', () => {
    // the four real conversions are exact
    expect(expectedBsCents(toCents('5000.00'), parseRate('9.7945'))).toBe(toCents('48972.50'));
    expect(expectedBsCents(toCents('2500.00'), parseRate('9.7606'))).toBe(toCents('24401.50'));
    // a non-exact product rounds to the centavo: 1234.56 * 9.8467 = 12156.341952 -> 12156.34 Bs
    expect(expectedBsCents(toCents('1234.56'), parseRate('9.8467'))).toBe(1215634);
  });

  it('formats cents without floats', () => {
    expect(formatCents(1212095)).toBe('12120.95');
    expect(formatCents(-248055)).toBe('-2480.55');
    expect(formatCents(5)).toBe('0.05');
  });
});
