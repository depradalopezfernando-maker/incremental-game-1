/**
 * Accounting helpers. Not part of the tick — these exist so tests and the UI can ask
 * questions about state without reaching into it.
 */

import {
  amountOf,
  RAW_RESOURCES,
  RESOURCES,
  RESOURCE_INDEX,
  type RawResource,
  type Resource,
  type ResourceAmounts,
  type RunState,
} from './types';
import { emptyAmounts } from './types';

/** Material sitting in every star's buffer. This is the resource-bar figure. */
export function networkTotals(run: RunState): ResourceAmounts {
  const totals = emptyAmounts();
  for (const star of run.stars) {
    for (const resource of RESOURCES) {
      totals[resource] += amountOf(star.buffer, resource);
    }
  }
  return totals;
}

export function networkTotal(run: RunState, resource: Resource): number {
  let total = 0;
  for (const star of run.stars) total += amountOf(star.buffer, resource);
  return total;
}

/** Material still on the wire. */
export function inTransitTotals(run: RunState): ResourceAmounts {
  const totals = emptyAmounts();
  for (const link of run.links) {
    // Entries before `head` have already been delivered and are merely awaiting pruning.
    for (let i = link.head; i < link.queue.length; i++) {
      const segment = link.queue[i];
      totals[segment.resource] += segment.amount;
    }
  }
  return totals;
}

export interface ConservationReport {
  readonly resource: RawResource;
  readonly supplied: number;
  readonly accounted: number;
  readonly residual: number;
}

/**
 * ROADMAP.md Phase 1, extended for construction:
 *
 *   extracted[r] + granted[r]
 *     === inBuffers[r] + inTransit[r] + vented[r] + consumedByRecipes[r]
 *         + spentOnConstruction[r]
 *
 * Per raw resource. Refining destroys its inputs and construction consumes material, so the
 * identity needs both sinks. `granted` covers material the player was handed rather than
 * mined — the opening stockpile, chart-tree grants, and dismantle refunds.
 */
export function conservation(run: RunState): ConservationReport[] {
  const buffers = networkTotals(run);
  const transit = inTransitTotals(run);

  return RAW_RESOURCES.map((resource) => {
    const supplied = amountOf(run.extracted, resource) + amountOf(run.granted, resource);
    const accounted =
      buffers[resource] +
      transit[resource] +
      amountOf(run.vented, resource) +
      amountOf(run.consumedByRecipes, resource) +
      amountOf(run.spentOnConstruction, resource);
    return { resource, supplied, accounted, residual: supplied - accounted };
  });
}

/** Largest absolute conservation residual across all raw resources. */
export function worstResidual(run: RunState): number {
  let worst = 0;
  for (const report of conservation(run)) {
    const magnitude = Math.abs(report.residual);
    if (magnitude > worst) worst = magnitude;
  }
  return worst;
}

/** Guards the 6-hour CI test: no NaN anywhere in state. */
export function findNonFinite(run: RunState): string | null {
  for (const resource of RESOURCES) {
    if (!Number.isFinite(amountOf(run.extracted, resource))) return `extracted.${resource}`;
    if (!Number.isFinite(amountOf(run.vented, resource))) return `vented.${resource}`;
    if (!Number.isFinite(amountOf(run.consumedByRecipes, resource))) {
      return `consumedByRecipes.${resource}`;
    }
    if (!Number.isFinite(amountOf(run.producedByRecipes, resource))) {
      return `producedByRecipes.${resource}`;
    }
  }
  for (const star of run.stars) {
    if (!Number.isFinite(star.reserve)) return `star ${star.id} reserve`;
    for (const resource of RESOURCES) {
      const held = star.buffer[RESOURCE_INDEX[resource]];
      if (!Number.isFinite(held)) return `star ${star.id} buffer.${resource}`;
      if (held < 0) return `star ${star.id} buffer.${resource} negative`;
    }
  }
  for (const link of run.links) {
    for (let i = link.head; i < link.queue.length; i++) {
      const segment = link.queue[i];
      if (!Number.isFinite(segment.amount)) return `link ${link.id} segment amount`;
      if (!Number.isFinite(segment.arrivesAt)) return `link ${link.id} segment arrivesAt`;
    }
  }
  return null;
}
