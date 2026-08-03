/**
 * Every worked example and table in BALANCE.md, checked against the formulas that claim
 * to produce them.
 *
 * This suite exists because the docs shipped with four tables that did not match their own
 * formulas — the link cost examples, the chart award curve, a node upgrade cost and the
 * early-star lifetimes. Transcription drift is the failure mode, so the transcription gets
 * a test.
 */

import { describe, expect, test } from 'vitest';
import {
  buildCost,
  chartsAwarded,
  clusterRadius,
  extractionGlobal,
  extractionStar,
  bufferCapacity,
  bufferMult,
  hubDesignateCost,
  linkDismantleRefund,
  linkLatency,
  linkUpgradeCost,
  nodeUpgradeCost,
  portCount,
  recipeSlotCount,
  RECIPES,
  reserveFor,
  baseYieldFor,
  richnessMult,
  scanRange,
  starCount,
  yieldMult,
  GUARANTEED_GTYPE_MAX_D,
  GUARANTEED_GTYPE_MIN_D,
  ORIGIN_RESERVE,
  RESERVE_ROLL_MAX,
  RESERVE_ROLL_MIN,
} from './constants';

describe('§ 1 cluster generation', () => {
  test('star count, radius and richness by collapse', () => {
    expect(starCount(0)).toBe(40);
    expect(starCount(1)).toBe(54);
    expect(clusterRadius(0)).toBe(260);
    expect(clusterRadius(1)).toBe(350);
    expect(richnessMult(0)).toBe(1);
    expect(richnessMult(1)).toBeCloseTo(1.45, 10);
    expect(richnessMult(2)).toBeCloseTo(2.1025, 10);
  });

  test('yieldMult is 1.204^n, the second-run acceleration lever', () => {
    expect(yieldMult(0)).toBe(1);
    expect(yieldMult(1)).toBeCloseTo(1.2042, 4);
    expect(yieldMult(2)).toBeCloseTo(1.45, 10);
  });

  test('the class-neutral reserve/lifetime table', () => {
    // reserve = 900 * (1 + d/120)^1.9, with class and richness multipliers of 1
    expect(reserveFor(0, 'rocky', 0, 1)).toBeCloseTo(900, 6);
    expect(reserveFor(100, 'rocky', 0, 1)).toBeCloseTo(2847.1, 1);
    expect(reserveFor(250, 'rocky', 0, 1)).toBeCloseTo(7645.1, 1);

    // baseYield = 1.0 * (1 + d/200)
    expect(baseYieldFor(0, 'rocky', 0)).toBeCloseTo(1.0, 10);
    expect(baseYieldFor(100, 'rocky', 0)).toBeCloseTo(1.5, 10);
    expect(baseYieldFor(250, 'rocky', 0)).toBeCloseTo(2.25, 10);

    // lifetimes ~15 / ~32 / ~57 min
    expect(reserveFor(0, 'rocky', 0, 1) / baseYieldFor(0, 'rocky', 0) / 60).toBeCloseTo(15, 0);
    expect(reserveFor(100, 'rocky', 0, 1) / baseYieldFor(100, 'rocky', 0) / 60).toBeCloseTo(32, 0);
    expect(reserveFor(250, 'rocky', 0, 1) / baseYieldFor(250, 'rocky', 0) / 60).toBeCloseTo(57, 0);
  });

  test('a binary is one resource at double output, not two resources', () => {
    // 1.30 applied twice = 2.60 effective, against a rocky remnant's 1.00
    expect(baseYieldFor(100, 'binary', 0) / baseYieldFor(100, 'rocky', 0)).toBeCloseTo(2.6, 10);
  });

  test('the origin M-dwarf lives ~31 minutes', () => {
    const lifetime = ORIGIN_RESERVE / baseYieldFor(0, 'mdwarf', 0) / 60;
    expect(lifetime).toBeCloseTo(31.1, 1);
  });

  /**
   * The G-type is the pacing anchor for § 10's `first star runs dry 0:12–0:18`. Its
   * lifetime straddles that window rather than sitting inside it; this test pins the
   * actual spread so a balance change to the annulus or the reserve roll is visible.
   */
  test('the guaranteed G-type dies between 10.6 and 20.5 minutes', () => {
    const shortest =
      (reserveFor(GUARANTEED_GTYPE_MIN_D, 'gtype', 0, RESERVE_ROLL_MIN) /
        baseYieldFor(GUARANTEED_GTYPE_MIN_D, 'gtype', 0)) /
      60;
    const longest =
      (reserveFor(GUARANTEED_GTYPE_MAX_D, 'gtype', 0, RESERVE_ROLL_MAX) /
        baseYieldFor(GUARANTEED_GTYPE_MAX_D, 'gtype', 0)) /
      60;

    expect(shortest).toBeCloseTo(10.6, 1);
    expect(longest).toBeCloseTo(20.5, 1);
    // It still reliably dies before the origin does.
    expect(longest).toBeLessThan(ORIGIN_RESERVE / baseYieldFor(0, 'mdwarf', 0) / 60);
  });
});

describe('§ 2 link tiers', () => {
  test('the 150 lu worked example', () => {
    expect(buildCost(150, 1)).toBeCloseTo(367.75, 2);
    expect(buildCost(150, 2)).toBeCloseTo(1287.12, 2);
    expect(buildCost(150, 3)).toBeCloseTo(4412.99, 2);
    expect(buildCost(150, 4)).toBeCloseTo(14709.98, 2);

    expect(linkLatency(150, 1)).toBeCloseTo(18.75, 6);
    expect(linkLatency(150, 2)).toBeCloseTo(10.71, 2);
    expect(linkLatency(150, 3)).toBeCloseTo(6.82, 2);
    expect(linkLatency(150, 4)).toBeCloseTo(4.41, 2);
  });

  test('upgrade cost is the difference plus a 25% surcharge', () => {
    const expected = (buildCost(150, 2) - buildCost(150, 1)) * 1.25;
    expect(linkUpgradeCost(150, 1, 2)).toBeCloseTo(expected, 9);
  });

  test('dismantle refunds 40%', () => {
    expect(linkDismantleRefund(150, 1)).toBeCloseTo(buildCost(150, 1) * 0.4, 9);
  });

  test('a four-hop tier-I chain to the frontier is ~75 seconds one way', () => {
    expect(linkLatency(150, 1) * 4).toBeCloseTo(75, 0);
    // ...and tier III cuts it to ~27.
    expect(linkLatency(150, 3) * 4).toBeCloseTo(27, 0);
  });
});

describe('§ 3 node tiers', () => {
  test('the upgrade cost column', () => {
    expect(nodeUpgradeCost(0)).toBeCloseTo(60, 6);
    expect(nodeUpgradeCost(1)).toBeCloseTo(204, 6);
    expect(nodeUpgradeCost(2)).toBeCloseTo(693.6, 6);
    expect(nodeUpgradeCost(3)).toBeCloseTo(2358.24, 6);
  });

  test('ports and slots by tier', () => {
    expect([0, 1, 2, 3, 4].map((t) => portCount(t as 0, false))).toEqual([2, 3, 4, 5, 7]);
    // A hub gets +2 ports.
    expect(portCount(1, true)).toBe(5);
    expect([0, 1, 2, 3, 4].map((t) => recipeSlotCount(t as 0, true))).toEqual([1, 1, 2, 3, 4]);
    // Slots are a hub-only affordance.
    expect(recipeSlotCount(4, false)).toBe(0);
  });

  test('buffer capacity composes tier, upgrade level and hub multiplier', () => {
    expect(bufferCapacity(0, 0, false)).toBe(200);
    expect(bufferCapacity(4, 0, false)).toBe(26000);
    expect(bufferCapacity(1, 0, true)).toBe(2800);
    expect(bufferCapacity(1, 1, false)).toBeCloseTo(700 * 1.6, 6);
  });

  test('the free origin hub does not count toward hub designation cost', () => {
    // hubsPurchased = 0 is the second hub in the network, the first the player pays for.
    expect(hubDesignateCost(0)).toBe(250);
    expect(hubDesignateCost(1)).toBeCloseTo(650, 6);
    expect(hubDesignateCost(2)).toBeCloseTo(1690, 6);

    // 250 alloy at one slot's 0.25/s is ~17 minutes of production, which lands the second
    // hub near § 10's 0:35 target given first alloy at 0:14.
    expect(250 / RECIPES.alloy.outputPerSecond / 60).toBeCloseTo(16.7, 1);
  });
});

describe('§ 4 recipes', () => {
  test('sustained input demand per slot', () => {
    expect(RECIPES.alloy.outputPerSecond).toBeCloseTo(0.25, 10);
    expect(RECIPES.catalyst.outputPerSecond).toBeCloseTo(0.16667, 5);
    expect(RECIPES.core.outputPerSecond).toBeCloseTo(0.05, 10);

    const demand = (id: 'alloy' | 'catalyst' | 'core', resource: string) =>
      RECIPES[id].inputs.find((i) => i.resource === resource)?.perSecond ?? 0;

    expect(demand('alloy', 'metals')).toBeCloseTo(0.75, 10);
    expect(demand('alloy', 'hydrogen')).toBeCloseTo(0.5, 10);
    expect(demand('catalyst', 'isotopes')).toBeCloseTo(0.33333, 5);
    expect(demand('catalyst', 'hydrogen')).toBeCloseTo(0.83333, 5);
    expect(demand('core', 'alloy')).toBeCloseTo(0.2, 10);
    expect(demand('core', 'catalyst')).toBeCloseTo(0.15, 10);
  });

  test('a core slot needs 0.8 alloy slots and 0.9 catalyst slots', () => {
    const alloyNeeded = 0.2 / RECIPES.alloy.outputPerSecond;
    const catalystNeeded = 0.15 / RECIPES.catalyst.outputPerSecond;
    expect(alloyNeeded).toBeCloseTo(0.8, 6);
    expect(catalystNeeded).toBeCloseTo(0.9, 1);
  });

  test('a tier-I link comfortably feeds one alloy slot', () => {
    // 0.75 metals/s + 0.5 hydrogen/s = 1.25 u/s against 3 u/s.
    const total = RECIPES.alloy.inputs.reduce((n, i) => n + i.perSecond, 0);
    expect(total).toBeLessThan(3);
  });
});

describe('§ 5 within-run upgrades', () => {
  test('the four upgrade curves', () => {
    expect(extractionGlobal(0)).toBe(1);
    expect(extractionGlobal(5)).toBeCloseTo(1.6, 10);
    expect(extractionStar(4)).toBeCloseTo(2.0, 10);
    expect(bufferMult(0)).toBe(1);
    expect(bufferMult(2)).toBeCloseTo(2.56, 10);
    expect(scanRange(0)).toBe(130);
    expect(scanRange(3)).toBe(232);
  });
});

describe('§ 6 collapse', () => {
  test('the chart award curve', () => {
    expect(chartsAwarded(25)).toBe(17);
    expect(chartsAwarded(60)).toBe(28);
    expect(chartsAwarded(100)).toBe(37);
    expect(chartsAwarded(250)).toBe(62);
    expect(chartsAwarded(500)).toBe(91);
  });

  test('doubling a run yields roughly 1.46x the charts', () => {
    expect(chartsAwarded(200) / chartsAwarded(100)).toBeCloseTo(1.46, 1);
    expect(chartsAwarded(500) / chartsAwarded(250)).toBeCloseTo(1.46, 1);
  });

  test('routing profiles are affordable at the first collapse, at a cost', () => {
    // 17 charts at 25 cores; routing profiles cost 12, so it is buyable but expensive.
    expect(chartsAwarded(25)).toBeGreaterThanOrEqual(12);
    expect(chartsAwarded(25) - 12).toBeLessThan(6);
  });
});
