/**
 * Closed-form offline catch-up. BALANCE.md § 8.
 *
 * **Do not replay ticks.** While the player is away the network is a static flow graph with
 * piecewise-constant behaviour: rates only change when something *happens* — a star runs
 * dry, a buffer fills and starts venting, a buffer empties and a recipe drops to its
 * inflow-limited rate. Between those events every quantity is linear in time, so each
 * interval is arithmetic rather than iteration.
 *
 * Replaying 8 hours of ticks is, per the project's own architecture rules, the single most
 * common way this genre's codebases become unfixable.
 *
 * Latency is ignored here. Over hours, transit delay is noise against throughput — and
 * that is load-bearing for the design rather than a shortcut: it is exactly why a
 * long-haul configuration optimises for zero waste rather than short paths. Short
 * absences, where latency is *not* noise, take the real-tick path instead.
 */

import {
  BUFFER_DRAWDOWN_SECONDS,
  bufferMult,
  extractionGlobal,
  extractionStar,
  HUB_BUFFER_MULT,
  NODE_BUFFER,
  OFFLINE_BUFFER_EPSILON,
  OFFLINE_CAP_SECONDS,
  OFFLINE_CLOSED_FORM_MIN_SECONDS,
  OFFLINE_COARSE_TICK_SECONDS,
  OFFLINE_EVENT_CAP,
  OFFLINE_MIN_INTERVAL_SECONDS,
  RECIPES,
  SIM_STEP_SECONDS,
} from './constants';
import { clampLink, distributeRate } from './flow';
import { tick } from './tick';
import {
  RESOURCES,
  RESOURCE_COUNT,
  RESOURCE_INDEX,
  type GameState,
  type NodeTier,
  type Resource,
  type RunState,
  type StarId,
} from './types';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface DepletionEvent {
  readonly starId: StarId;
  readonly name: string;
  /** Seconds into the absence. */
  readonly at: number;
}

export interface VentEvent {
  readonly starId: StarId;
  readonly name: string;
  readonly resource: Resource;
  readonly seconds: number;
  readonly amount: number;
}

export interface OfflineResult {
  /** Wall-clock seconds the player was away. */
  readonly elapsedRequested: number;
  /** Seconds actually resolved, after `offlineCap`. */
  readonly elapsedResolved: number;
  /** True when the absence exceeded the cap — the arrival summary must say so. */
  readonly capped: boolean;
  /** How the absence was resolved. */
  readonly method: 'ticks' | 'closedForm';
  readonly intervals: number;
  /** True if the event cap was hit and the remainder finished on coarse ticks. */
  readonly usedCoarseFallback: boolean;
  readonly depleted: readonly DepletionEvent[];
  /** One entry per star and resource that vented, with duration and amount. */
  readonly vented: readonly VentEvent[];
  readonly produced: Readonly<Record<Resource, number>>;
}

// ---------------------------------------------------------------------------
// Steady state over one interval
// ---------------------------------------------------------------------------

interface Steady {
  /** Extraction rate, by `starId * RESOURCE_COUNT + resourceIndex`. */
  extraction: Float64Array;
  inflow: Float64Array;
  outflow: Float64Array;
  consumption: Float64Array;
  production: Float64Array;
  /**
   * Net rate of change of the buffer *excluding* extraction, which is tracked separately.
   *
   * The split exists so that a depletion landing inside an interval stays exactly
   * accounted: the ledger records the material actually mined, `min(reserve, rate * dt)`,
   * and the buffer is moved by that same amount rather than by `rate * dt`. Using the rate
   * for one and the capped amount for the other loses material at every depletion.
   */
  netNoExtract: Float64Array;
  /** 1 where the buffer is at capacity and still gaining — i.e. actively venting. */
  full: Uint8Array;
  linkRate: Float64Array;
  /** Star ids in decreasing hop distance — a topological order for default routing. */
  order: StarId[];
  capacity: Float64Array;
}

function makeSteady(run: RunState): Steady {
  const n = run.stars.length;
  const size = n * RESOURCE_COUNT;
  const order = run.stars.map((s) => s.id);
  const hop = run.topology.hopDistance;
  // Descending hop order. Unreachable stars (Infinity) sort first; they have no outbound
  // links so their position is immaterial, but sorting them first keeps the order total.
  order.sort((a, b) => {
    const ha = hop[a] === Infinity ? Number.MAX_VALUE : hop[a];
    const hb = hop[b] === Infinity ? Number.MAX_VALUE : hop[b];
    return hb - ha;
  });

  return {
    extraction: new Float64Array(size),
    inflow: new Float64Array(size),
    outflow: new Float64Array(size),
    consumption: new Float64Array(size),
    production: new Float64Array(size),
    netNoExtract: new Float64Array(size),
    full: new Uint8Array(size),
    linkRate: new Float64Array(run.links.length * 2 * RESOURCE_COUNT),
    order,
    capacity: new Float64Array(n),
  };
}

function capacityOf(tier: NodeTier, bufMult: number, isHub: boolean): number {
  return NODE_BUFFER[tier] * bufMult * (isHub ? HUB_BUFFER_MULT : 1);
}

/**
 * Solve the network's steady state: the rate every link carries, every recipe consumes and
 * every buffer changes, holding until the next event.
 *
 * Stars are processed in decreasing hop distance, which is a topological order for the
 * default routing — flow only ever descends the hop gradient, so one pass propagates
 * inflow exactly. Player-set weights that route sideways or uphill can break that ordering;
 * those are approximated to one pass, which is noted in OPEN_QUESTIONS.md.
 */
function computeSteady(state: GameState, s: Steady): void {
  const run = state.run;
  const stars = run.stars;
  const links = run.links;
  const bufMult = bufferMult(run.upgrades.buffer);
  const globalMult = extractionGlobal(run.upgrades.extractionGlobal);

  s.extraction.fill(0);
  s.inflow.fill(0);
  s.outflow.fill(0);
  s.consumption.fill(0);
  s.production.fill(0);
  s.netNoExtract.fill(0);
  s.full.fill(0);
  s.linkRate.fill(0);

  for (const star of stars) {
    s.capacity[star.id] = capacityOf(star.tier, bufMult, star.role === 'hub');
    const resource = star.resource;
    if (!star.claimed || resource === null || star.reserve <= 0) continue;
    const rate =
      star.baseYield * globalMult * extractionStar(star.extractionK) * star.throttle;
    if (rate > 0) s.extraction[star.id * RESOURCE_COUNT + RESOURCE_INDEX[resource]] = rate;
  }

  // Propagate flow down the hop gradient.
  for (const starId of s.order) {
    const buffer = stars[starId].buffer;
    const base = starId * RESOURCE_COUNT;

    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const held = buffer[r];
      const backlog = held > OFFLINE_BUFFER_EPSILON ? held / BUFFER_DRAWDOWN_SECONDS : 0;
      const available = s.extraction[base + r] + s.inflow[base + r] + backlog;
      distributeRate(run, starId, r, available, s.linkRate);
    }

    for (const edge of run.topology.adjacency[starId]) {
      const link = links[edge.link];
      clampLink(link, s.linkRate);
      const dir = link.a === starId ? 0 : 1;
      const rateBase = (link.id * 2 + dir) * RESOURCE_COUNT;
      const otherBase = edge.other * RESOURCE_COUNT;
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const rate = s.linkRate[rateBase + r];
        if (rate <= 0) continue;
        s.outflow[base + r] += rate;
        s.inflow[otherBase + r] += rate;
      }
    }
  }

  // Refining. Slots are processed in order, so a slot's output is available to a later slot
  // on the same hub — matching the tick, which mutates the buffer as it goes.
  for (const star of stars) {
    if (star.role !== 'hub' || !star.claimed) continue;
    const base = star.id * RESOURCE_COUNT;
    const capacity = s.capacity[star.id];

    for (const slot of star.slots) {
      if (slot.recipe === null) continue;
      const recipe = RECIPES[slot.recipe];
      const outputIndex = RESOURCE_INDEX[recipe.output];

      // Backed up: output at capacity stalls the slot rather than destroying anything.
      if (star.buffer[outputIndex] >= capacity - OFFLINE_BUFFER_EPSILON) continue;

      let fraction = 1;
      for (const input of recipe.inputs) {
        const index = RESOURCE_INDEX[input.resource];
        if (star.buffer[index] > OFFLINE_BUFFER_EPSILON) continue;
        // No stock: the slot can only consume as fast as the input arrives.
        const arriving =
          s.extraction[base + index] +
          s.inflow[base + index] +
          s.production[base + index] -
          s.outflow[base + index] -
          s.consumption[base + index];
        const supported = arriving <= 0 ? 0 : arriving / input.perSecond;
        if (supported < fraction) fraction = supported;
      }
      if (fraction <= 0) continue;

      for (const input of recipe.inputs) {
        s.consumption[base + RESOURCE_INDEX[input.resource]] += input.perSecond * fraction;
      }
      s.production[base + outputIndex] += recipe.outputPerSecond * fraction;
    }
  }

  // Net rate per buffer, and which buffers are already full and therefore venting.
  for (const star of stars) {
    const base = star.id * RESOURCE_COUNT;
    const capacity = s.capacity[star.id];
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const idx = base + r;
      s.netNoExtract[idx] =
        s.inflow[idx] + s.production[idx] - s.outflow[idx] - s.consumption[idx];
      const net = s.netNoExtract[idx] + s.extraction[idx];
      const atCapacity = star.buffer[r] >= capacity - OFFLINE_BUFFER_EPSILON;
      s.full[idx] = net > 0 && atCapacity ? 1 : 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Interval length
// ---------------------------------------------------------------------------

/**
 * Time until the network's behaviour changes: a star depletes, a buffer fills and begins
 * venting, or a buffer empties and drops its recipes to an inflow-limited rate.
 */
function timeUntilNextEvent(run: RunState, s: Steady, remaining: number): number {
  let soonest = remaining;

  for (const star of run.stars) {
    const base = star.id * RESOURCE_COUNT;

    if (star.reserve > 0 && star.resource !== null) {
      const rate = s.extraction[base + RESOURCE_INDEX[star.resource]];
      if (rate > 0) {
        const t = star.reserve / rate;
        if (t < soonest) soonest = t;
      }
    }

    const capacity = s.capacity[star.id];
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const idx = base + r;
      // A buffer that is already full and venting has nothing left to schedule — leaving
      // its net rate positive here would put an event at t=0 on every single interval.
      if (s.full[idx] === 1) continue;
      const net = s.netNoExtract[idx] + s.extraction[idx];
      const held = star.buffer[r];
      if (net > 0 && held < capacity) {
        const t = (capacity - held) / net;
        if (t < soonest) soonest = t;
      } else if (net < 0 && held > OFFLINE_BUFFER_EPSILON) {
        const t = held / -net;
        if (t < soonest) soonest = t;
      }
    }
  }

  if (soonest < 0) soonest = 0;
  // Guarantee progress even if several events land on top of each other.
  if (soonest < OFFLINE_MIN_INTERVAL_SECONDS) {
    return Math.min(remaining, OFFLINE_MIN_INTERVAL_SECONDS);
  }
  return soonest;
}

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

function advanceAnalytically(
  state: GameState,
  s: Steady,
  dt: number,
  at: number,
  depleted: DepletionEvent[],
  ventSeconds: Float64Array,
  ventAmount: Float64Array,
): void {
  const run = state.run;

  const coreIndex = RESOURCE_INDEX.core;

  for (const star of run.stars) {
    const base = star.id * RESOURCE_COUNT;
    const capacity = s.capacity[star.id];

    // Extraction, and the depletion event if it lands inside this interval. `mined` is the
    // amount actually taken, so the ledger and the buffer move by the same number.
    let minedIndex = -1;
    let minedAmount = 0;
    const resource = star.resource;
    if (resource !== null && star.reserve > 0) {
      const index = RESOURCE_INDEX[resource];
      const rate = s.extraction[base + index];
      if (rate > 0) {
        minedIndex = index;
        minedAmount = Math.min(star.reserve, rate * dt);
        star.reserve -= minedAmount;
        run.extracted[index] += minedAmount;
        if (star.reserve <= OFFLINE_BUFFER_EPSILON) {
          star.reserve = 0;
          depleted.push({ starId: star.id, name: star.name, at: at + minedAmount / rate });
        }
      }
    }

    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const idx = base + r;

      const consumed = s.consumption[idx] * dt;
      if (consumed > 0) run.consumedByRecipes[r] += consumed;

      const produced = s.production[idx] * dt;
      if (produced > 0) {
        run.producedByRecipes[r] += produced;
        if (r === coreIndex) {
          run.coresProduced += produced;
          state.meta.stats.totalCoresProduced += produced;
        }
      }

      const delta = s.netNoExtract[idx] * dt + (r === minedIndex ? minedAmount : 0);

      if (s.full[idx] === 1) {
        // At capacity and still gaining: everything arriving is destroyed.
        if (delta > 0) {
          run.vented[r] += delta;
          state.meta.stats.totalVented += delta;
          ventSeconds[idx] += dt;
          ventAmount[idx] += delta;
        }
        continue;
      }

      if (delta === 0) continue;

      let held = star.buffer[r] + delta;
      if (held > capacity) {
        // The interval boundary should land exactly on capacity; this clamps float drift
        // and accounts for anything that slipped past rather than losing it silently.
        const excess = held - capacity;
        held = capacity;
        run.vented[r] += excess;
        state.meta.stats.totalVented += excess;
        ventSeconds[idx] += dt;
        ventAmount[idx] += excess;
      }
      star.buffer[r] = held < 0 ? 0 : held;
    }
  }

  run.elapsed += dt;
}

/**
 * Deliver everything in flight into its destination buffer and clear the queues.
 *
 * Material arrives early by up to one link-latency, which over an absence measured in hours
 * is immaterial — and it keeps in-transit material from being silently stranded for the
 * whole absence, which would be a real loss.
 */
function flushInFlight(run: RunState): void {
  for (const link of run.links) {
    for (let i = link.head; i < link.queue.length; i++) {
      const segment = link.queue[i];
      run.stars[segment.to].buffer[RESOURCE_INDEX[segment.resource]] += segment.amount;
    }
    link.queue.length = 0;
    link.head = 0;
    link.tail.fill(null);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function resolveOffline(state: GameState, elapsedSeconds: number): OfflineResult {
  const requested = Math.max(0, elapsedSeconds);
  const resolved = Math.min(requested, OFFLINE_CAP_SECONDS);
  const capped = requested > OFFLINE_CAP_SECONDS;

  const before = snapshotProduced(state.run);

  if (resolved <= 0) {
    return {
      elapsedRequested: requested,
      elapsedResolved: 0,
      capped,
      method: 'ticks',
      intervals: 0,
      usedCoarseFallback: false,
      depleted: [],
      vented: [],
      produced: diffProduced(state.run, before),
    };
  }

  // Short absences run as real ticks. Closed-form resolution discards latency, which is
  // correct over hours and wrong over minutes: a four-hop tier-I chain is ~75s one way, so
  // discarding it across a 10-minute absence misstates that path's delivery by over 10%.
  if (resolved < OFFLINE_CLOSED_FORM_MIN_SECONDS) {
    const reserveBefore = state.run.stars.map((s) => s.reserve);
    runTicks(state, resolved, SIM_STEP_SECONDS);
    const depleted: DepletionEvent[] = [];
    state.run.stars.forEach((star, id) => {
      if (reserveBefore[id] > 0 && star.reserve <= 0) {
        depleted.push({ starId: id, name: star.name, at: resolved });
      }
    });
    return {
      elapsedRequested: requested,
      elapsedResolved: resolved,
      capped,
      method: 'ticks',
      intervals: 0,
      usedCoarseFallback: false,
      depleted,
      vented: [],
      produced: diffProduced(state.run, before),
    };
  }

  flushInFlight(state.run);

  const s = makeSteady(state.run);
  const size = state.run.stars.length * RESOURCE_COUNT;
  const ventSeconds = new Float64Array(size);
  const ventAmount = new Float64Array(size);
  const depleted: DepletionEvent[] = [];

  let t = 0;
  let intervals = 0;
  let usedCoarseFallback = false;

  while (t < resolved && intervals < OFFLINE_EVENT_CAP) {
    computeSteady(state, s);
    const dt = timeUntilNextEvent(state.run, s, resolved - t);
    if (dt <= 0) break;
    advanceAnalytically(state, s, dt, t, depleted, ventSeconds, ventAmount);
    t += dt;
    intervals++;
  }

  // Event cap reached: finish the remainder on coarse ticks rather than leaving time
  // unresolved. A network churning through 400 regime changes is pathological, not normal.
  if (t < resolved - OFFLINE_MIN_INTERVAL_SECONDS) {
    usedCoarseFallback = true;
    runTicks(state, resolved - t, OFFLINE_COARSE_TICK_SECONDS);
  }

  return {
    elapsedRequested: requested,
    elapsedResolved: resolved,
    capped,
    method: 'closedForm',
    intervals,
    usedCoarseFallback,
    depleted,
    vented: collectVents(state.run, ventSeconds, ventAmount),
    produced: diffProduced(state.run, before),
  };
}

function runTicks(state: GameState, seconds: number, step: number): void {
  let remaining = seconds;
  while (remaining > 0) {
    const dt = Math.min(step, remaining);
    tick(state, dt);
    remaining -= dt;
  }
}

function snapshotProduced(run: RunState): Float64Array {
  return new Float64Array(run.producedByRecipes);
}

function diffProduced(run: RunState, before: Float64Array): Record<Resource, number> {
  const out = {} as Record<Resource, number>;
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    out[RESOURCES[r]] = run.producedByRecipes[r] - before[r];
  }
  return out;
}

function collectVents(
  run: RunState,
  ventSeconds: Float64Array,
  ventAmount: Float64Array,
): VentEvent[] {
  const events: VentEvent[] = [];
  for (const star of run.stars) {
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const idx = star.id * RESOURCE_COUNT + r;
      if (ventAmount[idx] <= 0) continue;
      events.push({
        starId: star.id,
        name: star.name,
        resource: RESOURCES[r],
        seconds: ventSeconds[idx],
        amount: ventAmount[idx],
      });
    }
  }
  // Largest loss first — the arrival summary names the worst offender.
  events.sort((a, b) => b.amount - a.amount);
  return events;
}
