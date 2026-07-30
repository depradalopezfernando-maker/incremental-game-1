/**
 * UI.md § Inspector. Selection-dependent, three cases: star, link, nothing.
 *
 * The player's core activity is diagnosis, so every panel is built to answer "what is wrong
 * here and what do I do about it" — a stalled slot names the missing input, a full buffer says
 * so, and a reserve shows its time to empty.
 */

import { useMemo } from 'react';
import {
  canDesignateHub,
  canUndesignateHub,
  canUpgradeNode,
  capacityOfStar,
  designateHub,
  held,
  hubDesignateCostOf,
  nodeUpgradeCostOf,
  portsTotal,
  portsUsed,
  setSlotRecipe,
  setThrottle,
  undesignateHub,
  upgradeNode,
} from '../sim/actions';
import { LINK_BANDWIDTH, linkLatency, RECIPES } from '../sim/constants';
import { linkThroughput } from '../sim/flow';
import { scratchFor } from '../sim/tick';
import {
  RESOURCES,
  RESOURCE_INDEX,
  type GameState,
  type RecipeId,
  type Star,
} from '../sim/types';
import { VENT_VISIBLE_SECONDS } from '../app/hud';
import { ui, useUi } from '../app/store';
import styles from './app.module.css';
import {
  amount,
  classLabel,
  duration,
  latency as formatLatency,
  lightUnits,
  linkTierLabel,
  percent,
  rate,
  resourceLabel,
} from './format';

interface Props {
  readonly state: GameState;
}

export function Inspector({ state }: Props): JSX.Element {
  const selection = useUi((store) => store.selection);
  // The snapshot ticks at HUD rate and the world version bumps on every action; between them
  // the panel refreshes often enough to feel live without re-rendering at simulation rate.
  const snapshot = useUi((store) => store.snapshot);
  const worldVersion = useUi((store) => store.worldVersion);
  void snapshot;
  void worldVersion;

  if (selection.kind === 'star') {
    const star = state.run.stars[selection.id];
    if (star === undefined) return <NetworkPanel state={state} />;
    return <StarPanel state={state} star={star} />;
  }

  if (selection.kind === 'link') {
    const link = state.run.links[selection.id];
    if (link === undefined) return <NetworkPanel state={state} />;
    return <LinkPanel state={state} linkId={selection.id} />;
  }

  return <NetworkPanel state={state} />;
}

// ---------------------------------------------------------------------------

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <>
      <span className={styles.rowKey}>{k}</span>
      <span className={styles.rowValue}>{v}</span>
    </>
  );
}

function Action({
  label,
  cost,
  outcome,
  onClick,
}: {
  label: string;
  cost?: string | undefined;
  outcome: { readonly ok: boolean; readonly reason?: string | undefined };
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.button}
      disabled={!outcome.ok}
      // The refusal reason is the tooltip, in the interface's voice rather than an apology.
      title={outcome.ok ? undefined : outcome.reason}
      onClick={onClick}
    >
      {label}
      {cost !== undefined && <span className={styles.buttonCost}>{cost}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------

function StarPanel({ state, star }: { state: GameState; star: Star }): JSX.Element {
  const run = state.run;
  const capacity = capacityOfStar(run, star.id);
  const dead = star.resource !== null && star.reserve <= 0;
  const venting = star.lastVentAt >= 0 && run.elapsed - star.lastVentAt <= VENT_VISIBLE_SECONDS;

  const extractionRate = star.baseYield * star.throttle;
  const timeToEmpty = extractionRate > 0 ? star.reserve / extractionRate : Infinity;

  const upgrade = canUpgradeNode(run, star.id);
  const designate = canDesignateHub(run, star.id);
  const undesignate = canUndesignateHub(run, star.id);

  return (
    <div>
      <h2 className={styles.title}>{star.name}</h2>
      <p className={styles.subtitle}>
        {classLabel(star.cls)}
        {star.resource !== null && ` · ${resourceLabel(star.resource)}`}
        {star.role === 'hub' && ' · hub'}
        {dead && ' · exhausted'}
      </p>

      {venting && (
        <p className={`${styles.section} ${styles.venting}`}>
          Venting. Material is being destroyed here.
        </p>
      )}

      {star.resource !== null && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>reserve</div>
          <div className={styles.meter}>
            <div
              className={styles.meterFill}
              style={{
                width: percent(star.reserveMax > 0 ? star.reserve / star.reserveMax : 0),
              }}
            />
          </div>
          <div className={styles.rows}>
            <Row k="remaining" v={`${amount(star.reserve)} of ${amount(star.reserveMax)}`} />
            <Row k="extracting" v={rate(extractionRate)} />
            <Row k="time to empty" v={dead ? 'exhausted' : duration(timeToEmpty)} />
          </div>
        </div>
      )}

      {star.resource !== null && !dead && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>throttle · {percent(star.throttle)}</div>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={100}
            value={Math.round(star.throttle * 100)}
            aria-label={`Throttle for ${star.name}`}
            onChange={(event) => {
              setThrottle(run, star.id, Number(event.target.value) / 100);
              ui.worldChanged();
            }}
          />
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionLabel}>node</div>
        <div className={styles.rows}>
          <Row k="tier" v={String(star.tier)} />
          <Row k="ports" v={`${portsUsed(run, star.id)}/${portsTotal(run, star.id)}`} />
          <Row k="buffer" v={`${amount(capacity)} each`} />
        </div>
        <Action
          label={star.tier >= 4 ? 'Node at tier 4' : `Upgrade node to tier ${star.tier + 1}`}
          cost={star.tier >= 4 ? undefined : `${amount(nodeUpgradeCostOf(run, star.id))} alloy`}
          outcome={upgrade}
          onClick={() => {
            upgradeNode(run, star.id);
            ui.worldChanged();
          }}
        />
        {star.role === 'hub' ? (
          <Action
            label="Un-designate hub"
            outcome={undesignate}
            onClick={() => {
              undesignateHub(run, star.id);
              ui.worldChanged();
            }}
          />
        ) : (
          <Action
            label="Designate as hub"
            cost={`${amount(hubDesignateCostOf(run))} alloy`}
            outcome={designate}
            onClick={() => {
              designateHub(run, star.id);
              ui.worldChanged();
            }}
          />
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>buffer</div>
        <div className={styles.rows}>
          {RESOURCES.map((resource) => {
            const value = star.buffer[RESOURCE_INDEX[resource]];
            if (value <= 0) return null;
            return (
              <Row
                key={resource}
                k={resourceLabel(resource)}
                v={`${amount(value)}${value >= capacity - 1e-6 ? ' · full' : ''}`}
              />
            );
          })}
        </div>
        {RESOURCES.every((r) => star.buffer[RESOURCE_INDEX[r]] <= 0) && (
          <p className={styles.empty}>Empty.</p>
        )}
      </div>

      {star.role === 'hub' && <Slots state={state} star={star} />}
    </div>
  );
}

/**
 * Slot assignment, including the ability to stop a slot.
 *
 * Stopping matters more than it looks: the opening 300 metals is both the link budget and the
 * alloy refinery's feedstock, and a slot left running eats the metals the player needs for
 * their first link. Without a way to turn it off, dawdling for four minutes leaves you unable
 * to build anything and unable to mine more metals — see OPEN_QUESTIONS.md.
 */
function Slots({ state, star }: { state: GameState; star: Star }): JSX.Element {
  const unlocked = state.meta.recipesUnlocked;

  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>recipe slots</div>
      {star.slots.map((slot, index) => (
        <div key={index} className={styles.slot}>
          <div
            className={
              slot.status.kind === 'starved' || slot.status.kind === 'backedUp'
                ? `${styles.slotStatus} ${styles.stalled}`
                : styles.slotStatus
            }
          >
            {slotStatusText(slot.status)}
          </div>
          <select
            className={styles.slotSelect}
            value={slot.recipe ?? ''}
            aria-label={`Recipe for slot ${index + 1} on ${star.name}`}
            onChange={(event) => {
              const value = event.target.value;
              setSlotRecipe(state.run, star.id, index, value === '' ? null : (value as RecipeId));
              ui.worldChanged();
            }}
          >
            <option value="">stopped</option>
            {unlocked.map((id) => (
              <option key={id} value={id}>
                {resourceLabel(RECIPES[id].output)}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

function slotStatusText(status: Star['slots'][number]['status']): string {
  switch (status.kind) {
    case 'idle':
      return 'idle';
    case 'running':
      return `running at ${percent(status.fraction)}`;
    // A stalled slot must say *which* input is missing — this is the core diagnostic loop.
    case 'starved':
      return `stalled — no ${status.missing.map(resourceLabel).join(', no ')}`;
    case 'backedUp':
      return `stalled — ${resourceLabel(status.output)} buffer full`;
  }
}

// ---------------------------------------------------------------------------

function LinkPanel({ state, linkId }: { state: GameState; linkId: number }): JSX.Element {
  const run = state.run;
  const link = run.links[linkId];
  const a = run.stars[link.a];
  const b = run.stars[link.b];
  const scratch = scratchFor(run);

  const bandwidth = LINK_BANDWIDTH[link.tier];
  const carried = linkThroughput(scratch, link.id);
  const utilisation = bandwidth > 0 ? carried / bandwidth : 0;

  const perResource = useMemo(() => {
    const rows: { resource: string; value: number }[] = [];
    for (const resource of RESOURCES) {
      let total = 0;
      for (let i = link.head; i < link.queue.length; i++) {
        if (link.queue[i].resource === resource) total += link.queue[i].amount;
      }
      if (total > 0) rows.push({ resource, value: total });
    }
    return rows;
  }, [link, link.head, link.queue.length]);

  return (
    <div>
      <h2 className={styles.title}>
        {a.name} — {b.name}
      </h2>
      <p className={styles.subtitle}>{linkTierLabel(link.tier)}</p>

      <div className={styles.section}>
        <div className={styles.rows}>
          <Row k="length" v={lightUnits(link.length)} />
          <Row k="latency" v={formatLatency(linkLatency(link.length, link.tier))} />
          <Row k="bandwidth" v={rate(bandwidth)} />
          <Row k="carrying" v={rate(carried)} />
        </div>
        <div className={styles.meter}>
          <div className={styles.meterFill} style={{ width: percent(Math.min(1, utilisation)) }} />
        </div>
        <div className={styles.rows}>
          <Row k="utilisation" v={percent(utilisation)} />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>in transit</div>
        {perResource.length === 0 ? (
          <p className={styles.empty}>Nothing in flight.</p>
        ) : (
          <div className={styles.rows}>
            {perResource.map((row) => (
              <Row key={row.resource} k={resourceLabel(row.resource)} v={amount(row.value)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NetworkPanel({ state }: { state: GameState }): JSX.Element {
  const snapshot = useUi((store) => store.snapshot);
  const summary = snapshot.summary;

  return (
    <div>
      <h2 className={styles.title}>Network</h2>
      <p className={styles.subtitle}>Nothing selected.</p>

      <div className={styles.section}>
        <div className={styles.rows}>
          <Row k="throughput" v={rate(summary.throughput)} />
          <Row k="stars claimed" v={String(summary.claimedStars)} />
          <Row k="links" v={String(summary.linkCount)} />
          <Row k="stalled hubs" v={String(summary.stalledHubs)} />
          <Row k="venting stars" v={String(summary.ventingStars)} />
          <Row k="under 5 min reserve" v={String(summary.expiringStars)} />
          <Row k="exhausted stars" v={String(summary.deadStars)} />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>holdings</div>
        <div className={styles.rows}>
          <Row k="metals" v={amount(held(state.run, 'metals'))} />
          <Row k="alloy" v={amount(held(state.run, 'alloy'))} />
        </div>
      </div>

      <p className={styles.empty}>
        Click a star or a link to inspect it. Drag from a claimed star to an unclaimed one to
        build a link.
      </p>
    </div>
  );
}
