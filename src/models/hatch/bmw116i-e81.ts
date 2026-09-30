import type { SedanSpec } from '../sedan/build';
import type { ZoneDef } from '../types';
import { SEDAN_ZONES } from '../sedan/solaris';

/** Auto-Data data for the E81 116i 122 Hp Steptronic (2009–2011). Overhang split is photo-estimated. */
export const BMW116I_E81_DIMENSIONS = {
  length: 4.239,
  width: 1.748,
  height: 1.421,
  wheelbase: 2.66,
  frontTrack: 1.484,
  rearTrack: 1.497,
  groundClearance: 0.145,
  // The catalog lists total length and wheelbase, not separate E81 overhangs.
  // The split is an approximate fit to the E81 side photos, not a factory figure.
  frontOverhangApprox: 0.737,
  rearOverhangApprox: 0.842,
} as const;

/**
 * BMW 116i E81 (3-door hatchback, 2009–2011). Geometry is a photo-guided procedural approximation,
 * not OEM/CAD. Published dimensions, tracks, clearance and 195/55 R16 tyre size:
 * https://www.auto-data.net/en/bmw-1-series-hatchback-3dr-e81-116i-122hp-steptronic-9797
 * Body reference photos (including the side view) are on the E81 generation page:
 * https://www.auto-data.net/en/bmw-1-series-hatchback-3dr-e81-generation-3846
 */
const WB_HALF = BMW116I_E81_DIMENSIONS.wheelbase / 2;
const X_FRONT = WB_HALF + BMW116I_E81_DIMENSIONS.frontOverhangApprox;
const X_REAR = -WB_HALF - BMW116I_E81_DIMENSIONS.rearOverhangApprox;
/** Cross-sections from the short front overhang through the long 3-door to the steep hatch. */
const KX = [X_FRONT, 2.005, 1.82, WB_HALF, 0.73, 0.15, -0.78, -1.22, -1.62, -1.95, X_REAR];
const zip = (values: number[]): [number, number][] => values.map((value, i) => [KX[i], value]);
// Fit the lofted shell envelope to the published body width, height and ride clearance.
// These tiny profile transforms are geometric calibration, not additional OEM measurements.
const BODY_Y_SCALE = 0.9988037631231714;
const BODY_Y_OFFSET = -0.007410062497413494;
const BODY_Z_SCALE = 0.9888664023986437;
const fitY = (profile: [number, number][]): [number, number][] => profile.map(([x, y]) => [x, y * BODY_Y_SCALE + BODY_Y_OFFSET]);
const fitZ = (profile: [number, number][]): [number, number][] => profile.map(([x, z]) => [x, z * BODY_Z_SCALE]);
const fitRise = (profile: [number, number][]): [number, number][] => profile.map(([x, y]) => [x, y * BODY_Y_SCALE]);

export const BMW116I_E81_SPEC: SedanSpec = {
  style: 'bmw-e81-2009',
  sideDoors: 3,
  tail: 'hatch',
  drive: 'rwd',
  grille: 'kidney',
  xFront: X_FRONT,
  xRear: X_REAR,
  frontAxleX: WB_HALF,
  rearAxleX: -WB_HALF,
  trackHalf: (BMW116I_E81_DIMENSIONS.frontTrack + BMW116I_E81_DIMENSIONS.rearTrack) / 4,
  frontTrackHalf: BMW116I_E81_DIMENSIONS.frontTrack / 2,
  rearTrackHalf: BMW116I_E81_DIMENSIONS.rearTrack / 2,
  // Nominal 195/55 R16 outside diameter = 406.4 + 2×107.25 = 620.9 mm.
  wheelR: 0.31045,
  tireW: 0.195,
  archR: 0.365,
  x: {
    bumperFront: 1.9,
    cowl: 0.73,
    doorFront: 0.66,
    roofFront: 0.15,
    doorSplit: -0.78,
    roofRear: -1.22,
    doorRear: -0.78,
    trunkFront: -1.62,
    bumperRear: -1.95,
  },
  body: {
    glassRise: 0.045 * BODY_Y_SCALE,
    profile: {
      yBot: fitY(zip([0.34, 0.28, 0.21, 0.17, 0.16, 0.16, 0.16, 0.18, 0.26, 0.31, 0.34])),
      wBot: fitZ(zip([0.52, 0.58, 0.63, 0.64, 0.65, 0.65, 0.65, 0.64, 0.6, 0.55, 0.5])),
      yS: fitY(zip([0.44, 0.38, 0.31, 0.27, 0.26, 0.26, 0.26, 0.28, 0.36, 0.42, 0.46])),
      wS: fitZ(zip([0.62, 0.72, 0.82, 0.85, 0.86, 0.86, 0.85, 0.84, 0.8, 0.74, 0.64])),
      wM: fitZ(zip([0.69, 0.78, 0.85, 0.87, 0.874, 0.874, 0.87, 0.86, 0.83, 0.76, 0.68])),
      yBelt: fitY(zip([0.68, 0.71, 0.75, 0.82, 0.9, 0.94, 0.95, 0.94, 0.92, 0.9, 0.86])),
      // Long bonnet, compact cabin, short rear side glass and sharply sloped hatchback tail.
      yC: fitY([
        [X_FRONT, 0.77], [2.005, 0.82], [1.82, 0.88], [WB_HALF, 0.94], [0.73, 1.0],
        [0.42, 1.17], [0.15, 1.33], [-0.18, 1.41], [-0.55, BMW116I_E81_DIMENSIONS.height], [-0.85, 1.415],
        [-1.08, 1.37], [-1.22, 1.3], [-1.42, 1.17], [-1.62, 1.02], [-1.85, 0.98], [-2.04, 0.94], [X_REAR, 0.91],
      ]),
      wG: fitZ(zip([0.48, 0.57, 0.68, 0.73, 0.77, 0.79, 0.77, 0.71, 0.66, 0.59, 0.53])),
      wR: fitZ(zip([0.4, 0.46, 0.54, 0.58, 0.61, 0.63, 0.62, 0.57, 0.52, 0.48, 0.44])),
      crown: fitRise(zip([0.02, 0.02, 0.02, 0.025, 0.03, 0.035, 0.035, 0.03, 0.02, 0.02, 0.02])),
    },
  },
};

const tailgate = (zone: ZoneDef): ZoneDef => (zone.id === 'trunk' ? { ...zone, label: 'Задняя дверь (багажник)' } : zone);
/** E81 is a 3-door: retain front doors and fixed rear quarter windows, remove rear-door zones. */
export const BMW116I_E81_ZONES: ZoneDef[] = SEDAN_ZONES
  .filter((zone) => !['rear_glass', 'door_rl', 'door_rr'].includes(zone.id))
  .map(tailgate);
