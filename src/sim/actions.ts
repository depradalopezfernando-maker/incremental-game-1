/**
 * Player actions as pure state transitions. MECHANICS.md § 2 and § 5.
 *
 * These are *rules*, not interface, so they live here rather than in the app layer: they
 * are headless, deterministic and testable, and the UI's only job is to call them and
 * render whatever they say.
 *
 * Every action comes in two halves — a `can…` that explains itself and a `do…` that
 * performs it. The explanation is what the interface shows when something is not possible,
 * so the reasons are written in the game's voice: what happened and what to do about it,
 * never an apology. See CONTENT.md § Voice.
 */

import {
  buildCost,
  bufferCapacity,
  hubDesignateCost,
  HUB_UNDESIGNATE_REFUND,
  linkDismantleRefund,
  LINK_COST_CURRENCY,
  MAX_NODE_TIER,
  nodeUpgradeCost,
  portCount,
  recipeSlotCount,
  scanRange,
} from './constants';
import { recomputeTopology } from './flow';
import {
  makeRouting,
  RESOURCE_COUNT,
  RESOURCE_INDEX,
  type LinkId,
  type LinkTier,
  type NodeTier,
  type RecipeId,
  type Resource,
  type RunState,
  type Segment,
  type StarId,
} from './types';

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: Outcome = { ok: true };

function no(reason: string): Outcome {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Geometry and capacity
// ---------------------------------------------------------------------------

export function distanceBetween(run: RunState, a: StarId, b: StarId): number {
  const starA = run.stars[a];
  const starB = run.stars[b];
  return Math.hypot(starA.x - starB.x, starA.y - starB.y);
}

export function portsUsed(run: RunState, starId: StarId): number {
  return run.topology.adjacency[starId].length;
}

export function portsTotal(run: RunState, starId: StarId): number {
  const star = run.stars[starId];
  return portCount(star.tier, star.role === 'hub');
}

export function freePorts(run: RunState, starId: StarId): number {
  return portsTotal(run, starId) - portsUsed(run, starId);
}

export function currentScanRange(run: RunState): number {
  return scanRange(run.upgrades.scanRange);
}

export function capacityOfStar(run: RunState, starId: StarId): number {
  const star = run.stars[starId];
  return bufferCapacity(star.tier, run.upgrades.buffer, star.role === 'hub');
}

/** Whether an unclaimed star is close enough to anything you own to reach it. */
export function isInScanRange(run: RunState, starId: StarId): boolean {
  const range = currentScanRange(run);
  for (const star of run.stars) {
    if (!star.claimed) continue;
    if (distanceBetween(run, star.id, starId) <= range) return true;
  }
  return false;
}

export function areLinked(run: RunState, a: StarId, b: StarId): boolean {
  for (const edge of run.topology.adjacency[a]) {
    if (edge.other === b) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/**
 * Material lives in star buffers; the resource bar shows the network-wide sum, and a
 * purchase debits the stars holding that resource nearest-first from whatever is being
 * bought. Co-location constrains *refining* only — see UI.md § Resource bar.
 */
export function held(run: RunState, resource: Resource): number {
  const index = RESOURCE_INDEX[resource];
  let total = 0;
  for (const star of run.stars) total += star.buffer[index];
  return total;
}

/** Stars ordered by distance from `nearId`; id breaks ties so spending is deterministic. */
function byDistanceFrom(run: RunState, nearId: StarId): StarId[] {
  return run.stars
    .map((star) => ({ id: star.id, distance: distanceBetween(run, nearId, star.id) }))
    .sort((a, b) => a.distance - b.distance || a.id - b.id)
    .map((entry) => entry.id);
}

/**
 * Debit `amount` of `resource`, nearest to `nearId` first. All-or-nothing: returns false
 * and touches nothing if the network does not hold enough.
 *
 * Recorded in `spentOnConstruction`. Without that, building anything would remove material
 * from buffers with no matching sink and the conservation identity would silently stop
 * holding — which is exactly what happened before this ledger existed.
 */
export function spend(
  run: RunState,
  resource: Resource,
  amount: number,
  nearId: StarId,
): boolean {
  if (amount <= 0) return true;
  if (held(run, resource) < amount) return false;

  const index = RESOURCE_INDEX[resource];
  let remaining = amount;

  for (const id of byDistanceFrom(run, nearId)) {
    if (remaining <= 0) break;
    const buffer = run.stars[id].buffer;
    if (buffer[index] <= 0) continue;
    const take = Math.min(buffer[index], remaining);
    buffer[index] -= take;
    remaining -= take;
  }

  run.spentOnConstruction[index] += amount - Math.max(0, remaining);
  return true;
}

/**
 * Return `amount` to the network, nearest to `toId` first, filling each buffer only to its
 * capacity before moving outward.
 *
 * Spreading matters: a refund dumped into one full buffer would silently evaporate, and a
 * dismantle that hands back nothing is worse than one that hands back a little. Anything with
 * genuinely nowhere to go is vented, because material that cannot be stored is destroyed —
 * and either way it lands on a ledger so conservation still closes.
 */
export function refund(run: RunState, resource: Resource, amount: number, toId: StarId): void {
  if (amount <= 0) return;
  const index = RESOURCE_INDEX[resource];
  let remaining = amount;

  for (const id of byDistanceFrom(run, toId)) {
    if (remaining <= 0) break;
    const star = run.stars[id];
    if (!star.claimed) continue;
    const room = capacityOfStar(run, id) - star.buffer[index];
    if (room <= 0) continue;
    const place = Math.min(room, remaining);
    star.buffer[index] += place;
    remaining -= place;
  }

  run.granted[index] += amount - remaining;
  if (remaining > 0) {
    run.vented[index] += remaining;
    run.granted[index] += remaining;
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function linkBuildCost(run: RunState, a: StarId, b: StarId, tier: LinkTier): number {
  return buildCost(distanceBetween(run, a, b), tier);
}

export function linkCurrency(tier: LinkTier): Resource {
  return LINK_COST_CURRENCY[tier];
}

export function canBuildLink(
  run: RunState,
  a: StarId,
  b: StarId,
  tier: LinkTier = 1,
): Outcome {
  if (a === b) return no('A link needs two different stars.');
  const starA = run.stars[a];
  const starB = run.stars[b];
  if (starA === undefined || starB === undefined) return no('No such star.');
  if (areLinked(run, a, b)) return no(`${starA.name} and ${starB.name} are already linked.`);

  // You expand outward from your network — you cannot found a disconnected second one.
  if (!starA.claimed && !starB.claimed) {
    return no('Neither star is connected to your network.');
  }

  const unclaimed = !starA.claimed ? starA : !starB.claimed ? starB : null;
  if (unclaimed !== null && !isInScanRange(run, unclaimed.id)) {
    return no(`${unclaimed.name} is beyond scan range. Extend scan range to reach it.`);
  }

  for (const star of [starA, starB]) {
    if (freePorts(run, star.id) <= 0) {
      return no(`No free ports on ${star.name}. Upgrade the node or dismantle a link.`);
    }
  }

  const cost = linkBuildCost(run, a, b, tier);
  const currency = linkCurrency(tier);
  if (held(run, currency) < cost) {
    return no(`Need ${Math.ceil(cost)} ${currency}. Holding ${Math.floor(held(run, currency))}.`);
  }

  return OK;
}

export function buildLink(run: RunState, a: StarId, b: StarId, tier: LinkTier = 1): Outcome {
  const check = canBuildLink(run, a, b, tier);
  if (!check.ok) return check;

  const cost = linkBuildCost(run, a, b, tier);
  // Charge against the end that is already yours — that is where the material would come
  // from, and it keeps nearest-first spending sensible when expanding outward.
  const payFrom = run.stars[a].claimed ? a : b;
  if (!spend(run, linkCurrency(tier), cost, payFrom)) {
    return no('Not enough material.');
  }

  run.links.push({
    id: run.links.length,
    a,
    b,
    tier,
    length: distanceBetween(run, a, b),
    kind: 'normal',
    queue: [],
    head: 0,
    tail: new Array<Segment | null>(2 * RESOURCE_COUNT).fill(null),
  });

  run.stars[a].claimed = true;
  run.stars[b].claimed = true;
  run.topology = recomputeTopology(run);
  return OK;
}

/** Material still in flight on a link. Dismantling destroys it, so the UI warns first. */
export function inTransitOn(run: RunState, linkId: LinkId): number {
  const link = run.links[linkId];
  if (link === undefined) return 0;
  let total = 0;
  for (let i = link.head; i < link.queue.length; i++) total += link.queue[i].amount;
  return total;
}

/**
 * What dismantling this link hands back.
 *
 * Normally 40% — the designed sink that makes topology changes cost something. But when the
 * network is stranded, the refund is **full**: DESIGN.md is explicit that there is no losing,
 * and a 40% refund is not enough to climb out of a dead end. Two hydrogen links bought with
 * the opening stockpile refund about 120 metals against a 187-metal nearest link, which is
 * still stuck. A partial refund that leaves you exactly as unable to act is not a way out.
 *
 * This never affects normal play: a network with income of the currency is never stranded.
 */
export function dismantleRefundOf(run: RunState, linkId: LinkId): number {
  const link = run.links[linkId];
  if (link === undefined) return 0;
  const full = buildCost(link.length, link.tier);
  return isStranded(run) ? full : linkDismantleRefund(link.length, link.tier);
}

/**
 * Dismantling refunds a fraction of cost and frees both ports. Anything in transit is lost.
 *
 * This is the player's way out of a corner: the opening stockpile is finite and there is no
 * metals income until a rocky remnant is claimed, so a network that has spent itself into a
 * dead end needs *some* lever. DESIGN.md is explicit that there is no losing — a state you
 * cannot act from is broken, not harsh.
 */
export function dismantleLink(run: RunState, linkId: LinkId): Outcome {
  const link = run.links[linkId];
  if (link === undefined) return no('No such link.');

  // Destroyed, and recorded as such. Material loss always lands on the ledger.
  for (let i = link.head; i < link.queue.length; i++) {
    const segment = link.queue[i];
    run.vented[RESOURCE_INDEX[segment.resource]] += segment.amount;
  }

  refund(run, linkCurrency(link.tier), dismantleRefundOf(run, linkId), link.a);

  run.links.splice(linkId, 1);
  // Link ids are array positions, so everything after the hole shifts down. Routing overrides
  // are keyed by link id and would silently point at the wrong link; drop them on any star
  // that has them rather than rewriting keys. (Nothing sets overrides before Phase 6.)
  run.links.forEach((existing, index) => {
    if (existing.id !== index) (existing as { id: LinkId }).id = index;
  });
  for (const star of run.stars) {
    if (star.routing.some((entry) => entry !== null)) star.routing = makeRouting();
  }

  run.topology = recomputeTopology(run);
  return OK;
}

/**
 * Whether the player can still act. True when there is no metals income and nothing they can
 * afford to build — the corner that dismantling exists to get out of.
 */
export function isStranded(run: RunState): boolean {
  for (const star of run.stars) {
    if (!star.claimed || star.resource !== 'metals') continue;
    if (star.reserve > 0) return false;
  }

  for (const star of run.stars) {
    if (star.claimed) continue;
    if (!isInScanRange(run, star.id)) continue;
    for (const other of run.stars) {
      if (!other.claimed) continue;
      if (canBuildLink(run, other.id, star.id, 1).ok) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Nodes and hubs
// ---------------------------------------------------------------------------

/**
 * Keep a star's slot count in step with its tier and role.
 *
 * New slots default to `alloy` — the only recipe unlocked when the first hubs are bought,
 * and a hub with an unassigned slot does nothing at all. Explicit slot assignment arrives
 * with the other two recipes in Phase 4.
 */
function resizeSlots(run: RunState, starId: StarId): void {
  const star = run.stars[starId];
  const wanted = recipeSlotCount(star.tier, star.role === 'hub');
  while (star.slots.length > wanted) star.slots.pop();
  while (star.slots.length < wanted) {
    star.slots.push({ recipe: 'alloy', status: { kind: 'idle' } });
  }
}

/** What the next node tier costs from where this star is now. */
export function nodeUpgradeCostOf(run: RunState, starId: StarId): number {
  return nodeUpgradeCost(run.stars[starId].tier);
}

/** What the next hub costs. Scales on hubs *purchased*, not hubs owned. */
export function hubDesignateCostOf(run: RunState): number {
  return hubDesignateCost(run.hubsPurchased);
}

export function canUpgradeNode(run: RunState, starId: StarId): Outcome {
  const star = run.stars[starId];
  if (star === undefined) return no('No such star.');
  if (!star.claimed) return no(`${star.name} is not connected to your network.`);
  if (star.tier >= MAX_NODE_TIER) return no('Already at tier 4.');

  const cost = nodeUpgradeCost(star.tier);
  if (held(run, 'alloy') < cost) {
    return no(`Need ${Math.ceil(cost)} alloy. Holding ${Math.floor(held(run, 'alloy'))}.`);
  }
  return OK;
}

export function upgradeNode(run: RunState, starId: StarId): Outcome {
  const check = canUpgradeNode(run, starId);
  if (!check.ok) return check;

  const star = run.stars[starId];
  spend(run, 'alloy', nodeUpgradeCost(star.tier), starId);
  star.tier = (star.tier + 1) as NodeTier;
  resizeSlots(run, starId);
  return OK;
}

export function canDesignateHub(run: RunState, starId: StarId): Outcome {
  const star = run.stars[starId];
  if (star === undefined) return no('No such star.');
  if (!star.claimed) return no(`${star.name} is not connected to your network.`);
  if (star.role === 'hub') return no(`${star.name} is already a hub.`);

  const cost = hubDesignateCost(run.hubsPurchased);
  if (held(run, 'alloy') < cost) {
    return no(`Need ${Math.ceil(cost)} alloy. Holding ${Math.floor(held(run, 'alloy'))}.`);
  }
  return OK;
}

export function designateHub(run: RunState, starId: StarId): Outcome {
  const check = canDesignateHub(run, starId);
  if (!check.ok) return check;

  spend(run, 'alloy', hubDesignateCost(run.hubsPurchased), starId);
  run.hubsPurchased += 1;
  run.stars[starId].role = 'hub';
  resizeSlots(run, starId);
  // A new hub changes every hop distance, and therefore every default route.
  run.topology = recomputeTopology(run);
  return OK;
}

export function canUndesignateHub(run: RunState, starId: StarId): Outcome {
  const star = run.stars[starId];
  if (star === undefined) return no('No such star.');
  if (star.role !== 'hub') return no(`${star.name} is not a hub.`);

  const hubs = run.stars.filter((s) => s.role === 'hub').length;
  if (hubs <= 1) return no('The network needs at least one hub.');

  // Losing the hub bonus can leave a star holding more links than it has ports for.
  const portsAfter = portCount(star.tier, false);
  if (portsUsed(run, starId) > portsAfter) {
    return no(
      `${star.name} would have ${portsUsed(run, starId)} links and ${portsAfter} ports. ` +
        'Dismantle a link first.',
    );
  }
  return OK;
}

export function undesignateHub(run: RunState, starId: StarId): Outcome {
  const check = canUndesignateHub(run, starId);
  if (!check.ok) return check;

  const star = run.stars[starId];
  // Refunded against the *previous* purchase price, and the counter comes back down so a
  // stranded interior hub can be traded for a frontier one.
  if (run.hubsPurchased > 0) {
    const previous = hubDesignateCost(run.hubsPurchased - 1);
    run.hubsPurchased -= 1;
    refund(run, 'alloy', previous * HUB_UNDESIGNATE_REFUND, starId);
  }

  star.role = 'none';
  resizeSlots(run, starId);
  run.topology = recomputeTopology(run);
  return OK;
}

// ---------------------------------------------------------------------------
// Throttle, slots and within-run upgrades
// ---------------------------------------------------------------------------

export function setThrottle(run: RunState, starId: StarId, throttle: number): void {
  const star = run.stars[starId];
  if (star === undefined) return;
  star.throttle = Math.min(1, Math.max(0, throttle));
}

export function setSlotRecipe(
  run: RunState,
  starId: StarId,
  slotIndex: number,
  recipe: RecipeId | null,
): Outcome {
  const star = run.stars[starId];
  if (star === undefined) return no('No such star.');
  const slot = star.slots[slotIndex];
  if (slot === undefined) return no('No such recipe slot.');
  slot.recipe = recipe;
  slot.status = { kind: 'idle' };
  return OK;
}
