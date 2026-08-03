/**
 * UI.md § Layout. Resource bar across the top, map filling everything it can, inspector in a
 * fixed right rail that never overlays the map, a strip beneath the map for messages.
 *
 * The map is the game; everything else is chrome.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfflineResult } from '../sim/offline';
import type { GameState } from '../sim/types';
import { startLoop } from '../app/loop';
import { discardRun } from '../app/persistence';
import { useUi } from '../app/store';
import styles from './app.module.css';
import { amount, duration, resourceLabel } from './format';
import { Inspector } from './Inspector';
import { ResourceBar } from './ResourceBar';
import { StarMap } from './StarMap';

interface Props {
  readonly state: GameState;
  readonly arrival: OfflineResult | null;
  readonly loadError: string | null;
}

export function App({ state, arrival, loadError }: Props): JSX.Element {
  const drawRef = useRef<(() => void) | null>(null);
  const notify = useUi((store) => store.notify);

  const onReady = useCallback((drawFrame: () => void) => {
    drawRef.current = drawFrame;
  }, []);

  useEffect(() => {
    const loop = startLoop(state, () => drawRef.current?.());
    return () => loop.stop();
  }, [state]);

  // Say what happened while the player was away, before they wonder. The full arrival summary
  // screen with cause attribution is Phase 6; this is the honest one-line version.
  useEffect(() => {
    if (loadError !== null) {
      notify(loadError, 'refusal');
      return;
    }
    if (arrival !== null) notify(arrivalLine(arrival));
  }, [arrival, loadError, notify]);

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <ResourceBar />
      </div>
      <div className={styles.map}>
        <StarMap state={state} onReady={onReady} />
      </div>
      <div className={styles.inspector}>
        <Inspector state={state} />
      </div>
      <div className={styles.strip}>
        <NoticeLine />
      </div>
    </div>
  );
}

function NoticeLine(): JSX.Element {
  const notice = useUi((store) => store.notice);

  return (
    <>
      <span className={notice?.tone === 'refusal' ? styles.noticeRefusal : styles.notice}>
        {notice?.text ?? ''}
      </span>
      <span className={styles.hint}>
        drag to pan · wheel to zoom · drag star to star to link
      </span>
      <ResetRun />
    </>
  );
}

/**
 * Discard the run and generate a new cluster.
 *
 * Two-step rather than a dialog: UI.md permits no modals during play, and this erases
 * everything. The wording says what is actually lost rather than asking "are you sure".
 *
 * Reloading is the simplest correct way to start over — it re-runs the same load path a
 * returning player takes, so there is no second code path that builds a fresh game slightly
 * differently. `discardRun` has to come first, because the reload fires `visibilitychange` and
 * the loop would otherwise save the run being discarded straight back over the empty slot.
 */
function ResetRun(): JSX.Element {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    // Disarm if the player thinks better of it and looks away.
    const timer = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={armed ? `${styles.reset} ${styles.resetArmed}` : styles.reset}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        discardRun();
        window.location.reload();
      }}
    >
      {armed ? 'Confirm — discard this cluster' : 'New cluster'}
    </button>
  );
}

/** How many depleted stars to name before summarising the rest. */
const MAX_NAMED_DEPLETIONS = 4;

/**
 * CONTENT.md § Arrival summary: name the specific cause, and if the absence exceeded the cap,
 * say so rather than silently resolving less time than elapsed.
 */
function arrivalLine(result: OfflineResult): string {
  if (result.elapsedResolved < 1) return '';

  const away = result.capped
    ? `Away ${duration(result.elapsedRequested)} · ${duration(result.elapsedResolved)} resolved (maximum)`
    : `Away ${duration(result.elapsedResolved)}`;

  const produced = Object.entries(result.produced)
    .filter(([, value]) => value > 0.05)
    .map(([resource, value]) => `${amount(value)} ${resourceLabel(resource)}`)
    .join(' · ');

  const parts = [away];
  parts.push(produced.length > 0 ? `Produced ${produced}` : 'Produced nothing');

  if (result.depleted.length > 0) {
    // A long absence can exhaust the whole cluster; naming forty stars in one line helps
    // nobody. The full accounting belongs in the arrival summary screen in Phase 6.
    const named = result.depleted.slice(0, MAX_NAMED_DEPLETIONS).map((event) => event.name);
    const rest = result.depleted.length - named.length;
    parts.push(
      rest > 0
        ? `Depleted ${named.join(', ')} and ${rest} more`
        : `Depleted ${named.join(', ')}`,
    );
  }

  const worst = result.vented[0];
  if (worst === undefined) {
    parts.push('Vented nothing');
  } else {
    parts.push(
      `Vented ${amount(worst.amount)} ${resourceLabel(worst.resource)} at ${worst.name} ` +
        `over ${duration(worst.seconds)}`,
    );
  }

  return parts.join('. ') + '.';
}
