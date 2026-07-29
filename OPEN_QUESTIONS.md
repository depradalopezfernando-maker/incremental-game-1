# Open questions

Decisions the design docs don't settle. Each has a default I'd take if no answer comes,
so Phase 1 is never blocked. Full reasoning in `REVIEW.md`.

Resolved questions get moved to the bottom with the answer and the doc that now owns it.

---

## Needs a decision before Phase 1

### 1. Where does spendable material live?
Buffers are per-star (`MECHANICS.md` § 1), but `UI.md` shows six global stockpiles and
every cost is quoted without a location. → `REVIEW.md` A2.

**Default:** the resource bar shows the network-wide sum of all buffers; a purchase
debits stars holding that resource, nearest-first. Co-location constrains refining only.

### 2. Rate-based flow, or keep buffer-drain?
`MECHANICS.md` § 3's `desired(link, r) = sourceBuffer[r] available this tick` is
`dt`-dependent and leaves the § 8 offline solver with no steady state to solve.
→ `REVIEW.md` A1.

**Default:** rate-based and `dt`-independent, contention rule unchanged. This is the one
default I'd most like confirmed — it's the load-bearing change and it touches
`flow.ts`, `tick.ts`, and `offline.ts` at once.

### 3. Link cost — formula or table?
`0.9 · 150^1.2 = 368`, but the § 2 worked examples say 389 (a coefficient of 0.9515).
→ `REVIEW.md` B1.

**Default:** the formula wins; correct the table to 368 / 1,288 / 4,415 / 14,716.

### 4. Does the free starting hub count toward `hubsOwned`?
250 alloy hits the 0:35 second-hub target; 650 alloy misses it by 22 minutes.
→ `REVIEW.md` D10.

**Default:** purchased hubs only.

---

## Needs a decision, not yet blocking

### 5. Where does the 2.6× second-run acceleration come from?
`richnessMult` scales `reserve` only, so later clusters last longer without producing
faster. Chart effects are +8–18 %. → `REVIEW.md` B4.

**Default:** add `richnessMult^0.5` to `baseYield`. Blocks Phase 4's acceptance
criterion, not Phase 1.

### 6. Is `Standing orders` (9 charts, auto-switch profiles on blur/focus) intended?
It automates away the arrival/departure ritual `DESIGN.md` builds the session shape
around, and `ROADMAP.md` asks for routing automation to be brought back rather than
decided. → `REVIEW.md` C1.

**Default:** implement as specified when Phase 6 arrives, flagging it again then.

### 7. Wormhole anchor ports.
Anchors spend two ports per wormhole end, and a tier-0 anchor has two ports total —
both consumed, leaving none for the link that claimed it. → `REVIEW.md` D9.

**Default:** generate anchors at minimum tier 1. Phase 6.

### 8. Chart tree budget: 372 charts across 27 nodes, or trim to ~340?
Affects "5–6 collapses to clear" and whether wormholes are reachable by collapse 3.
→ `REVIEW.md` B2, B3.

**Default:** state 372 and 7–8 collapses; lower the Folded space prerequisite to ≥13.

### 9. Which recipe-slot path should dominate — tall hubs or many hubs?
Hub designation and node tier both grant slots at near-identical cost for the second
slot, then diverge. Nothing states the intent. → `REVIEW.md` C3.

**Default:** leave both curves as written and revisit after Phase 4 pacing measurement.

---

## Defaults taken, no answer needed unless you disagree

Logged per `CLAUDE.md` — simplest option picked, noted here rather than escalated.
All from `REVIEW.md` § D.

| Question | Default taken |
|---|---|
| `GameState` shape (undocumented) | `{ meta, run }`; `meta` = everything surviving collapse |
| Recipe cycle semantics | Continuous rate-based consumption; cycle time is presentation |
| Slot behaviour when output buffer is full | Stall without consuming; venting stays extraction-only |
| Recipe unlock conditions | First time the network holds ≥1 of each input; persistent |
| Flow-graph cycles | Default weights only descend hop-distance-to-hub; player-made cycles allowed |
| In-flight segments when a link is upgraded | Keep the `arrivesAt` they were dispatched with |
| Buffer capacity composition | `tierBuffer[tier] · 1.6^k · (isHub ? 4 : 1)`, per resource |
| Binary stars | Single `resource`, 2 × 1.30 effective yield; `Star.resource` stays scalar |
| Default `throttle` | 1.0 |
| Displayed rate smoothing | EMA over ~2 s |
| Sub-unit stockpile formatting | One decimal below 10; roll to `M` at 999,950 |
| Short-absence offline | Real ticks below 120 s elapsed, closed form above |
| Star placement radial exponent | `0.85` → `1.33`, so density actually falls off outward |
| Seed guarantees | Constructive placement, not resampling whole clusters |
