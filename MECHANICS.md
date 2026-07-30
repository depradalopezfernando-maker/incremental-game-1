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
| `resource` | `hydrogen` \| `metals` \| `isotopes` \| `null` (wormhole anchors only) |
| `reserve` | Remaining material. Decreases forever. Never regenerates. |
| `reserveMax` | For UI display of depletion fraction |
| `baseYield` | Units/sec at 100% throttle before upgrades |
| `tier` | 0–4. Determines ports and buffer capacity. |
| `throttle` | 0.0–1.0, player-set. Defaults to 1.0 on claim. |
| `buffer` | Stored material per resource — see § 9 on representation |
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
surcharge. Upgrading is instantaneous and does not interrupt flow. Segments already in
transit keep the `arrivesAt` they were dispatched with — they were sent under the old
physics and are not retimed. Upgrading raises
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

2. **Arrive.** Pop all segments on all links with `arrivesAt <= now` and add to the
   destination buffer.

3. **Solve flows.** Compute the rate assigned to each directed link, respecting
   bandwidth and routing weights. See § Routing solve.

4. **Depart.** For each link, remove `rate * dt` from the source buffer and push a
   segment `{ resource, amount, arrivesAt }` onto the link's delay queue, where
   `arrivesAt = now + link.latency`.

5. **Refine.** Hubs with active recipe slots consume from their buffer and produce
   output — see § Refining.

6. **Vent.** For each star, for each resource, if `buffer[r] > capacity(star)`, set
   it to capacity and add the excess to `run.vented[r]`. **The excess is destroyed.**

Order matters, in two places.

**Arrive precedes Solve and Depart** so that everything a star has this tick is sitting
in its buffer before rates are computed. A relay can therefore receive and forward
within the same tick, and — more importantly — `supply()` in § Routing solve can count
arriving material without the solve promising a rate the buffer cannot cover at step 4.
Material still only arrives when its segment matures, so this does not let anything skip
a hop; it just removes a spurious one-tick stall at every relay.

**Vent happens last** so a star that receives and forwards in the same tick doesn't lose
material spuriously.

### Delay queues

Each link holds an array of in-transit segments, ordered by arrival.

To bound memory, departures are merged into **arrival buckets**: a departure joins the
open segment for its (direction, resource) when both fall in the same bucket, where a
bucket is `max(dt, latency / MAX_SEGMENTS_PER_LINK)` wide. That caps a link at a few dozen
segments per direction per resource, no matter how long the link or how fine the tick.

Merging smears arrival timing by at most one bucket width and never loses material. Note
the bucket cannot simply be "one tick" — with a fixed step and a fixed latency, every
consecutive departure would land in the same window and the whole queue would collapse
into one segment, destroying the delay the queue exists to model.

### Routing solve

Each star has a **routing table**: for each resource, a set of weights over its
outbound links. Weights are player-set; the default is described in § Default weights
below.

The solve is deliberately simple — it is not a min-cost-flow optimizer, because the
player optimizing the network *is the game*. Do not build an optimizer that plays the
game for them.

**Flow is a rate, not a buffer drain.** The rate assigned to a link must not depend on
`dt`. The same network simulated at 10 Hz, at 1 Hz, and resolved in closed form offline
must produce the same answer. This is not a nicety: it is what makes § 8's offline
solver possible at all, what keeps the long-running conservation tests meaningful at
coarse step sizes, and what makes link utilisation a gradient the player can read
rather than a binary that pins to full whenever anything is upstream.

For each star and resource, the supply available to forward this tick is:

```
supply(star, r) = extractionRate(star, r)     // 0 unless r is this star's resource
                + arrivingRate(star, r)       // segments landed at step 2
                + carried(star, r) / BUFFER_DRAWDOWN_SECONDS

  where carried = buffer[r] at the end of the previous tick
                  (i.e. buffer[r] now, less this tick's extraction and arrivals)

  and the total is capped at buffer[r] / dt
```

The three terms are disjoint, which is the point — extraction and arrivals pass straight
through at their own rate, and only the standing backlog is metered. Double-counting
them against the buffer they were just added to would let a star promise twice what it
holds.

The `/ dt` cap keeps a buffer from going negative at step 4. The
`BUFFER_DRAWDOWN_SECONDS` divisor is what stops a full buffer from demanding an unbounded
rate and saturating every link downstream of it.

Note what this gives you in steady state: with no backlog, `supply` equals the rate
material is actually showing up at, so link flow settles at exactly the upstream
production rate and buffers sit flat. That is what keeps the intervals in `BALANCE.md`
§ 8 linear rather than exponential — the property the closed-form solver depends on.

Then, for each directed link:

```
desired(link, r) = weight(link, r) * supply(source, r)
```

Then clamp: the sum of all resources' rates on a link cannot exceed the link's
bandwidth. If it would, scale all of them down proportionally *by weight*. This is
the contention rule — and it is what makes adding a source to a busy trunk degrade
everything already on it.

Surplus that can't move stays in the buffer, and if the buffer is full, it vents.

### Default weights

The default is an even split across those of a star's links whose far endpoint has a
strictly **lower hop-distance to the nearest hub**. Hop-distances come from a
breadth-first search recomputed when topology or hub designation changes — never per
tick.

Two consequences are worth stating outright:

- **No cycle forms by default.** Flow only descends the hop gradient, so material
  cannot loop back on itself and burn bandwidth. A player who sets weights that do
  create a cycle gets one; that is their business, and the map will show it plainly.
- **"Nearest hub" means nearest, not best.** Once a second hub exists, interior
  material keeps flowing to the origin. Pushing hydrogen *outward* to a frontier
  catalyst hub is a deliberate re-weighting the player has to make. The defaults are
  meant to be wrong for that, not to anticipate it — the polarity reversal around 0:50
  is the phase-2 lesson.

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

Each recipe slot is assigned one recipe. A slot draws **all of its inputs from that
hub's own buffer**. If any input is absent the slot stalls, and the inputs that are
present sit there untouched.

This is the co-location constraint that makes recipes interesting: it is not enough
to produce metals and hydrogen somewhere, they must *arrive at the same star*, in
ratio, with enough bandwidth on both branches to sustain the recipe rate.

**Consumption is continuous, not batched.** A slot consumes inputs and produces output
at the sustained rates in `BALANCE.md` § 4, scaled by `dt`. The cycle time in that
table is presentation — it sets how the slot animates and how progress reads in the
inspector, not how material moves. Discrete all-or-nothing batches would make the
closed-form offline solver in `BALANCE.md` § 8 impossible, since a hub's state would
depend on where in a 4-second cycle it happened to be.

A slot runs at a fraction of its rate if inputs are available but insufficient — it
consumes what is there, in ratio, and produces proportionally. It never consumes an
input it cannot pair with the others.

### Stalling

A slot stalls, consuming nothing, in two distinct cases, and the UI must tell them
apart:

- **Starved.** One or more inputs are absent from the hub's buffer. Name the missing
  input.
- **Backed up.** The output resource is at buffer capacity. Inputs are preserved —
  refined goods are never destroyed for want of space. Venting applies only to
  extraction overflow, at step 6 of the tick.

### Recipe unlocks

A recipe becomes permanently available the first time the network holds at least one
of each of its inputs anywhere. Catalyst unlocks on first isotopes, lattice core on
first alloy and catalyst held together. The alloy recipe is available from the start.
Unlocks are stored on the persistent side of state and survive collapse — see § 9.

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

Because a wormhole eats two ports and claiming the anchor in the first place eats a
third, **anchors generate at minimum node tier 1** (3 ports). At tier 0 an anchor could
be claimed or wormholed but never both. Tier 1 is an exact fit with no slack, so an
anchor that also needs to relay anything wants upgrading.

Anchors have no resource and never produce. They are pure topology.

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

## 9. State shape

State splits in two, and the split is exactly the collapse boundary from § 6. If you
are unsure which side something belongs on, ask whether it should survive a collapse.

```
GameState
  meta                          persists across collapse
    charts                      unspent
    chartNodesPurchased         set of node ids
    recipesUnlocked             set of recipe ids
    collapseCount               n, drives generation in BALANCE.md § 1
    stats                       lifetime totals, for display only
  run                           discarded on collapse
    seed                        the cluster's seed
    elapsed                     seconds of simulated time this run
    stars                       by id, shape as § 1
    links                       by id, shape as § 2, each with its delay queue
    hopDistance                 derived, cached, rebuilt on topology change
    upgrades                    k per within-run upgrade track, BALANCE.md § 5
    profiles                    saved routing profiles, once unlocked
    extracted                   cumulative this run, per resource
    granted                     material handed over rather than mined — the opening
                                stockpile and chart-tree starting grants
    vented                      cumulative this run, per resource
    consumedByRecipes           cumulative this run, per resource
    producedByRecipes           cumulative this run, per resource
    coresProduced               lifetime this run, drives the collapse award
```

The five ledgers exist so material can be accounted for exactly. See `ROADMAP.md`
Phase 1 for the conservation identity they satisfy; the arrival summary in `CONTENT.md`
needs them too.

Per-resource quantities — star buffers and those ledgers — are stored indexed by a fixed
resource order rather than keyed by name. They are read and written with a *dynamic*
resource in the tick's hot loops, where a keyed lookup costs 20–50 ns and there are dozens
per star per tick; the indexed form is what makes a six-hour endurance run fit the suite
budget. It is a representation choice and nothing more: capacity is still per resource, and
nothing about the rules changes.

Everything under `run` is regenerated from `seed` and `meta` at collapse. Nothing under
`meta` is ever recomputed from `run`.

---

## 10. Non-mechanics — deliberately absent

Do not add these. Each was considered and rejected:

- **Upkeep costs on links.** Adds bookkeeping, punishes redundancy, and redundancy
  is the thing that makes routing profiles interesting.
- **Random hazards or events.** The player should always be able to explain why the
  network is in the state it's in.
- **Combat or defence.**
- **Automation that routes for the player.** Routing *is* the game. Automation may
  reduce clicking (profiles, bulk throttle) but must never make routing decisions.
- **Any pathfinding the player didn't specify.** No auto-route button.
