/**
 * UI.md § Number formatting, asserted. The rules are specific and easy to get subtly wrong,
 * and a jittering or over-precise digit is the fastest way to make this game feel cheap.
 */

import { describe, expect, test } from 'vitest';
import { amount, clock, duration, latency, rate } from './format';

describe('amounts', () => {
  test('one decimal below 10, because the first few units matter', () => {
    expect(amount(0)).toBe('0.0');
    expect(amount(0.6)).toBe('0.6');
    expect(amount(4.24)).toBe('4.2');
    expect(amount(9.94)).toBe('9.9');
  });

  test('integers with separators from 10 to 9,999', () => {
    expect(amount(10)).toBe('10');
    expect(amount(1240)).toBe('1,240');
    expect(amount(9999)).toBe('9,999');
  });

  test('one decimal and K from 10,000', () => {
    expect(amount(10_000)).toBe('10.0K');
    expect(amount(24_600)).toBe('24.6K');
    expect(amount(999_000)).toBe('999.0K');
  });

  test('rolls to M before it could ever print 1000.0K', () => {
    expect(amount(999_949)).toBe('999.9K');
    expect(amount(999_950)).toBe('1.00M');
    expect(amount(1_240_000)).toBe('1.24M');
  });

  test('two decimals for M, B and T', () => {
    expect(amount(3.05e9)).toBe('3.05B');
    expect(amount(1.5e12)).toBe('1.50T');
  });

  test('never exceeds four significant figures', () => {
    for (const value of [9.99, 9999, 24_600, 999_949, 1_240_000, 3.05e9]) {
      const digits = amount(value).replace(/[^0-9]/g, '');
      expect(digits.length).toBeLessThanOrEqual(4);
    }
  });

  test('handles negatives and infinities without producing nonsense', () => {
    expect(amount(-1240)).toBe('-1,240');
    expect(amount(-0.5)).toBe('-0.5');
    expect(amount(Infinity)).toBe('—');
    expect(amount(NaN)).toBe('—');
  });
});

describe('rates', () => {
  test('precision narrows as the number grows', () => {
    expect(rate(0.83)).toBe('0.83/s');
    expect(rate(4.2)).toBe('4.20/s');
    expect(rate(42)).toBe('42.0/s');
    expect(rate(310)).toBe('310/s');
  });

  test('never renders as zero — that is idle', () => {
    expect(rate(0)).toBe('idle');
    expect(rate(0.0001)).toBe('idle');
    expect(rate(-0.0001)).toBe('idle');
    // Just above the threshold it is a real number again.
    expect(rate(0.006)).toBe('0.01/s');
  });

  test('negative rates keep their sign, since consuming faster than producing is normal', () => {
    expect(rate(-4.2)).toBe('-4.20/s');
  });
});

describe('durations', () => {
  test('the documented shapes', () => {
    expect(duration(252)).toBe('4m 12s');
    expect(duration(7560)).toBe('2h 06m');
    expect(duration(Infinity)).toBe('—');
  });

  test('pads so digits do not shift as time passes', () => {
    expect(duration(65)).toBe('1m 05s');
    expect(duration(3660)).toBe('1h 01m');
  });

  test('seconds alone below a minute', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(59)).toBe('59s');
  });
});

describe('other readouts', () => {
  test('the clock is stable width past the first hour', () => {
    expect(clock(0)).toBe('0:00:00');
    expect(clock(3661)).toBe('1:01:01');
  });

  test('latency reads as the inspector states it', () => {
    expect(latency(18.75)).toBe('18.8s one way');
  });
});
