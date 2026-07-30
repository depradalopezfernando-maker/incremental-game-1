/**
 * The game loop. ROADMAP.md Phase 3: fixed 10 Hz simulation step, decoupled from render rate.
 *
 * Three cadences, deliberately separate:
 *
 *   simulation   fixed 10 Hz, accumulator-driven, never varies with frame rate
 *   render       every animation frame, reading whatever the simulation last produced
 *   HUD          5 Hz snapshot into the store, so React re-renders a few times a second
 *
 * A fixed step is not a stylistic choice: the whole simulation is built around `dt`
 * independence and the offline solver assumes it, so letting frame time leak into the step
 * would undo the property Phases 1 and 2 were spent establishing.
 */

import { SIM_STEP_SECONDS } from '../sim/constants';
import { scratchFor, tick } from '../sim/tick';
import type { GameState } from '../sim/types';
import { HUD_HZ, HudSampler } from './hud';
import { AUTOSAVE_INTERVAL_SECONDS, save } from './persistence';
import { ui } from './store';

/**
 * Longest real interval fed into the simulation in one frame. A backgrounded tab, a
 * breakpoint or a slow first paint can hand us a gap of minutes; catching that up at 10 Hz
 * would stall the frame. Anything longer is the offline solver's job, and it runs on load.
 */
const MAX_FRAME_SECONDS = 0.25;

export interface Loop {
  stop: () => void;
  /** Ticks pending in the accumulator, for tests. */
  readonly state: GameState;
}

export function startLoop(state: GameState, onDraw: () => void): Loop {
  const sampler = new HudSampler();
  let accumulator = 0;
  let hudCountdown = 0;
  let autosaveCountdown = AUTOSAVE_INTERVAL_SECONDS;
  let lastFrame = performance.now();
  let frameHandle = 0;
  let stopped = false;

  // Publish immediately so the interface has real numbers before the first frame lands.
  ui.publish(sampler.sample(state, 0, scratchFor(state.run)));

  const frame = (now: number): void => {
    if (stopped) return;

    const realSeconds = Math.min(MAX_FRAME_SECONDS, (now - lastFrame) / 1000);
    lastFrame = now;
    accumulator += realSeconds;

    let stepped = 0;
    while (accumulator >= SIM_STEP_SECONDS) {
      tick(state, SIM_STEP_SECONDS);
      accumulator -= SIM_STEP_SECONDS;
      stepped += SIM_STEP_SECONDS;
    }

    onDraw();

    if (stepped > 0) {
      hudCountdown -= stepped;
      if (hudCountdown <= 0) {
        hudCountdown = 1 / HUD_HZ;
        ui.publish(sampler.sample(state, 1 / HUD_HZ, scratchFor(state.run)));
      }

      autosaveCountdown -= stepped;
      if (autosaveCountdown <= 0) {
        autosaveCountdown = AUTOSAVE_INTERVAL_SECONDS;
        save(state);
      }
    }

    frameHandle = requestAnimationFrame(frame);
  };

  frameHandle = requestAnimationFrame(frame);

  // Save on the way out. `visibilitychange` fires when a tab is hidden or the phone is
  // locked, which is the moment that actually matters — `beforeunload` is not reliable on
  // mobile.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') save(state);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    state,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frameHandle);
      document.removeEventListener('visibilitychange', onVisibility);
      save(state);
    },
  };
}
