/**
 * Phase 1 acceptance for the tick. ROADMAP.md Phase 1.
 */

import { describe, expect, test } from 'vitest';
import { conservation, inTransitTotals, networkTotals, worstResidual } from './audit';
import { LINK_BANDWIDTH, SIM_STEP_SECONDS } from './constants';
import { fiveStarNetwork, loneHub, run, twoStarTrunk } from './fixtures';
import { RESOURCE_INDEX, setAmount, toAmounts } from './types';
import { tick } from './tick';

const HALF_HOUR = 30 * 60;

describe('the five-star network over 30 simulated minutes', () => {
  /**
   * Best of three for the timing. The simulation is deterministic, so repeating it costs
   * nothing in signal — but a single cold sample on a shared machine is noise: this same
   * 30 minutes measures ~100ms idle and ~260ms with a browser running alongside it, which
   * would fail in CI for reasons that have nothing to do with the code.
   */
  test('runs in under 200ms and produces exact stockpiles', () => {
    let state = fiveStarNetwork();
    let elapsedMs = Infinity;

    for (let attempt = 0; attempt < 3; attempt++) {
      state = fiveStarNetwork();
      const started = performance.now();
      run(state, HALF_HOUR, SIM_STEP_SECONDS);
      elapsedMs = Math.min(elapsedMs, performance.now() - started);
    }

    expect(elapsedMs).toBeLessThan(200);

    const extracted = toAmounts(state.run.extracted);
    const produced = toAmounts(state.run.producedByRecipes);
    const consumed = toAmounts(state.run.consumedByRecipes);
    const vented = toAmounts(state.run.vented);
    const buffers = networkTotals(state.run);
    const transit = inTransitTotals(state.run);

    // Analytically derived — extraction is rate * time, capped by reserve.
    //   Bell-4  0.75    * 1800 = 1350, of 1400 reserve
    //   Ash-2   1.0125  * 1800 = 1822.5, capped at its 900 reserve
    //   Reed-1  1.4     * 1800 = 2520
    //   Vane-3  2.5     * 1800 = 4500
    //   Pike-9  2.0     * 1800 = 3600
    expect(extracted.hydrogen).toBeCloseTo(2250, 6);
    expect(extracted.metals).toBeCloseTo(7020, 6);
    expect(extracted.isotopes).toBeCloseTo(3600, 6);

    expect(state.run.stars[0].reserve).toBeCloseTo(50, 6);
    expect(state.run.stars[1].reserve).toBeCloseTo(2480, 6);
    expect(state.run.stars[2].reserve).toBe(0);
    expect(state.run.stars[3].reserve).toBeCloseTo(2400, 6);
    expect(state.run.stars[4].reserve).toBeCloseTo(1500, 6);

    // Recipe stoichiometry: 3 metals + 2 hydrogen per alloy. Tolerance is float drift
    // over 18,000 accumulations, ~1e-12 relative.
    expect(consumed.metals).toBeCloseTo(produced.alloy * 3, 6);
    expect(consumed.hydrogen).toBeCloseTo(produced.alloy * 2, 6);
    // A single alloy slot caps at 0.25/s, so 1800s can never exceed 450.
    expect(produced.alloy).toBeLessThanOrEqual(450);

    // Locked values. These are observed, not derived — they exist to catch unintended
    // changes in tick behaviour. If a deliberate change moves them, re-lock them.
    expect(produced.alloy).toBeCloseTo(447.4749999998669, 6);
    expect(buffers.hydrogen).toBeCloseTo(1355.0500000010754, 6);
    expect(buffers.metals).toBeCloseTo(1672.3785482159751, 6);
    expect(buffers.isotopes).toBeCloseTo(2731.5306060904754, 6);
    expect(transit.metals).toBeCloseTo(49.315314842467984, 6);
    expect(transit.isotopes).toBeCloseTo(43.884685157532004, 6);
    expect(vented.metals).toBeCloseTo(3955.881136940845, 6);
    expect(vented.isotopes).toBeCloseTo(824.584708751997, 6);
    expect(vented.hydrogen).toBe(0);
  });

  test('conserves material per raw resource', () => {
    const state = fiveStarNetwork();
    run(state, HALF_HOUR, SIM_STEP_SECONDS);

    for (const report of conservation(state.run)) {
      // extracted + granted === inBuffers + inTransit + vented + consumedByRecipes
      expect(Math.abs(report.residual)).toBeLessThan(1e-6);
      expect(report.supplied).toBeGreaterThan(0);
    }
  });

  test('vents material once a buffer is full, and says so', () => {
    const state = fiveStarNetwork();
    run(state, HALF_HOUR, SIM_STEP_SECONDS);

    // Reed-1 is the bottleneck: 5.9 u/s of demand against 3 u/s of tier-I bandwidth.
    const reed = state.run.stars[1];
    expect(reed.buffer[RESOURCE_INDEX.metals]).toBeGreaterThan(190);
    expect(toAmounts(state.run.vented).metals).toBeGreaterThan(0);
  });
});

describe('bandwidth contention', () => {
  /**
   * A saturated trunk scales every flow on it down by the same factor. This is the rule
   * that makes adding a source to a busy trunk degrade everything already using it.
   */
  test('scales all resources on a saturated trunk proportionally', () => {
    const state = twoStarTrunk(1);
    const source = state.run.stars[1];
    setAmount(source.buffer, 'hydrogen', 100);
    setAmount(source.buffer, 'metals', 50);

    tick(state, SIM_STEP_SECONDS);

    const transit = inTransitTotals(state.run);
    const total = transit.hydrogen + transit.metals;

    // Demand is 20 + 10 u/s against 3 u/s of tier-I bandwidth, so the trunk is pinned.
    expect(total).toBeCloseTo(LINK_BANDWIDTH[1] * SIM_STEP_SECONDS, 9);
    // ...and the 2:1 ratio of the two demands survives the clamp untouched.
    expect(transit.hydrogen / transit.metals).toBeCloseTo(2, 9);
  });

  test('leaves flows alone when the trunk has headroom', () => {
    const state = twoStarTrunk(4);
    const source = state.run.stars[1];
    setAmount(source.buffer, 'hydrogen', 100);
    setAmount(source.buffer, 'metals', 50);

    tick(state, SIM_STEP_SECONDS);

    const transit = inTransitTotals(state.run);
    // 30 u/s of demand fits inside tier IV's 70 u/s, so supply is the only limit.
    expect(transit.hydrogen).toBeCloseTo(20 * SIM_STEP_SECONDS, 9);
    expect(transit.metals).toBeCloseTo(10 * SIM_STEP_SECONDS, 9);
  });

  test('adding a second resource to a busy trunk degrades the first', () => {
    const alone = twoStarTrunk(1);
    setAmount(alone.run.stars[1].buffer, 'hydrogen', 100);
    tick(alone, SIM_STEP_SECONDS);
    const hydrogenAlone = inTransitTotals(alone.run).hydrogen;

    const shared = twoStarTrunk(1);
    setAmount(shared.run.stars[1].buffer, 'hydrogen', 100);
    setAmount(shared.run.stars[1].buffer, 'metals', 50);
    tick(shared, SIM_STEP_SECONDS);
    const hydrogenShared = inTransitTotals(shared.run).hydrogen;

    expect(hydrogenShared).toBeLessThan(hydrogenAlone);
    // Hydrogen keeps its 2/3 share of the trunk, having 2/3 of the demand.
    expect(hydrogenShared).toBeCloseTo((hydrogenAlone * 2) / 3, 9);
  });
});

describe('recipe slots', () => {
  test('a hub missing an input stalls and consumes nothing', () => {
    const state = loneHub();
    const hub = state.run.stars[0];
    setAmount(hub.buffer, 'metals', 100);

    tick(state, SIM_STEP_SECONDS);

    const alloySlot = hub.slots[0];
    expect(alloySlot.status.kind).toBe('starved');
    if (alloySlot.status.kind === 'starved') {
      expect(alloySlot.status.missing).toEqual(['hydrogen']);
    }
    // The input that *is* present sits there untouched.
    expect(hub.buffer[RESOURCE_INDEX.metals]).toBe(100);
    expect(toAmounts(state.run.consumedByRecipes).metals).toBe(0);
    expect(toAmounts(state.run.producedByRecipes).alloy).toBe(0);
  });

  test('names every missing input, not just the first', () => {
    const state = loneHub();
    const hub = state.run.stars[0];

    tick(state, SIM_STEP_SECONDS);

    const catalystSlot = hub.slots[1];
    expect(catalystSlot.status.kind).toBe('starved');
    if (catalystSlot.status.kind === 'starved') {
      expect([...catalystSlot.status.missing].sort()).toEqual(['hydrogen', 'isotopes']);
    }
  });

  test('runs once every input is present', () => {
    const state = loneHub();
    const hub = state.run.stars[0];
    setAmount(hub.buffer, 'metals', 100);
    setAmount(hub.buffer, 'hydrogen', 100);

    run(state, 10, SIM_STEP_SECONDS);

    expect(hub.slots[0].status.kind).toBe('running');
    // 0.25 alloy/s for 10s.
    expect(toAmounts(state.run.producedByRecipes).alloy).toBeCloseTo(2.5, 6);
    expect(toAmounts(state.run.consumedByRecipes).metals).toBeCloseTo(7.5, 6);
    expect(toAmounts(state.run.consumedByRecipes).hydrogen).toBeCloseTo(5, 6);
  });

  test('stalls backed up rather than destroying refined output', () => {
    const state = loneHub();
    const hub = state.run.stars[0];
    // Tier-2 hub: 2400 * 4 = 9600 per resource.
    setAmount(hub.buffer, 'alloy', 9600);
    setAmount(hub.buffer, 'metals', 100);
    setAmount(hub.buffer, 'hydrogen', 100);

    tick(state, SIM_STEP_SECONDS);

    expect(hub.slots[0].status.kind).toBe('backedUp');
    expect(hub.buffer[RESOURCE_INDEX.metals]).toBe(100);
    expect(hub.buffer[RESOURCE_INDEX.alloy]).toBe(9600);
    expect(toAmounts(state.run.vented).alloy).toBe(0);
  });
});

/**
 * The rate on a link must not depend on `dt`. Phase 2's closed-form offline solver is only
 * correct if this holds, and the endurance test is only meaningful at a coarse step if it
 * holds too.
 *
 * `dt` has to stay well below link latency for the delay queue to behave — arrival is
 * quantised to tick boundaries, so a step comparable to latency changes *when* material
 * lands, not just at what rate. Resolution coarser than that is § 8's job, not the tick's.
 */
describe('dt-independence', () => {
  const PERIOD = 10 * 60;

  function summarise(dt: number) {
    const state = fiveStarNetwork();
    run(state, PERIOD, dt);
    return {
      extracted: toAmounts(state.run.extracted),
      alloy: toAmounts(state.run.producedByRecipes).alloy,
      vented: toAmounts(state.run.vented),
      residual: worstResidual(state.run),
    };
  }

  const reference = summarise(SIM_STEP_SECONDS);

  for (const dt of [0.25, 0.5, 1]) {
    test(`agrees with 10Hz at dt=${dt}s to within 1%`, () => {
      const actual = summarise(dt);

      expect(actual.extracted.hydrogen).toBeCloseTo(reference.extracted.hydrogen, 6);
      expect(actual.extracted.metals).toBeCloseTo(reference.extracted.metals, 6);
      expect(actual.extracted.isotopes).toBeCloseTo(reference.extracted.isotopes, 6);

      expect(actual.alloy).toBeGreaterThan(reference.alloy * 0.99);
      expect(actual.alloy).toBeLessThan(reference.alloy * 1.01);

      expect(actual.vented.metals).toBeGreaterThan(reference.vented.metals * 0.99);
      expect(actual.vented.metals).toBeLessThan(reference.vented.metals * 1.01);

      expect(actual.residual).toBeLessThan(1e-6);
    });
  }
});
