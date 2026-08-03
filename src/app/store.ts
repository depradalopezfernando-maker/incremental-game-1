/**
 * The bridge between the simulation and React.
 *
 * The live `GameState` is *not* stored in Zustand. It is mutated in place at 10 Hz and the
 * canvas reads it directly every frame; putting it in a store would either force a new object
 * graph per tick or make React re-render the whole tree at simulation rate. What lives here
 * is what the chrome needs: the periodic HUD snapshot, the current selection, and the last
 * message to show the player.
 *
 * Architecture rule 2 holds throughout: rendering reads state, never writes it. Player
 * actions go through `sim/actions.ts` and then bump the store.
 */

import { create } from 'zustand';
import type { LinkId, StarId } from '../sim/types';
import { emptySnapshot, type HudSnapshot } from './hud';

export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'star'; readonly id: StarId }
  | { readonly kind: 'link'; readonly id: LinkId };

export const NOTHING_SELECTED: Selection = { kind: 'none' };

export interface Notice {
  readonly text: string;
  /** Rejected actions read differently from arrival summaries; the panel styles them apart. */
  readonly tone: 'info' | 'refusal';
  readonly at: number;
}

interface UiState {
  snapshot: HudSnapshot;
  selection: Selection;
  notice: Notice | null;
  /** Bumped whenever a player action changes the world, so panels re-read derived values. */
  worldVersion: number;

  publish: (snapshot: HudSnapshot) => void;
  select: (selection: Selection) => void;
  notify: (text: string, tone?: Notice['tone']) => void;
  dismissNotice: () => void;
  worldChanged: () => void;
}

export const useUi = create<UiState>((set) => ({
  snapshot: emptySnapshot(),
  selection: NOTHING_SELECTED,
  notice: null,
  worldVersion: 0,

  publish: (snapshot) => set({ snapshot }),
  select: (selection) => set({ selection }),
  notify: (text, tone = 'info') => set({ notice: { text, tone, at: Date.now() } }),
  dismissNotice: () => set({ notice: null }),
  worldChanged: () => set((prior) => ({ worldVersion: prior.worldVersion + 1 })),
}));

/** Imperative handles for the loop and the canvas, which are outside React. */
export const ui = {
  publish: (snapshot: HudSnapshot) => useUi.getState().publish(snapshot),
  select: (selection: Selection) => useUi.getState().select(selection),
  notify: (text: string, tone: Notice['tone'] = 'info') => useUi.getState().notify(text, tone),
  worldChanged: () => useUi.getState().worldChanged(),
  selection: () => useUi.getState().selection,
};
