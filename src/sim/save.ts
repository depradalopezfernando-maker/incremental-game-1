/**
 * Serialize, deserialize, version, migrate.
 *
 * Two rules shape this module:
 *
 * 1. **Derived state is never saved.** The topology cache, each link's `tail` pointers and
 *    its `head` read offset are all rebuilt on load. Saving derived data means saving a
 *    second source of truth that can disagree with the first.
 * 2. **Every save carries its version, and loading goes through `migrate`.** The migration
 *    chain is the only sanctioned way to change the save shape — see `migrate` below.
 *
 * The localStorage wiring and the autosave timer belong to the app layer in Phase 3. This
 * module is pure: it turns state into a plain JSON-safe object and back.
 */

import { recomputeTopology } from './flow';
import {
  makeRouting,
  RESOURCE_COUNT,
  RESOURCE_INDEX,
  type GameState,
  type Link,
  type LinkTier,
  type MetaState,
  type NodeTier,
  type RawResource,
  type RecipeId,
  type RecipeSlot,
  type RoutingOverrides,
  type RunState,
  type Segment,
  type Star,
  type StarClass,
  type StarRole,
} from './types';

export const SAVE_VERSION = 1;

/** CLAUDE.md: localStorage key is `lightlace.save.v{N}`. */
export const SAVE_KEY = `lightlace.save.v${SAVE_VERSION}`;

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

interface SavedSegment {
  resource: string;
  amount: number;
  arrivesAt: number;
  to: number;
}

interface SavedLink {
  id: number;
  a: number;
  b: number;
  tier: number;
  length: number;
  kind: string;
  queue: SavedSegment[];
}

interface SavedStar {
  id: number;
  x: number;
  y: number;
  name: string;
  cls: string;
  resource: string | null;
  reserve: number;
  reserveMax: number;
  baseYield: number;
  tier: number;
  throttle: number;
  buffer: number[];
  role: string;
  claimed: boolean;
  slots: { recipe: string | null }[];
  extractionK: number;
  routing: (Record<string, number> | null)[];
}

export interface SavedGame {
  version: number;
  /** Epoch milliseconds at save time. The app derives the absence from this. */
  savedAt: number;
  meta: {
    charts: number;
    chartNodes: string[];
    recipesUnlocked: string[];
    collapseCount: number;
    stats: { totalCoresProduced: number; totalCollapses: number; totalVented: number };
  };
  run: {
    seed: number;
    elapsed: number;
    stars: SavedStar[];
    links: SavedLink[];
    upgrades: { extractionGlobal: number; buffer: number; scanRange: number };
    profiles: { name: string; routing: (Record<string, number> | null)[][]; throttles: number[] }[];
    extracted: number[];
    granted: number[];
    vented: number[];
    consumedByRecipes: number[];
    producedByRecipes: number[];
    coresProduced: number;
  };
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function serialize(state: GameState, savedAt: number = Date.now()): SavedGame {
  const { meta, run } = state;

  return {
    version: SAVE_VERSION,
    savedAt,
    meta: {
      charts: meta.charts,
      chartNodes: [...meta.chartNodes],
      recipesUnlocked: [...meta.recipesUnlocked],
      collapseCount: meta.collapseCount,
      stats: { ...meta.stats },
    },
    run: {
      seed: run.seed,
      elapsed: run.elapsed,
      stars: run.stars.map(serializeStar),
      links: run.links.map(serializeLink),
      upgrades: { ...run.upgrades },
      profiles: run.profiles.map((profile) => ({
        name: profile.name,
        routing: profile.routing.map((overrides) => overrides.map(cloneOverride)),
        throttles: [...profile.throttles],
      })),
      extracted: [...run.extracted],
      granted: [...run.granted],
      vented: [...run.vented],
      consumedByRecipes: [...run.consumedByRecipes],
      producedByRecipes: [...run.producedByRecipes],
      coresProduced: run.coresProduced,
    },
  };
}

function cloneOverride(entry: Record<string, number> | null): Record<string, number> | null {
  return entry === null ? null : { ...entry };
}

function serializeStar(star: Star): SavedStar {
  return {
    id: star.id,
    x: star.x,
    y: star.y,
    name: star.name,
    cls: star.cls,
    resource: star.resource,
    reserve: star.reserve,
    reserveMax: star.reserveMax,
    baseYield: star.baseYield,
    tier: star.tier,
    throttle: star.throttle,
    buffer: [...star.buffer],
    role: star.role,
    claimed: star.claimed,
    // Slot *status* is derived from the next tick and deliberately not saved.
    slots: star.slots.map((slot) => ({ recipe: slot.recipe })),
    extractionK: star.extractionK,
    routing: star.routing.map(cloneOverride),
  };
}

function serializeLink(link: Link): SavedLink {
  const queue: SavedSegment[] = [];
  // Entries before `head` have already been delivered; saving them would resurrect
  // material that no longer exists.
  for (let i = link.head; i < link.queue.length; i++) {
    const segment = link.queue[i];
    queue.push({
      resource: segment.resource,
      amount: segment.amount,
      arrivesAt: segment.arrivesAt,
      to: segment.to,
    });
  }
  return {
    id: link.id,
    a: link.a,
    b: link.b,
    tier: link.tier,
    length: link.length,
    kind: link.kind,
    queue,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export class SaveError extends Error {}

/**
 * Bring a save of any past version up to `SAVE_VERSION`.
 *
 * Add one step per version bump and let them chain — never edit an existing step, because
 * a player's save may be several versions behind and every intermediate step still has to
 * run. v1 is the first version, so there is nothing to migrate yet; the hook exists so the
 * second version has somewhere obvious to go.
 */
export function migrate(raw: unknown): SavedGame {
  if (typeof raw !== 'object' || raw === null) {
    throw new SaveError('save is not an object');
  }
  const candidate = raw as { version?: unknown };
  if (typeof candidate.version !== 'number') {
    throw new SaveError('save has no version field');
  }
  if (candidate.version > SAVE_VERSION) {
    throw new SaveError(
      `save version ${candidate.version} is newer than this build (${SAVE_VERSION})`,
    );
  }

  let save = raw as SavedGame;

  // for (let v = save.version; v < SAVE_VERSION; v++) { save = STEPS[v](save); }

  if (save.version !== SAVE_VERSION) {
    throw new SaveError(`no migration path from version ${save.version}`);
  }
  return save;
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

export function deserialize(raw: unknown): GameState {
  const save = migrate(raw);

  const meta: MetaState = {
    charts: save.meta.charts,
    chartNodes: [...save.meta.chartNodes],
    recipesUnlocked: save.meta.recipesUnlocked.map((id) => id as RecipeId),
    collapseCount: save.meta.collapseCount,
    stats: { ...save.meta.stats },
  };

  const stars: Star[] = save.run.stars.map(deserializeStar);
  const links: Link[] = save.run.links.map(deserializeLink);

  const run: RunState = {
    seed: save.run.seed,
    elapsed: save.run.elapsed,
    stars,
    links,
    topology: { hopDistance: [], adjacency: [], descending: [] },
    upgrades: { ...save.run.upgrades },
    profiles: save.run.profiles.map((profile) => ({
      name: profile.name,
      routing: profile.routing.map((overrides) => overrides.map(cloneOverride)),
      throttles: [...profile.throttles],
    })),
    extracted: vectorFrom(save.run.extracted),
    granted: vectorFrom(save.run.granted),
    vented: vectorFrom(save.run.vented),
    consumedByRecipes: vectorFrom(save.run.consumedByRecipes),
    producedByRecipes: vectorFrom(save.run.producedByRecipes),
    coresProduced: save.run.coresProduced,
  };

  run.topology = recomputeTopology(run);
  return { meta, run };
}

function vectorFrom(values: readonly number[]): Float64Array {
  if (values.length !== RESOURCE_COUNT) {
    throw new SaveError(`expected ${RESOURCE_COUNT} resource slots, got ${values.length}`);
  }
  return new Float64Array(values);
}

function deserializeStar(saved: SavedStar): Star {
  const slots: RecipeSlot[] = saved.slots.map((slot) => ({
    recipe: slot.recipe === null ? null : (slot.recipe as RecipeId),
    // Recomputed on the first tick after load.
    status: { kind: 'idle' },
  }));

  const routing: RoutingOverrides = makeRouting();
  saved.routing.forEach((entry, index) => {
    routing[index] = cloneOverride(entry);
  });

  return {
    id: saved.id,
    x: saved.x,
    y: saved.y,
    name: saved.name,
    cls: saved.cls as StarClass,
    resource: saved.resource === null ? null : (saved.resource as RawResource),
    reserve: saved.reserve,
    reserveMax: saved.reserveMax,
    baseYield: saved.baseYield,
    tier: saved.tier as NodeTier,
    throttle: saved.throttle,
    buffer: vectorFrom(saved.buffer),
    role: saved.role as StarRole,
    claimed: saved.claimed,
    slots,
    extractionK: saved.extractionK,
    routing,
  };
}

function deserializeLink(saved: SavedLink): Link {
  const queue: Segment[] = saved.queue.map((segment) => ({
    resource: segment.resource as Segment['resource'],
    amount: segment.amount,
    arrivesAt: segment.arrivesAt,
    to: segment.to,
  }));

  const link: Link = {
    id: saved.id,
    a: saved.a,
    b: saved.b,
    tier: saved.tier as LinkTier,
    length: saved.length,
    kind: saved.kind === 'wormhole' ? 'wormhole' : 'normal',
    queue,
    head: 0,
    tail: new Array<Segment | null>(2 * RESOURCE_COUNT).fill(null),
  };

  // Rebuild the merge pointers so departures after a load can still merge into an open
  // bucket instead of starting a fresh segment every tick.
  queue.sort((a, b) => a.arrivesAt - b.arrivesAt);
  for (const segment of queue) {
    const dir = segment.to === link.b ? 0 : 1;
    link.tail[dir * RESOURCE_COUNT + RESOURCE_INDEX[segment.resource]] = segment;
  }

  return link;
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

export function toJson(state: GameState, savedAt?: number): string {
  return JSON.stringify(serialize(state, savedAt));
}

export function fromJson(text: string): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SaveError(`save is not valid JSON: ${String(cause)}`);
  }
  return deserialize(parsed);
}
