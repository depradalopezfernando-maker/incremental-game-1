/**
 * Advance state by `dt`. The six-step tick from MECHANICS.md § Flow model:
 *
 *   1. Extract   2. Arrive   3. Solve flows   4. Depart   5. Refine   6. Vent
 *
 * Arrive precedes Solve and Depart so everything a star has this tick is in its buffer
 * before rates are computed — a relay can receive and forward in the same tick, and
 * `supply()` can count arriving material without promising a rate the buffer cannot
 * cover. Vent happens last so a star that receives and forwards doesn't lose material
 * spuriously.
 *
 * `tick` mutates `state` in place and returns it. See OPEN_QUESTIONS.md — the alternative
 * reading of architecture rule 1 (a fresh GameState per tick) cannot meet the perf
 * budgets stated in the same documents.
 */

import {
  bufferMult,
  extractionGlobal,
  extractionStar,
  linkLatency,
  HUB_BUFFER_MULT,
  NODE_BUFFER,
  RECIPES,
  RECIPE_IDS,
  segmentMergeWindow,
} from './constants';
import {
  DIR_AB,
  DIR_BA,
  makeScratch,
  scratchFits,
  solveFlows,
  type FlowScratch,
} from './flow';
import {
  RESOURCES,
  RESOURCE_COUNT,
  RESOURCE_INDEX,
  type GameState,
  type NodeTier,
  type Resource,
  type RunState,
  type Segment,
  type SlotStatus,
} from './types';

const scratchCache = new WeakMap<RunState, FlowScratch>();

const IDLE: SlotStatus = { kind: 'idle' };

/**
 * Slot status objects are reused rather than rebuilt every tick. A scripted 6-hour game
 * is 216,000 ticks; allocating a status per slot per tick made the endurance test GC-bound
 * for no benefit, since consumers only ever read the current value.
 */
const BACKED_UP: Readonly<Record<Resource, SlotStatus>> = {
  hydrogen: { kind: 'backedUp', output: 'hydrogen' },
  metals: { kind: 'backedUp', output: 'metals' },
  isotopes: { kind: 'backedUp', output: 'isotopes' },
  alloy: { kind: 'backedUp', output: 'alloy' },
  catalyst: { kind: 'backedUp', output: 'catalyst' },
  core: { kind: 'backedUp', output: 'core' },
};

/** Bit per resource index, so a starved slot's missing set compares without allocating. */
function missingMaskOf(status: SlotStatus): number {
  if (status.kind !== 'starved') return -1;
  let mask = 0;
  for (const resource of status.missing) mask |= 1 << RESOURCE_INDEX[resource];
  return mask;
}

function maskToResources(mask: number): Resource[] {
  const out: Resource[] = [];
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    if (mask & (1 << r)) out.push(RESOURCES[r]);
  }
  return out;
}

/** Per-tick working memory, keyed by run so callers never have to thread it through. */
export function scratchFor(run: RunState): FlowScratch {
  const existing = scratchCache.get(run);
  if (existing !== undefined && scratchFits(existing, run)) return existing;
  const fresh = makeScratch(run.stars.length, run.links.length);
  scratchCache.set(run, fresh);
  return fresh;
}

export function tick(state: GameState, dt: number): GameState {
  if (dt <= 0) return state;

  const run = state.run;
  const scratch = scratchFor(run);

  run.elapsed += dt;
  const now = run.elapsed;

  // Hoisted once per tick: the buffer upgrade multiplier is a Math.pow, and capacity is
  // needed for every star and every recipe slot.
  const bufMult = bufferMult(run.upgrades.buffer);

  extract(state, scratch, dt);
  arrive(run, scratch, now, dt);
  solveFlows(run, scratch, dt);
  depart(run, scratch, now, dt);
  refine(state, bufMult, dt);
  vent(state, scratch, bufMult);

  return state;
}

/** capacity(star, r) = tierBuffer[tier] * bufferMult(k) * (isHub ? 4 : 1), per resource. */
function capacityOf(tier: NodeTier, bufMult: number, isHub: boolean): number {
  return NODE_BUFFER[tier] * bufMult * (isHub ? HUB_BUFFER_MULT : 1);
}

/**
 * 1. Extract. `extracted = yield(star) * throttle * dt`, capped by remaining reserve.
 *
 * yield(star) = baseYield * extractionGlobal(k) * extractionStar(kStar)
 */
function extract(state: GameState, s: FlowScratch, dt: number): void {
  s.extractedRate.fill(0);
  const run = state.run;
  const globalMult = extractionGlobal(run.upgrades.extractionGlobal);

  for (const star of run.stars) {
    if (!star.claimed) continue;
    const resource = star.resource;
    if (resource === null) continue;
    if (star.reserve <= 0) continue;

    const rate =
      star.baseYield * globalMult * extractionStar(star.extractionK) * star.throttle;
    if (rate <= 0) continue;

    let amount = rate * dt;
    if (amount > star.reserve) amount = star.reserve;
    if (amount <= 0) continue;

    const ri = RESOURCE_INDEX[resource];
    star.reserve -= amount;
    star.buffer[ri] += amount;
    run.extracted[ri] += amount;
    s.extractedRate[star.id * RESOURCE_COUNT + ri] += amount / dt;
  }
}

/**
 * 2. Arrive. Deliver every segment whose `arrivesAt` has passed.
 *
 * `queue` is ordered by arrival, so this walks from `head` and stops at the first segment
 * still in flight — O(arriving), not O(queue). Delivered entries are pruned in batches to
 * keep the array from growing without bound.
 */
function arrive(run: RunState, s: FlowScratch, now: number, dt: number): void {
  s.arrivedRate.fill(0);

  for (const link of run.links) {
    const queue = link.queue;
    let head = link.head;

    while (head < queue.length) {
      const seg = queue[head];
      if (seg.arrivesAt > now) break;
      head++;

      const ri = RESOURCE_INDEX[seg.resource];
      run.stars[seg.to].buffer[ri] += seg.amount;
      s.arrivedRate[seg.to * RESOURCE_COUNT + ri] += seg.amount / dt;

      const dir = seg.to === link.b ? DIR_AB : DIR_BA;
      const tailIndex = dir * RESOURCE_COUNT + ri;
      if (link.tail[tailIndex] === seg) link.tail[tailIndex] = null;
    }

    if (head > 0 && head >= QUEUE_PRUNE_THRESHOLD) {
      queue.splice(0, head);
      head = 0;
    }
    link.head = head;
  }
}

/** Delivered segments to accumulate before compacting a link's queue. */
const QUEUE_PRUNE_THRESHOLD = 64;

/**
 * Restore the `arrivesAt` ordering of a link's queue. Required after any change to a
 * link's latency, since in-flight segments keep their original arrival times.
 */
export function sortLinkQueue(link: { queue: Segment[]; head: number }): void {
  if (link.head > 0) {
    link.queue.splice(0, link.head);
    link.head = 0;
  }
  link.queue.sort((a, b) => a.arrivesAt - b.arrivesAt);
}

/**
 * 4. Depart. Remove `rate * dt` from the source buffer and push a segment arriving one
 * link-latency from now.
 *
 * Departures inside the same arrival bucket merge into the open segment, which bounds
 * queue length without losing material — see constants.ts § MAX_SEGMENTS_PER_LINK.
 */
function depart(run: RunState, s: FlowScratch, now: number, dt: number): void {
  for (const link of run.links) {
    const latency = linkLatency(link.length, link.tier);
    const window = segmentMergeWindow(latency, dt);
    const arrivesAt = now + latency;
    const bucket = Math.floor(arrivesAt / window);

    for (let dir = 0; dir < 2; dir++) {
      const fromId = dir === DIR_AB ? link.a : link.b;
      const toId = dir === DIR_AB ? link.b : link.a;
      const source = run.stars[fromId];
      const base = (link.id * 2 + dir) * RESOURCE_COUNT;

      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const rate = s.rate[base + r];
        if (rate <= 0) continue;

        let amount = rate * dt;
        const held = source.buffer[r];
        if (amount > held) amount = held;
        if (amount <= 0) continue;

        source.buffer[r] -= amount;
        const resource = RESOURCES[r];

        const tailIndex = dir * RESOURCE_COUNT + r;
        const tail = link.tail[tailIndex];
        if (tail !== null && Math.floor(tail.arrivesAt / window) === bucket) {
          tail.amount += amount;
          continue;
        }

        const seg: Segment = { resource, amount, arrivesAt, to: toId };
        link.queue.push(seg);
        link.tail[tailIndex] = seg;
      }
    }
  }
}

/**
 * 5. Refine. Consumption is continuous, not batched — cycle time in BALANCE.md § 4 is
 * presentation. A slot runs at a fraction of its rate when inputs are short, stalls
 * `starved` when an input is absent entirely, and stalls `backedUp` when its output has
 * nowhere to go. Refined goods are never destroyed for want of space.
 */
function refine(state: GameState, bufMult: number, dt: number): void {
  const run = state.run;

  for (const star of run.stars) {
    if (star.role !== 'hub' || !star.claimed) continue;
    if (star.slots.length === 0) continue;

    const capacity = capacityOf(star.tier, bufMult, true);

    for (const slot of star.slots) {
      if (slot.recipe === null) {
        slot.status = IDLE;
        continue;
      }

      const recipe = RECIPES[slot.recipe];
      let fraction = 1;
      let missingMask = 0;

      for (const input of recipe.inputs) {
        const index = RESOURCE_INDEX[input.resource];
        const held = star.buffer[index];
        if (held <= 0) {
          missingMask |= 1 << index;
          continue;
        }
        const need = input.perSecond * dt;
        if (held < need) {
          const limited = held / need;
          if (limited < fraction) fraction = limited;
        }
      }

      if (missingMask !== 0) {
        if (missingMaskOf(slot.status) !== missingMask) {
          slot.status = { kind: 'starved', missing: maskToResources(missingMask) };
        }
        continue;
      }

      const wantOutput = recipe.outputPerSecond * dt;
      const outputIndex = RESOURCE_INDEX[recipe.output];
      const headroom = capacity - star.buffer[outputIndex];
      let outputLimited = false;

      if (headroom <= 0) {
        slot.status = BACKED_UP[recipe.output];
        continue;
      }
      if (wantOutput * fraction > headroom) {
        fraction = headroom / wantOutput;
        outputLimited = true;
      }
      if (fraction <= 0) {
        slot.status = BACKED_UP[recipe.output];
        continue;
      }

      for (const input of recipe.inputs) {
        const amount = input.perSecond * dt * fraction;
        const ri = RESOURCE_INDEX[input.resource];
        star.buffer[ri] -= amount;
        run.consumedByRecipes[ri] += amount;
      }

      const produced = wantOutput * fraction;
      star.buffer[outputIndex] += produced;
      run.producedByRecipes[outputIndex] += produced;
      if (recipe.output === 'core') {
        run.coresProduced += produced;
        state.meta.stats.totalCoresProduced += produced;
      }

      if (outputLimited) {
        slot.status = BACKED_UP[recipe.output];
      } else if (slot.status.kind === 'running') {
        slot.status.fraction = fraction;
      } else {
        slot.status = { kind: 'running', fraction };
      }
    }
  }
}

/**
 * 6. Vent. Anything above capacity is destroyed. This is not a bug to smooth over —
 * material loss on overflow is the point of the game.
 *
 * Recipe unlocks are evaluated here because the network-wide totals are already in hand:
 * a recipe unlocks permanently the first time the network holds ≥1 of each input.
 */
function vent(state: GameState, s: FlowScratch, bufMult: number): void {
  const run = state.run;
  const totals = s.networkTotal;
  totals.fill(0);

  for (const star of run.stars) {
    const capacity = capacityOf(star.tier, bufMult, star.role === 'hub');
    const buffer = star.buffer;
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const held = buffer[r];
      if (held <= 0) continue;
      if (held > capacity) {
        const excess = held - capacity;
        buffer[r] = capacity;
        run.vented[r] += excess;
        state.meta.stats.totalVented += excess;
        totals[r] += capacity;
      } else {
        totals[r] += held;
      }
    }
  }

  for (const id of RECIPE_IDS) {
    if (state.meta.recipesUnlocked.includes(id)) continue;
    let satisfied = true;
    for (const input of RECIPES[id].inputs) {
      if (totals[RESOURCE_INDEX[input.resource]] < 1) {
        satisfied = false;
        break;
      }
    }
    if (satisfied) {
      state.meta.recipesUnlocked = [...state.meta.recipesUnlocked, id];
    }
  }
}
