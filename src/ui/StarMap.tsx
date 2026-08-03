/**
 * The canvas host. React owns the element; it does not own what is drawn on it.
 *
 * Architecture rule: the map never re-renders through React. This component mounts a canvas,
 * registers pointer handlers, and hands a draw callback to the loop. Nothing inside it calls
 * `setState` per frame — the render reads live simulation state directly.
 *
 * Interaction, per ROADMAP.md Phase 3:
 *   drag on empty space   pan
 *   wheel                 zoom about the cursor
 *   click a star or link  select
 *   drag star → star      build a tier-I link
 */

import { useEffect, useRef } from 'react';
import {
  buildLink,
  canBuildLink,
  currentScanRange,
  linkBuildCost,
  linkCurrency,
} from '../sim/actions';
import { scratchFor } from '../sim/tick';
import type { GameState, StarId } from '../sim/types';
import { ui } from '../app/store';
import { frameOn, makeCamera, panBy, zoomAt } from '../render/camera';
import { draw, linkAt, starAt } from '../render/map';
import styles from './app.module.css';
import { amount } from './format';

/** Pointer travel, in pixels, before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

interface Props {
  readonly state: GameState;
  /** Registers the per-frame draw so the loop can call it. */
  readonly onReady: (drawFrame: () => void) => void;
}

export function StarMap({ state, onReady }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const camera = makeCamera(canvas.clientWidth, canvas.clientHeight);
    // Open on the network the player owns, plus enough room to see what is reachable.
    frameOn(
      camera,
      state.run.stars.filter((star) => star.claimed),
      currentScanRange(state.run) * 0.9,
    );

    // Interaction state lives here, outside React, because it changes per pointer event and
    // nothing in the chrome depends on it.
    let hover: StarId | null = null;
    let dragFrom: StarId | null = null;
    let dragToScreen: { x: number; y: number } | null = null;
    let panning = false;
    let pressed = false;
    let pressX = 0;
    let pressY = 0;
    let travelled = 0;

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      camera.width = canvas.clientWidth;
      camera.height = canvas.clientHeight;
      canvas.width = Math.round(camera.width * ratio);
      canvas.height = Math.round(camera.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    const drawFrame = (): void => {
      draw(ctx, {
        state,
        camera,
        scratch: scratchFor(state.run),
        selection: ui.selection(),
        hover,
        dragFrom,
        dragToScreen,
      });
    };
    onReady(drawFrame);

    const pointAt = (event: PointerEvent): { x: number; y: number } => {
      const bounds = canvas.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };

    const onPointerDown = (event: PointerEvent): void => {
      const point = pointAt(event);
      pressed = true;
      travelled = 0;
      pressX = point.x;
      pressY = point.y;
      canvas.setPointerCapture(event.pointerId);

      const star = starAt(state, camera, point.x, point.y);
      if (star !== null && state.run.stars[star].claimed) {
        // A press on one of your own stars starts a link drag; releasing on empty space just
        // selects it, so this costs the player nothing to try.
        dragFrom = star;
        dragToScreen = point;
      } else {
        panning = true;
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      const point = pointAt(event);

      if (pressed) travelled = Math.max(travelled, Math.hypot(point.x - pressX, point.y - pressY));

      if (panning && pressed) {
        panBy(camera, event.movementX, event.movementY);
        return;
      }

      if (dragFrom !== null) {
        dragToScreen = point;
        hover = starAt(state, camera, point.x, point.y);
        return;
      }

      hover = starAt(state, camera, point.x, point.y);
    };

    const onPointerUp = (event: PointerEvent): void => {
      const point = pointAt(event);
      const wasDrag = travelled > DRAG_THRESHOLD;
      const target = starAt(state, camera, point.x, point.y);

      if (dragFrom !== null && wasDrag && target !== null && target !== dragFrom) {
        attemptLink(state, dragFrom, target);
      } else if (!wasDrag) {
        // A click, not a drag: select whatever is under it.
        if (target !== null) {
          ui.select({ kind: 'star', id: target });
        } else {
          const link = linkAt(state, camera, point.x, point.y);
          ui.select(link !== null ? { kind: 'link', id: link } : { kind: 'none' });
        }
      }

      pressed = false;
      panning = false;
      dragFrom = null;
      dragToScreen = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      // Exponential in scroll distance so a trackpad and a wheel both feel proportional.
      zoomAt(
        camera,
        Math.exp(-event.deltaY * 0.0015),
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      );
    };

    const onLeave = (): void => {
      hover = null;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', resize);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', resize);
    };
  }, [state, onReady]);

  return <canvas ref={canvasRef} className={styles.canvas} />;
}

/**
 * Build if possible, and say plainly why not if it isn't. Refusals are the interface's voice:
 * what happened and what to do about it.
 */
function attemptLink(state: GameState, from: StarId, to: StarId): void {
  const check = canBuildLink(state.run, from, to, 1);
  if (!check.ok) {
    ui.notify(check.reason, 'refusal');
    return;
  }

  const cost = linkBuildCost(state.run, from, to, 1);
  const currency = linkCurrency(1);
  const result = buildLink(state.run, from, to, 1);

  if (result.ok) {
    ui.notify(
      `${state.run.stars[from].name} — ${state.run.stars[to].name} linked. ` +
        `${amount(cost)} ${currency} spent.`,
    );
    ui.select({ kind: 'star', id: to });
    ui.worldChanged();
  } else {
    ui.notify(result.reason, 'refusal');
  }
}
