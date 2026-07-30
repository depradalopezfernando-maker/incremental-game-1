/**
 * Phase 1 acceptance for generation. ROADMAP.md Phase 1 and BALANCE.md § Seed guarantees.
 */

import { describe, expect, test } from 'vitest';
import {
  CLASS_RESOURCE,
  GUARANTEED_GTYPE_MAX_D,
  GUARANTEED_GTYPE_MIN_D,
  GUARANTEED_ROCKY_MAX_D,
  INITIAL_METALS,
  INITIAL_SCAN_RANGE,
  ISOTOPE_EXCLUSION_RADIUS,
  MIN_STAR_SEPARATION,
  MIN_STARS_IN_INITIAL_SCAN,
  ORIGIN_MAX_DISTANCE,
  ORIGIN_RESERVE,
  clusterRadius,
  starCount,
} from './constants';
import { generateRun, newGame } from './generate';
import { RESOURCE_INDEX, type RunState } from './types';

const SEEDS = Array.from({ length: 120 }, (_, i) => i * 7919 + 1);

function distanceFromOrigin(run: RunState, id: number): number {
  return Math.hypot(run.stars[id].x, run.stars[id].y);
}

describe('determinism', () => {
  test('the same seed produces byte-identical clusters', () => {
    for (const seed of [1, 42, 20260730, 999983]) {
      const a = JSON.stringify(generateRun(seed, 0));
      const b = JSON.stringify(generateRun(seed, 0));
      expect(a).toBe(b);
    }
  });

  test('different seeds produce different clusters', () => {
    const a = JSON.stringify(generateRun(1, 0));
    const b = JSON.stringify(generateRun(2, 0));
    expect(a).not.toBe(b);
  });

  test('collapse count changes the cluster for a fixed seed', () => {
    const first = generateRun(1, 0);
    const second = generateRun(1, 1);
    expect(second.stars.length).toBe(starCount(1));
    expect(second.stars.length).toBeGreaterThan(first.stars.length);
  });
});

describe('seed guarantees, across 120 seeds', () => {
  const runs = SEEDS.map((seed) => generateRun(seed, 0));

  test('the origin is an M-dwarf within 20 lu with exactly 1400 reserve', () => {
    for (const run of runs) {
      const origin = run.stars[0];
      expect(origin.cls).toBe('mdwarf');
      expect(distanceFromOrigin(run, 0)).toBeLessThan(ORIGIN_MAX_DISTANCE);
      expect(origin.reserve).toBe(ORIGIN_RESERVE);
      expect(origin.role).toBe('hub');
      expect(origin.claimed).toBe(true);
      expect(origin.tier).toBe(1);
    }
  });

  test('exactly one G-type sits 60–95 lu from the origin', () => {
    for (const run of runs) {
      const inAnnulus = run.stars.filter((star, id) => {
        const d = distanceFromOrigin(run, id);
        return (
          star.cls === 'gtype' && d >= GUARANTEED_GTYPE_MIN_D && d <= GUARANTEED_GTYPE_MAX_D
        );
      });
      expect(inAnnulus).toHaveLength(1);
    }
  });

  test('at least one rocky remnant sits within 85 lu', () => {
    for (const run of runs) {
      const near = run.stars.filter(
        (star, id) =>
          star.cls === 'rocky' && distanceFromOrigin(run, id) <= GUARANTEED_ROCKY_MAX_D,
      );
      expect(near.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('no isotope source within 140 lu', () => {
    for (const run of runs) {
      for (let id = 0; id < run.stars.length; id++) {
        if (distanceFromOrigin(run, id) >= ISOTOPE_EXCLUSION_RADIUS) continue;
        expect(CLASS_RESOURCE[run.stars[id].cls]).not.toBe('isotopes');
      }
    }
  });

  test('at least four stars sit within initial scan range', () => {
    for (const run of runs) {
      let count = 0;
      for (let id = 1; id < run.stars.length; id++) {
        if (distanceFromOrigin(run, id) <= INITIAL_SCAN_RANGE) count++;
      }
      expect(count).toBeGreaterThanOrEqual(MIN_STARS_IN_INITIAL_SCAN);
    }
  });

  test('no two stars are closer than the minimum separation', () => {
    for (const run of runs) {
      for (let i = 0; i < run.stars.length; i++) {
        for (let j = i + 1; j < run.stars.length; j++) {
          const d = Math.hypot(
            run.stars[i].x - run.stars[j].x,
            run.stars[i].y - run.stars[j].y,
          );
          expect(d).toBeGreaterThanOrEqual(MIN_STAR_SEPARATION - 1e-9);
        }
      }
    }
  });

  test('every star falls inside the cluster radius', () => {
    for (const run of runs) {
      for (let id = 0; id < run.stars.length; id++) {
        expect(distanceFromOrigin(run, id)).toBeLessThanOrEqual(clusterRadius(0) + 1e-9);
      }
    }
  });

  test('names are unique and short enough to render on the map', () => {
    for (const run of runs) {
      const names = new Set(run.stars.map((s) => s.name));
      expect(names.size).toBe(run.stars.length);
      for (const star of run.stars) {
        expect(star.name.split('-')[0].length).toBeLessThanOrEqual(8);
      }
    }
  });
});

describe('the opening state', () => {
  test('grants 300 metals into the origin buffer and nothing else', () => {
    const state = newGame(20260730);
    const origin = state.run.stars[0];

    expect(origin.buffer[RESOURCE_INDEX.metals]).toBe(INITIAL_METALS);
    expect(origin.buffer[RESOURCE_INDEX.hydrogen]).toBe(0);
    expect(state.run.granted[RESOURCE_INDEX.metals]).toBe(INITIAL_METALS);

    // The grant is on the ledger, so it does not read as material out of nowhere.
    expect(state.run.extracted[RESOURCE_INDEX.metals]).toBe(0);
  });

  test('starts with one alloy slot, no links, and only alloy unlocked', () => {
    const state = newGame(20260730);
    expect(state.run.links).toHaveLength(0);
    expect(state.run.stars[0].slots).toHaveLength(1);
    expect(state.run.stars[0].slots[0].recipe).toBe('alloy');
    expect(state.meta.recipesUnlocked).toEqual(['alloy']);
  });

  test('leaves every star but the origin unclaimed', () => {
    const state = newGame(20260730);
    const claimed = state.run.stars.filter((s) => s.claimed);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(0);
  });
});

describe('placement density', () => {
  /**
   * BALANCE.md § Star placement: density must fall off with distance so the frontier feels
   * sparse. The radial exponent has to exceed the uniform-area sqrt(u) for that to hold —
   * at the previous 0.85 the frontier came out denser than the interior.
   */
  test('areal density decreases outward', () => {
    const radius = clusterRadius(0);
    const inner = { count: 0, area: 0 };
    const outer = { count: 0, area: 0 };
    const half = radius / 2;
    inner.area = Math.PI * half * half;
    outer.area = Math.PI * radius * radius - inner.area;

    for (const seed of SEEDS) {
      const run = generateRun(seed, 0);
      for (let id = 0; id < run.stars.length; id++) {
        if (distanceFromOrigin(run, id) <= half) inner.count++;
        else outer.count++;
      }
    }

    const innerDensity = inner.count / inner.area;
    const outerDensity = outer.count / outer.area;
    expect(outerDensity).toBeLessThan(innerDensity);
  });
});
