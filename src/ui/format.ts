/**
 * Number and time formatting. UI.md § Number formatting.
 *
 * Numbers appear everywhere in this game and change constantly, so the rules matter more than
 * they look like they do: never more than 4 significant figures, never a jittering digit, and
 * never `0.00/s` where `idle` is the truth.
 */

/** Roll over to `M` just below 1,000,000 so nothing ever renders as `1000.0K`. */
const K_ROLLOVER = 999_950;

const SUFFIXES = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
] as const;

/**
 * Stockpiles and amounts.
 *
 *   below 10        one decimal      `4.2`, `0.6`
 *   10 – 9,999      integer          `1,240`
 *   10,000 – ~1e6   one decimal + K  `24.6K`
 *   1e6 and up      two decimals     `1.24M`, `3.05B`
 */
export function amount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);

  for (const { limit, suffix } of SUFFIXES) {
    if (magnitude >= limit) return `${sign}${(magnitude / limit).toFixed(2)}${suffix}`;
  }
  if (magnitude >= K_ROLLOVER) return `${sign}${(magnitude / 1e6).toFixed(2)}M`;
  if (magnitude >= 10_000) return `${sign}${(magnitude / 1000).toFixed(1)}K`;
  if (magnitude >= 10) return `${sign}${Math.round(magnitude).toLocaleString('en-US')}`;
  // The first few units of anything matter — buffers and refined goods are floats.
  return `${sign}${magnitude.toFixed(1)}`;
}

/**
 * Rates.
 *
 *   below 10    two decimals   `0.83/s`
 *   below 100   one decimal    `4.2/s`
 *   above       integer        `31/s`
 *
 * A rate that rounds to nothing reads as `idle` rather than `0.00/s`.
 */
export function rate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude < 0.005) return 'idle';

  const sign = value < 0 ? '-' : '';
  if (magnitude < 10) return `${sign}${magnitude.toFixed(2)}/s`;
  if (magnitude < 100) return `${sign}${magnitude.toFixed(1)}/s`;
  return `${sign}${Math.round(magnitude).toLocaleString('en-US')}/s`;
}

/** `4m 12s`, `2h 06m`, `—` for infinite. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';

  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;

  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Elapsed run time, always in `h:mm:ss`-ish register for the status line. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Distance in light-units. */
export function lightUnits(value: number): string {
  return `${Math.round(value)} lu`;
}

/** Latency, as the inspector states it: `18.8s one way`. */
export function latency(seconds: number): string {
  return `${seconds.toFixed(1)}s one way`;
}

export function percent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

const RESOURCE_LABEL: Record<string, string> = {
  hydrogen: 'hydrogen',
  metals: 'metals',
  isotopes: 'isotopes',
  alloy: 'alloy',
  catalyst: 'catalyst',
  core: 'lattice core',
};

export function resourceLabel(resource: string): string {
  return RESOURCE_LABEL[resource] ?? resource;
}

/** Star class as the interface names it. CONTENT.md § Star classes. */
const CLASS_LABEL: Record<string, string> = {
  mdwarf: 'M-dwarf',
  gtype: 'G-type',
  rocky: 'rocky remnant',
  heavy: 'heavy remnant',
  neutron: 'neutron star',
  binary: 'binary',
  anchor: 'wormhole anchor',
};

export function classLabel(cls: string): string {
  return CLASS_LABEL[cls] ?? cls;
}

const ROMAN = ['0', 'I', 'II', 'III', 'IV'];

export function linkTierLabel(tier: number): string {
  return `tier ${ROMAN[tier] ?? tier}`;
}
