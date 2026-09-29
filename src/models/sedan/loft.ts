import { BufferAttribute, BufferGeometry } from 'three';

/**
 * Параметрический кузов седана: «лофт» по продольным сечениям.
 * Сетка станций (по X, спереди назад) × точек контура (по кругу). Части кузова
 * (капот, двери, крылья…) — это прямоугольные области клеток этой сетки, поэтому все
 * панели стыкуются идеально, а нормали считаются по всей поверхности целиком (нет «швов» шейдинга).
 *
 * Система координат: +X — вперёд, +Y — вверх, +Z — правая сторона автомобиля. Единицы — метры.
 */

/** Монотонная кубическая интерполяция (Fritsch–Carlson): без «колебаний» между ключевыми точками. */
export function pchip(xsIn: number[], ysIn: number[]): (x: number) => number {
  const n = xsIn.length;
  const rev = xsIn[0] > xsIn[n - 1];
  const xs = rev ? [...xsIn].reverse() : xsIn;
  const ys = rev ? [...ysIn].reverse() : ysIn;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  m[0] = d[0] * 0.5;
  m[n - 1] = d[n - 2] * 0.5;
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h[i] * m[i + 1]
    );
  };
}

export const PROFILE_KEYS = ['yBot', 'wBot', 'yS', 'wS', 'wM', 'yBelt', 'yC', 'wG', 'wR', 'crown'] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export interface BodySpec {
  /** параметры сечения как ключевые точки [x, значение] (x — от носа к корме) */
  profile: Record<ProfileKey, [number, number][]>;
  /** высота линии стекла над плечом */
  glassRise: number;
}

/** Число сегментов между управляющими точками контура: k0→k1 … k6→k7 */
export const SEG = [3, 3, 3, 3, 2, 4, 6] as const;
export const K_IDX = SEG.reduce<number[]>((a, n) => (a.push(a[a.length - 1] + n), a), [0]); // [0,3,6,9,12,14,18,24]
export const HALF = K_IDX[K_IDX.length - 1]; // 24
export const LOOP = HALF * 2; // 48
export const COLS = LOOP + 1;

type Pt = [number, number]; // z, y

function catmull(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

export interface Section {
  /** правая половина контура: j = 0..HALF (от низа-центра к верху-центру), пары [z, y] */
  half: Pt[];
  cy: number;
}

export class BodyLoft {
  private fns: Record<ProfileKey, (x: number) => number>;
  constructor(private spec: BodySpec) {
    this.fns = {} as Record<ProfileKey, (x: number) => number>;
    for (const k of PROFILE_KEYS) this.fns[k] = pchip(spec.profile[k].map((p) => p[0]), spec.profile[k].map((p) => p[1]));
  }

  section(x: number, s = 1): Section {
    const f = this.fns;
    const yBot = f.yBot(x);
    const yS = f.yS(x);
    const yBelt = f.yBelt(x);
    const yC = f.yC(x);
    const wM = f.wM(x);
    const yG = yBelt + this.spec.glassRise;
    const ctrl: Pt[] = [
      [0, yBot],
      [f.wBot(x), yBot],
      [f.wS(x), yS],
      [wM + 0.004, yS + (yBelt - yS) * 0.55],
      [wM, yBelt],
      [f.wG(x), yG],
      [f.wR(x), yC - f.crown(x)],
      [0, yC],
    ];
    const ext: Pt[] = [[-ctrl[1][0], ctrl[1][1]], ...ctrl, [-ctrl[6][0], ctrl[6][1]]];
    const half: Pt[] = [];
    for (let k = 0; k < SEG.length; k++) {
      for (let s2 = 0; s2 < SEG[k]; s2++) {
        half.push(catmull(ext[k], ext[k + 1], ext[k + 2], ext[k + 3], s2 / SEG[k]));
      }
    }
    half.push(ctrl[7]);
    const cy = (yBot + yC) / 2;
    if (s !== 1) for (const p of half) ((p[0] *= s), (p[1] = cy + (p[1] - cy) * s));
    return { half, cy };
  }

  /** Координата Z наружной поверхности борта на высоте y в сечении x (правый борт). */
  sideZ(x: number, y: number): number {
    const { half } = this.section(x);
    for (let j = K_IDX[1]; j < K_IDX[5]; j++) {
      const [z0, y0] = half[j];
      const [z1, y1] = half[j + 1];
      if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) return z0 + ((y - y0) / (y1 - y0)) * (z1 - z0);
    }
    return half[K_IDX[4]][0];
  }

  /** Y крыши/капота по центру в сечении x. */
  topY(x: number): number {
    return this.fns.yC(x);
  }

  /** Замкнутый контур сечения (для перегородок): массив [z, y]. */
  loop(x: number, yClip = Infinity): Pt[] {
    const { half } = this.section(x);
    const pts: Pt[] = [];
    for (let j = 0; j < LOOP; j++) {
      const p = j <= HALF ? half[j] : half[LOOP - j];
      const z = j <= HALF ? p[0] : -p[0];
      pts.push([z, Math.min(p[1], yClip)]);
    }
    return pts;
  }
}

export interface Station {
  x: number;
  s: number;
}

/** Построение списка станций: торцевые кольца на носу/корме + равномерная сетка с точными границами панелей. */
export function buildStations(xFront: number, xRear: number, boundaries: number[], maxStep = 0.085): Station[] {
  const capS = [0, 0.3, 0.58, 0.8, 0.93];
  const st: Station[] = [];
  for (const s of capS) st.push({ x: xFront, s });
  st.push({ x: xFront - 0.012, s: 0.985 });
  const xs = [...new Set([xFront - 0.04, ...boundaries, xRear + 0.04])].sort((a, b) => b - a);
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    const n = Math.max(1, Math.ceil((a - b) / maxStep - 1e-6));
    for (let k = 0; k < n; k++) st.push({ x: a + ((b - a) * k) / n, s: 1 });
  }
  st.push({ x: xs[xs.length - 1], s: 1 });
  st.push({ x: xRear + 0.012, s: 0.985 });
  for (let k = capS.length - 1; k >= 0; k--) st.push({ x: xRear, s: capS[k] });
  return st;
}

export interface Grid {
  stations: Station[];
  /** позиции вершин, индекс = i * COLS + j */
  pos: Float32Array;
  nrm: Float32Array;
  rows: number;
  /** индекс станции по x (только «обычные» станции s=1) */
  idx(x: number): number;
}

export function buildGrid(loft: BodyLoft, stations: Station[]): Grid {
  const rows = stations.length;
  const pos = new Float32Array(rows * COLS * 3);
  for (let i = 0; i < rows; i++) {
    const { x, s } = stations[i];
    const { half } = loft.section(x, s);
    for (let j = 0; j < COLS; j++) {
      const jj = j % LOOP;
      const p = jj <= HALF ? half[jj] : half[LOOP - jj];
      const z = jj <= HALF ? p[0] : -p[0];
      const o = (i * COLS + j) * 3;
      pos[o] = x;
      pos[o + 1] = p[1];
      pos[o + 2] = z;
    }
  }
  // нормали: по всей сетке, чтобы стыки панелей не давали разрывов шейдинга
  const idxArr: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < LOOP; j++) {
      const a = i * COLS + j;
      const b = a + 1;
      const c = a + COLS;
      const d = c + 1;
      idxArr.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idxArr);
  g.computeVertexNormals();
  const nrm = (g.getAttribute('normal') as BufferAttribute).array as Float32Array;
  // сшиваем шов контура (столбцы 0 и LOOP)
  for (let i = 0; i < rows; i++) {
    const a = (i * COLS) * 3;
    const b = (i * COLS + LOOP) * 3;
    for (let k = 0; k < 3; k++) {
      const v = (nrm[a + k] + nrm[b + k]) / 2;
      nrm[a + k] = v;
      nrm[b + k] = v;
    }
  }
  g.dispose();
  const regular = stations.map((s, i) => [s, i] as const).filter(([s]) => s.s === 1);
  return {
    stations,
    pos,
    nrm,
    rows,
    idx: (x: number) => {
      let best = regular[0][1];
      let bd = Infinity;
      for (const [s, i] of regular) {
        const d = Math.abs(s.x - x);
        if (d < bd) ((bd = d), (best = i));
      }
      return best;
    },
  };
}

/** Владельцы клеток сетки: какая деталь какими клетками владеет. */
export class Ownership {
  readonly cells: (string | null)[];
  constructor(private grid: Grid) {
    this.cells = new Array((grid.rows - 1) * LOOP).fill(null);
  }
  private set(i: number, j: number, owner: string) {
    if (i < 0 || i >= this.grid.rows - 1) return;
    this.cells[i * LOOP + (((j % LOOP) + LOOP) % LOOP)] = owner;
  }
  get(i: number, j: number): string | null {
    if (i < 0 || i >= this.grid.rows - 1) return null;
    return this.cells[i * LOOP + (((j % LOOP) + LOOP) % LOOP)];
  }
  /** Абсолютные индексы: станции [i0,i1), клетки контура [j0,j1) */
  rect(owner: string, i0: number, i1: number, j0: number, j1: number): void {
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) this.set(i, j, owner);
  }
  /** По координатам x (от большего к меньшему) и диапазону контура правой половины; зеркалится на левую. */
  side(ownerR: string, ownerL: string, xFrom: number, xTo: number, j0: number, j1: number): void {
    const i0 = this.grid.idx(xFrom);
    const i1 = this.grid.idx(xTo);
    this.rect(ownerR, i0, i1, j0, j1);
    this.rect(ownerL, i0, i1, LOOP - j1, LOOP - j0);
  }
  /** Область по центру (капот/крыша/багажник): j абсолютные. */
  center(owner: string, xFrom: number, xTo: number, j0: number, j1: number): void {
    this.rect(owner, this.grid.idx(xFrom), this.grid.idx(xTo), j0, j1);
  }
}

export interface PanelGeometry {
  geometry: BufferGeometry;
  /** отрезки границы панели (для линий стыков), с небольшим смещением по нормали */
  edges: Float32Array;
}

/** Собирает геометрию всех клеток указанного владельца; границы — там, где сосед другой (и не «свой» по префиксу). */
export function extractPanel(grid: Grid, own: Ownership, owner: string, edgeGroup?: (o: string | null) => boolean): PanelGeometry | null {
  const cells: number[] = [];
  for (let i = 0; i < grid.rows - 1; i++) for (let j = 0; j < LOOP; j++) if (own.get(i, j) === owner) cells.push(i * LOOP + j);
  if (!cells.length) return null;
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const nrm: number[] = [];
  const index: number[] = [];
  const vert = (i: number, j: number): number => {
    const key = i * COLS + j;
    let v = remap.get(key);
    if (v === undefined) {
      v = remap.size;
      remap.set(key, v);
      pos.push(grid.pos[key * 3], grid.pos[key * 3 + 1], grid.pos[key * 3 + 2]);
      nrm.push(grid.nrm[key * 3], grid.nrm[key * 3 + 1], grid.nrm[key * 3 + 2]);
    }
    return v;
  };
  const edges: number[] = [];
  const off = 0.0022;
  const edge = (i0: number, j0: number, i1: number, j1: number) => {
    for (const [i, j] of [
      [i0, j0],
      [i1, j1],
    ]) {
      const k = (i * COLS + j) * 3;
      edges.push(grid.pos[k] + grid.nrm[k] * off, grid.pos[k + 1] + grid.nrm[k + 1] * off, grid.pos[k + 2] + grid.nrm[k + 2] * off);
    }
  };
  const same = edgeGroup ?? ((o: string | null) => o === owner);
  for (const c of cells) {
    const i = Math.floor(c / LOOP);
    const j = c % LOOP;
    const a = vert(i, j);
    const b = vert(i, j + 1);
    const cc = vert(i + 1, j);
    const d = vert(i + 1, j + 1);
    index.push(a, b, cc, b, d, cc);
    if (i > 0 && !same(own.get(i - 1, j))) edge(i, j, i, j + 1);
    if (i < grid.rows - 2 && !same(own.get(i + 1, j))) edge(i + 1, j, i + 1, j + 1);
    if (!same(own.get(i, j - 1))) edge(i, j, i + 1, j);
    if (!same(own.get(i, j + 1))) edge(i, j + 1, i + 1, j + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return { geometry: g, edges: new Float32Array(edges) };
}

export { LOOP as LOOP_N };
