# Lightlace — content

## Voice

Cold, technical, unsentimental. Flight-plan register. Sentence case. No exclamation
marks anywhere in the game. No "Congratulations". No second-person cheerleading.

Good: `Vela-7 exhausted. 2 ports recoverable.`
Bad: `Oh no! Vela-7 has run out! 😢`

Good: `Refinery stalled — no isotopes for 4m 12s.`
Bad: `Warning! Your refinery needs attention!`

Errors and empty states explain what happened and what to do, in the interface's
voice, never apologising. `No free ports on Kestrel Anchor. Upgrade the node or
dismantle a link.` — not `Sorry, you can't do that.`

## Star naming

Procedural, two-part: a designation from a fixed list of ~60 short names plus a
numeral. `Vela-7`, `Kestrel-2`, `Anwen-14`. Names must be short (≤8 chars) because
they render on the map at small sizes.

Name pool should feel like a real catalogue: a mix of navigational, mythological, and
mundane-technical. Avoid fantasy-sounding invented words.

Suggested pool seeds: Vela, Kestrel, Anwen, Mira, Corvid, Tessel, Bright, Halden,
Onyx, Farrow, Sable, Pell, Wick, Marrow, Quill, Reed, Vane, Ash, Loom, Kite, Drift,
Cinder, Hollow, Latch, Pike, Bell, Crane, Ember, Fenn, Grove.

## Star classes

| Class | Resource | Reads as | Map colour |
|---|---|---|---|
| M-dwarf | hydrogen | Small, dim, common, long-lived | deep red-orange |
| G-type | hydrogen | Bright, fast-burning, valuable | warm yellow-white |
| Rocky remnant | metals | Dead planetary system | dull grey-brown |
| Heavy remnant | isotopes | White dwarf, dense | pale blue-white |
| Neutron star | isotopes | Tiny, fierce, brief | violet-white |
| Binary (n≥2) | hydrogen ×2 | Two points orbiting | paired yellow |
| Wormhole anchor (n≥3) | none | Ringed, no light | cyan ring, dark centre |

A player should learn to read the map by colour within ten minutes and never need
to check a legend after that. Class colour is the single most important visual
signal in the game.

Two clarifications on the table above:

- **Binary** is a single resource — hydrogen — at double yield, not two different
  outputs. `Star.resource` stays a single value. It reads as two points on the map and
  behaves as one rich hydrogen source.
- **Wormhole anchor** has `resource: null` and never produces anything. It generates at
  minimum node tier 1, because claiming it costs a port and a wormhole costs two more —
  see `MECHANICS.md` § 7.

## Resources

| Resource | Icon idea | Colour |
|---|---|---|
| Hydrogen | simple circle | warm amber |
| Metals | hexagon | slate grey |
| Isotopes | diamond | pale violet |
| Alloy | filled hexagon, outlined | steel blue |
| Catalyst | filled diamond, outlined | teal |
| Lattice core | small square lattice | white / near-white |

Lattice core should be the only near-white element in the resource palette so it
reads as precious.

## Chart tree

27 nodes, 372 charts total. Tree layout: three branches from a root, converging at the
wormhole node. Costs in charts.

### Branch: Extraction

| Node | Cost | Effect |
|---|---|---|
| Deep survey I | 2 | +8% extraction |
| Deep survey II | 5 | +8% extraction |
| Deep survey III | 11 | +10% extraction |
| Deep survey IV | 24 | +12% extraction |
| Core sampling | 8 | +20% reserve on all stars in new clusters |
| Bulk throttle | 6 | Unlock: set throttle on many stars at once |
| Deep scan | 7 | Start each run with +80 lu scan range |
| Prospector's start | 9 | Start each run with 1,200 metals and 400 alloy |

### Branch: Infrastructure

| Node | Cost | Effect |
|---|---|---|
| Wider conduits I | 4 | +12% link bandwidth |
| Wider conduits II | 10 | +15% link bandwidth |
| Wider conduits III | 22 | +18% link bandwidth |
| Phase alignment I | 5 | +12% link speed |
| Phase alignment II | 13 | +15% link speed |
| Phase alignment III | 28 | +18% link speed |
| Extra moorings I | 16 | +1 port on every star |
| Extra moorings II | 45 | +1 port on every star |
| Grade IV conduits | 18 | Unlock link tier IV |
| Modular hubs | 12 | −30% hub designation cost |

### Branch: Control

| Node | Cost | Effect |
|---|---|---|
| Routing profiles | 12 | Unlock: save and switch named routing profiles |
| Standing orders | 9 | Profiles can auto-switch on tab blur/focus |
| Flow readouts | 3 | Show exact rates on every link, not just when hovered |
| Bottleneck trace | 7 | Highlight the limiting link on any stalled hub |
| Depletion forecast | 6 | Show time-to-empty on every star |
| Salvage protocol | 14 | Dismantle refund 40% → 70% |
| Parallel refining | 20 | +1 recipe slot on every hub |
| Predictive routing | 26 | Flow readouts project 60s ahead |

### Convergence

| Node | Cost | Requires | Effect |
|---|---|---|---|
| Folded space | 30 | one node from each branch at cost ≥11 | Unlock wormhole links and anchors |

Totals: Extraction 72 · Infrastructure 173 · Control 97 · Convergence 30 = **372
charts across 27 nodes.**

The `≥11` threshold is chosen so the cheapest satisfying set is Deep survey III (11) +
Phase alignment II (13) + Salvage protocol (14) = 38, putting wormholes at 68 charts all
in and reachable by the third collapse (~82 charts cumulative). The Extraction branch has no node priced between
11 and 24, so any higher threshold forces Deep survey IV and delays wormholes a whole
collapse — see `BALANCE.md` § 7.

**Design note on the Control branch:** these are almost all *information* upgrades
rather than power upgrades. That is intentional. In a game where the fun is
diagnostic, better instruments are a genuine reward, and they cost nothing in
balance terms. `Bottleneck trace` and `Depletion forecast` in particular should feel
like the best purchases in the tree.

## Arrival summary copy

Shown on return from offline. Template:

```
Away 7h 42m

Produced      4,180 alloy · 2,020 catalyst · 61 lattice cores
Depleted      Vela-7, Anwen-3, Pike-11
Vented        11,400 hydrogen  ·  0 metals  ·  340 isotopes

Hydrogen vented for 6h 20m — Bell-4 outbound link at capacity.
```

The last line is the important one: name the specific cause, not just the total.
If nothing was vented, say so plainly: `Vented   nothing.`

If the absence exceeded `offlineCap`, say so on the first line rather than silently
resolving less time than elapsed:

```
Away 26h 04m · 14h resolved (maximum)
```

The cap is the one place the game could quietly shortchange the player, so it is stated
plainly and without apology, in the same register as everything else.

## Collapse copy

```
Collapse

The cluster is spent. 138 lattice cores recovered.
Charts awarded: 44

Everything in this cluster will be lost. Charts and their purchases persist.
```

Confirmation button reads `Collapse the cluster`, not `Confirm` or `OK`.
