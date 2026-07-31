/**
 * Full state shape. See MECHANICS.md § 9 for the meta/run split, § 1 for Star and
 * § 2 for Link.
 *
 * This module is pure types plus the structural orderings that indexing depends on.
 * Balance numbers live in constants.ts without exception.
 */

export type RawResource = 'hydrogen' | 'metals' | 'isotopes';
export type RefinedResource = 'alloy' | 'catalyst' | 'core';
export type Resource = RawResource | RefinedResource;

/**
 * Canonical resource order. Flat arrays in the flow solver are indexed by position
 * here, so this order is load-bearing: changing it changes nothing semantically but
 * invalidates any persisted flat array.
 */
export const RESOURCES: readonly Resource[] = [
  'hydrogen',
  'metals',
  'isotopes',
  'alloy',
  'catalyst',
  'core',
];

export const RAW_RESOURCES: readonly RawResource[] = ['hydrogen', 'metals', 'isotopes'];

export const RESOURCE_COUNT = RESOURCES.length;

export const RESOURCE_INDEX: Readonly<Record<Resource, number>> = {
  hydrogen: 0,
  metals: 1,
  isotopes: 2,
  alloy: 3,
  catalyst: 4,
  core: 5,
};

/** Plain-object per-resource amounts. Reporting, serialisation and test assertions. */
export type ResourceAmounts = Record<Resource, number>;

export function emptyAmounts(): ResourceAmounts {
  return { hydrogen: 0, metals: 0, isotopes: 0, alloy: 0, catalyst: 0, core: 0 };
}

/**
 * Per-resource amounts indexed by `RESOURCE_INDEX` — star buffers and the run ledgers.
 *
 * A `Float64Array` rather than a keyed object because these are read and written with a
 * *dynamic* resource in the tick's hot loops. Keyed lookups on a plain object cost 20–50ns
 * each and there are dozens per tick per star; measured on a realistic 40-star cluster,
 * that representation put a 6-hour run at 11 seconds, which does not fit the suite budget
 * in ROADMAP.md § Testing discipline. The same run is a little over 2 seconds this way.
 *
 * Use `amountOf` / `addAmount` where the resource is dynamic and readability matters, and
 * `toAmounts` at the boundary where state leaves the simulation.
 */
export type ResourceVector = Float64Array;

export function makeVector(): ResourceVector {
  return new Float64Array(RESOURCE_COUNT);
}

export function amountOf(vector: ResourceVector, resource: Resource): number {
  return vector[RESOURCE_INDEX[resource]];
}

export function addAmount(vector: ResourceVector, resource: Resource, amount: number): void {
  vector[RESOURCE_INDEX[resource]] += amount;
}

export function setAmount(vector: ResourceVector, resource: Resource, amount: number): void {
  vector[RESOURCE_INDEX[resource]] = amount;
}

export function toAmounts(vector: ResourceVector): ResourceAmounts {
  const out = emptyAmounts();
  for (let r = 0; r < RESOURCE_COUNT; r++) out[RESOURCES[r]] = vector[r];
  return out;
}

export type StarId = number;
export type LinkId = number;

export type StarClass =
  | 'mdwarf'
  | 'gtype'
  | 'rocky'
  | 'heavy'
  | 'neutron'
  | 'binary'
  | 'anchor';

/** Node tier, 0–4. Determines ports, buffer capacity and hub recipe slots. */
export type NodeTier = 0 | 1 | 2 | 3 | 4;

/** Link tier, 1–4. Determines bandwidth and propagation speed. */
export type LinkTier = 1 | 2 | 3 | 4;

export type RecipeId = 'alloy' | 'catalyst' | 'core';

export type StarRole = 'none' | 'hub';

/**
 * Why a recipe slot is not producing at full rate. MECHANICS.md § Stalling requires
 * `starved` and `backedUp` to be distinguishable — a hub waiting on isotopes and a hub
 * with nowhere to put its alloy are different problems with different fixes.
 */
export type SlotStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; fraction: number }
  | { readonly kind: 'starved'; readonly missing: readonly Resource[] }
  | { readonly kind: 'backedUp'; readonly output: Resource };

export interface RecipeSlot {
  recipe: RecipeId | null;
  status: SlotStatus;
}

/**
 * Player-set weights over a star's outbound links, keyed by link id, per resource.
 *
 * Indexed by `RESOURCE_INDEX` and `null` where the player has not overridden anything —
 * a `null` entry uses the default weights from MECHANICS.md § Default weights. Overrides
 * are stored rather than a resolved table because a topology change would leave a fully
 * materialised table stale.
 */
export type RoutingOverrides = (Record<string, number> | null)[];

export function makeRouting(): RoutingOverrides {
  return [null, null, null, null, null, null];
}

export interface Star {
  readonly id: StarId;
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly cls: StarClass;
  /** `null` for wormhole anchors, which never produce. */
  readonly resource: RawResource | null;
  reserve: number;
  readonly reserveMax: number;
  /** Units/sec at 100% throttle before upgrades. */
  readonly baseYield: number;
  tier: NodeTier;
  /** 0.0–1.0, player-set. Defaults to 1.0 on claim. */
  throttle: number;
  buffer: ResourceVector;
  role: StarRole;
  claimed: boolean;
  slots: RecipeSlot[];
  /** Per-star extraction upgrade level, `k` in BALANCE.md § 5. Max 4. */
  extractionK: number;
  routing: RoutingOverrides;
  /**
   * `run.elapsed` when this star last destroyed material through overflow, or -1 if never.
   *
   * Venting has to be visible *per star* rather than only as a network total: UI.md wants a
   * persistent marker beside the star for as long as it continues, and the network summary
   * counts how many stars are currently losing material. Neither is reconstructable from
   * `run.vented`, which is a single figure for the whole network.
   */
  lastVentAt: number;
}

/** Material in transit on a link. Not an entity — see MECHANICS.md § 3. */
export interface Segment {
  readonly resource: Resource;
  amount: number;
  readonly arrivesAt: number;
  /** Which endpoint this segment is travelling toward. */
  readonly to: StarId;
}

export interface Link {
  readonly id: LinkId;
  readonly a: StarId;
  readonly b: StarId;
  tier: LinkTier;
  /** Euclidean distance in lu, fixed at build time. */
  readonly length: number;
  readonly kind: 'normal' | 'wormhole';
  /**
   * In-transit segments, ordered by `arrivesAt`. Entries before `head` have already been
   * delivered and are pruned periodically rather than on every tick.
   *
   * The ordering invariant holds because every departure on a link is stamped
   * `now + latency` and `now` only increases. A latency change breaks it — segments keep
   * the `arrivesAt` they were dispatched with (MECHANICS.md § Upgrading), so a link
   * upgrade must call `sortLinkQueue`.
   */
  queue: Segment[];
  /** Read pointer into `queue`. */
  head: number;
  /**
   * Most recent segment per (direction, resource), so departures can merge into an
   * open time bucket in O(1) instead of scanning the queue. Derived and transient —
   * rebuilt from `queue` on load. Indexed `(dir * RESOURCE_COUNT) + resourceIndex`.
   */
  tail: (Segment | null)[];
}

/**
 * Derived topology, rebuilt when links or hub designation change — never per tick.
 * MECHANICS.md § Default weights.
 */
export interface Topology {
  /** Hops to the nearest hub by `StarId`, `Infinity` if none reachable. */
  hopDistance: number[];
  /** Per star, `{ link, other }` for every incident link. */
  adjacency: { readonly link: LinkId; readonly other: StarId }[][];
  /** Per star, the links whose far endpoint has a strictly lower hop distance. */
  descending: LinkId[][];
}

export interface RoutingProfile {
  readonly name: string;
  readonly routing: readonly RoutingOverrides[];
  readonly throttles: readonly number[];
}

export interface LifetimeStats {
  totalCoresProduced: number;
  totalCollapses: number;
  totalVented: number;
}

/** Everything that survives a collapse. */
export interface MetaState {
  charts: number;
  /** Chart tree node ids. Narrowed to a union when the tree lands in Phase 4. */
  chartNodes: readonly string[];
  recipesUnlocked: readonly RecipeId[];
  /** `n` in BALANCE.md § 1. */
  collapseCount: number;
  stats: LifetimeStats;
}

/** Everything discarded on collapse. Regenerated from `seed` and `MetaState`. */
export interface RunState {
  readonly seed: number;
  /** Seconds of simulated time this run. */
  elapsed: number;
  /** Indexed by `StarId` — `stars[i].id === i`. */
  stars: Star[];
  /** Indexed by `LinkId` — `links[i].id === i`. */
  links: Link[];
  /** Derived, rebuilt on topology change. Not serialised. */
  topology: Topology;
  upgrades: {
    extractionGlobal: number;
    buffer: number;
    scanRange: number;
  };
  /**
   * Hubs the player has paid for. Drives `hubDesignateCost` — the origin hub is granted
   * free at run start and deliberately does not count, so the second hub in the network is
   * the first purchase. Un-designating decrements it, which is what makes trading a
   * stranded interior hub for a frontier one a real move.
   */
  hubsPurchased: number;
  profiles: RoutingProfile[];
  /**
   * Cumulative ledgers, this run. Together they close the conservation identity in
   * ROADMAP.md Phase 1:
   *
   *   extracted[r] + granted[r]
   *     === inBuffers[r] + inTransit[r] + vented[r] + consumedByRecipes[r]
   *
   * `granted` covers material the player was handed rather than mined — the opening
   * stockpile, and chart-tree starting grants from Phase 4.
   */
  extracted: ResourceVector;
  granted: ResourceVector;
  vented: ResourceVector;
  consumedByRecipes: ResourceVector;
  producedByRecipes: ResourceVector;
  /**
   * Material consumed by construction — links, node tiers, hub designations.
   *
   * Spending removes material from buffers, so without a ledger for it the conservation
   * identity fails the moment the player builds anything. Refunds come back through
   * `granted`, which is what that ledger is for.
   */
  spentOnConstruction: ResourceVector;
  coresProduced: number;
}

export interface GameState {
  meta: MetaState;
  run: RunState;
}
