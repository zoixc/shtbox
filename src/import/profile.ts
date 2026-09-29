import { KINDS, MAX_PARTS } from './types';
import type { BodyType, Dims, Kind, Lines, PartInfo, Profile, Vec3 } from './types';

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
      if (p.z !== undefined) parts[id].z = str(p.z, 40);
      if (p.u) parts[id].u = 1;
    }
    const profile: Profile = {
      v: 1, title: str(o.title), body, layout: o.layout, driver: o.driver, frame, dims, lines, paint, parts,
    };
    const c = o.credits as Record<string, unknown> | undefined;
    if (c && typeof c === 'object') {
      profile.credits = {};
      for (const k of ['author', 'license', 'source'] as const) if (typeof c[k] === 'string') profile.credits[k] = str(c[k], 300);
    }
    const h = o.hinges as Record<string, Record<string, unknown>> | undefined;
    if (h && typeof h === 'object') {
      profile.hinges = {};
      for (const [z, v] of Object.entries(h).slice(0, 12)) {
        const hv: Record<string, number> = {};
        for (const k of ['x', 'y', 'z', 'angle']) if (v[k] !== undefined) hv[k] = num(v[k], -100, 100);
        profile.hinges[str(z, 40)] = hv;
      }
    }
    return profile;
  } catch (e) {
    throw new Error(`Некорректный профиль модели (${(e as Error).message})`);
  }
}
