# Open questions

Decisions the design docs don't settle. Anything here that isn't answered has a default
recorded, so Phase 1 is never blocked. Reasoning lives in `REVIEW.md`.

---

## Still open

Neither blocks Phase 1.

### 1. Should `Standing orders` exist at 9 charts?
`CONTENT.md` § Control sells auto-switching of routing profiles on tab blur/focus for 9
charts — the third-cheapest node in the tree. `DESIGN.md` § Why it fits bursty play
builds the session's shape around exactly that ritual: "arrive, re-weight for live, play,
re-weight for long-haul, leave. Two deliberate rituals bracketing the fun." The node
makes the game's stated best moment opt-out, permanently, for almost nothing.

It arguably stays inside `MECHANICS.md` § Non-mechanics, since the player authored both
the profiles and the trigger — no routing decision is being made for them. The concern is
the price, not the rule. `ROADMAP.md` § What to ask about rather than guess names this
category explicitly. → `REVIEW.md` C1.

**Default if unanswered:** implement as specified when Phase 6 arrives, and raise it
again then. Moving it to ~24 charts, late in the branch, would preserve the ritual for
the hours where it is the point.

### 2. Should recipe slots come from tall hubs or many hubs?
Hub designation (`250 · 2.6^hubsPurchased`) and node tier (`60 · 3.4^t`, hub only) both
grant slots, cost near-identically at the second slot, then diverge — the hub curve is
shallower per step but starts 4× higher, so which path dominates flips somewhere in the
middle. Nothing states the intent, and it decides whether phase 2 is a few tall hubs or
a spread of small ones. → `REVIEW.md` C3.

**Default if unanswered:** leave both curves as written; measure in Phase 4 against the
§ 10 pacing targets and tune then. This is a balance question, not a rules question, so
it is cheap to defer.

---

## Raised during Phase 1 implementation

### 3. Wormhole bandwidth, latency and cost are not specified anywhere
`MECHANICS.md` § 7 says a wormhole has "latency independent of length (a small fixed
value)", "very high bandwidth", and "a cost in lattice cores". `BALANCE.md` has no numbers
for any of the three. Phase 6 cannot be built without them.

**Default if unanswered:** none taken — `Link.kind` carries `'wormhole'` in the type, and
bandwidth/latency currently fall through to the tier table. Needs real numbers before
Phase 6, not a guess from me.

### 4. Do player-set routing weights normalise?
`MECHANICS.md` § Routing solve says weights are "a set of weights over its outbound links"
and the default is an "even split", which implies proportions. Nothing says what happens if
the player's weights sum to less than 1 — is that a deliberate hold-back, or just
relative weighting?

**Default taken:** weights are relative and normalised to sum to 1 over the links the
player has weighted. A star whose weights are all zero forwards nothing and backs up,
which seemed like a legitimate thing to want. If hold-back should be expressible, that is a
rules change and belongs in `MECHANICS.md`.

### 5. Offline resolution approximates player-set weights that do not descend the hop gradient
The steady-state solve propagates inflow in one pass over stars ordered by hop distance,
which is exact for the default routing because flow only descends the gradient. Weights the
player sets by hand can route sideways or uphill, and a single pass under-propagates those.

**Default taken:** one pass, accepted. Nothing sets overrides yet — the routing UI is Phase
6 — and by then the honest fix is either iterating to a fixed point or refusing to let the
default solve claim exactness. Worth revisiting when profiles land, not before.

---

## Resolved

| Question | Resolution | Now owned by |
|---|---|---|
| Rate-based flow or buffer-drain? | **Rate-based**, `dt`-independent. Contention rule unchanged. | `MECHANICS.md` § Routing solve |
| Where does spendable material live? | Network-wide sum of buffers; purchases debit nearest-first. Co-location constrains refining only. | `UI.md` § Resource bar |
| Link cost — formula or table? | **Formula wins at `0.9`**; table corrected to 368 / 1,287 / 4,413 / 14,710. | `BALANCE.md` § 2 |
| Does the free origin hub count toward hub cost? | **No** — `hubsPurchased` counts paid hubs only, so the second hub costs 250 alloy and lands at ~0:31. | `BALANCE.md` § 3 |
| Where does 2.6× second-run acceleration come from? | `yieldMult = richnessMult^0.5` on `baseYield`; re-measure in Phase 4. | `BALANCE.md` § Reserve and yield |
| Chart tree budget | 372 charts, 27 nodes, 7–8 collapses to clear. | `BALANCE.md` § 7, `CONTENT.md` |
| Are wormholes reachable at collapse 3? | Yes, once the Folded space prerequisite drops to ≥11 (68 charts all in). | `CONTENT.md` § Convergence |
| Wormhole anchor ports | Anchors generate at minimum tier 1; `resource: null`. | `MECHANICS.md` § 7 |
| `GameState` shape | `{ meta, run }`, split on the collapse boundary. | `MECHANICS.md` § 9 |
| Recipe cycle semantics | Continuous rate-based consumption; cycle time is presentation. | `MECHANICS.md` § 4 |
| Slot behaviour when output is full | Stalls "backed up", inputs preserved. Venting stays extraction-only. | `MECHANICS.md` § 4 |
| Recipe unlock conditions | First time the network holds ≥1 of each input; persists across collapse. | `MECHANICS.md` § 4 |
| Flow-graph cycles | Defaults descend hop-distance to nearest hub, so none form. Player-made cycles allowed. | `MECHANICS.md` § Default weights |
| In-flight segments on link upgrade | Keep the `arrivesAt` they were dispatched with. | `MECHANICS.md` § Upgrading |
| Buffer capacity composition | `tierBuffer[tier] · 1.6^k · (isHub ? 4 : 1)`, per resource. | `BALANCE.md` § 3 |
| Binary stars | Single `resource`, 1.30 yieldMult applied twice. | `CONTENT.md` § Star classes |
| Default `throttle` | 1.0 on claim. | `MECHANICS.md` § 1 |
| Displayed rate smoothing | EMA over ~2 s. | `UI.md` § Resource bar |
| Sub-unit stockpile formatting | One decimal below 10; roll to `M` at 999,950. | `UI.md` § Number formatting |
| Short-absence offline | Real ticks below `offlineClosedFormMinSeconds = 120`. | `BALANCE.md` § 8 |
| Star placement radial exponent | `sqrt(u)^0.85` → `sqrt(u)^1.33`, so density falls off outward. | `BALANCE.md` § Star placement |
| Seed guarantees | Constructive six-step placement, not whole-cluster resampling. | `BALANCE.md` § Seed guarantees |
| Phase 1 conservation identity | Per raw resource, with a `consumedByRecipes` term. | `ROADMAP.md` Phase 1 |
| Phase-6 chart nodes in Phase 4 | Rendered locked with their phase, not hidden. | `ROADMAP.md` Phase 4 |
