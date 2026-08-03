/**
 * Star designations. CONTENT.md § Star naming: two-part, a name from a fixed pool plus
 * a numeral. Names must be ≤8 characters because they render on the map at small sizes,
 * and the pool should read like a real catalogue — navigational, mythological and
 * mundane-technical, no invented fantasy words.
 *
 * The first 30 are the seeds listed in CONTENT.md; the rest continue the register.
 */
export const NAME_POOL: readonly string[] = [
  // CONTENT.md § Star naming, verbatim
  'Vela',
  'Kestrel',
  'Anwen',
  'Mira',
  'Corvid',
  'Tessel',
  'Bright',
  'Halden',
  'Onyx',
  'Farrow',
  'Sable',
  'Pell',
  'Wick',
  'Marrow',
  'Quill',
  'Reed',
  'Vane',
  'Ash',
  'Loom',
  'Kite',
  'Drift',
  'Cinder',
  'Hollow',
  'Latch',
  'Pike',
  'Bell',
  'Crane',
  'Ember',
  'Fenn',
  'Grove',
  // navigational
  'Sextant',
  'Rudder',
  'Beacon',
  'Cairn',
  'Fathom',
  'Gimbal',
  'Plumb',
  'Sounder',
  'Transit',
  'Bearing',
  'Lodestar',
  'Azimuth',
  // mythological
  'Orpheus',
  'Nemesis',
  'Theseus',
  'Icarus',
  'Hecate',
  'Perseus',
  'Aeolus',
  'Charon',
  'Thetis',
  // mundane-technical
  'Ballast',
  'Bracket',
  'Spindle',
  'Ratchet',
  'Flange',
  'Grommet',
  'Trestle',
  'Dowel',
  'Gasket',
];

export const NAME_NUMERAL_MAX = 40;
