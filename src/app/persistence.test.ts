/**
 * Load, save, and offline catch-up on return. ROADMAP.md Phase 3: "closing the tab for 10
 * minutes and returning produces correct state".
 *
 * The browser check covers the real thing; this covers the wiring, deterministically, so a
 * regression shows up in the suite rather than in a screenshot.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { held } from '../sim/actions';
import { OFFLINE_CAP_SECONDS, SIM_STEP_SECONDS } from '../sim/constants';
import { run, spanningTreeCluster } from '../sim/fixtures';
import { SAVE_KEY } from '../sim/save';
import { clearSave, load, save } from './persistence';

/** Minimal localStorage, since these tests run headless. */
class MemoryStorage {
  private entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: new MemoryStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a fresh start', () => {
  test('generates a cluster when there is nothing saved', () => {
    const result = load(NOW, 20260730);
    expect(result.offline).toBeNull();
    expect(result.loadError).toBeNull();
    expect(result.state.run.elapsed).toBe(0);
    expect(result.state.run.stars.length).toBeGreaterThan(0);
  });

  test('the seed is deterministic when supplied', () => {
    const a = load(NOW, 4242);
    const b = load(NOW, 4242);
    expect(a.state.run.stars.map((s) => s.name)).toEqual(b.state.run.stars.map((s) => s.name));
  });
});

describe('returning after an absence', () => {
  test('ten minutes away is resolved and added to elapsed', () => {
    const state = spanningTreeCluster(20260730);
    run(state, 300, SIM_STEP_SECONDS);
    const elapsedAtSave = state.run.elapsed;
    save(state, NOW);

    const result = load(NOW + 10 * 60 * 1000);

    expect(result.loadError).toBeNull();
    expect(result.offline).not.toBeNull();
    expect(result.offline!.elapsedResolved).toBeCloseTo(600, 6);
    expect(result.offline!.capped).toBe(false);
    expect(result.state.run.elapsed).toBeCloseTo(elapsedAtSave + 600, 3);
  });

  test('the absence actually produced something', () => {
    const state = spanningTreeCluster(20260730);
    run(state, 300, SIM_STEP_SECONDS);
    const alloyAtSave = held(state.run, 'alloy');
    save(state, NOW);

    const result = load(NOW + 30 * 60 * 1000);
    expect(held(result.state.run, 'alloy')).toBeGreaterThan(alloyAtSave);
  });

  test('an absence past the cap resolves 14 hours and reports it', () => {
    const state = spanningTreeCluster(20260730);
    save(state, NOW);

    const result = load(NOW + 26 * 60 * 60 * 1000);
    expect(result.offline!.capped).toBe(true);
    expect(result.offline!.elapsedResolved).toBe(OFFLINE_CAP_SECONDS);
  });

  test('no time away means no resolution at all', () => {
    const state = spanningTreeCluster(20260730);
    run(state, 60, SIM_STEP_SECONDS);
    save(state, NOW);

    const result = load(NOW);
    expect(result.offline).toBeNull();
    expect(result.state.run.elapsed).toBeCloseTo(60, 6);
  });

  test('a clock that ran backwards is treated as no time at all, not negative time', () => {
    const state = spanningTreeCluster(20260730);
    save(state, NOW);
    const result = load(NOW - 60_000);
    expect(result.state.run.elapsed).toBe(0);
  });
});

describe('a save that cannot be read', () => {
  test('starts a fresh cluster and says so rather than failing silently', () => {
    window.localStorage.setItem(SAVE_KEY, '{not json');

    const result = load(NOW, 20260730);
    expect(result.loadError).not.toBeNull();
    expect(result.loadError).toContain('Starting a new cluster');
    expect(result.state.run.elapsed).toBe(0);
  });

  test('a save from a future version is refused rather than misread', () => {
    const state = spanningTreeCluster(20260730);
    save(state, NOW);
    const stored = JSON.parse(window.localStorage.getItem(SAVE_KEY)!);
    stored.version = 99;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(stored));

    const result = load(NOW, 1);
    expect(result.loadError).toContain('newer than this build');
  });
});

describe('storage handling', () => {
  test('clearing removes the save', () => {
    save(spanningTreeCluster(1), NOW);
    expect(window.localStorage.getItem(SAVE_KEY)).not.toBeNull();
    clearSave();
    expect(window.localStorage.getItem(SAVE_KEY)).toBeNull();
  });

  test('an unavailable storage does not stop the game starting', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        // Private browsing throws on access rather than returning null.
        throw new Error('denied');
      },
    });

    expect(() => save(spanningTreeCluster(1), NOW)).not.toThrow();
    const result = load(NOW, 7);
    expect(result.state.run.stars.length).toBeGreaterThan(0);
    expect(result.offline).toBeNull();
  });
});
