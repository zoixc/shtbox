import { PAINT_FINISHES } from '../view3d/paintMaterial';
import type { PaintFinish } from '../view3d/paintMaterial';
import { INTERIOR_MODES, KINDS, MAX_PARTS } from './types';
import type { BodyType, DataConfidence, DataProvenance, Dims, HingeOverride, InteriorMode, Kind, Lines, PanelRegion, PartInfo, Profile, ProfileProvenance, Vec3 } from './types';

const num = (v: unknown, lo = -1000, hi = 1000): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error('bad number');
  return v;
};
const str = (v: unknown, max = 120): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('bad string');
  return v;
};

const LINE_KEYS: (keyof Lines)[] = [
  'bumperFront', 'cowl', 'doorFront', 'roofFront', 'doorSplit', 'roofRear', 'doorRear', 'trunkFront', 'bumperRear',
  'sill', 'belt', 'bumperTopF', 'bumperTopR', 'hoodHw', 'trunkHw',
];
const DIM_KEYS: (keyof Dims)[] = ['L', 'W', 'H', 'xFront', 'xRear', 'axleF', 'axleR', 'track', 'wheelR'];

/** Проверяет и нормализует профиль из файла (недоверенные данные). Бросает Error при нарушении формата. */
export function parseProfile(raw: unknown): Profile {
  try {
    const o = raw as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.v !== 1) throw new Error('version');
    const body = o.body as BodyType;
    if (!['sedan', 'hatch', 'coupe'].includes(body)) throw new Error('body');
    if (o.layout !== 'front' && o.layout !== 'rear') throw new Error('layout');
    if (o.driver !== 'l' && o.driver !== 'r') throw new Error('driver');
    const fr = o.frame as Record<string, unknown>;
    const yaw = num(fr.yaw, 0, 270);
    if (![0, 90, 180, 270].includes(yaw)) throw new Error('yaw');
    const off = fr.offset as unknown[];
    if (!Array.isArray(off) || off.length !== 3) throw new Error('offset');
    const frame = { yaw, scale: num(fr.scale, 1e-6, 1e6), offset: off.map((v) => num(v, -1e6, 1e6)) as Vec3 };
    const d = o.dims as Record<string, unknown>;
    const dims = Object.fromEntries(DIM_KEYS.map((k) => [k, num(d[k])])) as unknown as Dims;
    const l = o.lines as Record<string, unknown>;
    const lines = Object.fromEntries(LINE_KEYS.map((k) => [k, num(l[k])])) as unknown as Lines;
    const paint = (Array.isArray(o.paint) ? o.paint : []).slice(0, 12).map((m) => str(m));
    const pr = o.parts as Record<string, Record<string, unknown>>;
    const ids = Object.keys(pr ?? {});
    if (!ids.length || ids.length > MAX_PARTS) throw new Error('parts');
    const parts: Record<string, PartInfo> = {};
    for (const id of ids) {
      if (!/^p\d{1,4}$/.test(id)) throw new Error('part id');
      const p = pr[id];
      if (!KINDS.includes(p.k as Kind)) throw new Error('kind');
      parts[id] = { n: str(p.n), k: p.k as Kind, m: str(p.m) };
      if (p.confidence !== undefined) {
        if (p.confidence !== 'low' && p.confidence !== 'medium' && p.confidence !== 'high') throw new Error('part confidence');
        parts[id].confidence = p.confidence;
      }
      if (p.z !== undefined) parts[id].z = str(p.z, 40);
      if (p.u) parts[id].u = 1;
      if (p.b) parts[id].b = 1;
    }
    const profile: Profile = {
      v: 1, title: str(o.title), body, layout: o.layout, driver: o.driver, frame, dims, lines, paint, parts,
    };
    const provenance = o.provenance;
    if (provenance === undefined) profile.provenance = { dimensions: 'auto', dimensionsConfidence: 'low', panelBoundaries: 'auto', panelBoundariesConfidence: 'low' };
    else {
      if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('provenance');
      const p = provenance as Record<string, unknown>;
      const valid = (x: unknown): x is DataProvenance => x === 'auto' || x === 'manual' || x === 'document' || x === 'oem';
      const confidence = (source: DataProvenance, value: unknown): DataConfidence => {
        if (value === 'low' || value === 'medium' || value === 'high') return value;
        if (value !== undefined) throw new Error('provenance confidence');
        return source === 'oem' ? 'high' : source === 'document' || source === 'manual' ? 'medium' : 'low';
      };
      if (!valid(p.dimensions) || !valid(p.panelBoundaries)) throw new Error('provenance values');
      const normalized: ProfileProvenance = {
        dimensions: p.dimensions,
        dimensionsConfidence: confidence(p.dimensions, p.dimensionsConfidence),
        panelBoundaries: p.panelBoundaries,
        panelBoundariesConfidence: confidence(p.panelBoundaries, p.panelBoundariesConfidence),
      };
      if (p.reference !== undefined) normalized.reference = str(p.reference, 300);
      profile.provenance = normalized;
    }
    const regions = o.panelRegions;
    if (regions !== undefined) {
      if (!Array.isArray(regions) || regions.length > 48) throw new Error('panel regions');
      profile.panelRegions = regions.map((rawRegion) => {
        const r = rawRegion as Record<string, unknown>;
        if (!r || typeof r !== 'object' || (r.projection !== 'side' && r.projection !== 'top')) throw new Error('panel region');
        if (!Array.isArray(r.points) || r.points.length < 3 || r.points.length > 64) throw new Error('panel points');
        const points = r.points.map((point) => {
          if (!Array.isArray(point) || point.length !== 2) throw new Error('panel point');
          return [num(point[0]), num(point[1])] as [number, number];
        });
        const zone = str(r.zone, 40);
        if (!zone.trim()) throw new Error('panel zone');
        const region: PanelRegion = { zone, projection: r.projection, points };
        if (r.side !== undefined) {
          if (r.side !== 'left' && r.side !== 'right' && r.side !== 'both') throw new Error('panel side');
          region.side = r.side;
        }
        if (r.minAbsZ !== undefined) region.minAbsZ = num(r.minAbsZ, 0, 100);
        if (r.minNormalY !== undefined) region.minNormalY = num(r.minNormalY, 0, 1);
        if (r.kinds !== undefined) {
          if (!Array.isArray(r.kinds) || r.kinds.length > 3 || r.kinds.some((k) => k !== 'paint' && k !== 'glass' && k !== 'trim')) throw new Error('panel kinds');
          region.kinds = [...new Set(r.kinds as Array<'paint' | 'glass' | 'trim'>)];
        }
        return region;
      });
    }
    const c = o.credits as Record<string, unknown> | undefined;
    if (c && typeof c === 'object') {
      profile.credits = {};
      for (const k of ['author', 'license', 'source'] as const) if (typeof c[k] === 'string') profile.credits[k] = str(c[k], 300);
    }
    const h = o.hinges as Record<string, Record<string, unknown>> | undefined;
    if (h && typeof h === 'object') {
      profile.hinges = {};
      for (const [z, v] of Object.entries(h).slice(0, 12)) {
        const hv: HingeOverride = {};
        for (const k of ['x', 'y', 'z', 'angle'] as const) if (v[k] !== undefined) hv[k] = num(v[k], -100, 100);
        if (v.axis !== undefined) {
          if (v.axis !== 'x' && v.axis !== 'y' && v.axis !== 'z') throw new Error('hinge axis');
          hv.axis = v.axis;
        }
        profile.hinges[str(z, 40)] = hv;
      }
    }
    if (o.color !== undefined) {
      if (typeof o.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.color)) throw new Error('color');
      profile.color = o.color.toLowerCase();
    }
    if (o.colorCode !== undefined) {
      if (typeof o.colorCode !== 'string' || o.colorCode.length > 24) throw new Error('colorCode');
      profile.colorCode = o.colorCode.trim();
    }
    if (o.finish !== undefined) {
      if (typeof o.finish !== 'string' || !PAINT_FINISHES.includes(o.finish as (typeof PAINT_FINISHES)[number])) throw new Error('finish');
      profile.finish = o.finish as PaintFinish;
    }
    if (o.interior !== undefined) {
      if (typeof o.interior !== 'string' || !INTERIOR_MODES.includes(o.interior as InteriorMode)) throw new Error('interior mode');
      profile.interior = o.interior as InteriorMode;
    }
    if (o.autoNotes !== undefined) {
      if (!Array.isArray(o.autoNotes) || o.autoNotes.length > 8) throw new Error('auto notes');
      profile.autoNotes = o.autoNotes.map((n) => str(n, 200));
    }
    return profile;
  } catch (e) {
    throw new Error(`Некорректный профиль модели (${(e as Error).message})`);
  }
}
