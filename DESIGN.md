# Lightlace — design

## Premise

A star cluster is dying. You are the logistics intelligence tasked with stripping it
before it goes dark. You lay relay links between stars, extract what they hold, and
haul it inward to refineries — knowing that every star you touch is finite, and that
the ones nearest you will burn out first.

## Player fantasy

Not "I am a galactic emperor." The fantasy is narrower and better:

> **I am an engineer looking at a network that is slowly going wrong, and I can see
> exactly which three links to change.**

The pleasure is diagnostic. You come back, see that a refinery has stalled with 4,000
units of hydrogen backed up and no metals, trace it to a star that ran dry two hours
ago, and re-thread the network. The game should reward *reading* a system, not
clicking fast.

## The three constraints

Everything interesting comes from these three fighting each other.

**Ports.** Every star has a limited number of connection points. A link consumes one
at each end. You cannot simply connect everything to everything. Expansion is
always a question of *what do I give up*.

**Bandwidth.** Links carry a finite rate. Flows share links. Adding a new source to
an existing trunk degrades everything already using it. Expansion is never free.

**Latency.** Material takes real time to travel. Distance costs you seconds. This is
the constraint that makes the map's geometry matter rather than just its topology.

## Why it fits bursty play

The optimal network is genuinely different depending on whether you are about to
play or about to leave. This is not a gimmick bolted on; it falls out of the physics.

**Long-haul configuration** — you're closing the game. Latency across 8 hours is
noise. What matters is that nothing overflows and nothing starves for the whole
period. You route conservatively, throttle extraction to match bandwidth, and accept
slow round trips in exchange for zero waste.

**Live configuration** — you just sat down for 25 minutes. Now latency dominates.
You want short cycles so you can make a change and *see* it inside a minute. You
push extraction past sustainable rates, accept some venting, and pull material
through the fastest paths you have.

So a session has a natural shape: arrive, re-weight for live, play, re-weight for
long-haul, leave. Two deliberate rituals bracketing the fun.

Critically, **re-weighting is free; re-building is expensive.** You change routing
weights, not topology. This means late-game you deliberately build redundant links
you don't always use, purely to have configurations to switch between. Redundancy
becomes a strategic asset rather than waste.

## The stakes

Two rules give the game teeth. Both must be preserved:

1. **Stars deplete permanently.** No respawn, no regrowth. Within a run, the cluster
   only ever gets poorer.
2. **Overflow is destroyed.** Material extracted beyond what your buffers hold and
   your links can carry is vented to space and gone forever.

Together these mean a badly configured network is not merely inefficient — it is
actively burning a finite resource. Leaving overnight with a bad configuration
costs you something real. That is what makes the pre-departure ritual matter.

This should never be presented as a punishment or a fail state. There is no losing.
The framing is thermodynamic: waste is a fact of the universe you are working
against.

## The arc, in one sentence

Your network's core dies while its frontier is where the value is, so your empire's
center of gravity has to keep migrating outward — and it has to do that *while
running*, because everything downstream depends on it.

## The five phases

| Phase | Approx. | The new problem the player faces |
|---|---|---|
| First light | 0:00–0:40 | One hub, hydrogen only. Ports, bandwidth, latency, first depletion. |
| Convergence | 0:40–1:45 | Metals and isotopes. Recipes force flows to *converge* at a hub in ratio. |
| The frontier | 1:45–3:00 | Interior stars die. Promote a new hub outward, dismantle, reclaim ports. |
| Collapse | 3:00–4:15 | First prestige. New cluster, star charts, routing profiles. |
| Folded space | 4:15+ | Wormhole links ignore distance. The map's geometry stops being a constraint. |

Each phase should **invalidate** the previous network rather than scale it. If a
player can get from phase 3 to phase 4 by buying multipliers without re-planning
their topology, the design has failed and the phase needs a new constraint.

## Tone

Cold, precise, slightly elegiac. The cluster is dying and you are the one taking it
apart. Copy is technical and unsentimental — flight-plan language, not space-opera
language. No exclamation marks. No "Congratulations!" See `CONTENT.md` § Voice.

## Explicit non-goals

- No combat, no enemies, no threats to defend against
- No random events, no RNG during play (RNG exists only in cluster generation)
- No timers you wait on that aren't physical transit or extraction
- No narrative, no characters, no dialogue
- Never punish the player for being away. Offline time is productive time.
