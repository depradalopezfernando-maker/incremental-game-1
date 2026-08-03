/**
 * localStorage wiring and offline catch-up on load.
 *
 * The save format itself lives in `sim/save.ts` and knows nothing about browsers. This is
 * the only module that touches storage.
 */

import { newGame } from '../sim/generate';
import { resolveOffline, type OfflineResult } from '../sim/offline';
import { fromJson, SAVE_KEY, SaveError, serialize, toJson } from '../sim/save';
import type { GameState } from '../sim/types';

/** CLAUDE.md: autosave every 20s and on `visibilitychange`. */
export const AUTOSAVE_INTERVAL_SECONDS = 20;

export interface LoadResult {
  readonly state: GameState;
  /** Absent on a fresh start. */
  readonly offline: OfflineResult | null;
  /** Set when a save existed but could not be read. */
  readonly loadError: string | null;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Private browsing and some embedded contexts throw on access rather than returning
    // null. Playing without persistence is better than not playing.
    return null;
  }
}

/**
 * Set once the run has been discarded, so nothing writes it back.
 *
 * Without this a reset cannot work: clearing storage and reloading fires `visibilitychange`
 * on the way out, the loop dutifully saves the run being discarded, and the "new" game loads
 * the old one straight back.
 */
let discarded = false;

export function save(state: GameState, at: number = Date.now()): void {
  if (discarded) return;
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(SAVE_KEY, toJson(state, at));
  } catch {
    // Quota exhausted or storage disabled mid-session. Nothing useful to do here; the
    // player keeps playing and the next autosave tries again.
  }
}

export function clearSave(): void {
  storage()?.removeItem(SAVE_KEY);
}

/**
 * Discard the run: erase the save and refuse every further write.
 *
 * Separate from the reload so it can be tested without a browser. Callers reload afterwards;
 * a fresh load with no save generates a new cluster.
 */
export function discardRun(): void {
  discarded = true;
  clearSave();
}

/** Test seam — the module-level flag would otherwise leak between cases. */
export function resumeSaving(): void {
  discarded = false;
}

/**
 * Load, then resolve however long the player was away.
 *
 * A corrupt or unreadable save starts a fresh cluster rather than dropping the player into a
 * broken state — but it says so, because silently discarding someone's run would be worse
 * than either.
 */
export function load(now: number = Date.now(), seed?: number): LoadResult {
  const store = storage();
  const text = store?.getItem(SAVE_KEY) ?? null;

  if (text === null) {
    return { state: newGame(seed ?? (now >>> 0)), offline: null, loadError: null };
  }

  let state: GameState;
  let savedAt: number;
  try {
    state = fromJson(text);
    savedAt = JSON.parse(text).savedAt ?? now;
  } catch (cause) {
    const reason = cause instanceof SaveError ? cause.message : String(cause);
    return {
      state: newGame(seed ?? (now >>> 0)),
      offline: null,
      loadError: `Save could not be read (${reason}). Starting a new cluster.`,
    };
  }

  const awaySeconds = Math.max(0, (now - savedAt) / 1000);
  const offline = awaySeconds > 0 ? resolveOffline(state, awaySeconds) : null;
  return { state, offline, loadError: null };
}

/** Serialize without writing, for tests and for the export affordance in a later phase. */
export function snapshotSave(state: GameState): string {
  return JSON.stringify(serialize(state));
}
