/**
 * Seeded PRNG. BALANCE.md § 1 requires a small explicit implementation and forbids
 * `Math.random()` anywhere in generation — the same seed must always yield the same
 * cluster, forever.
 *
 * mulberry32: 32-bit state, fast, good enough for placement and class rolls.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [0, n). */
  int(n: number): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (n) => Math.floor(next() * n),
  };
}
