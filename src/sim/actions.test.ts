/**
 * Player actions. MECHANICS.md § 2 and § 5, BALANCE.md § 3.
 *
 * These are the rules the interface calls into, so they are tested headlessly — a refusal that
 * reads wrong or a cost that debits the wrong star is a bug whether or not a button exists.
 */

import { describe, expect, test } from 'vitest';
import {
  buildLink,
  canBuildLink,
  canDesignateHub,
  canUndesignateHub,
  canUpgradeNode,
  currentScanRange,
  designateHub,
  freePorts,
  held,
  hubDesignateCostOf,
  linkBuildCost,
  portsTotal,
  setSlotRecipe,
  setThrottle,
  spend,
  undesignateHub,
  upgradeNode,
} from './actions';
import { INITIAL_METALS, NODE_PORTS, SIM_STEP_SECONDS } from './constants';
import { run } from './fixtures';
import { newGame } from './generate';
import { RESOURCE_INDEX, setAmount, type GameState } from './types';

function opening(): GameState {
  return newGame(20260730);
}

/** The nearest unclaimed star to the origin, which is what a player reaches for first. */
function nearestUnclaimed(state: GameState): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const star of state.run.stars) {
    if (star.claimed) continue;
    const d = Math.hypot(star.x, star.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = star.id;
    }
  }
  return best;
}

describe('spending', () => {
  test('the resource bar total is the sum of every buffer', () => {
    const state = opening();
    expect(held(state.run, 'metals')).toBe(INITIAL_METALS);

    setAmount(state.run.stars[5].buffer, 'metals', 40);
    expect(held(state.run, 'metals')).toBe(INITIAL_METALS + 40);
  });

  test('debits nearest-first from the thing being bought', () => {
    const state = opening();
    const run_ = state.run;
    // Clear the opening grant so the test controls every source.
    setAmount(run_.stars[0].buffer, 'metals', 0);

    // Three stars holding metals at increasing distance from star 0.
    const byDistance = run_.stars
      .slice(1)
      .map((s) => ({ id: s.id, d: Math.hypot(s.x, s.y) }))
      .sort((a, b) => a.d - b.d);

    const near = byDistance[0].id;
    const far = byDistance[byDistance.length - 1].id;
    setAmount(run_.stars[near].buffer, 'metals', 30);
    setAmount(run_.stars[far].buffer, 'metals', 30);

    expect(spend(run_, 'metals', 40, 0)).toBe(true);
    // The near star is emptied before the far one is touched.
    expect(run_.stars[near].buffer[RESOURCE_INDEX.metals]).toBe(0);
    expect(run_.stars[far].buffer[RESOURCE_INDEX.metals]).toBeCloseTo(20, 9);
  });

  test('is all-or-nothing — a short purchase touches nothing', () => {
    const state = opening();
    const before = held(state.run, 'metals');
    expect(spend(state.run, 'metals', before + 1, 0)).toBe(false);
    expect(held(state.run, 'metals')).toBe(before);
  });
});

describe('building links', () => {
  test('claims the far star and charges metals for a tier-I link', () => {
    const state = opening();
    const target = nearestUnclaimed(state);
    const cost = linkBuildCost(state.run, 0, target, 1);

    expect(state.run.stars[target].claimed).toBe(false);
    const result = buildLink(state.run, 0, target, 1);

    expect(result.ok).toBe(true);
    expect(state.run.stars[target].claimed).toBe(true);
    expect(state.run.links).toHaveLength(1);
    expect(held(state.run, 'metals')).toBeCloseTo(INITIAL_METALS - cost, 6);
    // The new star is one hop from the hub, so default routing points it inward.
    expect(state.run.topology.hopDistance[target]).toBe(1);
  });

  test('refuses to found a disconnected second network', () => {
    const state = opening();
    const unclaimed = state.run.stars.filter((s) => !s.claimed).map((s) => s.id);
    const check = canBuildLink(state.run, unclaimed[0], unclaimed[1], 1);

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('Neither star is connected to your network.');
  });

  test('refuses a star beyond scan range, and names the fix', () => {
    const state = opening();
    const range = currentScanRange(state.run);
    const distant = state.run.stars.find(
      (s) => !s.claimed && Math.hypot(s.x, s.y) > range + 1,
    );
    expect(distant).toBeDefined();

    const check = canBuildLink(state.run, 0, distant!.id, 1);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('beyond scan range');
  });

  test('refuses when a port is already spoken for, and names the star', () => {
    const state = opening();
    const origin = state.run.stars[0];
    // Tier 1 with the hub bonus is five ports. Give it plenty of metals and fill them.
    setAmount(origin.buffer, 'metals', 100000);
    const reachable = state.run.stars
      .filter((s) => !s.claimed && Math.hypot(s.x, s.y) <= currentScanRange(state.run))
      .map((s) => s.id);
    expect(reachable.length).toBeGreaterThanOrEqual(4);

    for (const id of reachable) {
      if (freePorts(state.run, 0) <= 0) break;
      buildLink(state.run, 0, id, 1);
    }

    expect(freePorts(state.run, 0)).toBe(0);
    expect(portsTotal(state.run, 0)).toBe(NODE_PORTS[1] + 2);

    const spare = state.run.stars.find(
      (s) => !s.claimed && Math.hypot(s.x, s.y) <= currentScanRange(state.run),
    );
    if (spare !== undefined) {
      const check = canBuildLink(state.run, 0, spare.id, 1);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toContain(`No free ports on ${origin.name}`);
    }
  });

  test('refuses when the network cannot afford it, and says by how much', () => {
    const state = opening();
    setAmount(state.run.stars[0].buffer, 'metals', 1);
    const target = nearestUnclaimed(state);

    const check = canBuildLink(state.run, 0, target, 1);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain('Need');
      expect(check.reason).toContain('metals');
    }
  });

  test('refuses a duplicate link', () => {
    const state = opening();
    const target = nearestUnclaimed(state);
    buildLink(state.run, 0, target, 1);

    const check = canBuildLink(state.run, 0, target, 1);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('already linked');
  });
});

describe('hubs', () => {
  test('the first purchased hub costs 250 alloy, not 650', () => {
    const state = opening();
    // The free origin hub does not count toward the scaling.
    expect(state.run.hubsPurchased).toBe(0);
    expect(hubDesignateCostOf(state.run)).toBe(250);
  });

  test('designating charges, counts, and grants slots and ports', () => {
    const state = opening();
    const target = nearestUnclaimed(state);
    setAmount(state.run.stars[0].buffer, 'metals', 100000);
    buildLink(state.run, 0, target, 1);

    setAmount(state.run.stars[0].buffer, 'alloy', 300);
    const portsBefore = portsTotal(state.run, target);

    expect(canDesignateHub(state.run, target).ok).toBe(true);
    expect(designateHub(state.run, target).ok).toBe(true);

    expect(state.run.stars[target].role).toBe('hub');
    expect(state.run.hubsPurchased).toBe(1);
    expect(held(state.run, 'alloy')).toBeCloseTo(50, 6);
    expect(portsTotal(state.run, target)).toBe(portsBefore + 2);
    expect(state.run.stars[target].slots.length).toBeGreaterThan(0);
    // A second hub rewrites every hop distance, so it is now its own destination.
    expect(state.run.topology.hopDistance[target]).toBe(0);
    // The next one costs 2.6x.
    expect(hubDesignateCostOf(state.run)).toBeCloseTo(650, 6);
  });

  test('refuses an unaffordable hub and names the shortfall', () => {
    const state = opening();
    const target = nearestUnclaimed(state);
    buildLink(state.run, 0, target, 1);

    const check = canDesignateHub(state.run, target);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('alloy');
  });

  test('un-designating brings the counter back down so a hub can be traded', () => {
    const state = opening();
    const target = nearestUnclaimed(state);
    setAmount(state.run.stars[0].buffer, 'metals', 100000);
    buildLink(state.run, 0, target, 1);
    setAmount(state.run.stars[0].buffer, 'alloy', 300);
    designateHub(state.run, target);

    expect(hubDesignateCostOf(state.run)).toBeCloseTo(650, 6);
    expect(undesignateHub(state.run, target).ok).toBe(true);
    expect(state.run.hubsPurchased).toBe(0);
    expect(hubDesignateCostOf(state.run)).toBe(250);
    expect(state.run.stars[target].role).toBe('none');
  });

  test('refuses to remove the last hub', () => {
    const state = opening();
    const check = canUndesignateHub(state.run, 0);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('The network needs at least one hub.');
  });

  test('refuses to strip a hub whose links would exceed its ports', () => {
    const state = opening();
    setAmount(state.run.stars[0].buffer, 'metals', 100000);
    const reachable = state.run.stars
      .filter((s) => !s.claimed && Math.hypot(s.x, s.y) <= currentScanRange(state.run))
      .map((s) => s.id);

    // Fill the origin past what tier 1 alone (3 ports) could carry.
    for (const id of reachable) {
      if (freePorts(state.run, 0) <= 0) break;
      buildLink(state.run, 0, id, 1);
    }
    expect(state.run.topology.adjacency[0].length).toBeGreaterThan(NODE_PORTS[1]);

    // Give the network a second hub so "last hub" isn't the reason it refuses.
    setAmount(state.run.stars[reachable[0]].buffer, 'alloy', 300);
    designateHub(state.run, reachable[0]);

    const check = canUndesignateHub(state.run, 0);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('Dismantle a link first');
  });
});

describe('node upgrades', () => {
  test('charges alloy, raises the tier, and grows hub slots', () => {
    const state = opening();
    setAmount(state.run.stars[0].buffer, 'alloy', 500);
    const slotsBefore = state.run.stars[0].slots.length;

    expect(canUpgradeNode(state.run, 0).ok).toBe(true);
    expect(upgradeNode(state.run, 0).ok).toBe(true);

    expect(state.run.stars[0].tier).toBe(2);
    expect(held(state.run, 'alloy')).toBeCloseTo(500 - 204, 6);
    // Tier 2 is two recipe slots.
    expect(state.run.stars[0].slots.length).toBe(slotsBefore + 1);
    expect(portsTotal(state.run, 0)).toBe(NODE_PORTS[2] + 2);
  });

  test('refuses an unclaimed star', () => {
    const state = opening();
    const target = nearestUnclaimed(state);
    const check = canUpgradeNode(state.run, target);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('not connected');
  });
});

describe('throttle and slots', () => {
  test('throttle clamps to 0–1 and changes extraction', () => {
    const state = opening();
    setThrottle(state.run, 0, 0.5);
    expect(state.run.stars[0].throttle).toBe(0.5);
    setThrottle(state.run, 0, 5);
    expect(state.run.stars[0].throttle).toBe(1);
    setThrottle(state.run, 0, -2);
    expect(state.run.stars[0].throttle).toBe(0);

    // At zero throttle the star extracts nothing at all.
    const reserveBefore = state.run.stars[0].reserve;
    run(state, 10, SIM_STEP_SECONDS);
    expect(state.run.stars[0].reserve).toBe(reserveBefore);
  });

  /**
   * The opening 300 metals is both the link budget and the alloy refinery's feedstock. Being
   * able to stop the slot is what keeps a player who explores before building from stranding
   * themselves with alloy they cannot spend and no metals to build with.
   */
  test('a slot can be stopped, and stops consuming', () => {
    const state = opening();
    run(state, 20, SIM_STEP_SECONDS);
    expect(held(state.run, 'alloy')).toBeGreaterThan(0);

    setSlotRecipe(state.run, 0, 0, null);
    const metalsAfterStop = held(state.run, 'metals');
    run(state, 30, SIM_STEP_SECONDS);

    expect(held(state.run, 'metals')).toBeCloseTo(metalsAfterStop, 6);
    expect(state.run.stars[0].slots[0].status.kind).toBe('idle');
  });

  test('and started again', () => {
    const state = opening();
    setSlotRecipe(state.run, 0, 0, null);
    run(state, 10, SIM_STEP_SECONDS);
    expect(held(state.run, 'alloy')).toBe(0);

    setSlotRecipe(state.run, 0, 0, 'alloy');
    run(state, 10, SIM_STEP_SECONDS);
    expect(held(state.run, 'alloy')).toBeGreaterThan(0);
  });
});
