/**
 * Hand-built networks for tests. Deliberately *not* generated: these fix every reserve,
 * yield and tier explicitly so the tests lock the behaviour of the simulation rather than
 * the current contents of BALANCE.md. A balance change should not turn the tick tests red.
 */

import { recipeSlotCount } from './constants';
import { recomputeTopology } from './flow';
import { connect, newGame } from './generate';
import { tick } from './tick';
import {
  makeRouting,
  makeVector,
  RESOURCE_COUNT,
  type GameState,
  type Link,
  type LinkTier,
  type NodeTier,
  type RawResource,
  type RecipeId,
  type RecipeSlot,
  type RunState,
  type Star,
  type StarClass,
} from './types';

export interface StarSpec {
  x: number;
  y: number;
  name: string;
  cls: StarClass;
  resource: RawResource | null;
  reserve: number;
  baseYield: number;
  tier: NodeTier;
  hub: boolean;
  recipes: readonly (RecipeId | null)[];
}

export interface LinkSpec {
  a: number;
  b: number;
  tier: LinkTier;
}

function makeStar(id: number, spec: StarSpec): Star {
  const slotCount = recipeSlotCount(spec.tier, spec.hub);
  const slots: RecipeSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    slots.push({ recipe: spec.recipes[i] ?? null, status: { kind: 'idle' } });
  }
  return {
    id,
    x: spec.x,
    y: spec.y,
    name: spec.name,
    cls: spec.cls,
    resource: spec.resource,
    reserve: spec.reserve,
    reserveMax: spec.reserve,
    baseYield: spec.baseYield,
    tier: spec.tier,
    throttle: 1,
    buffer: makeVector(),
    role: spec.hub ? 'hub' : 'none',
    claimed: true,
    slots,
    extractionK: 0,
    routing: makeRouting(),
    lastVentAt: -1,
  };
}

export function buildNetwork(stars: readonly StarSpec[], links: readonly LinkSpec[]): GameState {
  const built: Star[] = stars.map((spec, id) => makeStar(id, spec));

  const builtLinks: Link[] = links.map((spec, id) => ({
    id,
    a: spec.a,
    b: spec.b,
    tier: spec.tier,
    length: Math.hypot(
      built[spec.a].x - built[spec.b].x,
      built[spec.a].y - built[spec.b].y,
    ),
    kind: 'normal',
    queue: [],
    head: 0,
    tail: new Array<null>(2 * RESOURCE_COUNT).fill(null),
  }));

  const run: RunState = {
    seed: 1,
    elapsed: 0,
    stars: built,
    links: builtLinks,
    topology: { hopDistance: [], adjacency: [], descending: [] },
    upgrades: { extractionGlobal: 0, buffer: 0, scanRange: 0 },
    hubsPurchased: 0,
    profiles: [],
    extracted: makeVector(),
    granted: makeVector(),
    vented: makeVector(),
    consumedByRecipes: makeVector(),
    producedByRecipes: makeVector(),
    spentOnConstruction: makeVector(),
    coresProduced: 0,
  };
  run.topology = recomputeTopology(run);

  return {
    meta: {
      charts: 0,
      chartNodes: [],
      recipesUnlocked: ['alloy', 'catalyst', 'core'],
      collapseCount: 0,
      stats: { totalCoresProduced: 0, totalCollapses: 0, totalVented: 0 },
    },
    run,
  };
}

/**
 * The acceptance fixture: five stars, four links, one hub refining alloy.
 *
 *        Ash-2 (H)
 *           |
 *   Bell-4 (H, hub) ── Reed-1 (metals) ── Pike-9 (isotopes)
 *                            └────────── Vane-3 (metals)
 *
 * Chosen so that one tick exercises everything at once:
 *
 *  - Reed-1's outbound trunk is deliberately oversubscribed (1.4 + 2.5 + 2.0 u/s of
 *    demand against 3 u/s of tier-I bandwidth), so it saturates and Reed-1's 200 u
 *    buffer backs up and vents.
 *  - Ash-2 holds only 900 u of reserve at 1.0125 u/s, so it depletes at ~14m 48s —
 *    inside the 30-minute test window.
 *  - Bell-4 receives hydrogen and metals and refines alloy, so recipe consumption
 *    appears in the conservation identity.
 */
export function fiveStarNetwork(): GameState {
  return buildNetwork(
    [
      {
        x: 0,
        y: 0,
        name: 'Bell-4',
        cls: 'mdwarf',
        resource: 'hydrogen',
        reserve: 1400,
        baseYield: 0.75,
        tier: 1,
        hub: true,
        recipes: ['alloy'],
      },
      {
        x: 80,
        y: 0,
        name: 'Reed-1',
        cls: 'rocky',
        resource: 'metals',
        reserve: 5000,
        baseYield: 1.4,
        tier: 0,
        hub: false,
        recipes: [],
      },
      {
        x: 0,
        y: -70,
        name: 'Ash-2',
        cls: 'mdwarf',
        resource: 'hydrogen',
        reserve: 900,
        baseYield: 1.0125,
        tier: 0,
        hub: false,
        recipes: [],
      },
      {
        x: 190,
        y: 40,
        name: 'Pike-9',
        cls: 'heavy',
        resource: 'isotopes',
        reserve: 6000,
        baseYield: 2.0,
        tier: 0,
        hub: false,
        recipes: [],
      },
      {
        x: 170,
        y: -60,
        name: 'Vane-3',
        cls: 'rocky',
        resource: 'metals',
        reserve: 6000,
        baseYield: 2.5,
        tier: 0,
        hub: false,
        recipes: [],
      },
    ],
    [
      { a: 1, b: 0, tier: 1 },
      { a: 2, b: 0, tier: 1 },
      { a: 3, b: 1, tier: 1 },
      { a: 4, b: 1, tier: 1 },
    ],
  );
}

/** Two stars, one link. The trunk's tier is the knob the contention tests turn. */
export function twoStarTrunk(tier: LinkTier): GameState {
  return buildNetwork(
    [
      {
        x: 0,
        y: 0,
        name: 'Bell-4',
        cls: 'mdwarf',
        resource: 'hydrogen',
        reserve: 0,
        baseYield: 0,
        tier: 4,
        hub: true,
        recipes: [null],
      },
      {
        x: 100,
        y: 0,
        name: 'Reed-1',
        cls: 'rocky',
        resource: null,
        reserve: 0,
        baseYield: 0,
        tier: 4,
        hub: false,
        recipes: [],
      },
    ],
    [{ a: 1, b: 0, tier }],
  );
}

/** A lone hub with one alloy slot and nothing feeding it. */
export function loneHub(): GameState {
  return buildNetwork(
    [
      {
        x: 0,
        y: 0,
        name: 'Bell-4',
        cls: 'mdwarf',
        resource: null,
        reserve: 0,
        baseYield: 0,
        tier: 2,
        hub: true,
        recipes: ['alloy', 'catalyst'],
      },
    ],
    [],
  );
}

/**
 * A realistic cluster: generated stars, wired outward from the origin as a spanning tree
 * of nearest neighbours — roughly what a player builds — plus a frontier hub so material
 * has two places to converge. Used by the endurance test.
 */
export function spanningTreeCluster(seed: number): GameState {
  const state = newGame(seed);
  const run = state.run;

  // A fresh game ships its refinery stopped, so a player has to start it. This fixture stands
  // in for a network someone has actually been running, so start it here.
  for (const slot of run.stars[0].slots) slot.recipe = 'alloy';

  const connected: number[] = [0];

  for (let id = 1; id < run.stars.length; id++) {
    let nearest = 0;
    let nearestD = Infinity;
    for (const other of connected) {
      const d = Math.hypot(
        run.stars[id].x - run.stars[other].x,
        run.stars[id].y - run.stars[other].y,
      );
      if (d < nearestD) {
        nearestD = d;
        nearest = other;
      }
    }
    connect(run, id, nearest, 2);
    connected.push(id);
  }

  const frontier = run.stars.reduce((a, b) =>
    Math.hypot(b.x, b.y) > Math.hypot(a.x, a.y) ? b : a,
  );
  frontier.role = 'hub';
  frontier.tier = 2;
  frontier.slots = [
    { recipe: 'catalyst', status: { kind: 'idle' } },
    { recipe: 'core', status: { kind: 'idle' } },
  ];
  run.topology = recomputeTopology(run);

  return state;
}

/** Run `seconds` of game time at a fixed step. */
export function run(state: GameState, seconds: number, dt: number): GameState {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) tick(state, dt);
  return state;
}
