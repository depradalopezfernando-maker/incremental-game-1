# Lightlace — project instructions

An incremental game about building a light-speed logistics network across a dying star cluster.
Working title: **Lightlace**. Alternates if you dislike it: *Slow Light*, *The Long Lag*, *Relay*.

## Read these before writing code

| File | What it holds |
|---|---|
| `DESIGN.md` | Theme, player fantasy, core loop, why it's fun |
| `MECHANICS.md` | Every system and how they interact. The authority on rules. |
| `BALANCE.md` | **All formulas and constants.** The authority on numbers. |
| `CONTENT.md` | Star classes, chart tree, naming, copy |
| `UI.md` | Screen layout, rendering, number formatting |
| `ROADMAP.md` | Build order. Follow it. Do not skip ahead. |

If `MECHANICS.md` and `BALANCE.md` disagree, `BALANCE.md` wins for numbers and
`MECHANICS.md` wins for rules. If something is genuinely unspecified, pick the
simplest option, implement it, and add a line to `OPEN_QUESTIONS.md` (create it if
absent) rather than inventing elaborate systems.

## Stack

- React 18 + TypeScript, strict mode
- Vite
- **Canvas 2D** for the star map. Not SVG, not WebGL, not a game engine.
- React only for the HUD/panels around the canvas. The map never re-renders through React.
- Zustand for game state
- Vitest for tests
- CSS Modules. No Tailwind, no component library.

No other runtime dependencies without asking. This is a game with a hand-built
simulation; pulling in an ECS or a physics library would be a mistake.

## Architecture rules

These are non-negotiable and everything else depends on them:

1. **The simulation is pure and headless.** `src/sim/` must have zero imports from
   React, the DOM, or the canvas. It takes a `GameState` and a `dtSeconds` and
   returns a new `GameState`. You should be able to run 8 hours of game in a unit
   test in under a second.

2. **Rendering reads state, never writes it.** The canvas renderer and React
   components are pure consumers.

3. **The economy is a flow graph, not a particle simulation.** Do not spawn objects
   that travel along links. Model links as continuous rate-carriers with a delay.
   See `MECHANICS.md` § Flow model.

4. **Offline progress is computed in closed form, not by replaying ticks.** See
   `BALANCE.md` § Offline resolution. Replaying 8 hours of ticks is the single most
   common way this genre's codebases become unfixable.

5. **All constants live in `src/sim/constants.ts`.** No magic numbers anywhere else.
   Balance changes must be one-file changes.

## Layout

```
src/
  sim/           pure simulation — no DOM, no React
    constants.ts
    types.ts
    generate.ts  seeded cluster generation
    flow.ts      bandwidth allocation and routing solve
    tick.ts      advance state by dt
    offline.ts   closed-form catch-up
    save.ts      serialize / migrate
  render/        canvas drawing
  ui/            React panels
  app/           wiring, game loop, persistence
```

## Commands

```
npm run dev
npm run build
npm run test
npm run typecheck
```

## Conventions

- No `any`. Discriminated unions over optional-field soup.
- Every formula in `BALANCE.md` gets a named exported function in `constants.ts`
  or `formulas.ts`, with the formula in a comment above it.
- Resource amounts are `number` (float). Do not use BigInt or a big-number library —
  see `BALANCE.md` § Number ceiling, values stay well inside `Number.MAX_SAFE_INTEGER`.
- Save to `localStorage` under key `lightlace.save.v{N}`, with an explicit version
  field and a migration function. Autosave every 20s and on `visibilitychange`.

## Do not

- Do not add sound, achievements, analytics, or a settings menu until Phase 6.
- Do not build a tutorial system. Onboarding is achieved through the generator
  guaranteeing a specific starting layout — see `BALANCE.md` § Seed guarantees.
- Do not add microtransactions, ads, or an energy/timer system. Ever.
- Do not "helpfully" smooth over the harsh parts. Material loss on overflow and
  permanent star depletion are the point of the game, not bugs.
