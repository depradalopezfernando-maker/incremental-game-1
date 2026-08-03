/**
 * The permanent endurance test. ROADMAP.md § Testing discipline: a scripted 6-hour game
 * asserting conservation of material and no NaN anywhere in state.
 *
 * This genre's bugs are exactly the kind that only surface after simulated hours — a
 * buffer that drifts negative by 1e-17 per tick, a segment that never arrives, a reserve
 * that goes to -0. None of them are visible in a 30-second run.
 *
 * It runs at 1 Hz rather than the live 10 Hz. Conservation and finiteness are
 * `dt`-independent properties, the 10 Hz path is covered by tick.test.ts, and agreement
 * between step sizes is asserted directly there. At 10 Hz this same run takes 7.4s and
 * would consume most of the suite's 10-second budget on its own; at 1 Hz it is ~0.7s.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { conservation, findNonFinite, networkTotals } from './audit';
import { run, spanningTreeCluster } from './fixtures';
import { toAmounts } from './types';

const SIX_HOURS = 6 * 60 * 60;
const ENDURANCE_STEP = 1;

describe('a scripted six-hour game', () => {
  let state = spanningTreeCluster(0);

  beforeAll(() => {
    state = spanningTreeCluster(20260730);
    run(state, SIX_HOURS, ENDURANCE_STEP);
  });

  test('conserves every raw resource', () => {
    for (const report of conservation(state.run)) {
      // Tolerance is relative: 21,600 steps of float accumulation on totals in the
      // hundreds of thousands.
      const scale = Math.max(1, report.supplied);
      expect(Math.abs(report.residual) / scale).toBeLessThan(1e-9);
    }
  });

  test('leaves no NaN, no Infinity and no negative buffer anywhere', () => {
    expect(findNonFinite(state.run)).toBeNull();
  });

  test('actually simulated something worth checking', () => {
    // A test that silently does nothing would pass the two above.
    const extracted = toAmounts(state.run.extracted);
    expect(extracted.hydrogen).toBeGreaterThan(1000);
    expect(extracted.metals).toBeGreaterThan(1000);
    expect(state.run.elapsed).toBeCloseTo(SIX_HOURS, 6);

    const produced = toAmounts(state.run.producedByRecipes);
    expect(produced.alloy).toBeGreaterThan(0);

    // Six hours in, the interior should be visibly spent — this is the whole premise.
    const dead = state.run.stars.filter((s) => s.reserve <= 0 && s.resource !== null);
    expect(dead.length).toBeGreaterThan(0);
  });

  test('material that stopped moving is accounted for, not lost', () => {
    const buffers = networkTotals(state.run);
    const vented = toAmounts(state.run.vented);
    // Something is either held, refined, in flight, or vented. Vented is expected here:
    // an unattended network at full throttle is exactly the configuration that wastes.
    expect(buffers.hydrogen + vented.hydrogen).toBeGreaterThan(0);
  });
});
