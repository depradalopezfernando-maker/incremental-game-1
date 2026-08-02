/**
 * Every number from BALANCE.md. No magic numbers anywhere else in the codebase —
 * balance changes must be a one-file change.
 *
 * Each formula carries the BALANCE.md expression it implements in a comment above it.
 * Units: distance in light-units (lu), time in seconds, material in units (u).
 */

import {
  type LinkTier,
  type NodeTier,
  type RawResource,
  type RecipeId,
  type Resource,
  type StarClass,
} from './types';

// ---------------------------------------------------------------------------
// Simulation stepping
// ---------------------------------------------------------------------------

/** Fixed simulation rate, decoupled from render rate. ROADMAP.md Phase 3. */
export const SIM_HZ = 10;
export const SIM_STEP_SECONDS = 1 / SIM_HZ;

// ---------------------------------------------------------------------------
// § 1 Cluster generation
// ---------------------------------------------------------------------------

export const STAR_COUNT_BASE = 40;
export const STAR_COUNT_PER_COLLAPSE = 14;
export const CLUSTER_RADIUS_BASE = 260;
export const CLUSTER_RADIUS_PER_COLLAPSE = 90;
export const RICHNESS_BASE = 1.45;

/** starCount = 40 + 14 * n */
export function starCount(collapseCount: number): number {
  return STAR_COUNT_BASE + STAR_COUNT_PER_COLLAPSE * collapseCount;
}

/** clusterRadius = 260 + 90 * n   (lu) */
export function clusterRadius(collapseCount: number): number {
  return CLUSTER_RADIUS_BASE + CLUSTER_RADIUS_PER_COLLAPSE * collapseCount;
}

/** richnessMult = 1.45 ^ n */
export function richnessMult(collapseCount: number): number {
  return Math.pow(RICHNESS_BASE, collapseCount);
}

/**
 * yieldMult = richnessMult ^ 0.5 = 1.204 ^ n
 *
 * The lever for the second-run acceleration target in § 10. Without it richness
 * scales reserve only, so later clusters last longer at flat throughput — and
 * throughput is what makes lattice cores.
 */
export const YIELD_RICHNESS_EXPONENT = 0.5;

export function yieldMult(collapseCount: number): number {
  return Math.pow(richnessMult(collapseCount), YIELD_RICHNESS_EXPONENT);
}

// --- Star placement ---

export const MIN_STAR_SEPARATION = 35;

/**
 * radius = clusterRadius * sqrt(u)^1.33      for uniform u
 *
 * Areal density then goes as r^(1/0.667 - 2) = r^-0.5, thinning outward. The exponent
 * must exceed the uniform-area sqrt(u); below it the frontier ends up denser than the
 * interior, which is the opposite of the intent.
 */
export const PLACEMENT_RADIUS_EXPONENT = 1.33;

export function placementRadius(u: number, radius: number): number {
  return radius * Math.pow(Math.sqrt(u), PLACEMENT_RADIUS_EXPONENT);
}

/** Bound on dart-throwing attempts per star before giving up on separation. */
export const PLACEMENT_MAX_ATTEMPTS = 200;

// --- Class assignment ---

export const CLASS_RESOURCE: Readonly<Record<StarClass, RawResource | null>> = {
  mdwarf: 'hydrogen',
  gtype: 'hydrogen',
  rocky: 'metals',
  heavy: 'isotopes',
  neutron: 'isotopes',
  binary: 'hydrogen',
  anchor: null,
};

export const CLASS_BASE_WEIGHT: Readonly<Record<StarClass, number>> = {
  mdwarf: 40,
  gtype: 18,
  rocky: 22,
  heavy: 12,
  neutron: 5,
  binary: 8,
  anchor: 6,
};

/** Collapse count at which each class starts appearing. */
export const CLASS_MIN_COLLAPSE: Readonly<Record<StarClass, number>> = {
  mdwarf: 0,
  gtype: 0,
  rocky: 0,
  heavy: 0,
  neutron: 0,
  binary: 2,
  anchor: 3,
};

/**
 * Weight modifiers by distance fraction df = d / clusterRadius.
 *
 *   M-dwarf         —
 *   G-type          —
 *   Rocky remnant   * (1 + 0.4*df)
 *   Heavy remnant   * (0.3 + 1.9*df)
 *   Neutron star    * (0.1 + 2.6*df)
 *   Binary          * (0.5 + df)
 *   Wormhole anchor * df
 *
 * Isotopes being frontier-weighted is what forces expansion in phase 2.
 */
export function classWeight(cls: StarClass, df: number, collapseCount: number): number {
  if (collapseCount < CLASS_MIN_COLLAPSE[cls]) return 0;
  const base = CLASS_BASE_WEIGHT[cls];
  switch (cls) {
    case 'mdwarf':
    case 'gtype':
      return base;
    case 'rocky':
      return base * (1 + 0.4 * df);
    case 'heavy':
      return base * (0.3 + 1.9 * df);
    case 'neutron':
      return base * (0.1 + 2.6 * df);
    case 'binary':
      return base * (0.5 + df);
    case 'anchor':
      return base * df;
  }
}

export const ALL_CLASSES: readonly StarClass[] = [
  'mdwarf',
  'gtype',
  'rocky',
  'heavy',
  'neutron',
  'binary',
  'anchor',
];

// --- Reserve and yield ---

export const RESERVE_BASE = 900;
export const RESERVE_DISTANCE_SCALE = 120;
export const RESERVE_DISTANCE_EXPONENT = 1.9;
export const RESERVE_ROLL_MIN = 0.8;
export const RESERVE_ROLL_MAX = 1.25;

export const YIELD_BASE = 1.0;
export const YIELD_DISTANCE_SCALE = 200;

export const CLASS_RESERVE_MULT: Readonly<Record<StarClass, number>> = {
  mdwarf: 1.35,
  gtype: 0.85,
  rocky: 1.0,
  heavy: 0.7,
  neutron: 0.45,
  binary: 1.1,
  anchor: 0,
};

export const CLASS_YIELD_MULT: Readonly<Record<StarClass, number>> = {
  mdwarf: 0.75,
  gtype: 1.6,
  rocky: 1.0,
  heavy: 0.85,
  neutron: 2.4,
  binary: 1.3,
  anchor: 0,
};

/**
 * A binary is a single resource — hydrogen — at double output, not two different
 * resources. Effective yield multiplier is 1.30 * 2 = 2.60.
 */
export const BINARY_OUTPUT_COUNT = 2;

/** reserve = 900 * (1 + d/120)^1.9 * classReserveMult * richnessMult * rng(0.8, 1.25) */
export function reserveFor(
  d: number,
  cls: StarClass,
  collapseCount: number,
  roll: number,
): number {
  return (
    RESERVE_BASE *
    Math.pow(1 + d / RESERVE_DISTANCE_SCALE, RESERVE_DISTANCE_EXPONENT) *
    CLASS_RESERVE_MULT[cls] *
    richnessMult(collapseCount) *
    roll
  );
}

/** baseYield = 1.0 * (1 + d/200) * classYieldMult * yieldMult */
export function baseYieldFor(d: number, cls: StarClass, collapseCount: number): number {
  const outputs = cls === 'binary' ? BINARY_OUTPUT_COUNT : 1;
  return (
    YIELD_BASE *
    (1 + d / YIELD_DISTANCE_SCALE) *
    CLASS_YIELD_MULT[cls] *
    outputs *
    yieldMult(collapseCount)
  );
}

// --- Seed guarantees ---

export const ORIGIN_MAX_DISTANCE = 20;
export const ORIGIN_RESERVE = 1400;
export const ORIGIN_CLASS: StarClass = 'mdwarf';
export const ORIGIN_TIER: NodeTier = 1;

export const GUARANTEED_GTYPE_MIN_D = 60;
export const GUARANTEED_GTYPE_MAX_D = 95;

export const GUARANTEED_ROCKY_MIN_D = 45;
export const GUARANTEED_ROCKY_MAX_D = 85;

/** No isotope source within this radius — isotopes must feel like a discovery. */
export const ISOTOPE_EXCLUSION_RADIUS = 140;

export const MIN_STARS_IN_INITIAL_SCAN = 4;

/** Class re-rolls before falling back to the highest-weight permitted class. */
export const CLASS_REROLL_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// § 2 Link tiers
// ---------------------------------------------------------------------------

export const LINK_TIERS: readonly LinkTier[] = [1, 2, 3, 4];

/** Bandwidth in u/s, indexed by tier. Index 0 is unused. */
export const LINK_BANDWIDTH: readonly number[] = [0, 3, 9, 26, 70];

/** Propagation speed in lu/s, indexed by tier. */
export const LINK_SPEED: readonly number[] = [0, 8, 14, 22, 34];

/** Cost multiplier, indexed by tier. */
export const LINK_COST_MULT: readonly number[] = [0, 1.0, 3.5, 12, 40];

/** Tier I is paid in metals; tiers II–IV in alloy. */
export const LINK_COST_CURRENCY: readonly Resource[] = [
  'metals',
  'metals',
  'alloy',
  'alloy',
  'alloy',
];

export const LINK_COST_COEFFICIENT = 0.9;
export const LINK_COST_EXPONENT = 1.2;
export const LINK_UPGRADE_SURCHARGE = 1.25;
export const LINK_DISMANTLE_REFUND = 0.4;

/**
 * buildCost(len, tier) = 0.9 * len^1.2 * tierCostMult[tier]
 *
 * A 150 lu trunk: 368 metals at tier I, then 1,288 / 4,415 / 14,716 alloy.
 */
export function buildCost(length: number, tier: LinkTier): number {
  return (
    LINK_COST_COEFFICIENT * Math.pow(length, LINK_COST_EXPONENT) * LINK_COST_MULT[tier]
  );
}

/** latency(len, tier) = len / tierSpeed[tier] */
export function linkLatency(length: number, tier: LinkTier): number {
  return length / LINK_SPEED[tier];
}

/** upgradeCost(a → b) = (buildCost(len,b) - buildCost(len,a)) * 1.25 */
export function linkUpgradeCost(length: number, from: LinkTier, to: LinkTier): number {
  return (buildCost(length, to) - buildCost(length, from)) * LINK_UPGRADE_SURCHARGE;
}

/** dismantleRefund = 0.4 * buildCost(len, currentTier) */
export function linkDismantleRefund(length: number, tier: LinkTier): number {
  return LINK_DISMANTLE_REFUND * buildCost(length, tier);
}

// ---------------------------------------------------------------------------
// § 3 Node tiers
// ---------------------------------------------------------------------------

/** Ports by node tier. */
export const NODE_PORTS: readonly number[] = [2, 3, 4, 5, 7];

/** Buffer per resource (u) by node tier. */
export const NODE_BUFFER: readonly number[] = [200, 700, 2400, 8000, 26000];

/** Recipe slots by node tier — hubs only. */
export const NODE_SLOTS: readonly number[] = [1, 1, 2, 3, 4];

export const NODE_UPGRADE_BASE = 60;
export const NODE_UPGRADE_GROWTH = 3.4;

export const HUB_DESIGNATE_BASE = 250;
export const HUB_DESIGNATE_GROWTH = 2.6;
export const HUB_PORT_BONUS = 2;
export const HUB_BUFFER_MULT = 4.0;
export const HUB_UNDESIGNATE_REFUND = 0.5;

export const MAX_NODE_TIER: NodeTier = 4;

/** nodeUpgradeCost(t) = 60 * 3.4^t     // cost to go from t to t+1, in alloy */
export function nodeUpgradeCost(tier: NodeTier): number {
  return NODE_UPGRADE_BASE * Math.pow(NODE_UPGRADE_GROWTH, tier);
}

/**
 * hubDesignateCost = 250 * 2.6^hubsPurchased     alloy
 *
 * `hubsPurchased` counts hubs the player has paid for. The origin hub is granted free
 * at run start and does not count, so the second hub in the network costs 250 alloy.
 */
export function hubDesignateCost(hubsPurchased: number): number {
  return HUB_DESIGNATE_BASE * Math.pow(HUB_DESIGNATE_GROWTH, hubsPurchased);
}

/**
 * capacity(star, r) = tierBuffer[tier] * bufferMult(k) * (isHub ? 4 : 1)
 *
 * Per resource, not shared across resources.
 */
export function bufferCapacity(tier: NodeTier, bufferK: number, isHub: boolean): number {
  return NODE_BUFFER[tier] * bufferMult(bufferK) * (isHub ? HUB_BUFFER_MULT : 1);
}

export function portCount(tier: NodeTier, isHub: boolean): number {
  return NODE_PORTS[tier] + (isHub ? HUB_PORT_BONUS : 0);
}

export function recipeSlotCount(tier: NodeTier, isHub: boolean): number {
  return isHub ? NODE_SLOTS[tier] : 0;
}

/**
 * Delay-queue segment budget per link, per direction, per resource. A long tier-I trunk
 * at 10 Hz would otherwise hold ~190 segments; MECHANICS.md § Delay queues wants a few
 * dozen. Departures inside the same arrival bucket merge, which smears arrival timing by
 * at most `latency / MAX_SEGMENTS_PER_LINK` and never loses material.
 */
export const MAX_SEGMENTS_PER_LINK = 32;

export function segmentMergeWindow(latency: number, dt: number): number {
  const window = latency / MAX_SEGMENTS_PER_LINK;
  return window > dt ? window : dt;
}

/**
 * A standing buffer offers its contents downstream over roughly this many seconds
 * rather than all at once. See MECHANICS.md § Routing solve — the bound is what stops
 * a full buffer from demanding an unbounded rate and saturating everything downstream.
 */
export const BUFFER_DRAWDOWN_SECONDS = 5;

// ---------------------------------------------------------------------------
// § 4 Recipes
// ---------------------------------------------------------------------------

export interface RecipeInput {
  readonly resource: Resource;
  /** Units consumed per second at full rate. */
  readonly perSecond: number;
}

export interface Recipe {
  readonly id: RecipeId;
  readonly inputs: readonly RecipeInput[];
  readonly output: Resource;
  /** Units produced per second per slot at full rate. */
  readonly outputPerSecond: number;
  /** Cycle length in seconds. Presentation only — consumption is continuous. */
  readonly cycleSeconds: number;
}

/**
 * | Recipe       | Inputs                    | Output | Cycle | Effective rate      |
 * | Alloy        | 3 metals + 2 hydrogen     | 1      | 4 s   | 0.25 alloy/s        |
 * | Catalyst     | 2 isotopes + 5 hydrogen   | 1      | 6 s   | 0.167 catalyst/s    |
 * | Lattice core | 4 alloy + 3 catalyst      | 1      | 20 s  | 0.05 core/s         |
 *
 * Rates below are derived from quantity / cycle so the table above stays the source
 * of truth and the two can never drift.
 */
interface RecipeSpec {
  readonly inputs: readonly (readonly [Resource, number])[];
  readonly output: Resource;
  readonly outputAmount: number;
  readonly cycleSeconds: number;
}

const RECIPE_TABLE: Readonly<Record<RecipeId, RecipeSpec>> = {
  alloy: {
    inputs: [
      ['metals', 3],
      ['hydrogen', 2],
    ],
    output: 'alloy',
    outputAmount: 1,
    cycleSeconds: 4,
  },
  catalyst: {
    inputs: [
      ['isotopes', 2],
      ['hydrogen', 5],
    ],
    output: 'catalyst',
    outputAmount: 1,
    cycleSeconds: 6,
  },
  core: {
    inputs: [
      ['alloy', 4],
      ['catalyst', 3],
    ],
    output: 'core',
    outputAmount: 1,
    cycleSeconds: 20,
  },
};

function deriveRecipe(id: RecipeId): Recipe {
  const spec = RECIPE_TABLE[id];
  return {
    id,
    inputs: spec.inputs.map(([resource, amount]) => ({
      resource,
      perSecond: amount / spec.cycleSeconds,
    })),
    output: spec.output,
    outputPerSecond: spec.outputAmount / spec.cycleSeconds,
    cycleSeconds: spec.cycleSeconds,
  };
}

export const RECIPES: Readonly<Record<RecipeId, Recipe>> = {
  alloy: deriveRecipe('alloy'),
  catalyst: deriveRecipe('catalyst'),
  core: deriveRecipe('core'),
};

export const RECIPE_IDS: readonly RecipeId[] = ['alloy', 'catalyst', 'core'];

/** The alloy recipe is available from the start; the others unlock on first inputs. */
export const INITIAL_RECIPES: readonly RecipeId[] = ['alloy'];

// ---------------------------------------------------------------------------
// § 5 Upgrades within a run
// ---------------------------------------------------------------------------

/** extractionGlobal(k) = 1 + 0.12*k     cost: 90 * 1.55^k catalyst */
export function extractionGlobal(k: number): number {
  return 1 + 0.12 * k;
}
export function extractionGlobalCost(k: number): number {
  return 90 * Math.pow(1.55, k);
}

/** extractionStar(k) = 1 + 0.25*k       cost: 40 * 1.9^k catalyst, max k=4 */
export const EXTRACTION_STAR_MAX_K = 4;
export function extractionStar(k: number): number {
  return 1 + 0.25 * k;
}
export function extractionStarCost(k: number): number {
  return 40 * Math.pow(1.9, k);
}

/** bufferMult(k) = 1.6^k                cost: 120 * 2.1^k catalyst */
export function bufferMult(k: number): number {
  return Math.pow(1.6, k);
}
export function bufferMultCost(k: number): number {
  return 120 * Math.pow(2.1, k);
}

/** scanRange(k) = 130 + 34*k     (lu)   cost: 70 * 1.75^k catalyst */
export const INITIAL_SCAN_RANGE = 130;
export function scanRange(k: number): number {
  return INITIAL_SCAN_RANGE + 34 * k;
}
export function scanRangeCost(k: number): number {
  return 70 * Math.pow(1.75, k);
}

/**
 * Initial stockpile: 450 metals, 0 everything else. Held in the origin's buffer.
 *
 * Raised from 300 after playtesting. At 300 the opening bought roughly one or two links, and
 * the guaranteed rocky remnant can cost up to 186 of it — so a player who spent on the wrong
 * stars first could end up with no metals, no metals income, and nothing affordable. 450 gives
 * the opening enough slack to make a mistake and recover from it by playing rather than by
 * dismantling.
 */
export const INITIAL_METALS = 450;

// ---------------------------------------------------------------------------
// § 6 Collapse
// ---------------------------------------------------------------------------

export const COLLAPSE_UNLOCK_CORES = 25;
export const CHART_COEFFICIENT = 3;
export const CHART_EXPONENT = 0.55;

/** charts(totalCores) = floor(3 * totalCores^0.55) */
export function chartsAwarded(totalCores: number): number {
  return Math.floor(CHART_COEFFICIENT * Math.pow(totalCores, CHART_EXPONENT));
}

// ---------------------------------------------------------------------------
// § 8 Offline resolution
// ---------------------------------------------------------------------------

export const OFFLINE_CAP_SECONDS = 14 * 60 * 60;
export const OFFLINE_EFFICIENCY = 1.0;
export const OFFLINE_EVENT_CAP = 400;
export const OFFLINE_COARSE_TICK_SECONDS = 60;

/**
 * Absences shorter than this resolve by real ticks instead of closed form. Closed-form
 * resolution discards latency, which is correct over hours and wrong over minutes.
 */
export const OFFLINE_CLOSED_FORM_MIN_SECONDS = 120;

/**
 * A buffer below this is treated as empty. Without it, a buffer hovering at 1e-18 keeps
 * generating "empties at t=1e-18" events and the interval solver burns its event budget
 * making no progress.
 */
export const OFFLINE_BUFFER_EPSILON = 1e-9;

/** Forced progress when every event lands at t≈0, for the same reason. */
export const OFFLINE_MIN_INTERVAL_SECONDS = 1e-3;
