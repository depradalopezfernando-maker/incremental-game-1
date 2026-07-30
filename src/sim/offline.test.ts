/**
 * Phase 2 acceptance for offline resolution. ROADMAP.md Phase 2, BALANCE.md § 8.
 */

import { describe, expect, test } from 'vitest';
import { conservation, findNonFinite, networkTotals } from './audit';
import {
  OFFLINE_CAP_SECONDS,
  OFFLINE_CLOSED_FORM_MIN_SECONDS,
  SIM_STEP_SECONDS,
} from './constants';
import { fiveStarNetwork, run, spanningTreeCluster } from './fixtures';
import { resolveOffline } from './offline';
import { toAmounts, type GameState } from './types';

const HOUR = 60 * 60;

function relativeGap(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale;
}

describe('performance', () => {
  /**
   * Best of 8, which is the steady-state cost BALANCE.md § 8 describes ("single-digit
   * milliseconds") — measured at ~6.4ms on a 40-star cluster. The first call in a fresh
   * process is ~26ms and it takes about five calls for V8 to finish tiering up the solver,
   * so a single cold sample measures compilation rather than the algorithm. The cold path
   * is bounded separately below.
   *
   * This is the assertion that catches what architecture rule 4 exists to prevent: an
   * implementation that quietly replays ticks lands in the seconds, not the milliseconds.
   */
  test('resolves 12 hours in under 20ms', () => {
    let best = Infinity;
    let intervals = 0;
    let method = '';
    let coarse = true;

    for (let attempt = 0; attempt < 8; attempt++) {
      const state = spanningTreeCluster(20260730);
      const started = performance.now();
      const result = resolveOffline(state, 12 * HOUR);
      best = Math.min(best, performance.now() - started);
      intervals = result.intervals;
      method = result.method;
      coarse = result.usedCoarseFallback;
      expect(result.elapsedResolved).toBe(12 * HOUR);
    }

    expect(method).toBe('closedForm');
    expect(best).toBeLessThan(20);
    // A 12-hour absence should be a few dozen regime changes, nowhere near the 400 cap.
    expect(intervals).toBeLessThan(400);
    expect(coarse).toBe(false);
  });

  test('resolves 12 hours in under 60ms even on a cold start', () => {
    // Offline resolution happens once, at load, so players pay the cold cost — a one-off
    // ~26ms at startup. Bounded here so a real regression still shows up.
    const state = spanningTreeCluster(20260730);
    const started = performance.now();
    resolveOffline(state, 12 * HOUR);
    expect(performance.now() - started).toBeLessThan(60);
  });

  test('scales with regime changes, not with elapsed time', () => {
    // Twelve times the absence for roughly the same work is the whole point of § 8.
    const short = resolveOffline(spanningTreeCluster(20260730), HOUR);
    const long = resolveOffline(spanningTreeCluster(20260730), 12 * HOUR);
    expect(long.intervals).toBeLessThan(short.intervals * 3);
  });

  test('resolves 12 hours on the small network in a handful of intervals', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, 12 * HOUR);
    expect(result.intervals).toBeLessThan(100);
    expect(findNonFinite(state.run)).toBeNull();
  });
});

/**
 * The claim being tested is that the closed form is not a different simulation. Latency is
 * the one deliberate divergence — it is discarded offline — so the comparison is made over a
 * period long enough for transit delay to be noise, which is the regime the closed form is
 * for.
 */
describe('agreement with a tick-by-tick reference', () => {
  function compare(build: () => GameState, period: number, tolerance: number) {
    const closed = build();
    resolveOffline(closed, period);

    const reference = build();
    run(reference, period, SIM_STEP_SECONDS);

    const closedExtracted = toAmounts(closed.run.extracted);
    const refExtracted = toAmounts(reference.run.extracted);
    const closedProduced = toAmounts(closed.run.producedByRecipes);
    const refProduced = toAmounts(reference.run.producedByRecipes);
    const closedVented = toAmounts(closed.run.vented);
    const refVented = toAmounts(reference.run.vented);

    for (const resource of ['hydrogen', 'metals', 'isotopes'] as const) {
      expect(relativeGap(closedExtracted[resource], refExtracted[resource])).toBeLessThan(
        tolerance,
      );
      expect(relativeGap(closedVented[resource], refVented[resource])).toBeLessThan(
        tolerance,
      );
    }
    expect(relativeGap(closedProduced.alloy, refProduced.alloy)).toBeLessThan(tolerance);

    // And the reserves left behind, which is what the next session inherits.
    for (let id = 0; id < closed.run.stars.length; id++) {
      expect(
        relativeGap(closed.run.stars[id].reserve, reference.run.stars[id].reserve),
      ).toBeLessThan(tolerance);
    }
  }

  test('the five-star network over one hour, within 1%', () => {
    compare(fiveStarNetwork, HOUR, 0.01);
  });

  test('the five-star network over four hours, within 1%', () => {
    compare(fiveStarNetwork, 4 * HOUR, 0.01);
  });

  test('a realistic 40-star cluster over one hour, within 1%', () => {
    compare(() => spanningTreeCluster(20260730), HOUR, 0.01);
  });
});

describe('short absences', () => {
  test('below the threshold, resolve by real ticks', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, OFFLINE_CLOSED_FORM_MIN_SECONDS - 1);
    expect(result.method).toBe('ticks');
    expect(state.run.elapsed).toBeCloseTo(OFFLINE_CLOSED_FORM_MIN_SECONDS - 1, 6);
  });

  test('at the threshold, switch to closed form', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, OFFLINE_CLOSED_FORM_MIN_SECONDS);
    expect(result.method).toBe('closedForm');
  });

  /**
   * The reason the threshold exists: over ten minutes, discarding latency misstates a
   * multi-hop path's delivery badly. Ticking keeps the short case honest, and this asserts
   * the tick path agrees with itself rather than drifting.
   */
  test('a ten-minute absence matches ticking the same period', () => {
    const viaOffline = fiveStarNetwork();
    resolveOffline(viaOffline, 10 * 60);

    const viaTicks = fiveStarNetwork();
    run(viaTicks, 10 * 60, SIM_STEP_SECONDS);

    // Ten minutes is above the 120s threshold, so this goes through the closed form — the
    // gap here is exactly the cost of discarding latency at this timescale.
    const a = networkTotals(viaOffline.run);
    const b = networkTotals(viaTicks.run);
    expect(relativeGap(a.metals, b.metals)).toBeLessThan(0.05);

    const short = fiveStarNetwork();
    const shortResult = resolveOffline(short, 90);
    expect(shortResult.method).toBe('ticks');
    const shortTicks = fiveStarNetwork();
    run(shortTicks, 90, SIM_STEP_SECONDS);
    // The tick path is the same code, so it agrees exactly.
    expect(networkTotals(short.run).metals).toBeCloseTo(
      networkTotals(shortTicks.run).metals,
      6,
    );
  });

  test('zero and negative absences do nothing', () => {
    const state = fiveStarNetwork();
    resolveOffline(state, 0);
    expect(state.run.elapsed).toBe(0);
    resolveOffline(state, -5);
    expect(state.run.elapsed).toBe(0);
  });
});

describe('the offline cap', () => {
  test('resolves at most 14 hours and says when it capped', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, 26 * HOUR);

    expect(result.capped).toBe(true);
    expect(result.elapsedRequested).toBe(26 * HOUR);
    expect(result.elapsedResolved).toBe(OFFLINE_CAP_SECONDS);
    expect(state.run.elapsed).toBeCloseTo(OFFLINE_CAP_SECONDS, 3);
  });

  test('does not flag a shorter absence as capped', () => {
    const state = fiveStarNetwork();
    expect(resolveOffline(state, 2 * HOUR).capped).toBe(false);
  });
});

describe('depletion during offline', () => {
  test('applies depletions in the order they happen', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, 6 * HOUR);

    // Every star in this fixture is finite, so six hours empties all of them.
    for (const star of state.run.stars) {
      if (star.resource !== null) expect(star.reserve).toBe(0);
    }

    expect(result.depleted.length).toBe(5);
    for (let i = 1; i < result.depleted.length; i++) {
      expect(result.depleted[i].at).toBeGreaterThanOrEqual(result.depleted[i - 1].at);
    }

    // Ash-2 holds 900u at 1.0125/s → ~889s. It dies first, and its timing is exact
    // because a depletion is an interval boundary, not something rounded to a tick.
    const first = result.depleted[0];
    expect(first.name).toBe('Ash-2');
    expect(first.at).toBeCloseTo(900 / 1.0125, 3);
  });

  test('reports depletion times that match the reserve and rate', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, 6 * HOUR);

    const byName = new Map(result.depleted.map((d) => [d.name, d.at]));
    // Bell-4: 1400u at 0.75/s. Reed-1: 5000u at 1.4/s. Pike-9: 6000u at 2.0/s.
    expect(byName.get('Bell-4')).toBeCloseTo(1400 / 0.75, 3);
    expect(byName.get('Reed-1')).toBeCloseTo(5000 / 1.4, 3);
    expect(byName.get('Pike-9')).toBeCloseTo(6000 / 2.0, 3);
    expect(byName.get('Vane-3')).toBeCloseTo(6000 / 2.5, 3);
  });

  test('a depleted star stops producing but keeps relaying', () => {
    const state = spanningTreeCluster(20260730);
    resolveOffline(state, 12 * HOUR);

    const dead = state.run.stars.filter((s) => s.reserve <= 0 && s.resource !== null);
    expect(dead.length).toBeGreaterThan(0);
    // Dead stars are infrastructure, not garbage — their links are untouched.
    for (const star of dead) {
      expect(state.run.topology.adjacency[star.id].length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('material accounting', () => {
  test('conserves every raw resource through a closed-form resolve', () => {
    const state = fiveStarNetwork();
    resolveOffline(state, 8 * HOUR);

    for (const report of conservation(state.run)) {
      const scale = Math.max(1, report.supplied);
      expect(Math.abs(report.residual) / scale).toBeLessThan(1e-9);
    }
  });

  test('conserves through a resolve on a realistic cluster', () => {
    const state = spanningTreeCluster(20260730);
    resolveOffline(state, 12 * HOUR);

    for (const report of conservation(state.run)) {
      const scale = Math.max(1, report.supplied);
      expect(Math.abs(report.residual) / scale).toBeLessThan(1e-9);
    }
    expect(findNonFinite(state.run)).toBeNull();
  });

  test('flushes in-flight material into buffers rather than stranding it', () => {
    const state = fiveStarNetwork();
    run(state, 5 * 60, SIM_STEP_SECONDS);

    const inFlight = state.run.links.reduce(
      (total, link) => total + link.queue.slice(link.head).reduce((n, s) => n + s.amount, 0),
      0,
    );
    expect(inFlight).toBeGreaterThan(0);

    resolveOffline(state, 4 * HOUR);

    for (const link of state.run.links) {
      expect(link.queue.length).toBe(0);
      expect(link.head).toBe(0);
    }
    for (const report of conservation(state.run)) {
      const scale = Math.max(1, report.supplied);
      expect(Math.abs(report.residual) / scale).toBeLessThan(1e-9);
    }
  });
});

/**
 * CONTENT.md § Arrival summary has to name the specific cause of a vent, not just the
 * total — "Hydrogen vented for 6h 20m — Bell-4 outbound link at capacity". That is
 * impossible to reconstruct after the fact, so the solver records it per interval.
 */
describe('vent attribution', () => {
  test('records which star lost what, for how long, worst first', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, 4 * HOUR);

    expect(result.vented.length).toBeGreaterThan(0);

    for (let i = 1; i < result.vented.length; i++) {
      expect(result.vented[i].amount).toBeLessThanOrEqual(result.vented[i - 1].amount);
    }

    const worst = result.vented[0];
    // Reed-1 is the bottleneck: 5.9 u/s of demand into 3 u/s of tier-I bandwidth.
    expect(worst.name).toBe('Reed-1');
    expect(worst.seconds).toBeGreaterThan(0);
    expect(worst.seconds).toBeLessThanOrEqual(4 * HOUR);

    // The per-star attribution sums to the run's vent ledger.
    const attributed = result.vented.reduce((n, v) => n + v.amount, 0);
    const total = Object.values(toAmounts(state.run.vented)).reduce((n, v) => n + v, 0);
    expect(attributed).toBeCloseTo(total, 6);
  });

  test('reports produced totals for the arrival summary', () => {
    const state = fiveStarNetwork();
    const result = resolveOffline(state, 4 * HOUR);
    expect(result.produced.alloy).toBeGreaterThan(0);
  });
});
