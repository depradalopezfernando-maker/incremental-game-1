/**
 * Canvas 2D star map. Phase 3 is deliberately plain: circles and lines, no glow, no flow
 * pulses, no starfield. UI.md's visual layer is Phase 5, and the point of building this
 * first is to find out whether the first forty minutes are interesting *without* it.
 *
 * A pure consumer of state — architecture rule 2. This module never writes to `GameState`,
 * and it never goes through React.
 */

import {
  areLinked,
  canBuildLink,
  currentScanRange,
  distanceBetween,
  freePorts,
  held,
  linkBuildCost,
  linkCurrency,
  portsTotal,
  portsUsed,
} from '../sim/actions';
import { LINK_BANDWIDTH, linkLatency } from '../sim/constants';
import { linkThroughput, type FlowScratch } from '../sim/flow';
import type { GameState, StarClass, StarId } from '../sim/types';
import { VENT_VISIBLE_SECONDS } from '../app/hud';
import type { Selection } from '../app/store';
import {
  scaleOf,
  worldToScreenX,
  worldToScreenY,
  type Camera,
} from './camera';

/** CONTENT.md § Star classes. The map colour is the primary signal, so it lives here. */
const CLASS_COLOUR: Record<StarClass, string> = {
  mdwarf: '#c4542c',
  gtype: '#f2e2b0',
  rocky: '#8a7f74',
  heavy: '#cfe0f0',
  neutron: '#cbb4f5',
  binary: '#e8d489',
  anchor: '#4fd6d0',
};

const BACKGROUND = '#05070c';
const LINK_COLOUR = '#6d7684';
const LABEL_COLOUR = '#9aa5b3';
const SELECTED = '#8fe3f2';
const VENT = '#ff4d4d';

/** Star radius in screen pixels by node tier, at 1× zoom. UI.md § Stars. */
const TIER_RADIUS = [6, 8, 10, 12, 14];

/** Line width by link tier, at 1× zoom. UI.md § Links. */
const TIER_WIDTH = [0, 1, 2, 3, 4.5];

/** Labels appear above this zoom. */
const LABEL_ZOOM = 0.6;

export interface DrawInput {
  readonly state: GameState;
  readonly camera: Camera;
  readonly scratch: FlowScratch;
  readonly selection: Selection;
  /** Star the pointer is over, if any. */
  readonly hover: StarId | null;
  /** Star a link-drag started from, if a drag is in progress. */
  readonly dragFrom: StarId | null;
  readonly dragToScreen: { x: number; y: number } | null;
}

/** One line of the readout, with whether it should render as a refusal. */
interface ReadoutLine {
  readonly text: string;
  readonly warn: boolean;
}

export function draw(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { camera } = input;

  ctx.save();
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, camera.width, camera.height);

  drawScanRange(ctx, input);
  drawUnclaimed(ctx, input);
  drawLinks(ctx, input);
  drawDragPreview(ctx, input);
  drawClaimed(ctx, input);

  if (camera.zoom >= LABEL_ZOOM) drawLabels(ctx, input);
  drawReadout(ctx, input);

  ctx.restore();
}

/**
 * What this action would cost, at the cursor, before it is committed.
 *
 * Playtesting found this missing: you could drag a link into existence without ever seeing its
 * price or what the star on the other end actually holds, and spend an unrecoverable opening
 * budget on stars that produce the wrong thing. A price you only learn after paying it is not
 * a decision.
 */
function drawReadout(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { state, dragFrom, dragToScreen, hover } = input;
  const run = state.run;

  let anchor = dragToScreen;
  let lines: ReadoutLine[] = [];

  if (dragFrom !== null && dragToScreen !== null) {
    lines = linkReadout(input, dragFrom, hover);
  } else if (hover !== null && dragFrom === null) {
    const star = run.stars[hover];
    anchor = {
      x: worldToScreenX(input.camera, star.x),
      y: worldToScreenY(input.camera, star.y) - 14,
    };
    lines = starReadout(input, hover);
  }

  if (anchor === null || lines.length === 0) return;

  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const padding = 7;
  const lineHeight = 15;
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line.text).width);

  const boxWidth = width + padding * 2;
  const boxHeight = lines.length * lineHeight + padding * 2 - 3;
  // Keep the box on screen when the cursor is near an edge.
  const x = Math.min(anchor.x + 14, input.camera.width - boxWidth - 4);
  const y = Math.min(Math.max(4, anchor.y + 14), input.camera.height - boxHeight - 4);

  ctx.fillStyle = 'rgba(6, 9, 15, 0.92)';
  ctx.strokeStyle = '#1b2230';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x, y, boxWidth, boxHeight);
  ctx.fill();
  ctx.stroke();

  lines.forEach((line, index) => {
    ctx.fillStyle = line.warn ? '#d8a24a' : index === 0 ? '#dfe6f0' : '#93a0b0';
    ctx.fillText(line.text, x + padding, y + padding + index * lineHeight);
  });
}

function starReadout(input: DrawInput, starId: StarId): ReadoutLine[] {
  const run = input.state.run;
  const star = run.stars[starId];
  const lines: ReadoutLine[] = [
    { text: star.name, warn: false },
    { text: describeStar(star), warn: false },
  ];

  if (star.resource !== null) {
    const rate = star.baseYield * star.throttle;
    lines.push({
      text:
        star.reserve <= 0
          ? 'exhausted'
          : `${formatAmount(star.reserve)} left · ${formatRate(rate)}`,
      warn: false,
    });
  }

  // For a star you do not own, the question is always "what would it cost to reach it".
  if (!star.claimed) {
    const best = cheapestConnection(run, starId);
    if (best === null) {
      lines.push({ text: 'no route — out of range or no free ports', warn: true });
    } else {
      const currency = linkCurrency(1);
      const affordable = held(run, currency) >= best.cost;
      lines.push({
        text: `link from ${run.stars[best.from].name}: ${Math.ceil(best.cost)} ${currency}`,
        warn: !affordable,
      });
      if (!affordable) {
        lines.push({ text: `holding ${Math.floor(held(run, currency))}`, warn: true });
      }
    }
  }

  return lines;
}

function linkReadout(
  input: DrawInput,
  from: StarId,
  target: StarId | null,
): ReadoutLine[] {
  const run = input.state.run;

  if (target === null || target === from) {
    return [{ text: `link from ${run.stars[from].name}`, warn: false }, { text: 'release on a star', warn: false }];
  }

  const to = run.stars[target];
  const cost = linkBuildCost(run, from, target, 1);
  const currency = linkCurrency(1);
  const check = canBuildLink(run, from, target, 1);

  const lines: ReadoutLine[] = [
    { text: `${run.stars[from].name} → ${to.name}`, warn: false },
    { text: describeStar(to), warn: false },
    {
      text: `${Math.round(distanceBetween(run, from, target))} lu · ${linkLatency(
        distanceBetween(run, from, target),
        1,
      ).toFixed(1)}s`,
      warn: false,
    },
    {
      text: `${Math.ceil(cost)} ${currency} · holding ${Math.floor(held(run, currency))}`,
      warn: !check.ok,
    },
  ];

  if (!check.ok) lines.push({ text: check.reason, warn: true });
  return lines;
}

function describeStar(star: GameState['run']['stars'][number]): string {
  const cls = CLASS_NAME[star.cls];
  if (star.resource === null) return cls;
  return `${cls} · ${star.resource}`;
}

/** The cheapest tier-I link that could reach this star from the existing network. */
function cheapestConnection(
  run: GameState['run'],
  starId: StarId,
): { from: StarId; cost: number } | null {
  let best: { from: StarId; cost: number } | null = null;
  for (const other of run.stars) {
    if (!other.claimed) continue;
    if (!canReach(run, other.id, starId)) continue;
    const cost = linkBuildCost(run, other.id, starId, 1);
    if (best === null || cost < best.cost) best = { from: other.id, cost };
  }
  return best;
}

/** Range and ports only — affordability is reported separately so the price still shows. */
function canReach(run: GameState['run'], from: StarId, to: StarId): boolean {
  if (distanceBetween(run, from, to) > currentScanRange(run)) return false;
  if (freePorts(run, from) <= 0 || freePorts(run, to) <= 0) return false;
  return !areLinked(run, from, to);
}

const CLASS_NAME: Record<StarClass, string> = {
  mdwarf: 'M-dwarf',
  gtype: 'G-type',
  rocky: 'rocky remnant',
  heavy: 'heavy remnant',
  neutron: 'neutron star',
  binary: 'binary',
  anchor: 'wormhole anchor',
};

function formatAmount(value: number): string {
  if (value >= 10000) return `${(value / 1000).toFixed(1)}K`;
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(1);
}

function formatRate(value: number): string {
  if (value < 0.005) return 'idle';
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)}/s`;
}

/**
 * The reachable frontier, drawn as a faint boundary around claimed stars. Scan range gates
 * expansion, so the player needs to see where it currently ends.
 */
function drawScanRange(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { state, camera } = input;
  const range = currentScanRange(state.run) * scaleOf(camera);

  ctx.strokeStyle = 'rgba(120, 200, 220, 0.07)';
  ctx.lineWidth = 1;
  for (const star of state.run.stars) {
    if (!star.claimed) continue;
    ctx.beginPath();
    ctx.arc(
      worldToScreenX(camera, star.x),
      worldToScreenY(camera, star.y),
      range,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
}

function drawUnclaimed(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { state, camera } = input;

  for (const star of state.run.stars) {
    if (star.claimed) continue;
    // Unclaimed stars are visible within scan range and invisible beyond it.
    if (!withinScan(state, star.id)) continue;

    const x = worldToScreenX(camera, star.x);
    const y = worldToScreenY(camera, star.y);
    const radius = Math.max(2, TIER_RADIUS[0] * camera.zoom * 0.5);

    // Dim and small, but *its own colour*: deciding what to claim next is a decision about
    // what the star holds, and CONTENT.md wants the map readable by colour. A uniform grey
    // dot would make every expansion choice blind.
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = CLASS_COLOUR[star.cls];
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function withinScan(state: GameState, starId: StarId): boolean {
  const range = currentScanRange(state.run);
  for (const other of state.run.stars) {
    if (!other.claimed) continue;
    if (distanceBetween(state.run, other.id, starId) <= range) return true;
  }
  return false;
}

function drawLinks(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { state, camera, scratch, selection } = input;

  for (const link of state.run.links) {
    const a = state.run.stars[link.a];
    const b = state.run.stars[link.b];

    // Utilisation drives opacity: a trunk running at bandwidth is the brightest line on the
    // map. UI.md § Links.
    const utilisation = Math.min(1, linkThroughput(scratch, link.id) / LINK_BANDWIDTH[link.tier]);
    const selected = selection.kind === 'link' && selection.id === link.id;

    ctx.beginPath();
    ctx.moveTo(worldToScreenX(camera, a.x), worldToScreenY(camera, a.y));
    ctx.lineTo(worldToScreenX(camera, b.x), worldToScreenY(camera, b.y));
    ctx.strokeStyle = selected ? SELECTED : LINK_COLOUR;
    ctx.globalAlpha = selected ? 1 : 0.25 + 0.75 * utilisation;
    ctx.lineWidth = Math.max(1, TIER_WIDTH[link.tier] * camera.zoom);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawDragPreview(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { state, camera, dragFrom, dragToScreen } = input;
  if (dragFrom === null || dragToScreen === null) return;

  const from = state.run.stars[dragFrom];
  ctx.beginPath();
  ctx.moveTo(worldToScreenX(camera, from.x), worldToScreenY(camera, from.y));
  ctx.lineTo(dragToScreen.x, dragToScreen.y);
  ctx.strokeStyle = SELECTED;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawClaimed(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { state, camera, selection, hover } = input;
  const run = state.run;

  for (const star of run.stars) {
    if (!star.claimed) continue;

    const x = worldToScreenX(camera, star.x);
    const y = worldToScreenY(camera, star.y);
    const radius = Math.max(3, TIER_RADIUS[star.tier] * camera.zoom);
    const dead = star.resource !== null && star.reserve <= 0;
    const anchor = star.resource === null;

    // Brightness carries remaining reserve — a star at 10% is visibly guttering, and a dead
    // one is a dark ring with no fill.
    const fraction = star.reserveMax > 0 ? star.reserve / star.reserveMax : 0;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (dead || anchor) {
      ctx.strokeStyle = CLASS_COLOUR[star.cls];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = CLASS_COLOUR[star.cls];
      ctx.globalAlpha = 0.35 + 0.65 * fraction;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Hubs get a ring; a hub with a stalled slot gets that ring dashed, which means exactly
    // one thing and is readable from across the map.
    if (star.role === 'hub') {
      const stalled = star.slots.some(
        (slot) => slot.status.kind === 'starved' || slot.status.kind === 'backedUp',
      );
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.6, 0, Math.PI * 2);
      ctx.strokeStyle = '#dfe7f0';
      ctx.lineWidth = 1.5;
      if (stalled) ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The only red in the game: you are losing material, right now, here.
    if (star.lastVentAt >= 0 && run.elapsed - star.lastVentAt <= VENT_VISIBLE_SECONDS) {
      ctx.beginPath();
      ctx.arc(x + radius + 5, y - radius - 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = VENT;
      ctx.fill();
    }

    const isSelected = selection.kind === 'star' && selection.id === star.id;
    if (isSelected || hover === star.id) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = SELECTED;
      ctx.globalAlpha = isSelected ? 1 : 0.45;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function drawLabels(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { state, camera } = input;
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const star of state.run.stars) {
    if (!star.claimed) continue;
    const radius = Math.max(3, TIER_RADIUS[star.tier] * camera.zoom);
    ctx.fillStyle = LABEL_COLOUR;
    ctx.fillText(
      star.name,
      worldToScreenX(camera, star.x),
      worldToScreenY(camera, star.y) + radius + 4,
    );
  }
}

/** Nearest claimed-or-visible star within a grab radius, for hit testing. */
export function starAt(
  state: GameState,
  camera: Camera,
  screenX: number,
  screenY: number,
): StarId | null {
  let best: StarId | null = null;
  let bestDistance = Infinity;

  for (const star of state.run.stars) {
    if (!star.claimed && !withinScan(state, star.id)) continue;
    const dx = worldToScreenX(camera, star.x) - screenX;
    const dy = worldToScreenY(camera, star.y) - screenY;
    const distance = Math.hypot(dx, dy);
    const radius = Math.max(3, TIER_RADIUS[star.tier] * camera.zoom);
    // A generous grab radius; small targets at low zoom are otherwise unusable.
    if (distance <= radius + 8 && distance < bestDistance) {
      bestDistance = distance;
      best = star.id;
    }
  }
  return best;
}

/** Nearest link within a few pixels of the point, for selecting a line. */
export function linkAt(
  state: GameState,
  camera: Camera,
  screenX: number,
  screenY: number,
): number | null {
  let best: number | null = null;
  let bestDistance = 6;

  for (const link of state.run.links) {
    const a = state.run.stars[link.a];
    const b = state.run.stars[link.b];
    const ax = worldToScreenX(camera, a.x);
    const ay = worldToScreenY(camera, a.y);
    const bx = worldToScreenX(camera, b.x);
    const by = worldToScreenY(camera, b.y);

    const distance = distanceToSegment(screenX, screenY, ax, ay, bx, by);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = link.id;
    }
  }
  return best;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Port pressure, surfaced by the inspector. */
export function portLabel(state: GameState, starId: StarId): string {
  return `${portsUsed(state.run, starId)}/${portsTotal(state.run, starId)}`;
}
