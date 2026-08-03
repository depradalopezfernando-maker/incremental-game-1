# Lightlace — interface

## The one principle

The player's core activity is **diagnosis**. They arrive, look at the map, and need
to work out what has gone wrong. Every design decision serves that.

Concretely: **a player should be able to identify a starving refinery, a saturated
trunk, and a dying star from the map alone, without opening a single panel.** If
that's not true, the map is failing at its job and no amount of panel polish will
fix it.

## Layout

```
┌────────────────────────────────────────────────────────────┐
│  resource bar — rates and stockpiles, always visible        │
├──────────────────────────────────────────┬─────────────────┤
│                                          │                 │
│                                          │   inspector     │
│           star map (canvas)              │   (selection-   │
│                                          │    dependent)   │
│                                          │                 │
│                                          │                 │
├──────────────────────────────────────────┤                 │
│  profile switcher · alerts strip          │                 │
└──────────────────────────────────────────┴─────────────────┘
```

- Map fills all available space. It is the game; everything else is chrome.
- Inspector is a fixed ~320px right rail. It never overlays the map.
- No modals during play. Collapse confirmation is the only exception.
- Below 900px width, the inspector becomes a bottom sheet. The map stays dominant.

## Star map — rendering

Canvas 2D. Pan with drag, zoom with wheel. Zoom range 0.25×–3×. No rotation.

Draw order, back to front:

1. **Background.** Near-black, very slightly blue. A sparse static starfield of dim
   points, generated once from the cluster seed. No parallax layers, no nebula
   textures — they compete with the actual game objects for attention.
2. **Unclaimed stars in scan range.** Dim, no label, small.
3. **Links.** Line width by tier (1px / 2px / 3px / 4.5px at 1× zoom).
4. **Flow animation.** See below.
5. **Claimed stars.** Class-coloured, glowing.
6. **Labels.** Star name + status glyph, only above 0.6× zoom.
7. **Alert markers.** Always drawn, always readable at any zoom.

### Stars

A star is a filled circle with a soft radial glow, colour from its class. Two things
encode state:

- **Radius** scales with node tier (6px → 14px at 1× zoom)
- **Brightness** scales with `reserve / reserveMax`. A star at 10% reserve is
  visibly guttering. A dead star is a dark ring with no fill.

Hubs get a thin bright ring at 1.6× the star radius. A hub with a stalled recipe slot
gets that ring drawn as a **dashed** arc instead — visible at any zoom, from across
the map, and it means exactly one thing.

### Links

Line colour is neutral grey by default. Two overlays:

- **Utilisation.** Line opacity from 0.25 (idle) to 1.0 (saturated). A trunk running
  at bandwidth is the brightest thing on the map besides stars.
- **Saturation warning.** A link at ≥98% utilisation for more than 5s gets a subtle
  warm tint. Not red — red is reserved for material loss.

### Flow animation

This is the signature visual. Along each link carrying flow, draw small pulses
travelling from source to destination.

- Pulse colour = the resource being carried
- Pulse **speed** = the link's actual propagation speed, scaled to screen. A tier-I
  link's pulses visibly crawl; a tier-IV link's snap across. This is how the player
  *feels* the latency upgrade rather than reading it.
- Pulse **spacing** = inversely proportional to flow rate

Implementation: purely a rendering artefact computed from `link.flowRate` and
`link.latency`. Do not tie it to actual delay-queue segments. A single phase
accumulator per link is enough.

Cap total drawn pulses at ~600. Beyond that, increase spacing rather than adding more.

### Venting

When a star vents material, draw a brief red particle burst dispersing outward, and
leave a small persistent red dot beside the star for as long as venting continues.

**This is the only red in the game.** Red means "you are losing material, right now,
here." A player scanning the map should be drawn straight to it.

## Resource bar

Six columns: hydrogen, metals, isotopes, alloy, catalyst, lattice core.

Each shows: stockpile, and net rate per second underneath in smaller type.
Rate is coloured — neutral when positive, warm when negative. A negative alloy rate
means you're consuming faster than producing, which is often fine and shouldn't
alarm, hence warm rather than red.

**The stockpile figure is the network-wide sum of every star's buffer for that
resource.** There is no separate global pool; material always lives somewhere. A
purchase debits stars holding that resource, nearest-first from the thing being bought,
so a full buffer on the far frontier is spendable — just as a matter of accounting, with
no transit involved. Co-location is a constraint on *refining* only (`MECHANICS.md`
§ 4), and that is the one place it earns its keep.

Displayed rates are smoothed with an exponential moving average over ~2 s. Instantaneous
rates at a 10 Hz step are noise, and jittering digits are the fastest way to make this
game feel cheap.

## Number formatting

- Below 10: one decimal (`4.2`, `0.6`) — buffers and refined goods are floats and the
  first few units of anything matter
- 10 to 9,999: integer with thousands separators
- 10,000 to 999,949: one decimal + `K` (`24.6K`)
- 999,950 and above: two decimals + `M`, `B`, `T` — the rollover point is chosen so
  nothing ever renders as `1000.0K`
- Rates: two decimals below 10, one decimal below 100, integer above (`0.83/s`,
  `4.2/s`, `31/s`)
- Time: `4m 12s`, `2h 06m`, `—` for infinite

Never show more than 4 significant figures. Never show a rate as `0.00/s` — show
`idle`.

## Inspector

Selection-dependent. Three cases:

**Star selected.** Name, class, resource, reserve bar with time-to-empty, throttle
slider, ports used/total, buffer levels per resource, tier and upgrade button. If a
hub: recipe slots with per-slot status, and for stalled slots, *which input is
missing and which upstream link is the bottleneck*.

**Link selected.** Endpoints, length, tier, latency (as `18.8s one way`), bandwidth,
current utilisation with a bar, per-resource breakdown of what's flowing, upgrade
and dismantle buttons.

**Nothing selected.** Network summary: total throughput, count of stalled hubs, count
of venting stars, count of stars with under 5 minutes of reserve remaining, and the
current routing profile.

## Alerts strip

A single horizontal strip under the map. Max 4 entries, each one line, each clickable
to fly the camera to the subject.

Priority order: venting > stalled hub > star depleting within 2 min > saturated link.

Entries are plain statements: `Bell-4 venting hydrogen · 12/s`. No icons beyond a
single leading dot in the alert's colour. No dismissal — an alert disappears when
the condition resolves, which teaches the player that fixing things makes the noise
go away.

## Profile switcher

Bottom-left, a small segmented control listing saved profiles. Only appears once
`Routing profiles` is unlocked. Switching is instant with a brief flash across
affected links so the player sees the change propagate.

## Typography and palette

Dark UI throughout — the map is near-black and the chrome must not fight it.

- Interface type: a clean grotesque with good numerals. Numbers appear everywhere
  and change constantly, so **tabular figures are mandatory** on every rate and
  stockpile. Jittering digits are the fastest way to make this game feel cheap.
- Consider a monospace for rates specifically. It suits the flight-plan voice and
  solves the jitter problem outright.
- Chrome palette: near-black backgrounds, three levels of grey for text, and
  otherwise *no colour at all*. All colour in the interface should be borrowed from
  the resources and star classes, so the palette is the game's own vocabulary rather
  than a decorative scheme.
- One accent for interactive affordances. Pick something cold — a pale cyan works
  with the anchor colour and stays out of the resource palette's way.

## Motion

Sparing. The flow pulses are the ambient motion budget for the whole game; anything
else competes with them.

Permitted: camera easing on alert click, a 150ms fade on panel content change, the
profile-switch flash, the vent burst.
Not permitted: hover animations on stars, pulsing buttons, animated backgrounds,
transitions on numbers.

Respect `prefers-reduced-motion`: freeze flow pulses into static dashes at correct
spacing, keep everything else.

## Accessibility floor

- Full keyboard navigation of the inspector and all buttons, visible focus rings
- Star class must never be encoded by colour alone — the status glyph and radius
  carry it too
- Minimum 12px type anywhere in chrome
- Map labels toggleable to always-on for players who can't parse the zoom threshold
