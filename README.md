# Lightlace

An incremental game about building a light-speed logistics network across a dying star
cluster. Design docs are the source of truth — start with `DESIGN.md`, then `MECHANICS.md`
(rules) and `BALANCE.md` (numbers).

Currently at the end of **Phase 3** in `ROADMAP.md`: the simulation is complete and tested,
and there is a minimum viable interface you can play. The visual layer is Phase 5, so the map
is plain circles and lines on purpose.

## Running it

Needs Node 18 or newer (developed on 22).

```bash
git clone <repo> && cd incremental-game-1
git checkout claude/review-game-design-docs-zshv6w
npm install
npm run dev
```

Then open **http://localhost:5173/**.

```bash
npm test        # 135 tests, ~4s
npm run typecheck
npm run build   # production build into dist/
npm run preview # serve the production build
```

## Playing it

| Action | How |
|---|---|
| Pan | drag empty space |
| Zoom | wheel, about the cursor |
| Inspect | click a star or a link |
| Build a link | drag from one of *your* stars to another star |

You start with one star — the origin, an M-dwarf, already a hub — and 450 metals. Unclaimed
stars inside scan range are drawn dim and small in their class colour; everything further out
is invisible until you expand toward it.

The first things worth doing:

1. **Build a link or two.** Cost scales with length, so the nearest neighbours are cheapest.
   Watch the strip under the map — a refused build says exactly why.
2. **Find the rocky remnant** (dull grey-brown). It is your only source of metals, and metals
   are what tier-I links are paid in.
3. **Start the refinery when you have metals coming in.** The origin's recipe slot ships
   stopped on purpose — running it consumes the same metals your links are paid in. Select the
   origin and pick `alloy` once a rocky remnant is feeding you.
4. **Watch the bright yellow-white star.** The generator guarantees a G-type 60–95 lu out. It
   is the richest thing near you and it dies in roughly 10–20 minutes. That first depletion is
   meant to be the moment the game turns.

Things to look for while playing, since this is the "stop and play it" gate in `ROADMAP.md`:
whether the opening metals squeeze reads as tension or as a trap, and whether the first
depletion lands as a moment or a chore. Both are `BALANCE.md` § 10 problems if they feel wrong.

## Saving

Autosaves every 20 seconds and whenever the tab is hidden, into `localStorage` under
`lightlace.save.v1`.

**To start over:** open the browser console and run `localStorage.clear()`, then reload.

**To test offline progress:** close the tab, wait a couple of minutes, and reopen it. The
arrival line under the map reports what was produced, what depleted, and what was vented.
Absences under two minutes are simulated tick-by-tick; longer ones are resolved in closed form,
capped at 14 hours. Rewinding `savedAt` from the console does not work — the app saves on its
way out and overwrites the change.

## Layout

```
src/
  sim/     pure simulation — no DOM, no React, fully tested headless
  render/  canvas drawing, reads state and never writes it
  ui/      React panels around the canvas
  app/     game loop, store, persistence
```

`CLAUDE.md` has the architecture rules. The two that matter most: the simulation is headless
and deterministic, and the map never re-renders through React.
