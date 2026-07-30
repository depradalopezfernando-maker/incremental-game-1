# Lightlace — balance

Authority on **numbers**. Every constant here belongs in `src/sim/constants.ts`.
Every formula gets a named exported function with the formula in a comment.

Units: distance in **light-units (lu)**, time in **seconds**, material in **units (u)**.

These are a first pass tuned by hand, not playtested. They are meant to be close
enough to feel right on first run and easy to adjust. Treat the *pacing targets* in
§ 10 as the spec and the constants as the current best guess at hitting them.

---

## 1. Cluster generation

Seeded PRNG — use a small explicit implementation (mulberry32 or sfc32). Do not use
`Math.random()` anywhere in generation.

```
collapseCount  n           (0 for first run)
starCount      = 40 + 14 * n
clusterRadius  = 260 + 90 * n        (lu)
richnessMult   = 1.45 ^ n
```

### Star placement

Biased dart-throwing with rejection: sample a candidate point, reject it if it falls
within `35 lu` of an already-placed star, repeat. This is not uniform Poisson-disc —
the radial bias below is the whole point — but the minimum separation does the same
job, which is that clumped stars make the map unreadable and make port limits
meaningless.

Density should fall off with distance so the frontier feels sparse:

```
angle  = rng(0, 2*PI)
radius = clusterRadius * sqrt(u)^1.33     for uniform u      // i.e. R * u^0.667
```

Areal density then goes as `r^(1/0.667 − 2) = r^-0.5`, thinning outward.

The exponent must sit **above** the uniform-area `sqrt(u)`, not below it. An exponent
below 0.5 pushes each individual sample further out, which sounds like a sparse
frontier and is precisely the opposite — it piles stars against the rim. At `0.85`
(`= u^0.425`) density rises as `r^0.353` and the frontier ends up about 1.8× denser
than the interior.

### Class assignment

Roll per star, weights modified by distance fraction `df = d / clusterRadius`:

| Class | Resource | Base weight | Weight modifier |
|---|---|---|---|
| M-dwarf | hydrogen | 40 | — |
| G-type | hydrogen | 18 | — |
| Rocky remnant | metals | 22 | `* (1 + 0.4*df)` |
| Heavy remnant | isotopes | 12 | `* (0.3 + 1.9*df)` |
| Neutron star | isotopes | 5 | `* (0.1 + 2.6*df)` |
| Binary *(n≥2)* | hydrogen×2 | 8 | `* (0.5 + df)` |
| Wormhole anchor *(n≥3)* | none | 6 | `* df` |

Isotopes being frontier-weighted is what forces expansion in phase 2. Preserve it.

### Reserve and yield

```
reserve   = 900 * (1 + d/120)^1.9  * classReserveMult * richnessMult * rng(0.8, 1.25)
baseYield = 1.0 * (1 + d/200)      * classYieldMult   * yieldMult
yieldMult = richnessMult^0.5       = 1.204 ^ n
```

`yieldMult` is the lever for the second-run acceleration target in § 10. Without it
`richnessMult` scales `reserve` only, so later clusters hold 45% more material per
collapse but produce it no faster — stars last longer and throughput is flat, and
throughput is what makes lattice cores. The exponent `0.5` is deliberately gentler
than the reserve curve so that later clusters still get *longer*, not just faster.

This alone does not reach 2.6×. Together with chart extraction nodes (+8–20%), the
wider radius raising frontier `baseYield`, starting stockpile grants and the player
already knowing the layout, it is in range. Measure it in Phase 4 and tune here.

Class multipliers:

| Class | reserveMult | yieldMult |
|---|---|---|
| M-dwarf | 1.35 | 0.75 |
| G-type | 0.85 | 1.60 |
| Rocky remnant | 1.00 | 1.00 |
| Heavy remnant | 0.70 | 0.85 |
| Neutron star | 0.45 | 2.40 |
| Binary | 1.10 | 1.30, applied twice (`×2` below) |

Resulting lifetimes at 100% throttle, no upgrades, run 1:

| d (lu) | reserve | yield | lifetime |
|---|---|---|---|
| 0 | ~900 | 1.00 | ~15 min |
| 100 | ~2,850 | 1.50 | ~32 min |
| 250 | ~7,645 | 2.25 | ~57 min |

This table is **class-neutral** — it omits `classReserveMult` and `classYieldMult`, so
it describes the shape of the curve rather than any star that actually exists. Every
real star has a class. The two that matter early:

| Star | reserve | yield | lifetime |
|---|---|---|---|
| Origin M-dwarf, forced | 1,400 | 0.75 | ~31 min |
| Guaranteed G-type at 60–95 lu | 1,320–2,900 | 2.08–2.36 | **10.6–20.5 min** |

The G-type is the pacing anchor: it is reliably the first star to die, and the origin and
the guaranteed rocky remnant both outlive it, so the first depletion the player sees is
the bright one they were relying on.

Its lifetime straddles § 10's `first star runs dry 0:12–0:18` target rather than sitting
inside it — the spread comes from the 60–95 lu annulus and the `rng(0.8, 1.25)` reserve
roll, and the tails land at 10.6 and 20.5 minutes. Typical is ~15 min. Narrow the annulus
or the roll if playtesting says the early tail feels abrupt.

Near stars die inside the first session; far stars survive an hour. This gradient
*is* the outward pressure. If playtesting says phase 1 feels too frantic, raise the
`900` base rather than flattening the exponent.

### Seed guarantees

The opening layout must satisfy:

- Origin star is M-dwarf, at `d < 20`, reserve forced to exactly `1400`
- Exactly one G-type within `60–95 lu` of origin
- At least one rocky remnant within `85 lu` of origin
- No isotope source within `140 lu` of origin (isotopes must feel like a discovery)
- At least 4 stars within initial scan range

**Satisfy these constructively, not by resampling whole clusters.** The joint
probability of hitting all five by chance is around 3%, and the origin clause is far
worse than that on its own: with a 35 lu minimum separation and a rim-weighted radial
distribution, a random cluster has no star at all within 20 lu of (0,0) roughly 90% of
the time. Rejection sampling here is somewhere between wasteful and non-terminating.

Place them in this order:

1. Origin at exactly (0,0). Force class M-dwarf, `reserve = 1400`, tier 1, hub.
2. One G-type at a seeded random angle, radius uniform in `60–95 lu`.
3. One rocky remnant at a seeded random angle, radius uniform in `45–85 lu`,
   respecting the 35 lu separation.
4. The remaining `starCount − 3` stars by § Star placement.
5. Assign classes by § Class assignment, but re-roll any isotope class landing inside
   `140 lu`. After 8 failed re-rolls take the highest-weight non-isotope class instead.
6. Assert the G-type and scan-range clauses. If either fails, resample only the
   remaining stars from step 4 — never steps 1–3.

Determinism is unaffected: every step draws from the same seeded PRNG in a fixed
order, so a seed still reproduces a cluster exactly.

This replaces a tutorial. The first 15 minutes are authored through the layout.

---

## 2. Link tiers

| Tier | Bandwidth (u/s) | Speed (lu/s) | Cost mult | Cost currency |
|---|---|---|---|---|
| I | 3 | 8 | 1.0 | metals |
| II | 9 | 14 | 3.5 | alloy |
| III | 26 | 22 | 12 | alloy |
| IV | 70 | 34 | 40 | alloy |

```
buildCost(len, tier) = 0.9 * len^1.2 * tierCostMult[tier]
latency(len, tier)   = len / tierSpeed[tier]
upgradeCost(a → b)   = (buildCost(len,b) - buildCost(len,a)) * 1.25
dismantleRefund      = 0.4 * buildCost(len, currentTier)
```

Worked examples — a 150 lu trunk:

| Tier | Cost | Latency |
|---|---|---|
| I | 368 metals | 18.8 s |
| II | 1,287 alloy | 10.7 s |
| III | 4,413 alloy | 6.8 s |
| IV | 14,710 alloy | 4.4 s |

(An earlier version of this table read 389 / 1,362 / 4,670 / 15,566, which is the same
curve at a coefficient of 0.9515. The formula above is authoritative; the table is
derived from it.)

**Latency is the headline.** A four-hop tier-I chain to the frontier is a ~75-second
one-way trip. Upgrading that chain to tier III cuts it to 27 seconds and the network
visibly comes alive. Make sure the UI communicates round-trip time so the player
feels this upgrade rather than just reading a bigger number.

---

## 3. Node tiers

| Tier | Ports | Buffer per resource (u) | Recipe slots (hub only) | Upgrade cost (alloy) |
|---|---|---|---|---|
| 0 | 2 | 200 | 1 | — |
| 1 | 3 | 700 | 1 | 60 |
| 2 | 4 | 2,400 | 2 | 204 |
| 3 | 5 | 8,000 | 3 | 694 |
| 4 | 7 | 26,000 | 4 | 2,358 |

```
nodeUpgradeCost(t) = 60 * 3.4^t        // cost to go from t to t+1
hubDesignateCost   = 250 * 2.6^(hubsPurchased)     alloy
hubPortBonus       = +2
hubBufferMult      = 4.0
hubUndesignateRefund = 0.5

capacity(star, r)  = tierBuffer[star.tier] * bufferMult(k) * (isHub ? hubBufferMult : 1)
BUFFER_DRAWDOWN_SECONDS = 5
```

`hubsPurchased` counts hubs the player has **paid for**. The origin hub is granted free
at run start and does not count, so the second hub in the network is the first purchase
and costs 250 alloy. At one alloy slot's 0.25/s from first alloy at 0:14 that lands
around 0:31, against § 10's 0:35 target. Counting the free hub would make it 650 alloy
and ~0:57, missing the target by twenty-odd minutes.

`capacity` is per resource, not shared across resources. `BUFFER_DRAWDOWN_SECONDS` is
the flow parameter from `MECHANICS.md` § Routing solve: a standing buffer offers its
contents to downstream links over roughly this many seconds rather than all at once.
Lower makes the network twitchier and pins links to bandwidth more readily; higher
makes buffers sluggish to clear after a stall.

Hub cost scaling on `hubsPurchased` is load-bearing: it means promoting a frontier hub
is a real decision, and un-designating a stranded interior hub to afford it is a
legitimate and satisfying play.

---

## 4. Recipes

| Recipe | Inputs | Output | Cycle (s) | Effective rate |
|---|---|---|---|---|
| Alloy | 3 metals + 2 hydrogen | 1 alloy | 4 | 0.25 alloy/s per slot |
| Catalyst | 2 isotopes + 5 hydrogen | 1 catalyst | 6 | 0.167 catalyst/s per slot |
| Lattice core | 4 alloy + 3 catalyst | 1 core | 20 | 0.05 core/s per slot |

Sustained input demand per slot:

- Alloy slot: 0.75 metals/s + 0.5 hydrogen/s
- Catalyst slot: 0.333 isotopes/s + 0.833 hydrogen/s
- Core slot: 0.2 alloy/s + 0.15 catalyst/s → needs 0.8 alloy slots and 0.9 catalyst slots

Note that a tier-I link (3 u/s) comfortably feeds one alloy slot but a core chain
needs several slots feeding it, which forces the player onto tier II trunks around
the 1-hour mark. That's the intended gate into phase 2.

---

## 5. Upgrades within a run

```
extractionGlobal(k)  = 1 + 0.12*k          cost: 90 * 1.55^k  catalyst
extractionStar(k)    = 1 + 0.25*k          cost: 40 * 1.9^k   catalyst,  max k=4
bufferMult(k)        = 1.6^k               cost: 120 * 2.1^k  catalyst
scanRange(k)         = 130 + 34*k   (lu)   cost: 70 * 1.75^k  catalyst
```

Initial scan range: **130 lu**. Initial stockpile: **300 metals, 0 everything else**.
Player starts with the origin star claimed, tier 1, designated as a hub, with one
alloy recipe slot, and no links.

---

## 6. Collapse

```
collapseUnlockAt = 25 lattice cores produced (lifetime, this run)
charts(totalCores) = floor(3 * totalCores^0.55)
```

| Cores at collapse | Charts |
|---|---|
| 25 | 17 |
| 60 | 28 |
| 100 | 37 |
| 250 | 62 |
| 500 | 91 |

(An earlier version of this table read 39 / 67 / 97 for the last three rows, which no
single exponent produces. The formula is authoritative; these are its output.)

The exponent `0.55` is chosen so that pushing a run twice as far yields roughly 1.46×
the charts — enough that overextending is rewarded, not enough that it's ever correct
to grind a single run indefinitely. Do not raise it above 0.65.

---

## 7. Chart tree

Full node list in `CONTENT.md`. Budget: **27 nodes, costs 2–45 charts, total 372**,
so a player is roughly 7–8 collapses from clearing it. Cumulative awards along the § 10
pacing targets run about 17 / 45 / 82 / 132 / 194 / 271 through collapse 6.

Clearing the tree therefore runs past the "5–6 hours to see everything" line in § 10.
That is acceptable — the last nodes are refinements, not new problems — but do not
claim the tree completes inside the content window. Effects are drawn from:

```
+X% extraction          (several tiers)
+1 port on all stars    (expensive, twice only)
+X% link bandwidth
+X% link speed
starting stockpile grants
starting scan range
-X% hub designation cost
unlock: routing profiles      12 charts   ← gate this at ~first collapse
unlock: bulk throttle         6 charts
unlock: wormholes             30 charts + prerequisites, 68 all in
unlock: link tier IV          18 charts
```

`Routing profiles` at 12 charts means a player who reaches the first collapse at 17
charts can afford it immediately but at the cost of everything else. Good tension for
a first prestige decision.

**Wormholes cost more than their sticker price.** `CONTENT.md` gates `Folded space`
behind one node from each branch at cost ≥11, whose cheapest satisfying set is Deep
survey III (11) + Phase alignment II (13) + Salvage protocol (14) = 38. Wormholes are
therefore 68 charts of committed spend, against ~82 cumulative by collapse 3 — tight,
but reachable there, which is what § 10's `~5:30 total` needs.

The threshold is 11 rather than a rounder number because the Extraction branch has no
node between 11 and 24. Any threshold from 12 to 24 forces Deep survey IV and pushes
the true cost to 81+, which does not fit before collapse 4.

---

## 8. Offline resolution

**Do not replay ticks.** While the player is away, the network is a static flow graph
with piecewise-constant behaviour. Solve analytically.

```
resolveOffline(state, elapsed):
  if elapsed < offlineClosedFormMinSeconds:
    return tickNormally(state, elapsed)        // see below
  flushInFlightSegments(state)
  t = 0
  events = 0
  while t < elapsed and events < 400:
    flows = solveFlows(state)                  // steady-state rates
    dtNext = min(
      timeUntilNextStarDepletes(state, flows),
      timeUntilNextBufferFills(state, flows),
      timeUntilNextBufferEmpties(state, flows),
      elapsed - t
    )
    advanceAnalytically(state, flows, dtNext)  // closed form over the interval
    recordVenting(state, flows, dtNext)        // per star, per resource, per interval
    t += dtNext
    events++
  if events hit the cap:
    finish the remainder with coarse 60s ticks
```

```
offlineClosedFormMinSeconds = 120
```

**Short absences run as real ticks.** Closed-form resolution ignores latency, which is
correct over hours and wrong over minutes: a four-hop tier-I chain is ~75 s one way, so
discarding it across a 10-minute absence misstates that path's delivery by over 10% —
past the ±1% agreement `ROADMAP.md` Phase 2 asks for, and visible in Phase 3's
tab-closed-for-10-minutes check. Below the threshold, tick normally; 120 s at 10 Hz is
1,200 ticks and costs microseconds.

`recordVenting` accumulates `{ starId, resource, seconds, amount }` per interval. The
arrival summary in `CONTENT.md` has to name the specific cause of a vent, and that is
impossible to reconstruct after the fact — the totals alone cannot say which star was
losing material or for how long.

Each interval is linear in every quantity, so `advanceAnalytically` is arithmetic,
not iteration. A full 12-hour absence should resolve in single-digit milliseconds.

Measured on a 40-star cluster with 39 links: **98 intervals, 6.4 ms** for twelve hours,
and the interval count barely moves between a one-hour and a twelve-hour absence — the
work scales with regime changes, not with elapsed time, which is the whole point.

`solveFlows` here is a **steady-state** solve, not the per-tick one. Process stars in
decreasing hop-distance order: that is a topological order for the default routing, since
flow only ever descends the hop gradient, so a single pass propagates inflow exactly. Each
star's forwardable rate is its extraction plus its inflow plus any standing backlog, links
are clamped to bandwidth as they are visited, and the clamped rate becomes the downstream
star's inflow.

Three things end an interval, and they are the only three:

- a star's reserve reaches zero
- a buffer reaches capacity and starts venting
- a buffer empties, dropping any recipe drawing on it to its inflow-limited rate

A depletion that lands mid-interval must move the ledger and the buffer by the *same*
amount — the material actually mined, not `rate * dt`. Using one for each loses material at
every depletion, and the conservation test catches it immediately.

Latency during offline resolution is ignored for material already in flight beyond
the first interval — the steady-state flow already accounts for throughput, and
transit delay is irrelevant over hours. Do flush in-flight segments into their
destination buffers at the start of resolution.

```
offlineCap = 14 hours
offlineEfficiency = 1.0     // no offline penalty. Ever.
```

---

## 9. Number ceiling

Peak expected values after 6 collapses: lattice cores in the low tens of thousands,
alloy in the low millions, lifetime extraction in the low billions. All comfortably
inside float64. **Do not add a big-number library.** If a future balance pass pushes
past 1e15, the correct fix is to flatten the curves, not to add BigInt.

Growth is deliberately additive-and-polynomial rather than exponential. This game's
depth comes from topology, not from digit count.

---

## 10. Pacing targets

These are the actual spec. If the constants above don't produce these, change the
constants.

| Milestone | Target time |
|---|---|
| First link built | 0:01 |
| First star runs dry | 0:12–0:18 |
| First metals flowing | 0:08 |
| First alloy produced | 0:14 |
| Second hub designated | 0:35 |
| First isotopes reached | 0:50 |
| First catalyst produced | 0:58 |
| First lattice core | 1:20 |
| Forced to abandon/re-thread the interior | 1:45–2:10 |
| 25 cores — collapse available | 2:50–3:15 |
| Player actually collapses | 3:00–3:40 |
| Second run reaches 25 cores | 1:10 into run 2 |
| Wormholes unlocked | ~5:30 total |

Second-run acceleration should be roughly **2.6×**. Faster than that and the chart
tree feels overpowered; slower and prestige feels punishing.

Target for "the game has shown you everything it has": **5–6 hours.** Content beyond
that is repetition of the wormhole-era loop with bigger clusters, which is fine and
expected for the genre, but nothing new should be promised past hour 6.
