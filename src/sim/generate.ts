/**
 * Seeded cluster generation. BALANCE.md § 1.
 *
 * The seed guarantees are satisfied **constructively**, not by resampling whole clusters.
 * The joint probability of hitting all five by chance is around 3%, and the origin clause
 * is far worse than that on its own — with a 35 lu minimum separation, a random cluster
 * has no star at all within 20 lu of (0,0) roughly 90% of the time.
 *
 * Determinism is the hard requirement: every draw comes from the seeded PRNG in a fixed
 * order, so a seed always reproduces a cluster exactly.
 */

import {
  bufferCapacity,
  CLASS_REROLL_ATTEMPTS,
  CLASS_RESOURCE,
  classWeight,
  clusterRadius,
  GUARANTEED_GTYPE_MAX_D,
  GUARANTEED_GTYPE_MIN_D,
  GUARANTEED_ROCKY_MAX_D,
  GUARANTEED_ROCKY_MIN_D,
  INITIAL_METALS,
  INITIAL_RECIPES,
  INITIAL_SCAN_RANGE,
  ISOTOPE_EXCLUSION_RADIUS,
  MIN_STAR_SEPARATION,
  MIN_STARS_IN_INITIAL_SCAN,
  ORIGIN_CLASS,
  ORIGIN_RESERVE,
  ORIGIN_TIER,
  PLACEMENT_MAX_ATTEMPTS,
  placementRadius,
  recipeSlotCount,
  RESERVE_ROLL_MAX,
  RESERVE_ROLL_MIN,
  reserveFor,
  baseYieldFor,
  starCount,
  ALL_CLASSES,
} from './constants';
import { recomputeTopology } from './flow';
import { NAME_NUMERAL_MAX, NAME_POOL } from './names';
import { mulberry32, type Rng } from './rng';
import {
  makeRouting,
  makeVector,
  setAmount,
  RESOURCE_COUNT,
  type GameState,
  type MetaState,
  type NodeTier,
  type RecipeSlot,
  type RunState,
  type Star,
  type StarClass,
} from './types';

/** Bound on whole-placement retries for the scan-range clause. */
const PLACEMENT_RETRIES = 24;

interface Point {
  x: number;
  y: number;
}

function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

function farEnough(candidate: Point, placed: readonly Point[]): boolean {
  for (const p of placed) {
    if (distance(candidate, p) < MIN_STAR_SEPARATION) return false;
  }
  return true;
}

function pointAt(angle: number, radius: number): Point {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * Steps 1–3 of § Seed guarantees: origin, then the guaranteed G-type, then the guaranteed
 * rocky remnant. These are never resampled.
 */
function placeGuaranteed(rng: Rng): Point[] {
  const origin: Point = { x: 0, y: 0 };

  const gtype = pointAt(
    rng.range(0, Math.PI * 2),
    rng.range(GUARANTEED_GTYPE_MIN_D, GUARANTEED_GTYPE_MAX_D),
  );

  let rocky = pointAt(
    rng.range(0, Math.PI * 2),
    rng.range(GUARANTEED_ROCKY_MIN_D, GUARANTEED_ROCKY_MAX_D),
  );
  for (let attempt = 0; attempt < PLACEMENT_MAX_ATTEMPTS; attempt++) {
    if (farEnough(rocky, [origin, gtype])) break;
    rocky = pointAt(
      rng.range(0, Math.PI * 2),
      rng.range(GUARANTEED_ROCKY_MIN_D, GUARANTEED_ROCKY_MAX_D),
    );
  }

  return [origin, gtype, rocky];
}

/**
 * Step 4: the remaining stars by biased dart-throwing with rejection on the 35 lu
 * minimum separation. Not uniform Poisson-disc — the radial bias is the point of it.
 */
function placeRest(rng: Rng, placed: Point[], count: number, radius: number): void {
  for (let i = 0; i < count; i++) {
    let accepted: Point | null = null;
    for (let attempt = 0; attempt < PLACEMENT_MAX_ATTEMPTS; attempt++) {
      const candidate = pointAt(
        rng.range(0, Math.PI * 2),
        placementRadius(rng.next(), radius),
      );
      if (farEnough(candidate, placed)) {
        accepted = candidate;
        break;
      }
    }
    // Falling back to a rejected candidate keeps the star count exact. At the densities
    // in BALANCE.md § 1 this is unreachable — 40 stars at 35 lu in a 260 lu radius uses
    // about a quarter of the available hard-core capacity.
    placed.push(
      accepted ?? pointAt(rng.range(0, Math.PI * 2), placementRadius(rng.next(), radius)),
    );
  }
}

function isIsotopeClass(cls: StarClass): boolean {
  return CLASS_RESOURCE[cls] === 'isotopes';
}

function inGtypeAnnulus(d: number): boolean {
  return d >= GUARANTEED_GTYPE_MIN_D && d <= GUARANTEED_GTYPE_MAX_D;
}

/**
 * A class roll is rejected if it would break a seed guarantee:
 *
 *  - an isotope source inside 140 lu (isotopes must feel like a discovery)
 *  - a second G-type inside the 60–95 lu annulus, which would break "exactly one"
 */
function classPermitted(cls: StarClass, d: number): boolean {
  if (isIsotopeClass(cls) && d < ISOTOPE_EXCLUSION_RADIUS) return false;
  if (cls === 'gtype' && inGtypeAnnulus(d)) return false;
  return true;
}

function rollClass(rng: Rng, d: number, radius: number, collapseCount: number): StarClass {
  const df = d / radius;

  for (let attempt = 0; attempt < CLASS_REROLL_ATTEMPTS; attempt++) {
    let total = 0;
    for (const cls of ALL_CLASSES) total += classWeight(cls, df, collapseCount);
    if (total <= 0) break;

    let roll = rng.next() * total;
    for (const cls of ALL_CLASSES) {
      roll -= classWeight(cls, df, collapseCount);
      if (roll <= 0) {
        if (classPermitted(cls, d)) return cls;
        break;
      }
    }
  }

  // Fallback: the highest-weight class that is permitted here.
  let best: StarClass = 'mdwarf';
  let bestWeight = -1;
  for (const cls of ALL_CLASSES) {
    if (!classPermitted(cls, d)) continue;
    const w = classWeight(cls, df, collapseCount);
    if (w > bestWeight) {
      bestWeight = w;
      best = cls;
    }
  }
  return best;
}

function assignName(rng: Rng, taken: Set<string>): string {
  for (let attempt = 0; attempt < PLACEMENT_MAX_ATTEMPTS; attempt++) {
    const stem = NAME_POOL[rng.int(NAME_POOL.length)];
    const numeral = 1 + rng.int(NAME_NUMERAL_MAX);
    const name = `${stem}-${numeral}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  // Deterministic escape hatch: walk until something is free.
  for (const stem of NAME_POOL) {
    for (let n = 1; n <= NAME_NUMERAL_MAX; n++) {
      const name = `${stem}-${n}`;
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
  }
  throw new Error('name pool exhausted');
}

function makeSlots(tier: NodeTier, isHub: boolean): RecipeSlot[] {
  const count = recipeSlotCount(tier, isHub);
  const slots: RecipeSlot[] = [];
  for (let i = 0; i < count; i++) {
    slots.push({ recipe: null, status: { kind: 'idle' } });
  }
  return slots;
}

export function generateRun(seed: number, collapseCount: number): RunState {
  const rng = mulberry32(seed);
  const radius = clusterRadius(collapseCount);
  const total = starCount(collapseCount);

  const guaranteed = placeGuaranteed(rng);
  let points: Point[] = [];

  for (let retry = 0; retry < PLACEMENT_RETRIES; retry++) {
    points = [...guaranteed];
    placeRest(rng, points, total - guaranteed.length, radius);

    // Step 6: at least 4 stars within initial scan range of the origin. The two
    // guaranteed neighbours already count toward it.
    let inScan = 0;
    for (let i = 1; i < points.length; i++) {
      if (distance(points[0], points[i]) <= INITIAL_SCAN_RANGE) inScan++;
    }
    if (inScan >= MIN_STARS_IN_INITIAL_SCAN) break;
  }

  const taken = new Set<string>();
  const stars: Star[] = [];

  for (let id = 0; id < points.length; id++) {
    const point = points[id];
    const d = Math.hypot(point.x, point.y);

    let cls: StarClass;
    if (id === 0) cls = ORIGIN_CLASS;
    else if (id === 1) cls = 'gtype';
    else if (id === 2) cls = 'rocky';
    else cls = rollClass(rng, d, radius, collapseCount);

    const roll = rng.range(RESERVE_ROLL_MIN, RESERVE_ROLL_MAX);
    const isOrigin = id === 0;
    const reserve = isOrigin ? ORIGIN_RESERVE : reserveFor(d, cls, collapseCount, roll);
    const tier: NodeTier = isOrigin ? ORIGIN_TIER : 0;
    const isHub = isOrigin;

    stars.push({
      id,
      x: point.x,
      y: point.y,
      name: assignName(rng, taken),
      cls,
      resource: CLASS_RESOURCE[cls],
      reserve,
      reserveMax: reserve,
      baseYield: baseYieldFor(d, cls, collapseCount),
      tier,
      throttle: 1,
      buffer: makeVector(),
      role: isHub ? 'hub' : 'none',
      claimed: isOrigin,
      slots: makeSlots(tier, isHub),
      extractionK: 0,
      routing: makeRouting(),
      lastVentAt: -1,
    });
  }

  // The player starts with the origin claimed, tier 1, designated as a hub, with one
  // alloy recipe slot, and no links.
  const origin = stars[0];
  const firstSlot = origin.slots[0];
  if (firstSlot !== undefined) firstSlot.recipe = 'alloy';

  const granted = makeVector();
  setAmount(granted, 'metals', INITIAL_METALS);
  setAmount(origin.buffer, 'metals', INITIAL_METALS);

  const run: RunState = {
    seed,
    elapsed: 0,
    stars,
    links: [],
    topology: { hopDistance: [], adjacency: [], descending: [] },
    upgrades: { extractionGlobal: 0, buffer: 0, scanRange: 0 },
    hubsPurchased: 0,
    profiles: [],
    extracted: makeVector(),
    granted,
    vented: makeVector(),
    consumedByRecipes: makeVector(),
    producedByRecipes: makeVector(),
    coresProduced: 0,
  };

  run.topology = recomputeTopology(run);
  return run;
}

export function newMeta(): MetaState {
  return {
    charts: 0,
    chartNodes: [],
    recipesUnlocked: [...INITIAL_RECIPES],
    collapseCount: 0,
    stats: { totalCoresProduced: 0, totalCollapses: 0, totalVented: 0 },
  };
}

export function newGame(seed: number): GameState {
  const meta = newMeta();
  return { meta, run: generateRun(seed, meta.collapseCount) };
}

/**
 * Build a link between two stars, claiming the far endpoint. Cost and port checks belong
 * to the action layer in a later phase; this is the state transition only.
 */
export function connect(run: RunState, a: number, b: number, tier: 1 | 2 | 3 | 4): void {
  const starA = run.stars[a];
  const starB = run.stars[b];
  const id = run.links.length;

  run.links.push({
    id,
    a,
    b,
    tier,
    length: distance(starA, starB),
    kind: 'normal',
    queue: [],
    head: 0,
    tail: new Array<null>(2 * RESOURCE_COUNT).fill(null),
  });

  starA.claimed = true;
  starB.claimed = true;
  run.topology = recomputeTopology(run);
}

/** Capacity of a star's buffer for any one resource. Convenience for tests and UI. */
export function capacityOf(run: RunState, starId: number): number {
  const star = run.stars[starId];
  return bufferCapacity(star.tier, run.upgrades.buffer, star.role === 'hub');
}
