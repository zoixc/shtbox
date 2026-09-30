/**
 * Разбор деталей модели по узлам автомобиля (чистая геометрия, без three.js).
 * Кузов у многих моделей цельный, поэтому панели «вырезаются» по треугольникам: граница между
 * узлами проходит по линиям профиля (`Profile.lines`), а треугольники у границы
 * адаптивно делятся, чтобы срез получался ровным (~2–3 см).
 */
import type { BodyType, Kind, Lines, Profile, Vec3 } from './types';

export interface Zoner {
  paint(c: Vec3, n: Vec3): string;
  trim(c: Vec3, n: Vec3): string;
  glass(c: Vec3, n: Vec3): string;
  light(c: Vec3): string;
  interior(c: Vec3): string;
  wheel(c: Vec3): string;
  brake(c: Vec3): string;
}

const sd = (z: number) => (z < 0 ? 'l' : 'r');

function pointInPolygon(x: number, y: number, points: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-8 && x >= Math.min(xi, xj) - 1e-8 && x <= Math.max(xi, xj) + 1e-8 && y >= Math.min(yi, yj) - 1e-8 && y <= Math.max(yi, yj) + 1e-8) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function makeZoner(pr: Profile): Zoner {
  const L: Lines = pr.lines;
  const hw = pr.dims.W / 2;
  const coupe = pr.body === 'coupe';
  const axleMid = (pr.dims.axleF + pr.dims.axleR) / 2;
  const doorOf = (x: number, z: number): string => (coupe || x >= L.doorSplit ? `door_f${sd(z)}` : `door_r${sd(z)}`);
  const regions = (pr.panelRegions ?? []).map((region) => {
    const first = region.points.map((p) => p[0]);
    const second = region.points.map((p) => p[1]);
    return {
      ...region,
      minFirst: Math.min(...first), maxFirst: Math.max(...first),
      minSecond: Math.min(...second), maxSecond: Math.max(...second),
    };
  });
  const maskedZones = new Set(regions.map((r) => r.zone));

  const panelZone = (kind: 'paint' | 'glass' | 'trim', c: Vec3, n: Vec3): string | null => {
    for (const r of regions) {
      if (r.kinds && !r.kinds.includes(kind)) continue;
      const first = c[0];
      const second = r.projection === 'side' ? c[1] : c[2];
      if (first < r.minFirst - 1e-8 || first > r.maxFirst + 1e-8 || second < r.minSecond - 1e-8 || second > r.maxSecond + 1e-8) continue;
      if (r.projection === 'side') {
        if (r.minAbsZ !== undefined && Math.abs(c[2]) < r.minAbsZ) continue;
        if (r.side === 'left' && c[2] >= 0) continue;
        if (r.side === 'right' && c[2] <= 0) continue;
      } else {
        if (r.minNormalY !== undefined && n[1] < r.minNormalY) continue;
        if (r.side === 'left' && c[2] >= 0) continue;
        if (r.side === 'right' && c[2] <= 0) continue;
      }
      if (!pointInPolygon(first, second, r.points)) continue;
      return r.zone;
    }
    return null;
  };

  const paintByLines = (c: Vec3, n: Vec3): string => {
    const [x, y, z] = c;
    const az = Math.abs(z);
    if (x >= L.bumperFront && y < L.bumperTopF) return 'bumper_f';
    if (x <= L.bumperRear && y < L.bumperTopR) return 'bumper_r';
    if (x > L.doorFront) {
      if (x >= L.cowl) {
        if (az <= L.hoodHw && y >= L.bumperTopF * 0.85 && (n[1] > 0.3 || n[0] > 0.5)) return 'hood';
        return `fender_f${sd(z)}`;
      }
      return y > L.belt ? 'roof' : `fender_f${sd(z)}`;
    }
    if (x >= L.doorRear) {
      if (y < L.sill) return `sill_${sd(z)}`;
      if (y > L.belt) return 'roof';
      if (az > 0.5 * hw) return doorOf(x, z);
      return `sill_${sd(z)}`;
    }
    if (x < L.trunkFront && az <= L.trunkHw && y >= L.bumperTopR * 0.85 && (n[1] > 0.3 || n[0] < -0.5)) return 'trunk';
    if (x >= L.trunkFront && y > L.belt) return 'roof';
    return `quarter_r${sd(z)}`;
  };

  // Если для этой зоны задан авторский контур, не возвращаемся к прямоугольному plane-cut за его пределами.
  const avoidUnmaskedPanel = (zone: string, c: Vec3): string => {
    if (!maskedZones.has(zone)) return zone;
    const [x, y, z] = c;
    if (zone.startsWith('door_')) {
      const side = sd(z);
      if (y < L.sill + 0.06) return `sill_${side}`;
      if (y >= L.belt) return 'roof';
      if (x >= L.doorFront) return `fender_f${side}`;
      if (x <= L.doorRear) return `quarter_r${side}`;
      return y < (L.sill + L.belt) / 2 ? `sill_${side}` : `quarter_r${side}`;
    }
    if (zone === 'hood') return `fender_f${sd(z)}`;
    if (zone === 'trunk') {
      if (x <= L.bumperRear && y < L.bumperTopR) return 'bumper_r';
      return `quarter_r${sd(z)}`;
    }
    return zone;
  };
  const routePanel = (kind: 'paint' | 'glass' | 'trim', c: Vec3, n: Vec3, byLines: string): string =>
    panelZone(kind, c, n) ?? avoidUnmaskedPanel(byLines, c);

  const paint = (c: Vec3, n: Vec3): string => routePanel('paint', c, n, paintByLines(c, n));

  const trimByLines = (c: Vec3, n: Vec3): string => {
    const [x, y, z] = c;
    // зеркала, рамки окон: над поясом в зоне дверей — к двери
    if (x >= L.doorRear && x <= L.doorFront && y > L.belt - 0.1 && y < L.belt + 0.5 && Math.abs(z) > 0.7 * hw) return doorOf(x, z);
    return paintByLines(c, n);
  };
  const trim = (c: Vec3, n: Vec3): string => routePanel('trim', c, n, trimByLines(c, n));

  const glassByLines = (c: Vec3, n: Vec3): string => {
    const [x, , z] = c;
    const side = Math.abs(n[2]) > Math.abs(n[0]) && Math.abs(z) > 0.45 * hw;
    if (side) {
      if (x >= L.doorRear - 0.02) return doorOf(x, z);
      return `quarter_r${sd(z)}`;
    }
    if (x > (L.roofFront + L.roofRear) / 2) return 'windshield';
    return pr.body === 'hatch' ? 'trunk' : 'rear_glass';
  };
  const glass = (c: Vec3, n: Vec3): string => routePanel('glass', c, n, glassByLines(c, n));

  const light = (c: Vec3) => (c[0] >= axleMid ? 'lights_f' : 'lights_r');

  const driverZ = (pr.driver === 'l' ? -1 : 1) * 0.3 * hw;
  const seatSplit = coupe ? L.doorRear : L.doorSplit - 0.1;
  const interior = (c: Vec3): string => {
    const [x, y, z] = c;
    if (Math.hypot(x - (L.cowl - 0.45), y - L.belt * 0.97, z - driverZ) < 0.28) return 'steering';
    if (y < L.sill + 0.2) return 'floor';
    if (y > L.belt + 0.3) return 'headliner';
    if (x >= L.cowl - 0.55) return 'dashboard';
    if (Math.abs(z) < 0.2 * hw && y < L.belt) return 'console';
    if (x >= seatSplit) return z < 0 ? 'seat_fl' : 'seat_fr';
    return 'seat_r';
  };

  const wheel = (c: Vec3) => `wheel_${c[0] >= axleMid ? 'f' : 'r'}${sd(c[2])}`;
  const brake = (c: Vec3) => (c[0] >= axleMid ? 'brakes_f' : 'brakes_r');
  return { paint, trim, glass, light, interior, wheel, brake };
}

/** Узлы, которых нет у данного типа кузова, переадресуются на существующие. */
export function remapZone(zone: string, body: BodyType): string {
  if (body === 'hatch' && zone === 'rear_glass') return 'trunk';
  if (body === 'coupe' && (zone === 'door_rl' || zone === 'door_rr')) return zone.replace('door_r', 'door_f');
  return zone;
}

export interface Soup {
  /** 9 чисел на треугольник */
  pos: number[];
  nor: number[];
}

const MAX_SPLIT_TRIS = 400_000;

/**
 * Делит треугольник по зонам. Если вершины и центр попадают в разные узлы, а ребро длиннее `minEdge`,
 * то длиннейшее ребро делится пополам и процедура повторяется.
 */
export function splitInto(
  pos: ArrayLike<number>,
  nor: ArrayLike<number>,
  zoneFn: (c: Vec3, n: Vec3) => string,
  out: Map<string, Soup>,
  budget: { left: number },
  minEdge = 0.025,
): void {
  const push = (z: string, p: number[], n: number[]) => {
    let s = out.get(z);
    if (!s) out.set(z, (s = { pos: [], nor: [] }));
    s.pos.push(...p);
    s.nor.push(...n);
  };
  const rec = (p: number[], n: number[], depth: number) => {
    const cn: Vec3 = [(n[0] + n[3] + n[6]) / 3, (n[1] + n[4] + n[7]) / 3, (n[2] + n[5] + n[8]) / 3];
    const c: Vec3 = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3];
    const zc = zoneFn(c, cn);
    let mixed = false;
    if (depth < 7 && budget.left > 0) {
      for (let v = 0; v < 3 && !mixed; v++) if (zoneFn([p[v * 3], p[v * 3 + 1], p[v * 3 + 2]], [n[v * 3], n[v * 3 + 1], n[v * 3 + 2]]) !== zc) mixed = true;
    }
    if (mixed) {
      // самое длинное ребро
      let bi = 0;
      let bl = -1;
      for (let e = 0; e < 3; e++) {
        const a = e * 3, b = ((e + 1) % 3) * 3;
        const l = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
        if (l > bl) ((bl = l), (bi = e));
      }
      if (bl > minEdge) {
        const i0 = bi * 3, i1 = ((bi + 1) % 3) * 3, i2 = ((bi + 2) % 3) * 3;
        const mp = [(p[i0] + p[i1]) / 2, (p[i0 + 1] + p[i1 + 1]) / 2, (p[i0 + 2] + p[i1 + 2]) / 2];
        let mn = [(n[i0] + n[i1]) / 2, (n[i0 + 1] + n[i1 + 1]) / 2, (n[i0 + 2] + n[i1 + 2]) / 2];
        const l = Math.hypot(mn[0], mn[1], mn[2]) || 1;
        mn = mn.map((v) => v / l);
        budget.left--;
        const P = (i: number) => [p[i], p[i + 1], p[i + 2]];
        const N = (i: number) => [n[i], n[i + 1], n[i + 2]];
        rec([...P(i0), ...mp, ...P(i2)], [...N(i0), ...mn, ...N(i2)], depth + 1);
        rec([...mp, ...P(i1), ...P(i2)], [...mn, ...N(i1), ...N(i2)], depth + 1);
        return;
      }
    }
    push(zc, p, n);
  };
  const trianglePos = new Array<number>(9);
  const triangleNor = new Array<number>(9);
  for (let t = 0; t < pos.length; t += 9) {
    for (let i = 0; i < 9; i++) {
      trianglePos[i] = pos[t + i];
      triangleNor[i] = nor[t + i];
    }
    rec(trianglePos, triangleNor, 0);
  }
}

export const SPLIT_BUDGET = MAX_SPLIT_TRIS;

/** Доля треугольников по зонам (для решения «деталь целиком или по треугольникам»). */
export function histogram(pos: ArrayLike<number>, nor: ArrayLike<number>, zoneFn: (c: Vec3, n: Vec3) => string): Map<string, number> {
  const h = new Map<string, number>();
  const c: Vec3 = [0, 0, 0];
  const n: Vec3 = [0, 0, 0];
  for (let t = 0; t < pos.length; t += 9) {
    c[0] = (pos[t] + pos[t + 3] + pos[t + 6]) / 3;
    c[1] = (pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3;
    c[2] = (pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3;
    n[0] = (nor[t] + nor[t + 3] + nor[t + 6]) / 3;
    n[1] = (nor[t + 1] + nor[t + 4] + nor[t + 7]) / 3;
    n[2] = (nor[t + 2] + nor[t + 5] + nor[t + 8]) / 3;
    const z = zoneFn(c, n);
    h.set(z, (h.get(z) ?? 0) + 1);
  }
  return h;
}

export type { Kind };
