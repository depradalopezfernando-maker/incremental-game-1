/**
 * The snapshot React renders from.
 *
 * The simulation runs at 10 Hz and the canvas draws every frame, but re-rendering React at
 * either rate would be waste — nothing in the chrome changes meaningfully faster than a few
 * times a second. So the loop publishes one of these at `HUD_HZ` and the panels subscribe to
 * it; the map reads live state directly and never goes through React at all.
 *
 * Rates are smoothed. UI.md mandates tabular figures against jitter, and an instantaneous
 * rate at a 10 Hz step with discrete recipe output is noise — so displayed rates are an
 * exponential moving average over ~2 s.
 */

import { held } from '../sim/actions';
import { linkThroughput, type FlowScratch } from '../sim/flow';
import { RESOURCES, RESOURCE_COUNT, type GameState, type Resource } from '../sim/types';

/** Snapshot publication rate. Fast enough to feel live, slow enough to be cheap. */
export const HUD_HZ = 5;

/** UI.md § Resource bar: exponential moving average over ~2 s. */
export const RATE_SMOOTHING_SECONDS = 2;

export interface ResourceReading {
  readonly resource: Resource;
  readonly amount: number;
  /** Net units per second, smoothed. */
  readonly rate: number;
}

export interface NetworkSummary {
  readonly stalledHubs: number;
  readonly ventingStars: number;
  /** Stars with under five minutes of reserve left. UI.md § Inspector. */
  readonly expiringStars: number;
  readonly deadStars: number;
  readonly claimedStars: number;
  readonly linkCount: number;
  /** Total assigned throughput across every link, u/s. */
  readonly throughput: number;
}

export interface HudSnapshot {
  readonly elapsed: number;
  readonly resources: readonly ResourceReading[];
  readonly summary: NetworkSummary;
  /** Bumped on every publish so subscribers can compare cheaply. */
  readonly version: number;
}

export function emptySnapshot(): HudSnapshot {
  return {
    elapsed: 0,
    resources: RESOURCES.map((resource) => ({ resource, amount: 0, rate: 0 })),
    summary: {
      stalledHubs: 0,
      ventingStars: 0,
      expiringStars: 0,
      deadStars: 0,
      claimedStars: 0,
      linkCount: 0,
      throughput: 0,
    },
    version: 0,
  };
}

/** Rolling state for the rate estimator, owned by the loop. */
export class HudSampler {
  private lastAmounts = new Float64Array(RESOURCE_COUNT);
  private rates = new Float64Array(RESOURCE_COUNT);
  private primed = false;
  private version = 0;

  sample(state: GameState, dtSeconds: number, scratch: FlowScratch): HudSnapshot {
    const amounts = new Float64Array(RESOURCE_COUNT);
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      amounts[r] = held(state.run, RESOURCES[r]);
    }

    if (this.primed && dtSeconds > 0) {
      // Standard EMA weight for a time constant, so the smoothing is independent of how
      // often this happens to be called.
      const alpha = 1 - Math.exp(-dtSeconds / RATE_SMOOTHING_SECONDS);
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const instant = (amounts[r] - this.lastAmounts[r]) / dtSeconds;
        this.rates[r] += alpha * (instant - this.rates[r]);
      }
    }
    this.lastAmounts = amounts;
    this.primed = true;
    this.version += 1;

    return {
      elapsed: state.run.elapsed,
      resources: RESOURCES.map((resource, r) => ({
        resource,
        amount: amounts[r],
        rate: this.rates[r],
      })),
      summary: summarise(state, scratch),
      version: this.version,
    };
  }

  /** After an offline resolve, the jump in stockpiles is not a rate. */
  reset(): void {
    this.primed = false;
    this.rates.fill(0);
  }
}

const FIVE_MINUTES = 5 * 60;

/**
 * How long after its last overflow a star still counts as venting. Long enough that the
 * indicator does not flicker between ticks, short enough that fixing the problem clears it
 * while the player is still looking.
 */
export const VENT_VISIBLE_SECONDS = 1.5;

function summarise(state: GameState, scratch: FlowScratch): NetworkSummary {
  const run = state.run;
  let stalledHubs = 0;
  let expiringStars = 0;
  let deadStars = 0;
  let claimedStars = 0;
  let ventingStars = 0;

  for (const star of run.stars) {
    if (!star.claimed) continue;
    claimedStars += 1;

    if (star.resource !== null && star.reserve <= 0) deadStars += 1;
    if (star.lastVentAt >= 0 && run.elapsed - star.lastVentAt <= VENT_VISIBLE_SECONDS) {
      ventingStars += 1;
    }

    if (star.role === 'hub') {
      const stalled = star.slots.some(
        (slot) => slot.status.kind === 'starved' || slot.status.kind === 'backedUp',
      );
      if (stalled) stalledHubs += 1;
    }

    if (star.resource !== null && star.reserve > 0) {
      const rate = star.baseYield * star.throttle;
      if (rate > 0 && star.reserve / rate < FIVE_MINUTES) expiringStars += 1;
    }
  }

  let throughput = 0;
  for (const link of run.links) throughput += linkThroughput(scratch, link.id);

  return {
    stalledHubs,
    ventingStars,
    expiringStars,
    deadStars,
    claimedStars,
    linkCount: run.links.length,
    throughput,
  };
}
