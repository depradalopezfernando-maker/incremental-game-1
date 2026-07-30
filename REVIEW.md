# Lightlace — design document review

> **Status: resolved.** All findings below have been applied to the authority docs —
> see § G for the edit-by-edit record. Three decisions were made by the project owner:
> rate-based flow (A1), link cost coefficient `0.9` with the table corrected (B1), and
> the free origin hub not counting toward hub cost scaling (D10). Two questions remain
> open in `OPEN_QUESTIONS.md`; neither blocks Phase 1.
>
> This document is kept as the record of *why* the docs say what they now say. It is not
> a live task list.

Review of `DESIGN.md`, `MECHANICS.md`, `BALANCE.md`, `CONTENT.md`, `UI.md`, `ROADMAP.md`
as of commit `edc7a4c`. No code existed yet, so everything here is a documentation
finding: contradictions between docs, numbers that didn't reproduce, and gaps that
`src/sim/types.ts` and `flow.ts` could not be written without resolving.

Findings are ordered by whether they block Phase 1, not by how interesting they are.

**Summary.** The design is unusually coherent for a first pass — the three constraints
genuinely do generate the phase structure, and most of the balance tables reproduce
from their own formulas. Two things need a decision before any simulation code is
written: the flow model in `MECHANICS.md` § 3 is mathematically incompatible with the
offline solver in `BALANCE.md` § 8, and there is no defined answer to where spendable
material lives. Four numbers don't reproduce. One generator rule is close to
impossible to satisfy the way the doc says to satisfy it.

---

## A. Blocks Phase 1

### A1. The flow model and the offline solver contradict each other

`MECHANICS.md` § 3 defines desired flow as:

```
desired(link, r) = sourceBuffer[r] available this tick, split by weight
```

This is a **buffer-drain** model: the rate is whatever is in the buffer divided by the
tick. `BALANCE.md` § 8 then asks for a solver over intervals of piecewise-constant
**steady-state rates**, bounded by `timeUntilNextBufferEmpties`.

These cannot both hold. Under buffer-drain:

- Every buffer with material in it empties within one tick, so `solveFlows` has no
  steady state to return and `timeUntilNextBufferEmpties` is always ≈ one tick. The
  400-event cap is exhausted in 40 seconds of game time and every offline resolution
  falls through to the coarse-tick fallback — which is exactly the failure mode
  architecture rule 4 exists to prevent.
- The rate depends on `dt`. At 10 Hz a buffer holding 30 u wants to move 300 u/s; at
  1 Hz it wants 30 u/s. Both get clamped to bandwidth, so in practice **every link
  with anything upstream runs at exactly full bandwidth**, which erases the utilisation
  gradient `UI.md` asks the renderer to draw (0.25 idle → 1.0 saturated), makes the
  ≥98 %-for-5s saturation tint fire on essentially every active link, and makes
  "throttle extraction to match bandwidth" (`DESIGN.md`) a non-choice.
- `dt`-dependence also breaks the permanent 6-hour CI test in `ROADMAP.md`
  § Testing discipline. That test can only run inside the 10-second suite budget at a
  coarse `dt`, and a coarse `dt` gives different results than 10 Hz.

**Recommendation.** Make link flow rate-based and `dt`-independent:

```
supply(star, r)    = extraction rate + arriving rate + buffer drawdown allowance
desired(link, r)   = weight(link, r) * supply(source, r), capped by buffer contents/dt
rate(link)         = scale all resources down proportionally by weight if
                     sum(desired) > bandwidth       // unchanged contention rule
```

The buffer becomes a reservoir that smooths supply, not the quantity that sets the
rate. The contention rule in `MECHANICS.md` — the load-bearing part, the reason adding
a source to a busy trunk degrades everything on it — survives untouched. The solver in
§ 8 then has a real steady state, and a 12-hour resolve is a few dozen intervals.

This is the single most important open item in the doc set and it sits directly on the
Phase 1 critical path.

### A2. Nothing defines where spendable material lives

`MECHANICS.md` § 1 puts all material in per-star `buffer` records. `UI.md` § Resource
bar shows six global stockpiles. `BALANCE.md` § 5 says "Initial stockpile: 300 metals".
Link costs are "paid in metals", node upgrades cost alloy, extraction upgrades cost
catalyst — and no doc says which buffer a purchase debits.

Three readings, and they produce different games:

1. The resource bar is the **network-wide sum** of all buffers; a purchase debits stars
   holding that resource, nearest-first. Co-location constrains refining only.
2. A **separate global pool** that refined and mined output flows into.
3. A purchase draws **from one star's buffer** — you route alloy to where you want
   to build.

**Recommendation: (1).** It adds no state, keeps the co-location constraint doing the
one job `MECHANICS.md` § 4 wants it to do, and makes the starting 300 metals simply
the origin star's opening buffer. (2) quietly breaks the fiction that material has a
location and makes a full buffer irrelevant to your ability to spend. (3) is the most
thematically consistent and adds a whole logistics burden no doc mentions — it is a
design change, not a clarification.

Whichever is chosen, `UI.md` § Resource bar needs a sentence saying what the number is.

### A3. The seed guarantees cannot be met by resampling

`BALANCE.md` § Seed guarantees says "the generator must guarantee, by resampling until
satisfied". With the § Star placement distribution, the joint probability is roughly
3 %, and one clause is far worse than that.

Radial sampling is `r = clusterRadius * sqrt(u)^0.85 = R·u^0.425`, so the expected
count inside radius `x` is `40·(x/260)^2.353`. Run 1:

| Clause | Expected stars in range | P(clause) |
|---|---|---|
| Origin M-dwarf, `d < 20` | **0.10** | ~4 % (needs a star to exist there at all) |
| Exactly one G-type in 60–95 lu | 2.5 | ~33 % |
| ≥1 rocky remnant within 85 lu | 2.9 | ~51 % |
| No isotope source within 140 lu | 9.3 | ~22 % |
| ≥4 stars within 130 lu | 7.8 | ~93 % |

The origin clause is the killer: with a 35 lu minimum separation and an
outward-biased radial distribution, a random cluster has **no star at all** within
20 lu of (0,0) about 90 % of the time. Resampling whole clusters to hit that is
between wasteful and non-terminating.

**Recommendation.** Make the guarantees **constructive**, in this order, and delete
"by resampling until satisfied":

1. Place the origin star at (0,0) explicitly, force class M-dwarf and `reserve = 1400`.
2. Place one G-type at a seeded random angle, radius uniform in 60–95 lu.
3. Place one rocky remnant, radius uniform in 45–85 lu, respecting separation.
4. Poisson-disc the remaining `starCount - 3` stars around those.
5. Assign classes by the § Class assignment weights, but re-roll any isotope class
   inside 140 lu (bounded retries, then fall back to the next-highest-weight
   non-isotope class).
6. Assert the "exactly one G-type in 60–95 lu" and "≥4 within scan range" clauses and
   resample only the *remaining* stars if they fail.

Same authored opening, deterministic cost, and the "same seed → byte-identical
cluster" acceptance test in `ROADMAP.md` Phase 1 still holds.

### A4. The placement formula makes the frontier denser, not sparser

`BALANCE.md` § Star placement states the intent — "density should fall off with
distance so the frontier feels sparse" — and then gives a formula that does the
opposite.

With `r = R·u^a`, areal density scales as `r^(1/a - 2)`. At `a = 0.425` that is
`r^0.353`: density **rises** with radius. A star at 250 lu sits in a neighbourhood
about 1.8× denser than one at 50 lu. The doc's other claim in that paragraph — that
this "biases slightly outward from a uniform-area distribution" — is correct about
each sample's radius, but outward bias in radius *is* rim-heavy density. The two
sentences can't both serve the stated goal.

For density to fall off you need `a > 0.5`.

**Recommendation.** `a = 0.667` (i.e. `sqrt(u)^1.33`), giving density `∝ r^-0.5`. This
also makes A3's near-origin clauses much easier — expected stars within 85 lu goes
from 2.9 to 7.5 — though the origin still needs constructive placement, and the
isotope-free clause gets *harder* (more stars inside 140 lu), which is one more reason
to re-roll class rather than resample position.

Note also that § Star placement names two different algorithms in two sentences:
"Poisson-disc sampling within clusterRadius" (which is uniform by construction) and a
biased radial sample. The intended algorithm is presumably biased dart-throwing with
rejection on the 35 lu minimum separation. Worth saying so.

---

## B. Numbers that don't reproduce

### B1. Link cost table disagrees with its own formula (~5.7 % high)

`buildCost(len, tier) = 0.9 * len^1.2 * tierCostMult`. At 150 lu, `0.9 · 150^1.2 = 368`,
not the 389 in the table. The rest of the table is internally consistent with 389
(389 × 3.5 = 1,362 ✓, × 12 = 4,670 ✓, × 40 = 15,566 ✓), so the table was built with a
coefficient of **0.9515**, not 0.9.

| Tier | Doc | From the formula |
|---|---|---|
| I | 389 metals | 368 metals |
| II | 1,362 alloy | 1,288 alloy |
| III | 4,670 alloy | 4,415 alloy |
| IV | 15,566 alloy | 14,716 alloy |

Latencies in that table are all correct.

**Recommendation.** Keep `0.9` in `constants.ts` and correct the worked examples. The
formula is what ships; 5.7 % has no pacing consequence and round numbers in a doc are
worth less than one source of truth. (This is worth deciding rather than assuming,
because it lands on the tightest budget in the game: the opening 300 metals buys one
~85 lu link either way, but the margin for a second short link differs.)

Everything else in §§ 2–6 does reproduce: `nodeUpgradeCost(t) = 60·3.4^t` gives
60 / 204 / 694 / 2,360 ✓; the reserve/yield lifetime table at d = 0/100/250 gives
900/2,847/7,643 u and 15/32/57 min ✓; recipe input demands and the "core slot needs
0.8 alloy slots and 0.9 catalyst slots" derivation ✓; `charts(totalCores)` gives
17/28/39/67/97 ✓.

### B2. Chart tree totals 372, not ~340

Summing `CONTENT.md` § Chart tree: Extraction 72, Infrastructure 173, Control 97,
Folded space 30 → **372 charts across 27 nodes**. `CONTENT.md` says "~342" (which is
372 minus Folded space) and `BALANCE.md` § 7 says "~28 nodes, total ~340".

Consequence: `BALANCE.md`'s "roughly 5–6 collapses from clearing it" doesn't hold.
Cumulative awards along the § 10 pacing targets run something like 17 + 28 + 39 + 50 +
67 + 80 ≈ 281 by collapse 6, so clearing 372 takes closer to **7–8 collapses** — which
also sits past the "the game has shown you everything it has: 5–6 hours" claim in § 10.

**Recommendation.** Pick one: state 372 and say 7 collapses, or trim ~30 charts of
node cost. Either way the two docs should quote the same figure.

### B3. Wormholes are not reachable at collapse 3

`BALANCE.md` § 7 lists "unlock: wormholes 30 charts ← reachable around collapse 3".
`CONTENT.md` gates Folded space behind "one node from each branch at cost ≥20", whose
cheapest satisfying set is Deep survey IV (24) + Wider conduits III (22) + Parallel
refining (20) = 66. So wormholes cost **96 charts of committed spend**, not 30.

Cumulative charts by collapse 3 is roughly 17 + 28 + 39 = 84 < 96, and that assumes
buying *nothing else for three collapses*.

**Recommendation.** Lower the prerequisite threshold to ≥13 (which admits Phase
alignment II at 13, Deep survey III at 11 — cheapest set 11 + 13 + 14 = 38, total 68),
or drop Folded space to 24, or restate the target as collapse 4. § 10's "wormholes
unlocked ~5:30 total" is consistent with collapse 3 timing, so the chart budget is the
part that needs to move.

### B4. Nothing in the docs produces the 2.6× second-run acceleration

§ 10 sets second-run acceleration at 2.6× (run 1 to 25 cores at ~3:00, run 2 at 1:10)
and calls it the spec. The available mechanisms don't get close:

- Chart effects are almost all +8 % to +18 %. A first collapse awards 17 charts —
  enough for, say, Routing profiles (12) + Deep survey I (2) + Flow readouts (3), which
  is +8 % extraction and two convenience unlocks.
- `richnessMult = 1.45^n` multiplies **`reserve` only**. `baseYield` has no `n` term at
  all, so run-2 stars hold 45 % more material but produce it at the same rate. Richer
  reserves extend star lifetimes; they do not raise throughput, and throughput is what
  produces cores.
- The larger radius helps a little via `baseYield = 1.0·(1 + d/200)` — max yield 2.75
  at 350 lu vs 2.30 at 260 lu, so ~+20 % at the frontier.
- Starting grants (Prospector's start, 9 charts) compress the opening minutes but
  don't scale the run.

Realistically that's 1.3–1.5×, with the rest having to come from player knowledge.

**Recommendation.** Apply richness to yield as well —
`baseYield = 1.0 · (1 + d/200) · classYieldMult · richnessMult^0.5` or a separate
`yieldMult = 1.2^n` — which is a one-constant change in `constants.ts` and makes later
clusters genuinely faster rather than merely longer-lived. Otherwise 2.6× should be
restated as aspirational, and `ROADMAP.md` Phase 4's acceptance criterion ("second run
reaches 25 cores roughly 2.6× faster") will fail as written.

### B5. The Phase 1 conservation identity is not true as written

`ROADMAP.md` Phase 1 acceptance: `extracted == delivered + inTransit + vented`. Once
refining exists — and it's in the same phase's scope — this is false: the alloy recipe
destroys 3 metals and 2 hydrogen per cycle, and there is no term for that.

**Recommendation.** Restate per raw resource:

```
extracted[r] == inBuffers[r] + inTransit[r] + vented[r] + consumedByRecipes[r]
```

and track `consumedByRecipes` and `producedByRecipes` in run stats — they're wanted for
the arrival summary anyway. Worth fixing in the doc because it's an acceptance
criterion someone will implement literally.

---

## C. Design-level tensions

### C1. `Standing orders` deletes the ritual the design is built on

`DESIGN.md` § Why it fits bursty play makes the session shape the core pleasure:
"arrive, re-weight for live, play, re-weight for long-haul, leave. Two deliberate
rituals bracketing the fun." `CONTENT.md` then sells **Standing orders** for 9 charts:
"Profiles can auto-switch on tab blur/focus" — which automates away both rituals,
permanently, for the price of the third-cheapest node in the tree.

It also sits right on the line drawn by `MECHANICS.md` § Non-mechanics ("automation
that routes for the player... must never make routing decisions"). Defensible reading: the player
authored both profiles and the trigger, so no decision is being made for them. But the
cost isn't the rule, it's that the game's stated best moment becomes opt-out.

`ROADMAP.md` § What to ask about rather than guess lists exactly this ("anything that
makes routing decisions on the player's behalf") as something to bring back rather
than decide. **Flagging, not resolving.** If it stays, it should probably be
late and expensive rather than 9 charts.

### C2. Phase 2 needs hydrogen to flow *outward*, and the defaults fight it

Catalyst is 2 isotopes + 5 hydrogen, refined at a hub. Isotopes are frontier-weighted
and guaranteed absent within 140 lu, so the catalyst hub is necessarily outward — and
it needs 0.833 hydrogen/s shipped **away** from the core, against the direction every
flow has moved for the first 35 minutes.

Default routing weights are "even split across links that lead toward a hub". With a
frontier hub designated, "toward a hub" becomes ambiguous (nearest hub? any hub?), and
under the most likely reading — nearest — core hydrogen keeps going to the origin and
the new hub starves.

This is a genuinely good moment: the network's polarity reverses and the player has to
notice. But nothing in the docs acknowledges it, and it's the first thing after the
opening that the layout doesn't teach. Worth a line in `MECHANICS.md` § Routing solve
about which hub the default targets, and worth knowing this is where players will get
stuck around 0:50.

### C3. Recipe slots have two acquisition paths and no stated hierarchy

Slots come from hub designation (`250·2.6^hubsOwned` alloy) and from node tier
(`60·3.4^t` alloy, hub only). At the second slot these cost 250 vs 204 — near
identical — but the hub curve is steeper (2.6× vs 3.4× per step, from a 4× higher
base), so which path dominates flips somewhere in the middle and neither doc says
which behaviour is intended. Not a contradiction; a balance question that will decide
whether phase 2 is about tall hubs or many hubs.

### C4. The 14-hour offline cap versus "never punish the player for being away"

`DESIGN.md` says never punish, `BALANCE.md` sets `offlineCap = 14 hours` with
`offlineEfficiency = 1.0`. A player away 24 hours loses 10 hours of production. This is
the standard genre compromise and almost certainly right, but the copy should say it
plainly — the arrival summary already has the voice for it
(`Away 24h 10m · 14h resolved (maximum)`), and silently discarding the remainder is the
one place the game would be quietly dishonest with the player.

---

## D. Underspecified — needed for `types.ts` and `tick.ts`

Each of these has a simplest-option default that I'd implement and log in
`OPEN_QUESTIONS.md` per `CLAUDE.md`, rather than inventing a system.

| # | Gap | Default I'd take |
|---|---|---|
| D1 | **No `GameState` shape is documented anywhere.** `MECHANICS.md` § 1 defines `Star`, § 2 defines `Link`, and step 6 references `run.vented[r]` — but nothing defines the run/meta split (seed, `collapseCount`, elapsed, charts, purchased nodes, unlocked recipes, profiles, stats). Phase 1's first deliverable is "full state shape". | Define it in `types.ts` as `{ meta, run }`, with `meta` = everything that survives collapse; append a § to `MECHANICS.md`. |
| D2 | **Recipe cycle semantics.** § 4 says a slot "runs a cycle only if all inputs are present"; `BALANCE.md` § 4 gives continuous "effective rate"s. Discrete 4 s all-or-nothing batches don't survive closed-form offline resolution. | Continuous rate-based consumption with fractional progress. Cycle time becomes presentation. |
| D3 | **Output buffer full.** Undefined whether a slot stalls or produces into the void. | Stall without consuming inputs. Venting stays step 6 only, i.e. extraction overflow. UI must distinguish "starved" from "backed up" — `MECHANICS.md` § Stalling is visible only covers the missing-input case. |
| D4 | **Recipe unlock conditions.** Player starts with an alloy slot; nothing says how catalyst and lattice core unlock, though "unlocked recipes" persist across collapse. | Unlock a recipe the first time the network holds ≥1 of each input. Catalyst on first isotopes, core on first alloy + catalyst. Persistent flag. |
| D5 | **Cycles in the flow graph.** Links are bidirectional; nothing forbids A→B→A churn burning bandwidth forever. | Default weights point only at strictly-decreasing hop-distance-to-hub, so no cycle forms by default; player-set weights may create one and that's their business. |
| D6 | **Link upgrade and in-flight segments.** § Upgrading says upgrading is instantaneous and doesn't interrupt flow; latency drops. Do queued segments arrive sooner? | No — segments keep the `arrivesAt` they were dispatched with. |
| D7 | **Buffer capacity formula.** Three multipliers exist (node tier table, `bufferMult(k) = 1.6^k`, `hubBufferMult = 4.0`) and no doc composes them. | `capacity(star) = tierBuffer[tier] · 1.6^k · (isHub ? 4 : 1)`, per resource. |
| D8 | **Binary stars.** `BALANCE.md` says `hydrogen×2` with yieldMult "1.30 (per output, two resources)"; `CONTENT.md` says `hydrogen ×2`; `MECHANICS.md` gives `Star` a single `resource`. Phase 6 content, but it shapes `types.ts` now. | Single resource (hydrogen) at 2 × 1.30 effective yield. Keeps `Star.resource` scalar; no multi-output concept in Phase 1. |
| D9 | **Wormhole anchors have `resource: none`,** which isn't in the `Resource` union — and they consume "two ports at each end". A tier-0 anchor has 2 ports, both eaten by the wormhole, leaving none for the feeder link that claimed it. Anchors need ≥3 ports to be usable at all. | Model as `resource: null` in a discriminated union; give anchors a minimum tier of 1 at generation, or a `+2` port bonus like hubs. Needs a decision before Phase 6. |
| D10 | **`hubDesignateCost = 250·2.6^hubsOwned`** — does the free starting origin hub count? At 0.25 alloy/s from first alloy at 0:14, `hubsOwned = 0` → 250 alloy → ~0:31, hitting the 0:35 target. `hubsOwned = 1` → 650 alloy → ~0:57, missing it by 22 minutes. | Count purchased hubs only. |
| D11 | **Rate display smoothing.** `UI.md` shows net rates everywhere and mandates tabular figures against jitter, but at 10 Hz with discrete recipe output an instantaneous rate is pure noise. | EMA over ~2 s for all displayed rates. |
| D12 | **Sub-unit stockpiles.** "Below 10,000: integer with thousands separators" renders 0.6 catalyst as `1` or `0`. Also `999,999` renders as `1000.0K` — five significant figures, violating the same section's 4-sig-fig rule, and it should roll to `1.00M`. | One decimal below 10, integer to 9,999, `K` from 10,000, roll to `M` at 999,950. |
| D13 | **Default `throttle`** is never stated. | 1.0. |
| D14 | **Offline vent attribution.** § 8's pseudocode tracks totals, but `CONTENT.md` § Arrival summary requires per-star causal attribution ("Hydrogen vented for 6h 20m — Bell-4 outbound link at capacity"). The interval solver must record per-interval, per-star vent duration and cause. | Accumulate `{ starId, resource, seconds, amount }` per interval during resolution. Cheap, and impossible to reconstruct afterwards. |

### D15. Short absences will fail the ±1 % offline test

`BALANCE.md` § 8 ignores latency and flushes in-flight segments to their destinations
at the start of resolution. Over hours that's noise, as the doc says. But
`ROADMAP.md` Phase 3 acceptance is "closing the tab for **10 minutes** and returning
produces correct state", and Phase 2 requires the offline result to match a
tick-by-tick reference **within 1 %**. A four-hop tier-I chain is ~75 s one way; over a
600 s absence, ignoring that is a ~12 % error on that path's delivered total.

**Recommendation.** Below a threshold (`offlineClosedFormMinSeconds = 120`), resolve by
real ticks — 120 s at 10 Hz is 1,200 ticks, microseconds of work. Above it, closed
form. State the threshold in § 8 so the ±1 % test knows which regime it's asserting.

---

## E. Verified consistent

Checked and reproduces, listed so these don't get re-litigated:

- `nodeUpgradeCost(t) = 60·3.4^t` → the 60 / 204 / 694 / 2,360 column ✓
- Reserve/yield lifetimes at d = 0 / 100 / 250 → 900 / 2,847 / 7,643 u, 15 / 32 / 57 min ✓
  (note the table is class-neutral — it excludes `classReserveMult`/`classYieldMult`, so
  it describes no actual star; the origin M-dwarf is 1,400 u at 0.75 u/s = 31 min)
- All four link latencies (18.8 / 10.7 / 6.8 / 4.4 s at 150 lu) ✓
- Recipe input demands, and "a core slot needs 0.8 alloy slots and 0.9 catalyst slots" ✓
- `charts(totalCores) = floor(3·totalCores^0.55)` → 17 / 28 / 39 / 67 / 97 ✓, and the
  stated 1.46× for double distance ✓
- Poisson-disc feasibility: 40 stars at 35 lu separation in a 260 lu radius uses ~25 %
  of hard-core capacity ✓; 124 stars at 800 lu is comfortable ✓
- Dismantle refund 0.4 ✓ consistent with `Salvage protocol`'s "40 % → 70 %"
- Chart tree cost range "2–45" ✓; `BALANCE.md` § 7's effect list matches `CONTENT.md`'s
  nodes one-for-one ✓
- Isotopes are reachable by 0:50 on the base 130 lu scan range without buying scan
  upgrades (claim a star at ~100 lu, reach to ~230 lu) ✓ — consistent with both the
  140 lu isotope exclusion and "isotopes must feel like a discovery"
- **The pacing anchor works.** The guaranteed G-type at 60–95 lu has reserve ≈ 1,540–2,406 u
  at 2.2 u/s → **11.7–18.2 min**, landing precisely on § 10's "first star runs dry
  0:12–0:18". The origin (31 min) and the rocky remnant (23–36 min) both outlive it. The
  seed guarantee is doing exactly the authoring job it claims to.
- Phase 1's perf budget is achievable: 30 simulated minutes at 10 Hz is 18,000 ticks in
  200 ms ≈ 11 µs/tick for 5 stars. `CLAUDE.md`'s "8 hours under a second" is 3.5 µs/tick
  and the 6-hour CI test tightens it further — both fine for an O(links) solve, but only
  if the flow model is `dt`-independent (see A1).
- Throttle being 0–1 does not contradict `DESIGN.md`'s "push extraction past
  sustainable rates" — 100 % throttle exceeding link bandwidth is the overdrive, and
  venting is the cost ✓
- Offline resolution ignoring latency is not a shortcut, it's **load-bearing**: it is
  precisely why the long-haul configuration optimises for zero waste rather than short
  paths, and why speed upgrades are a live-play reward. Worth stating as intent.

---

## F. Build-order note

`ROADMAP.md` Phase 4 ships "collapse: chart award, cluster regeneration, chart tree UI
and effects", but four of the tree's nodes unlock features scheduled for Phase 6
(Routing profiles, Standing orders, Folded space/wormholes) and one more —
`Parallel refining` — touches hub slots. A Phase 4 player will be able to buy
Routing profiles at 12 charts with nothing behind it.

Phase 4 should either hide unimplemented nodes or render them explicitly locked. The
`Routing profiles` gate is called out in `BALANCE.md` § 7 as tension for the first
prestige decision, so hiding it changes that moment — worth deciding rather than
discovering.

---

## G. Doc edits — applied

| Doc | Location | Change | Finding |
|---|---|---|---|
| `MECHANICS.md` | § 1 | `resource` admits `null` for anchors; `throttle` defaults to 1.0 | D9, D13 |
| `MECHANICS.md` | § Upgrading | In-flight segments keep their `arrivesAt` | D6 |
| `MECHANICS.md` | § Routing solve | Buffer-drain `desired()` replaced with the rate-based form, `supply()` and bounded `drawdown` | A1 |
| `MECHANICS.md` | § Default weights *(new)* | Hop-distance-to-nearest-hub default, BFS on topology change; no-cycle guarantee; the outward-hydrogen reversal stated as intentional | C2, D5 |
| `MECHANICS.md` | § 4 | Continuous consumption; starved vs backed-up stalls; recipe unlock rule | D2, D3, D4 |
| `MECHANICS.md` | § 7 | Anchors generate at minimum tier 1 and never produce | D9 |
| `MECHANICS.md` | § 9 *(new)* | `GameState` shape, meta/run split at the collapse boundary. Non-mechanics renumbered to § 10. | D1 |
| `BALANCE.md` | § Star placement | Exponent `sqrt(u)^0.85` → `sqrt(u)^1.33`; named one algorithm; recorded why the exponent must exceed 0.5 | A4 |
| `BALANCE.md` | § Seed guarantees | Six-step constructive sequence replaces "resampling until satisfied" | A3 |
| `BALANCE.md` | § Reserve and yield | `yieldMult = richnessMult^0.5` added to `baseYield`; lifetime table marked class-neutral and the two real early stars tabulated | B4 |
| `BALANCE.md` | § 2 | Worked examples → 368 / 1,288 / 4,415 / 14,716, with the old figures noted as coefficient 0.9515 | B1 |
| `BALANCE.md` | § 3 | `hubsOwned` → `hubsPurchased`; `capacity()` composition; `BUFFER_DRAWDOWN_SECONDS = 5` | D7, D10, A1 |
| `BALANCE.md` | § 7 | 27 nodes / 372 charts / 7–8 collapses, with the cumulative award curve; true wormhole cost | B2, B3 |
| `BALANCE.md` | § 8 | `offlineClosedFormMinSeconds = 120`; `flushInFlightSegments` and `recordVenting` in the pseudocode | D14, D15 |
| `BALANCE.md` | class table | Binary yieldMult wording — 1.30 applied twice, not two outputs | D8 |
| `CONTENT.md` | § Star classes | Binary is one resource at double yield; anchors are `null` and tier 1 | D8, D9 |
| `CONTENT.md` | § Chart tree | 372 charts / 27 nodes with branch subtotals; Folded space prerequisite ≥20 → **≥11** | B2, B3 |
| `CONTENT.md` | § Arrival summary | Capped-absence line | C4 |
| `UI.md` | § Resource bar | Stockpile defined as the network-wide sum of buffers; 2 s EMA on displayed rates | A2, D11 |
| `UI.md` | § Number formatting | One decimal below 10; rollover at 999,950 so `1000.0K` never renders | D12 |
| `ROADMAP.md` | Phase 1 | Per-resource conservation identity with `consumedByRecipes`; new `dt`-independence test | B5, A1 |
| `ROADMAP.md` | Phase 2 | ±1% assertion scoped above `offlineClosedFormMinSeconds` | D15 |
| `ROADMAP.md` | Phase 4 | Phase-6 chart nodes rendered locked, not hidden; `yieldMult` named as the 2.6× lever | F, B4 |

**One correction to this review's own recommendation.** B3 originally proposed lowering
the Folded space prerequisite from ≥20 to ≥13. That barely helps: the Extraction branch
has no node priced between 11 and 24, so ≥13 still forces Deep survey IV (24) and leaves
the true cost at 81 charts — past what collapse 3 affords. The applied threshold is
**≥11**, which admits Deep survey III and brings wormholes to 68 charts all in.

Two questions remain open in `OPEN_QUESTIONS.md`: whether `Standing orders` should exist
at 9 charts (C1), and which recipe-slot acquisition path should dominate (C3). Neither
blocks Phase 1.
