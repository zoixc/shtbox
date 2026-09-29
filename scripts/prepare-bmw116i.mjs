/**
 * Готовит модель BMW 116i для приложения из «сырого» GLB (src/models/bmw_116.glb,
 * Sketchfab «BMW 116», Peter Stephan, CC-BY-4.0) → public/models/bmw116i.glb.
 *
 *   node scripts/prepare-bmw116i.mjs
 *
 * Что делает:
 *  1. убирает KHR_materials_pbrSpecularGlossiness (в three он не поддерживается) и заменяет материалы
 *     на собственную таблицу (metal-rough);
 *  2. переводит в систему координат приложения (+X вперёд, +Y вверх, лево = −Z, метры, колёса на y=0);
 *  3. группирует 145 «безымянных» мешей по узлам автомобиля (см. ZONES): у каждого узла — свой корневой
 *     node с extras (zone / paint / open / anchor / facing), у открываемых — origin в оси шарнира;
 *  4. режет стёкла, поясной молдинг и дверные карты по границе передней/задней двери;
 *  5. сваривает вершины и упрощает геометрию (meshoptimizer), склеивает меши по материалам.
 * Результат — детерминированный; в репозиторий кладётся уже готовый файл.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src/models/bmw_116.glb');
const OUT = resolve(ROOT, 'public/models/bmw116i.glb');

// ---------------------------------------------------------------- чтение GLB
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('не GLB');
  let off = 12;
  let json;
  let bin;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

function writeGlb(json, bin) {
  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const b = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const ch = (len, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(len, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(b.length, 0x004e4942), b]);
}

const { json, bin } = readGlb(SRC);
const license = json.asset?.extras;
// spec-gloss → убираем: материалы всё равно заменяются своими по имени
delete json.extensionsRequired;
delete json.extensionsUsed;
for (const m of json.materials) delete m.extensions;
const io = new NodeIO();
const src = await io.readBinary(new Uint8Array(writeGlb(json, bin)));
const sroot = src.getRoot();

// ---------------------------------------------------------------- геометрия исходника (мир, до нормализации)
const meshNode = new Map();
for (const n of sroot.listNodes()) if (n.getMesh()) meshNode.set(n.getMesh(), n);
const meshes = sroot.listMeshes();
if (meshes.length !== 145) throw new Error(`ожидалось 145 мешей, найдено ${meshes.length}`);

const det3 = (m) =>
  m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

function invT3(m) {
  // обратная транспонированная 3×3 (нормали)
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const dt = a * A + b * B + c * C;
  return [A / dt, B / dt, C / dt, D / dt, E / dt, F / dt, G / dt, H / dt, I / dt];
}

/** {pos, nor, uv?, idx, mat} в мировых координатах исходника. */
function sourceGeom(mi) {
  const mesh = meshes[mi];
  const m = meshNode.get(mesh).getWorldMatrix();
  const flip = det3(m) < 0;
  const N = invT3(m);
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  let mat = '';
  let hasUv = true;
  for (const prim of mesh.listPrimitives()) {
    mat = prim.getMaterial().getName();
    const P = prim.getAttribute('POSITION').getArray();
    const Nn = prim.getAttribute('NORMAL')?.getArray();
    const T = prim.getAttribute('TEXCOORD_0')?.getArray();
    if (!Nn) throw new Error(`меш ${mi}: нет нормалей`);
    if (!T) hasUv = false;
    const base = pos.length / 3;
    for (let k = 0; k < P.length; k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      const nx = Nn[k], ny = Nn[k + 1], nz = Nn[k + 2];
      let ax = N[0] * nx + N[3] * ny + N[6] * nz;
      let ay = N[1] * nx + N[4] * ny + N[7] * nz;
      let az = N[2] * nx + N[5] * ny + N[8] * nz;
      const l = Math.hypot(ax, ay, az) || 1;
      nor.push(ax / l, ay / l, az / l);
    }
    if (T) for (let k = 0; k < T.length; k++) uv.push(T[k]);
    const I = prim.getIndices().getArray();
    for (let k = 0; k < I.length; k += 3) {
      if (flip) idx.push(base + I[k], base + I[k + 2], base + I[k + 1]);
      else idx.push(base + I[k], base + I[k + 1], base + I[k + 2]);
    }
  }
  return { pos, nor, uv: hasUv && uv.length ? uv : null, idx, mat };
}

const cx = (g, t) => {
  const a = g.idx[t * 3], b = g.idx[t * 3 + 1], c = g.idx[t * 3 + 2];
  return [0, 1, 2].map((k) => (g.pos[a * 3 + k] + g.pos[b * 3 + k] + g.pos[c * 3 + k]) / 3);
};

/** Делит рёбра длиннее maxEdge пополам (для чистого разреза длинных треугольников по границе двери). */
function subdivide(g, maxEdge) {
  const pos = [...g.pos], nor = [...g.nor];
  const uv = g.uv ? [...g.uv] : null;
  const mid = (a, b) => {
    const id = pos.length / 3;
    for (let k = 0; k < 3; k++) pos.push((pos[a * 3 + k] + pos[b * 3 + k]) / 2);
    const n = [0, 1, 2].map((k) => nor[a * 3 + k] + nor[b * 3 + k]);
    const l = Math.hypot(...n) || 1;
    nor.push(n[0] / l, n[1] / l, n[2] / l);
    if (uv) uv.push((uv[a * 2] + uv[b * 2]) / 2, (uv[a * 2 + 1] + uv[b * 2 + 1]) / 2);
    return id;
  };
  const dist = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  let queue = [];
  for (let t = 0; t < g.idx.length; t += 3) queue.push([g.idx[t], g.idx[t + 1], g.idx[t + 2]]);
  const done = [];
  while (queue.length) {
    const next = [];
    for (const [a, b, c] of queue) {
      const e = [dist(a, b), dist(b, c), dist(c, a)];
      const m = Math.max(...e);
      if (m <= maxEdge) done.push(a, b, c);
      else if (m === e[0]) { const d = mid(a, b); next.push([a, d, c], [d, b, c]); }
      else if (m === e[1]) { const d = mid(b, c); next.push([a, b, d], [a, d, c]); }
      else { const d = mid(c, a); next.push([a, b, d], [d, b, c]); }
    }
    queue = next;
  }
  return { ...g, pos, nor, uv, idx: done };
}

function pickTris(g, pred) {
  const keep = [];
  const rest = [];
  for (let t = 0; t < g.idx.length / 3; t++) {
    const tri = [g.idx[t * 3], g.idx[t * 3 + 1], g.idx[t * 3 + 2]];
    (pred(cx(g, t)) ? keep : rest).push(...tri);
  }
  return [{ ...g, idx: keep }, { ...g, idx: rest }];
}

// ---------------------------------------------------------------- нормализация координат
const bbox = (mi) => {
  const g = sourceGeom(mi);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let k = 0; k < g.pos.length; k++) {
    lo[k % 3] = Math.min(lo[k % 3], g.pos[k]);
    hi[k % 3] = Math.max(hi[k % 3], g.pos[k]);
  }
  return { lo, hi };
};
const tireF = bbox(59), tireR = bbox(52);
const XC = (((tireF.lo[0] + tireF.hi[0]) / 2) + ((tireR.lo[0] + tireR.hi[0]) / 2)) / 2;
const WHEELBASE_SRC = (tireR.lo[0] + tireR.hi[0]) / 2 - (tireF.lo[0] + tireF.hi[0]) / 2;
const S = 2.69 / WHEELBASE_SRC; // реальная колёсная база F20 — 2690 мм
const Y0 = tireF.lo[1];
const fx = (x) => (XC - x) * S;
const fy = (y) => (y - Y0) * S;
const fz = (z) => -z * S; // исходный +Z — сторона водителя (слева) → у нас лево = −Z
const F = (p) => [fx(p[0]), fy(p[1]), fz(p[2])];

// ---------------------------------------------------------------- материалы
const MATERIALS = {
  paint: { color: [0.72, 0.74, 0.78], metal: 0.35, rough: 0.35 },
  'WIND-S': { color: [0.03, 0.05, 0.07], alpha: 0.5, metal: 0, rough: 0.08 },
  black_1: { color: [0.06, 0.06, 0.06], metal: 0, rough: 0.6 },
  black_2: { color: [0.02, 0.02, 0.02], metal: 0.1, rough: 0.25 },
  Chrome: { color: [0.75, 0.77, 0.8], metal: 1, rough: 0.22 },
  Light_HAZE: { color: [0.85, 0.87, 0.9], alpha: 0.4, metal: 0, rough: 0.1 },
  light_back: { color: [0.62, 0.03, 0.03], alpha: 0.75, metal: 0, rough: 0.15 },
  Light_front: { color: [0.85, 0.88, 0.92], alpha: 0.3, metal: 0, rough: 0.08 },
  Interior: { color: [0.3, 0.28, 0.25], metal: 0, rough: 0.9 },
  '17_-_Default': { color: [0.02, 0.02, 0.02], metal: 0, rough: 0.35 },
  Rubber_1: { color: [0.05, 0.05, 0.05], metal: 0, rough: 0.95 },
  rubber_2: { color: [0.05, 0.05, 0.05], metal: 0, rough: 0.95 },
  '10_-_Default': { color: [1, 1, 1], metal: 0.2, rough: 0.5, texture: true },
  '12_-_Default': { color: [0.42, 0.43, 0.45], metal: 0.85, rough: 0.5 },
  DISC: { color: [0.72, 0.73, 0.75], metal: 1, rough: 0.3 },
};
// BODY — краска кузова; в рантайме заменяется шейдером краски
const matName = (m) => (m === 'BODY' ? 'paint' : m);

// ---------------------------------------------------------------- состав узлов
const X_SPLIT = 12.26; // граница передней/задней двери (исходные координаты)
const front = (c) => c[0] < X_SPLIT;
const rear = (c) => c[0] >= X_SPLIT;
const card = (side) => (c) => Math.abs(c[2]) > 3.4 && Math.sign(c[2]) === side && c[1] < 5.0 && c[0] > 6.85 && c[0] < 17.3;
const P = (m, pred) => ({ m, pred });

/** side: +1 — исходный +Z (левая сторона авто), −1 — правая. */
const doorParts = (side, isFront) => {
  const L = side > 0;
  const half = isFront ? front : rear;
  const paint = [P(isFront ? (L ? 5 : 21) : L ? 6 : 22, null), P(L ? 0 : 19, half)];
  const parts = [P(L ? 144 : 89, half), P(L ? 143 : 88, half), P(96, (c) => card(side)(c) && half(c))];
  if (isFront) {
    paint.push(P(L ? 28 : 29, null));
    parts.push(...(L ? [P(114), P(115)] : [P(82), P(83)]));
  }
  return { paint, parts };
};

const WHEELS = {
  wheel_fl: [63, 59, 58, 60], wheel_fr: [42, 39, 41, 37], wheel_rl: [56, 52, 54, 50], wheel_rr: [47, 44, 46, 55],
};
const rng = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// h — точка шарнира в исходных координатах, a — ось, ang — угол
const ZONES = [
  { id: 'hood', paint: [P(7)], parts: [P(34)], open: { h: [6.95, 4.85, 0], axis: [0, 0, 1], angle: 1.0, label: 'Капот' }, facing: [0, 1, 0] },
  { id: 'trunk', paint: [P(16), P(9)], parts: [P(117), P(118), P(131), P(35)], open: { h: [18.5, 6.75, 0], axis: [0, 0, 1], angle: -1.2, label: 'Задняя дверь' }, facing: [-1, 0.5, 0] },
  ...[[1, 'l', 'левая', -1], [-1, 'r', 'правая', 1]].flatMap(([side, sn, ru, sd]) => [
    { id: `door_f${sn}`, ...doorParts(side, true), open: { h: [6.9, 0, side * 4.0], axis: [0, 1, 0], angle: sd * 1.15, label: `Дверь пер. ${ru}` }, side: sd, anchorY: 0.72 },
    { id: `door_r${sn}`, ...doorParts(side, false), open: { h: [12.15, 0, side * 4.05], axis: [0, 1, 0], angle: sd * 1.05, label: `Дверь зад. ${ru}` }, side: sd, anchorY: 0.72 },
  ]),
  { id: 'fender_fl', paint: [P(8)], parts: [P(87), P(110), P(112), P(113)], side: -1, anchorY: 0.72 },
  { id: 'fender_fr', paint: [P(20)], parts: [P(84), P(85), P(86)], side: 1, anchorY: 0.72 },
  { id: 'quarter_rl', paint: [P(12)], parts: [], side: -1, anchorY: 0.78 },
  { id: 'quarter_rr', paint: [P(24), P(30)], parts: [], side: 1, anchorY: 0.78 },
  { id: 'sill_l', paint: [P(4)], parts: [P(109)], side: -1, anchorY: 0.3 },
  { id: 'sill_r', paint: [P(23)], parts: [P(90)], side: 1, anchorY: 0.3 },
  { id: 'roof', paint: [P(10)], parts: [P(116)], facing: [0, 1, 0] },
  { id: 'bumper_f', paint: [P(11), ...[1, 18, 2, 27, 3, 25, 17, 26].map((m) => P(m))], parts: [75, 76, 77, 137, 138, 139, 142].map((m) => P(m)), facing: [1, 0, 0] },
  { id: 'bumper_r', paint: [13, 14, 15, 31].map((m) => P(m)), parts: [P(32)], facing: [-1, 0, 0] },
  { id: 'windshield', paint: [], parts: [119, 120, 121, 91, 92, 107, 108].map((m) => P(m)) },
  { id: 'lights_f', paint: [], parts: [...rng(64, 74), ...rng(122, 130), 140, 141].map((m) => P(m)), anchor: [2.0, 0.7, -0.62] },
  { id: 'lights_r', paint: [], parts: [78, 79, 80, 81, 111, 132, 133, 134, 135, 136].map((m) => P(m)), anchor: [-2.1, 0.85, -0.62] },
  ...Object.entries(WHEELS).map(([id, ms]) => ({ id, paint: [], parts: ms.map((m) => P(m)), anchor: undefined })),
  { id: 'brakes_f', paint: [], parts: [61, 62, 40, 38].map((m) => P(m)), anchor: [1.345, 0.3, -0.65] },
  { id: 'brakes_r', paint: [], parts: [53, 51, 45, 43].map((m) => P(m)), anchor: [-1.345, 0.3, -0.65] },
  { id: 'dashboard', paint: [], parts: [105, 100, 98, 99, 101, 102].map((m) => P(m)) },
  { id: 'steering', paint: [], parts: [104, 103].map((m) => P(m)) },
  { id: 'console', paint: [], parts: [P(106)] },
  { id: 'seat_fl', paint: [], parts: [P(97)] },
  { id: 'seat_fr', paint: [], parts: [P(95)] },
  { id: 'seat_r', paint: [], parts: [P(93), P(94)] },
  { id: 'floor', paint: [], parts: [P(96, (c) => !(card(1)(c) || card(-1)(c)))] },
];
// намеренно не используются: 33 — днище, 36/48/49/57 — «Clipper» (невидимые, alpha = 0)
const DROPPED = new Set([33, 36, 48, 49, 57]);

// ---------------------------------------------------------------- проверка полноты разбиения
{
  const used = new Map();
  for (const z of ZONES) for (const p of [...z.paint, ...z.parts]) used.set(p.m, (used.get(p.m) ?? 0) + 1);
  const split = new Set([0, 19, 96, 143, 144, 88, 89]);
  const miss = [];
  for (let i = 0; i < meshes.length; i++) if (!used.has(i) && !DROPPED.has(i)) miss.push(i);
  const dup = [...used].filter(([m, n]) => n > 1 && !split.has(m)).map(([m]) => m);
  if (miss.length || dup.length) throw new Error(`разбиение неполное: пропущены [${miss}], повторы [${dup}]`);
}

// ---------------------------------------------------------------- склейка, сварка, упрощение
await MeshoptSimplifier.ready;

/** Склеивает список sourceGeom в одну геометрию в системе авто (с вычетом origin). */
function assemble(list, origin) {
  const pos = [], nor = [], uv = [], idx = [];
  let hasUv = list.every((g) => g.uv);
  for (const g of list) {
    const base = pos.length / 3;
    for (let k = 0; k < g.pos.length; k += 3) {
      const p = F([g.pos[k], g.pos[k + 1], g.pos[k + 2]]);
      pos.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
      nor.push(-g.nor[k], g.nor[k + 1], -g.nor[k + 2]);
    }
    if (hasUv) uv.push(...g.uv);
    for (const i of g.idx) idx.push(base + i);
  }
  return { pos, nor, uv: hasUv ? uv : null, idx, base: list.reduce((s, g) => s + (g.base ?? g.idx.length / 3), 0) };
}

function weld(g) {
  const map = new Map();
  const pos = [], nor = [], uv = [];
  const remap = new Uint32Array(g.pos.length / 3);
  for (let v = 0; v < remap.length; v++) {
    const key = [
      Math.round(g.pos[v * 3] * 1e5), Math.round(g.pos[v * 3 + 1] * 1e5), Math.round(g.pos[v * 3 + 2] * 1e5),
      Math.round(g.nor[v * 3] * 50), Math.round(g.nor[v * 3 + 1] * 50), Math.round(g.nor[v * 3 + 2] * 50),
      g.uv ? Math.round(g.uv[v * 2] * 1e4) : 0, g.uv ? Math.round(g.uv[v * 2 + 1] * 1e4) : 0,
    ].join(',');
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
      nor.push(g.nor[v * 3], g.nor[v * 3 + 1], g.nor[v * 3 + 2]);
      if (g.uv) uv.push(g.uv[v * 2], g.uv[v * 2 + 1]);
    }
    remap[v] = id;
  }
  const idx = [];
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = remap[g.idx[t]], b = remap[g.idx[t + 1]], c = remap[g.idx[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { pos, nor, uv: g.uv ? uv : null, idx, base: g.base };
}

function simplify(g, ratio, { lockBorder = true, error = 0.01 } = {}) {
  const base = g.base ?? g.idx.length / 3;
  if ((ratio >= 1 && base * 3 >= g.idx.length) || g.idx.length < 300) return g;
  const positions = new Float32Array(g.pos);
  const normals = new Float32Array(g.nor);
  const target = Math.min(g.idx.length, Math.max(3, Math.floor(base * ratio) * 3));
  const [out] = MeshoptSimplifier.simplifyWithAttributes(
    new Uint32Array(g.idx), positions, 3, normals, 3, [0.6, 0.6, 0.6], null, target, error, lockBorder ? ['LockBorder'] : [],
  );
  // компактизация вершин
  const map = new Map();
  const pos = [], nor = [], uv = [];
  const idx = [];
  for (const v of out) {
    let id = map.get(v);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(v, id);
      pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
      nor.push(g.nor[v * 3], g.nor[v * 3 + 1], g.nor[v * 3 + 2]);
      if (g.uv) uv.push(g.uv[v * 2], g.uv[v * 2 + 1]);
    }
    idx.push(id);
  }
  return { pos, nor, uv: g.uv ? uv : null, idx, base: g.base };
}

// доля треугольников, которую оставляем
const RATIO = { paint: 0.5, DISC: 0.3, rubber_2: 0.5, Rubber_1: 0.6, Interior: 0.45, black_1: 0.6, black_2: 0.6, Chrome: 0.7 };
const ratioFor = (mat, zone) => {
  if (zone.startsWith('seat')) return 0.35;
  return RATIO[mat] ?? 1;
};

// ---------------------------------------------------------------- сборка нового документа
const doc = new Document();
doc.getRoot().getAsset().generator = 'shtbox/scripts/prepare-bmw116i.mjs';
doc.getRoot().getAsset().copyright = 'BMW 116 by Peter Stephan (https://sketchfab.com/Peter.Stephan), CC-BY-4.0';
doc.getRoot().setExtras({
  title: 'BMW 116i (F20)',
  author: license?.author,
  license: license?.license,
  source: license?.source,
  note: 'Оптимизировано scripts/prepare-bmw116i.mjs (оси приложения, метры, узлы автомобиля, упрощение геометрии).',
});
const buffer = doc.createBuffer();
const scene = doc.createScene('bmw116i');
const tex0 = src.getRoot().listTextures()[0];
const texture = doc.createTexture('logo').setImage(tex0.getImage()).setMimeType(tex0.getMimeType());

const materials = new Map();
const material = (name) => {
  if (materials.has(name)) return materials.get(name);
  const d = MATERIALS[name];
  if (!d) throw new Error(`нет описания материала «${name}»`);
  const m = doc
    .createMaterial(name)
    .setBaseColorFactor([...d.color, d.alpha ?? 1])
    .setMetallicFactor(d.metal)
    .setRoughnessFactor(d.rough)
    .setDoubleSided(true);
  if (d.alpha !== undefined) m.setAlphaMode('BLEND');
  if (d.texture) m.setBaseColorTexture(texture);
  materials.set(name, m);
  return m;
};

const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
function primitive(g, matNameStr) {
  const prim = doc.createPrimitive().setMaterial(material(matNameStr));
  prim.setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos)));
  prim.setAttribute('NORMAL', acc('VEC3', new Float32Array(g.nor)));
  if (g.uv) prim.setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(g.uv)));
  prim.setIndices(acc('SCALAR', g.pos.length / 3 > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx)));
  return prim;
}

const stats = [];
const round = (v) => Math.round(v * 1e4) / 1e4;
const r3 = (a) => a.map(round);

for (const z of ZONES) {
  const hinge = z.open ? F(z.open.h) : [0, 0, 0];
  const collect = (defs) => {
    const byMat = new Map();
    for (const d of defs) {
      let g = sourceGeom(d.m);
      g.base = g.idx.length / 3;
      if (d.pred) {
        const sub = subdivide(g, 0.12);
        const kept = pickTris(sub, d.pred)[0];
        kept.base = (g.base * kept.idx.length) / sub.idx.length; // «честное» число треугольников без учёта подразбиения
        g = kept;
      }
      if (!g.idx.length) throw new Error(`зона ${z.id}: меш ${d.m} пуст после фильтра`);
      const key = matName(g.mat);
      if (!MATERIALS[key]?.texture) g = { ...g, uv: null };
      (byMat.get(key) ?? byMat.set(key, []).get(key)).push(g);
    }
    return byMat;
  };

  const node = doc.createNode(z.id).setTranslation(hinge);
  const extras = { zone: z.id };
  if (z.paint.length) extras.paint = true;
  if (z.open) extras.open = { axis: z.open.axis, angle: z.open.angle, label: z.open.label };
  if (z.facing) extras.facing = z.facing;
  else if (z.side) extras.facing = [0, 0, z.side];

  let tris = 0;
  let bounds = null;
  const track = (g) => {
    for (let k = 0; k < g.pos.length; k += 3) {
      if (!bounds) bounds = { lo: [g.pos[0], g.pos[1], g.pos[2]], hi: [g.pos[0], g.pos[1], g.pos[2]] };
      for (let a = 0; a < 3; a++) {
        bounds.lo[a] = Math.min(bounds.lo[a], g.pos[k + a]);
        bounds.hi[a] = Math.max(bounds.hi[a], g.pos[k + a]);
      }
    }
  };

  // окрашиваемая деталь — один меш (на нём рисуются дефекты)
  if (z.paint.length) {
    const list = [...collect(z.paint).values()].flat();
    let g = weld(assemble(list, hinge));
    g = simplify(g, RATIO.paint, { error: 0.02 });
    tris += g.idx.length / 3;
    track(g);
    const pn = doc.createNode(`${z.id}:paint`).setMesh(doc.createMesh(`${z.id}:paint`).addPrimitive(primitive(g, 'paint')));
    pn.setExtras({ paint: true });
    node.addChild(pn);
  }
  // остальное: по материалам
  if (z.parts.length) {
    const mesh = doc.createMesh(`${z.id}:parts`);
    for (const [mat, list] of collect(z.parts)) {
      let g = weld(assemble(list, hinge));
      g = simplify(g, ratioFor(mat, z.id), { lockBorder: true, error: z.id === 'floor' ? 0.2 : 0.02 });
      tris += g.idx.length / 3;
      track(g);
      mesh.addPrimitive(primitive(g, mat));
    }
    node.addChild(doc.createNode(`${z.id}:parts`).setMesh(mesh));
  }

  if (z.anchor) extras.anchor = r3(z.anchor.map((v, i) => v - hinge[i]));
  else if (z.anchorY !== undefined && bounds) {
    // бейдж на внешней стороне панели, на середине по длине
    const outer = z.side > 0 ? bounds.hi[2] : bounds.lo[2];
    extras.anchor = r3([(bounds.lo[0] + bounds.hi[0]) / 2, z.anchorY - hinge[1], outer + 0.01 * z.side]);
  }
  node.setExtras(extras);
  scene.addChild(node);
  stats.push([z.id, Math.round(tris)]);
}

// ---------------------------------------------------------------- запись
mkdirSync(dirname(OUT), { recursive: true });
const out = await io.writeBinary(doc);
writeFileSync(OUT, out);
const total = stats.reduce((s, [, t]) => s + t, 0);
console.log(`масштаб ${S.toFixed(5)} м/ед., XC=${XC.toFixed(3)}, Y0=${Y0.toFixed(3)}`);
for (const [id, t] of stats) console.log(`  ${id.padEnd(12)} ${t}`);
console.log(`треугольников: ${total}; файл: ${(out.length / 1e6).toFixed(2)} МБ → ${OUT}`);
