/**
 * Bandwidth allocation and the routing solve. MECHANICS.md § Routing solve.
 *
 * The rate assigned to a link must not depend on `dt`. Everything here is written to
 * that constraint: rates come from supply rates, never from "whatever is in the buffer
 * this tick". Phase 2's closed-form offline solver is only correct if this holds.
 *
 * The solve is deliberately not an optimizer. The player optimizing the network is the
 * game.
 */

import {
  BUFFER_DRAWDOWN_SECONDS,
  LINK_BANDWIDTH,
} from './constants';
import {
  RESOURCE_COUNT,
  type Link,
  type LinkId,
  type RunState,
  type StarId,
  type Topology,
} from './types';

/**
 * Preallocated per-tick working memory. Allocating inside the tick would dominate the
 * runtime budget — 8 hours of game has to fit in under a second.
 */
export interface FlowScratch {
  /** Extraction rate this tick, by `starId * RESOURCE_COUNT + resourceIndex`. */
  extractedRate: Float64Array;
  /** Arrival rate this tick, same indexing. */
  arrivedRate: Float64Array;
  /** Forwardable supply, same indexing. */
  supply: Float64Array;
  /** Assigned rate by `(linkId * 2 + dir) * RESOURCE_COUNT + resourceIndex`. */
  rate: Float64Array;
  /** Network-wide held total per resource, recomputed during the vent step. */
  networkTotal: Float64Array;
}

/** Direction 0 travels a → b, direction 1 travels b → a. */
export const DIR_AB = 0;
export const DIR_BA = 1;

export function makeScratch(starCount: number, linkCount: number): FlowScratch {
  return {
    extractedRate: new Float64Array(starCount * RESOURCE_COUNT),
    arrivedRate: new Float64Array(starCount * RESOURCE_COUNT),
    supply: new Float64Array(starCount * RESOURCE_COUNT),
    rate: new Float64Array(linkCount * 2 * RESOURCE_COUNT),
    networkTotal: new Float64Array(RESOURCE_COUNT),
  };
}

export function scratchFits(scratch: FlowScratch, run: RunState): boolean {
  return (
    scratch.supply.length === run.stars.length * RESOURCE_COUNT &&
    scratch.rate.length === run.links.length * 2 * RESOURCE_COUNT
  );
}

export function bandwidth(link: Link): number {
  return LINK_BANDWIDTH[link.tier];
}

/**
 * Breadth-first search from every hub at once, so `hopDistance` is hops to the *nearest*
 * hub. Rebuilt on topology or hub change, never per tick.
 *
 * "Nearest hub" means nearest, not best. Once a second hub exists, interior material
 * keeps flowing to the origin — pushing hydrogen outward to a frontier catalyst hub is a
 * deliberate re-weighting the player has to make. The defaults are meant to be wrong for
 * that, not to anticipate it.
 */
export function recomputeTopology(run: RunState): Topology {
  const n = run.stars.length;
  const hopDistance = new Array<number>(n).fill(Infinity);
  const adjacency: { link: LinkId; other: StarId }[][] = Array.from(
    { length: n },
    () => [],
  );

  for (const link of run.links) {
    adjacency[link.a].push({ link: link.id, other: link.b });
    adjacency[link.b].push({ link: link.id, other: link.a });
  }

  const queue: StarId[] = [];
  for (const star of run.stars) {
    if (star.role === 'hub' && star.claimed) {
      hopDistance[star.id] = 0;
      queue.push(star.id);
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const next = hopDistance[id] + 1;
    for (const edge of adjacency[id]) {
      if (next < hopDistance[edge.other]) {
        hopDistance[edge.other] = next;
        queue.push(edge.other);
      }
    }
  }

  const descending: LinkId[][] = Array.from({ length: n }, () => []);
  for (let id = 0; id < n; id++) {
    const here = hopDistance[id];
    if (!Number.isFinite(here)) continue;
    for (const edge of adjacency[id]) {
      if (hopDistance[edge.other] < here) descending[id].push(edge.link);
    }
  }

  return { hopDistance, adjacency, descending };
}

/**
 * supply(star, r) = extractionRate + arrivingRate + carried / BUFFER_DRAWDOWN_SECONDS
 *
 *   carried = buffer[r] at the end of the previous tick
 *   total capped at buffer[r] / dt
 *
 * The three terms are disjoint: extraction and arrivals pass straight through at their
 * own rate, and only the standing backlog is metered. The `/ dt` cap is what keeps a
 * buffer from going negative when `dt` exceeds the drawdown window.
 */
export function computeSupply(run: RunState, s: FlowScratch, dt: number): void {
  const stars = run.stars;
  for (let i = 0; i < stars.length; i++) {
    const buffer = stars[i].buffer;
    const base = i * RESOURCE_COUNT;
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const idx = base + r;
      const held = buffer[r];
      if (held <= 0) {
        s.supply[idx] = 0;
        continue;
      }
      const inflowRate = s.extractedRate[idx] + s.arrivedRate[idx];
      const carried = Math.max(0, held - inflowRate * dt);
      const wanted = inflowRate + carried / BUFFER_DRAWDOWN_SECONDS;
      const ceiling = held / dt;
      s.supply[idx] = wanted > ceiling ? ceiling : wanted;
    }
  }
}

/**
 * desired(link, r) = weight(link, r) * supply(source, r)
 *
 * then clamped so the sum of all resources across both directions cannot exceed the
 * link's bandwidth, scaling proportionally by weight. That clamp is the contention rule,
 * and it is what makes adding a source to a busy trunk degrade everything already on it.
 */
export function solveFlows(run: RunState, s: FlowScratch, dt: number): void {
  computeSupply(run, s, dt);
  s.rate.fill(0);

  const { descending } = run.topology;
  const stars = run.stars;
  const links = run.links;

  for (let i = 0; i < stars.length; i++) {
    const routing = stars[i].routing;
    const base = i * RESOURCE_COUNT;

    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const available = s.supply[base + r];
      if (available <= 0) continue;

      const override = routing[r];

      if (override === null) {
        const outbound = descending[i];
        if (outbound.length === 0) continue;
        const share = available / outbound.length;
        for (const linkId of outbound) {
          const dir = links[linkId].a === i ? DIR_AB : DIR_BA;
          s.rate[(linkId * 2 + dir) * RESOURCE_COUNT + r] += share;
        }
        continue;
      }

      // Player weights are relative — normalise so they express proportions. A star
      // whose weights sum to zero forwards nothing and will back up, which is a
      // legitimate thing for a player to want.
      let total = 0;
      for (const key in override) total += override[key];
      if (total <= 0) continue;

      for (const key in override) {
        const linkId = Number(key);
        const link = links[linkId];
        if (link === undefined) continue;
        if (link.a !== i && link.b !== i) continue;
        const dir = link.a === i ? DIR_AB : DIR_BA;
        s.rate[(linkId * 2 + dir) * RESOURCE_COUNT + r] +=
          (override[key] / total) * available;
      }
    }
  }

  for (let l = 0; l < links.length; l++) {
    const cap = bandwidth(links[l]);
    const abBase = (l * 2 + DIR_AB) * RESOURCE_COUNT;
    const baBase = (l * 2 + DIR_BA) * RESOURCE_COUNT;

    let total = 0;
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      total += s.rate[abBase + r] + s.rate[baBase + r];
    }
    if (total <= cap) continue;

    const scale = cap / total;
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      s.rate[abBase + r] *= scale;
      s.rate[baBase + r] *= scale;
    }
  }
}

/** Total assigned rate on a link, both directions. For utilisation display. */
export function linkThroughput(s: FlowScratch, linkId: LinkId): number {
  const abBase = (linkId * 2 + DIR_AB) * RESOURCE_COUNT;
  const baBase = (linkId * 2 + DIR_BA) * RESOURCE_COUNT;
  let total = 0;
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    total += s.rate[abBase + r] + s.rate[baBase + r];
  }
  return total;
}
