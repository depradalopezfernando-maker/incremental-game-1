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

Poisson-disc sampling within `clusterRadius`, minimum separation `35 lu`. Reject and
resample rather than allowing clumps — clumped stars make the map unreadable and
make port limits meaningless.

Density should fall off with distance so the frontier feels sparse:
sample radius as `clusterRadius * sqrt(u) ^ 0.85` for uniform `u`, which biases
slightly outward from a uniform-area distribution.

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
baseYield = 1.0 * (1 + d/200)      * classYieldMult
```

Class multipliers:

| Class | reserveMult | yieldMult |
|---|---|---|
| M-dwarf | 1.35 | 0.75 |
| G-type | 0.85 | 1.60 |
| Rocky remnant | 1.00 | 1.00 |
| Heavy remnant | 0.70 | 0.85 |
| Neutron star | 0.45 | 2.40 |
| Binary | 1.10 | 1.30 (per output, two resources) |

Resulting lifetimes at 100% throttle, no upgrades, run 1:

| d (lu) | reserve | yield | lifetime |
|---|---|---|---|
| 0 | ~900 | 1.00 | ~15 min |
| 100 | ~2,870 | 1.50 | ~32 min |
| 250 | ~7,700 | 2.25 | ~57 min |

Near stars die inside the first session; far stars survive an hour. This gradient
*is* the outward pressure. If playtesting says phase 1 feels too frantic, raise the
`900` base rather than flattening the exponent.

### Seed guarantees

The generator must guarantee, by resampling until satisfied:

- Origin star is M-dwarf, `d < 20`, and its reserve is forced to exactly `1400`
- Exactly one G-type within `60–95 lu` of origin
- At least one rocky remnant within `85 lu` of origin
- No isotope source within `140 lu` of origin (isotopes must feel like a discovery)
- At least 4 stars within initial scan range

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
| I | 389 metals | 18.8 s |
| II | 1,362 alloy | 10.7 s |
| III | 4,670 alloy | 6.8 s |
| IV | 15,566 alloy | 4.4 s |

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
| 4 | 7 | 26,000 | 4 | 2,360 |

```
nodeUpgradeCost(t) = 60 * 3.4^t        // cost to go from t to t+1
hubDesignateCost   = 250 * 2.6^(hubsOwned)     alloy
hubPortBonus       = +2
hubBufferMult      = 4.0
hubUndesignateRefund = 0.5
```

Hub cost scaling on `hubsOwned` is load-bearing: it means promoting a frontier hub
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
| 100 | 39 |
| 250 | 67 |
| 500 | 97 |

The exponent `0.55` is chosen so that pushing a run twice as far yields roughly 1.46×
the charts — enough that overextending is rewarded, not enough that it's ever correct
to grind a single run indefinitely. Do not raise it above 0.65.

---

## 7. Chart tree

Full node list in `CONTENT.md`. Budget: **~28 nodes, costs 2–45 charts, total ~340**,
so a player is roughly 5–6 collapses from clearing it. Effects are drawn from:

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
unlock: wormholes             30 charts   ← reachable around collapse 3
unlock: link tier IV          18 charts
```

`Routing profiles` at 12 charts means a player who reaches the first collapse at 17
charts can afford it immediately but at the cost of everything else. Good tension for
a first prestige decision.

---

## 8. Offline resolution

**Do not replay ticks.** While the player is away, the network is a static flow graph
with piecewise-constant behaviour. Solve analytically.

```
resolveOffline(state, elapsed):
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
    t += dtNext
    events++
  if events hit the cap:
    finish the remainder with coarse 60s ticks
```

Each interval is linear in every quantity, so `advanceAnalytically` is arithmetic,
not iteration. A full 12-hour absence should resolve in single-digit milliseconds.

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
