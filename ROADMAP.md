# Lightlace — build roadmap

Build in this order. Each phase ends with something runnable. **Do not start a phase
until the previous phase's acceptance criteria pass.**

The single biggest risk to this project is building a beautiful map before the flow
model is correct. Phases 1 and 2 exist to prevent that: the simulation is proven
headless, in tests, before anything is drawn.

---

## Phase 1 — Simulation core, headless

No UI. No canvas. Nothing on screen.

- `types.ts` — full state shape
- `constants.ts` — every number from `BALANCE.md`
- `generate.ts` — seeded generation with all § Seed guarantees satisfied
- `flow.ts` — routing solve with bandwidth contention
- `tick.ts` — the six-step tick from `MECHANICS.md` § Flow model
- Extraction, depletion, delay queues, buffers, venting
- Recipes and hub refining

**Acceptance:**
- A test builds a fixed 5-star network, runs 30 simulated minutes in under 200ms,
  and asserts exact stockpile values
- A test asserts material is conserved, per raw resource:
  `extracted[r] == inBuffers[r] + inTransit[r] + vented[r] + consumedByRecipes[r]`
  to within floating-point tolerance. Refining destroys its inputs, so the identity
  needs that last term — without it the assertion fails the moment a hub runs.
- A test asserts a saturated trunk degrades all flows on it proportionally
- A test asserts a hub holding some but not all of a recipe's inputs stalls, consumes
  nothing, and names every missing input (no recipe has three inputs — the alloy and
  catalyst recipes have two each)
- A test asserts the simulation is `dt`-independent: the same network run for 10
  minutes at 10 Hz, 4 Hz, 2 Hz and 1 Hz agrees to within 1%. Phase 2's offline solver is
  only correct if this holds — see `MECHANICS.md` § Routing solve.

  `dt` has to stay well below link latency for this to mean anything. Arrival is quantised
  to tick boundaries, so a step comparable to a link's latency changes *when* material
  lands, not just the rate it lands at — and a single step longer than the latency delivers
  nothing at all, because a segment cannot depart and arrive in the same tick. Resolution
  coarser than that is `BALANCE.md` § 8's job, not the tick's.
- Same seed produces byte-identical clusters across runs, including after the
  constructive seed guarantees in `BALANCE.md` § Seed guarantees

---

## Phase 2 — Offline resolution and persistence

Still headless.

- `offline.ts` — the closed-form interval solver
- `save.ts` — serialize, deserialize, version field, migration hook

**Acceptance:**
- Resolving 12 hours offline completes in under 20ms
- Offline result matches a slow tick-by-tick reference simulation of the same
  period to within 1%, verified by a test that runs both. Assert this over a period
  well above `offlineClosedFormMinSeconds`; closed-form resolution discards latency,
  so short absences take the real-tick path instead and the ±1% claim does not apply
  to them — see `BALANCE.md` § 8.
- A save round-trips losslessly
- Depletion events during offline are correctly ordered and applied

This phase is where the project either becomes maintainable or doesn't. Do not
shortcut it.

---

## Phase 3 — Playable vertical slice

Minimum viable interface. Ugly is fine. Functional is not optional.

- Canvas map: stars as plain circles, links as plain lines, pan and zoom
- Click a star to select, click-drag star to star to build a tier-I link
- Inspector: star panel and link panel, real data
- Resource bar with stockpiles and rates
- Real-time game loop with `requestAnimationFrame`, fixed 10Hz simulation step
  decoupled from render rate
- Throttle slider, node tier upgrade, hub designation
- Autosave and offline catch-up on load

**Acceptance:**
- A person can play the first 40 minutes end to end: claim stars, build links, watch
  a star deplete, react by expanding
- Closing the tab for 10 minutes and returning produces correct state
- Frame rate stays above 55fps with 40 stars and 60 links

**Stop here and play it for a full session before continuing.** Everything after
this is amplification. If the first 40 minutes aren't interesting with plain circles
and lines, the visuals will not save it, and the fix belongs in `BALANCE.md` § 10.

---

## Phase 4 — Full economy

- Metals and isotopes, all three recipes
- Multiple hubs, recipe slot assignment, slot status
- All within-run upgrades (extraction, buffer, scan range)
- Link tiers II and III, upgrade and dismantle
- Alerts strip
- Collapse: chart award, cluster regeneration, chart tree UI and effects

Four chart nodes unlock features scheduled for Phase 6 — `Routing profiles`,
`Standing orders`, `Folded space`, and `Parallel refining`'s interaction with hub slots.
Render them explicitly locked with the phase they arrive in; do not hide them. The
`Routing profiles` decision at the first collapse is called out in `BALANCE.md` § 7 as
the tension of the first prestige, so the player should see it coming even while it is
unbuyable.

**Acceptance:**
- A full run to first collapse is playable and lands within the § 10 pacing targets,
  measured by actually playing it and logging timestamps
- Chart tree purchases persist across collapse and measurably accelerate run 2
- Second run reaches 25 cores roughly 2.6× faster than the first. `yieldMult` in
  `BALANCE.md` § Reserve and yield is the intended lever; if the measured figure comes
  in low, that exponent is the first thing to raise.

---

## Phase 5 — The visual layer

Now, and only now, make it look like the game described in `UI.md`.

- Star glow, class colours, brightness by remaining reserve
- Link utilisation opacity, tier line weights
- **Flow pulse animation** — the signature element, speed tied to real link speed
- Vent particle burst and persistent red indicator
- Hub rings, dashed for stalled
- Starfield background
- Typography pass, tabular figures, full number formatting
- Camera easing, alert click-to-focus

**Acceptance:**
- With panels hidden, a player can correctly identify a starving hub, a saturated
  trunk, and a nearly-dead star from the map alone
- 60fps at 120 stars and 200 links
- `prefers-reduced-motion` respected

---

## Phase 6 — Depth and finish

- Routing profiles and the switcher
- Wormholes and anchor generation
- Binary stars
- Remaining chart tree nodes, particularly the Control branch instruments
- Arrival summary screen with cause attribution
- Settings: reduced motion, always-on labels, autosave interval
- Sound, if wanted — ambient only, no UI clicks

**Acceptance:**
- A run reaches wormholes and the network genuinely needs re-planning afterward
- 6 hours of total playtime available without repeating a problem type

---

## Testing discipline

Every phase adds tests to a growing suite. The suite must always run in under 10
seconds — the moment it doesn't, it stops being run, and this genre's bugs are
exactly the kind that only surface after simulated hours.

Keep a permanent test that runs a scripted 6-hour game and asserts conservation of
material and no NaN anywhere in state. Run it in CI.

Run it at a coarse step (1 Hz), not the live 10 Hz. Conservation and finiteness are
`dt`-independent properties and the step sizes are compared against each other separately,
so the endurance test buys nothing from the finer step — and at 10 Hz on a realistic
40-star cluster it takes ~7.4s, which would spend most of the 10-second budget on one test.

---

## What to ask about rather than guess

Bring these back rather than deciding unilaterally:

- Any change to the three constraints (ports, bandwidth, latency)
- Any addition to § Non-mechanics in `MECHANICS.md`
- Adding a runtime dependency
- Anything that makes routing decisions on the player's behalf
- Deviating from the pacing targets by more than 30%
