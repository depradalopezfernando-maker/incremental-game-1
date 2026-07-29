# Lightlace — mechanics

Authority on **rules**. For numbers see `BALANCE.md`.

---

## 1. The cluster

A run takes place in one procedurally generated cluster. Generation is seeded; the
same seed always yields the same cluster. Seed is stored in the save.

Stars are points in 2D space with coordinates in **light-units (lu)**. The cluster
has an origin at (0,0) and a radius that grows with each collapse.

Each star has:

| Property | Notes |
|---|---|
| `id`, `x`, `y` | Position, immutable |
| `class` | Determines resource type and modifiers — see `CONTENT.md` |
| `resource` | `hydrogen` \| `metals` \| `isotopes` |
| `reserve` | Remaining material. Decreases forever. Never regenerates. |
| `reserveMax` | For UI display of depletion fraction |
| `baseYield` | Units/sec at 100% throttle before upgrades |
| `tier` | 0–4. Determines ports and buffer capacity. |
| `throttle` | 0.0–1.0, player-set |
| `buffer` | `Record<Resource, number>`, current stored material |
| `role` | `none` \| `hub` |
| `claimed` | Whether the player has connected it |

A star is **claimed** by building a link to it. Unclaimed stars are visible (dimmed)
within scan range and invisible beyond it.

### Depletion

`reserve` decreases at the current extraction rate. When it hits zero the star
becomes **dead**. A dead star:

- produces nothing, forever
- **keeps its ports and buffer** and still functions as a relay
- still costs nothing to maintain (no upkeep — see § Non-mechanics)
- renders visibly dark

This is deliberate: dead stars are not garbage, they are infrastructure. The
decision "dismantle this relay to reclaim two ports, or keep it as a bridge" is one
of the better decisions in the game and depends on dead stars remaining useful.

---

## 2. Links

A link connects exactly two stars. It has:

| Property | Notes |
|---|---|
| `a`, `b` | Star ids |
| `tier` | 1–4 |
| `length` | Euclidean distance in lu, fixed at build time |
| `bandwidth` | Derived from tier |
| `latency` | Derived from `length` and tier speed |

Links are **bidirectional in principle but carry directed flows**. Material moves
along a link in whichever direction the routing solve assigns; both directions share
the same bandwidth budget.

### Ports

Building a link consumes one **port** at each endpoint. A star's port count comes
from its tier plus a bonus if it is a hub. If either endpoint has no free port, the
link cannot be built.

### Building

To build a link, both of these must hold:

- At least one endpoint is already claimed (you expand outward from your network —
  you cannot found a disconnected second network)
- The unclaimed endpoint is within **scan range** of a claimed star

Cost is paid in metals (tier 1) or alloy (tiers 2–4) and scales with length.

### Upgrading

A link can be upgraded to the next tier at any time for the cost difference plus a
surcharge. Upgrading is instantaneous and does not interrupt flow. Upgrading raises
both bandwidth and propagation speed — see `BALANCE.md` § Link tiers. **The speed
increase is the emotionally important part**: upgrading a long trunk makes the whole
network suddenly feel responsive, and that should be the reward the player chases.

### Dismantling

Dismantling refunds a fraction of cost and frees both ports. Any material in transit
on that link is **lost**. Warn the player if in-transit amount exceeds a threshold.

---

## 3. Flow model

**This is the most important section. Get it wrong and nothing else works.**

Do not simulate individual packets or spawn traveling entities. The network is a
**flow graph with delay**.

### Per tick

1. **Extract.** For each living star: `extracted = yield(star) * throttle * dt`,
   capped by remaining reserve. Add to the star's buffer for its resource. Subtract
   from reserve.

2. **Solve flows.** Compute the rate assigned to each directed link, respecting
   bandwidth and routing weights. See § Routing solve.

3. **Depart.** For each link, remove `rate * dt` from the source buffer and push a
   segment `{ resource, amount, arrivesAt }` onto the link's delay queue, where
   `arrivesAt = now + link.latency`.

4. **Arrive.** Pop all segments on all links with `arrivesAt <= now` and add to the
   destination buffer.

5. **Refine.** Hubs with active recipe slots consume from their buffer and produce
   output — see § Refining.

6. **Vent.** For each star, for each resource, if `buffer[r] > capacity(star)`, set
   it to capacity and add the excess to `run.vented[r]`. **The excess is destroyed.**

Order matters. Venting happens last so a star that receives and forwards in the same
tick doesn't lose material spuriously.

### Delay queues

Each link holds an array of in-transit segments. To bound memory, merge adjacent
segments with the same resource whose arrival times are within one tick of each
other. A link should never hold more than a few dozen segments.

### Routing solve

Each star has a **routing table**: for each resource, a set of weights over its
outbound links. Weights are player-set (default: even split across links that lead
toward a hub).

The solve is deliberately simple — it is not a min-cost-flow optimizer, because the
player optimizing the network *is the game*. Do not build an optimizer that plays the
game for them.

For each directed link, desired rate is:

```
desired(link, r) = sourceBuffer[r] available this tick, split by weight
```

Then clamp: the sum of all resources' rates on a link cannot exceed the link's
bandwidth. If it would, scale all of them down proportionally *by weight*. This is
the contention rule — and it is what makes adding a source to a busy trunk degrade
everything already on it.

Surplus that can't move stays in the buffer, and if the buffer is full, it vents.

### Routing profiles

The player can save the entire set of routing weights (plus all throttle values) as a
named **profile** and switch between them instantly and for free. Switching profiles
never changes topology and costs nothing.

Two profiles are pre-named on unlock: `Live` and `Long-haul`. The player can rename
and add more.

**Unlocked by a chart tree node, not available from the start.** Doing the
re-weighting manually for the first few hours is what teaches the player why the
feature matters.

---

## 4. Resources and refining

Three raw resources — hydrogen, metals, isotopes — extracted from stars by class.

Two refined goods and one endgame good, produced at hubs:

| Output | Inputs | Used for |
|---|---|---|
| Alloy | metals + hydrogen | Link tiers 2–4, port upgrades, hub upgrades |
| Catalyst | isotopes + hydrogen | Extraction rate, buffer capacity, scan range |
| Lattice core | alloy + catalyst | The collapse currency. Nothing else. |

### Hubs

Any claimed star can be **designated a hub** for a cost. A hub:

- gains bonus ports
- gains recipe slots (count by tier)
- gains a much larger buffer
- can be un-designated, refunding a fraction

Each recipe slot is assigned one recipe. A slot runs a cycle only if **all inputs are
present in that hub's own buffer**. Partial inputs mean the slot stalls and the
present inputs sit there.

This is the co-location constraint that makes recipes interesting: it is not enough
to produce metals and hydrogen somewhere, they must *arrive at the same star*, in
ratio, with enough bandwidth on both branches to sustain the recipe rate.

### Stalling is visible

A stalled slot must be obvious in the UI, and must say *which input is missing*. A
player should be able to glance at the map and see "that hub is starving for
isotopes" without opening a panel. This is the core diagnostic loop — see `UI.md`.

---

## 5. Progression within a run

### Node tiers

Upgrading a star's tier increases its ports, buffer capacity, and (for hubs) recipe
slots. Cost in alloy, scaling steeply.

### Extraction upgrades

Global and per-star extraction rate multipliers, bought with catalyst.

### Scan range

Bought with catalyst. Determines how far from a claimed star you can see and reach
unclaimed stars. Gating expansion behind scan range means the frontier advances at a
pace you control rather than the whole map being available at once.

---

## 6. Collapse (prestige)

Available once the player has produced a threshold number of lattice cores.

On collapse:

- The current cluster is discarded entirely
- The player is awarded **charts**, computed from total lattice cores produced this
  run (see `BALANCE.md`)
- A new, larger, richer cluster is generated from a new seed
- Charts are permanent and spend on the chart tree
- Chart tree purchases persist across all future collapses

The player keeps: charts, chart tree purchases, unlocked recipes, statistics.
The player loses: the cluster, all links, all stockpiles, all node upgrades.

### Why collapse feels good

The second cluster is not just bigger — it contains **star classes that did not exist
in the first** (binaries at collapse 2, wormhole anchors at collapse 3). New topology
problems, not the same problem with bigger numbers. Preserve this.

---

## 7. Wormholes (phase 5)

Unlocked in the chart tree. Certain stars are **wormhole anchors**. A wormhole link
can be built between two anchors regardless of distance, with:

- latency independent of length (a small fixed value)
- very high bandwidth
- **a cost in lattice cores**, not alloy — they are genuinely expensive
- consumption of two ports at each end, not one

Wormholes break the geometric assumption the player has been building around for
hours. A frontier that was 900 lu away and effectively unreachable becomes a
one-hop neighbour. The correct network shape changes completely. That's the point.

---

## 8. Offline progress

The player must never be punished for closing the game. On return:

1. Compute elapsed real time, capped (see `BALANCE.md`)
2. Resolve in **closed form**, not by ticking — see `BALANCE.md` § Offline resolution
3. Present an arrival summary: what was produced, what depleted, what was vented

The vented figure must be shown honestly and prominently. If the player left a bad
configuration running for eight hours, they should see exactly what it cost them.
That is the feedback that makes the pre-departure ritual matter.

---

## 9. Non-mechanics — deliberately absent

Do not add these. Each was considered and rejected:

- **Upkeep costs on links.** Adds bookkeeping, punishes redundancy, and redundancy
  is the thing that makes routing profiles interesting.
- **Random hazards or events.** The player should always be able to explain why the
  network is in the state it's in.
- **Combat or defence.**
- **Automation that routes for the player.** Routing *is* the game. Automation may
  reduce clicking (profiles, bulk throttle) but must never make routing decisions.
- **Any pathfinding the player didn't specify.** No auto-route button.
