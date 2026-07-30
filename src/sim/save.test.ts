/**
 * Phase 2 acceptance for persistence. ROADMAP.md Phase 2.
 */

import { describe, expect, test } from 'vitest';
import { conservation } from './audit';
import { SIM_STEP_SECONDS } from './constants';
import { fiveStarNetwork, run, spanningTreeCluster } from './fixtures';
import { recomputeTopology } from './flow';
import { newGame } from './generate';
import {
  deserialize,
  fromJson,
  migrate,
  SAVE_KEY,
  SAVE_VERSION,
  SaveError,
  serialize,
  toJson,
} from './save';
import { tick } from './tick';
import { toAmounts, type GameState } from './types';

/** Everything that must survive a save, in a form that compares structurally. */
function fingerprint(state: GameState) {
  return {
    meta: {
      ...state.meta,
      chartNodes: [...state.meta.chartNodes],
      recipesUnlocked: [...state.meta.recipesUnlocked],
    },
    elapsed: state.run.elapsed,
    seed: state.run.seed,
    coresProduced: state.run.coresProduced,
    upgrades: { ...state.run.upgrades },
    extracted: toAmounts(state.run.extracted),
    granted: toAmounts(state.run.granted),
    vented: toAmounts(state.run.vented),
    consumed: toAmounts(state.run.consumedByRecipes),
    produced: toAmounts(state.run.producedByRecipes),
    stars: state.run.stars.map((star) => ({
      id: star.id,
      x: star.x,
      y: star.y,
      name: star.name,
      cls: star.cls,
      resource: star.resource,
      reserve: star.reserve,
      reserveMax: star.reserveMax,
      baseYield: star.baseYield,
      tier: star.tier,
      throttle: star.throttle,
      buffer: [...star.buffer],
      role: star.role,
      claimed: star.claimed,
      recipes: star.slots.map((slot) => slot.recipe),
      extractionK: star.extractionK,
      routing: star.routing.map((entry) => (entry === null ? null : { ...entry })),
    })),
    links: state.run.links.map((link) => ({
      id: link.id,
      a: link.a,
      b: link.b,
      tier: link.tier,
      length: link.length,
      kind: link.kind,
      queue: link.queue.slice(link.head).map((segment) => ({ ...segment })),
    })),
  };
}

describe('round-tripping', () => {
  test('a fresh game survives serialize and deserialize', () => {
    const original = newGame(20260730);
    const restored = deserialize(serialize(original));
    expect(fingerprint(restored)).toEqual(fingerprint(original));
  });

  test('a played game with in-flight material round-trips losslessly', () => {
    const original = fiveStarNetwork();
    run(original, 12 * 60, SIM_STEP_SECONDS);

    // There has to be something interesting in the save for this to mean anything.
    const inFlight = original.run.links.reduce((n, l) => n + (l.queue.length - l.head), 0);
    expect(inFlight).toBeGreaterThan(0);
    expect(toAmounts(original.run.vented).metals).toBeGreaterThan(0);

    const restored = deserialize(serialize(original));
    expect(fingerprint(restored)).toEqual(fingerprint(original));
  });

  test('survives a JSON string round-trip exactly', () => {
    const original = spanningTreeCluster(20260730);
    run(original, 5 * 60, SIM_STEP_SECONDS);

    const restored = fromJson(toJson(original));
    expect(fingerprint(restored)).toEqual(fingerprint(original));
  });

  test('floats round-trip bit-for-bit, not to some rounded decimal', () => {
    const original = fiveStarNetwork();
    run(original, 137.3, SIM_STEP_SECONDS);
    const restored = fromJson(toJson(original));

    for (let id = 0; id < original.run.stars.length; id++) {
      expect(restored.run.stars[id].reserve).toBe(original.run.stars[id].reserve);
      for (let r = 0; r < 6; r++) {
        expect(restored.run.stars[id].buffer[r]).toBe(original.run.stars[id].buffer[r]);
      }
    }
    expect(restored.run.elapsed).toBe(original.run.elapsed);
  });

  /**
   * The strongest form of the round-trip claim: a restored save is not merely equal on
   * inspection, it *continues identically*. This catches derived state that was saved
   * incorrectly or not rebuilt — a stale topology, a missing merge pointer.
   */
  test('a restored game continues identically for another 10 minutes', () => {
    const original = fiveStarNetwork();
    run(original, 8 * 60, SIM_STEP_SECONDS);

    const restored = deserialize(serialize(original));

    run(original, 10 * 60, SIM_STEP_SECONDS);
    run(restored, 10 * 60, SIM_STEP_SECONDS);

    expect(fingerprint(restored)).toEqual(fingerprint(original));
  });

  test('conservation still closes after a round-trip', () => {
    const original = fiveStarNetwork();
    run(original, 20 * 60, SIM_STEP_SECONDS);
    const restored = deserialize(serialize(original));
    run(restored, 20 * 60, SIM_STEP_SECONDS);

    for (const report of conservation(restored.run)) {
      const scale = Math.max(1, report.supplied);
      expect(Math.abs(report.residual) / scale).toBeLessThan(1e-9);
    }
  });
});

describe('derived state', () => {
  test('is rebuilt on load rather than trusted from the file', () => {
    const original = spanningTreeCluster(20260730);
    const saved = serialize(original);

    // Nothing derived is in the wire format at all.
    expect(saved.run).not.toHaveProperty('topology');
    expect(saved.run.links[0]).not.toHaveProperty('tail');
    expect(saved.run.links[0]).not.toHaveProperty('head');
    expect(saved.run.stars[0].slots[0]).not.toHaveProperty('status');

    const restored = deserialize(saved);
    expect(restored.run.topology.hopDistance).toEqual(
      recomputeTopology(original.run).hopDistance,
    );
    expect(restored.run.links[0].head).toBe(0);
    expect(restored.run.links[0].tail).toHaveLength(12);
  });

  test('does not resurrect segments that were already delivered', () => {
    const original = fiveStarNetwork();
    run(original, 3 * 60, SIM_STEP_SECONDS);

    // Delivered-but-unpruned entries sit before `head`; saving them would invent material.
    const link = original.run.links.find((l) => l.head > 0);
    expect(link).toBeDefined();

    const saved = serialize(original);
    const savedLink = saved.run.links.find((l) => l.id === link!.id);
    expect(savedLink!.queue.length).toBe(link!.queue.length - link!.head);

    const restored = deserialize(saved);
    for (const report of conservation(restored.run)) {
      const scale = Math.max(1, report.supplied);
      expect(Math.abs(report.residual) / scale).toBeLessThan(1e-9);
    }
  });

  test('rebuilds merge pointers so departures after a load still merge', () => {
    const original = fiveStarNetwork();
    run(original, 3 * 60, SIM_STEP_SECONDS);
    const restored = deserialize(serialize(original));

    const before = restored.run.links.map((l) => l.queue.length);
    tick(restored, SIM_STEP_SECONDS);
    const after = restored.run.links.map((l) => l.queue.length);

    // With pointers rebuilt, a tick merges into open buckets rather than appending a fresh
    // segment for every resource on every link.
    const grew = after.reduce((n, len, i) => n + (len - before[i]), 0);
    expect(grew).toBeLessThan(restored.run.links.length * 2);
  });
});

describe('versioning and migration', () => {
  test('the key and version agree', () => {
    expect(SAVE_KEY).toBe(`lightlace.save.v${SAVE_VERSION}`);
  });

  test('every save carries its version', () => {
    expect(serialize(newGame(1)).version).toBe(SAVE_VERSION);
  });

  test('a save from the future is refused rather than misread', () => {
    const saved = serialize(newGame(1)) as unknown as { version: number };
    saved.version = SAVE_VERSION + 1;
    expect(() => deserialize(saved)).toThrow(SaveError);
  });

  test('junk is refused with an explanation, not a crash', () => {
    expect(() => deserialize(null)).toThrow(SaveError);
    expect(() => deserialize(42)).toThrow(SaveError);
    expect(() => deserialize({})).toThrow(SaveError);
    expect(() => fromJson('not json')).toThrow(SaveError);
  });

  test('migrate passes a current save through unchanged', () => {
    const saved = serialize(newGame(1));
    expect(migrate(saved)).toBe(saved);
  });

  test('a resource vector of the wrong width is refused', () => {
    const saved = serialize(newGame(1));
    saved.run.stars[0].buffer = [1, 2, 3];
    expect(() => deserialize(saved)).toThrow(SaveError);
  });
});
