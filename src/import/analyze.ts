/**
 * Автоматический анализ модели: система координат, масштаб, колёса, остекление, границы панелей,
 * типы деталей. Чистые функции над массивами — работают в Worker, в Node (CLI) и в тестах.
 * Всё, что здесь угадано, пользователь может поправить в мастере; результат — `Profile`.
 */
import { bboxOf, centerOf, sizeOf, transformed, unionBox, yawBox } from './frame';
import type { Box } from './frame';
import { detectPanels, trimmedBox } from './seams';
import type { BodyType, DataConfidence, Dims, Frame, Kind, Lines, PartInfo, Profile, RawPart, Vec3 } from './types';

export interface AnalyzeHint {
  yaw?: number;
  /** масштаб исходных единиц → метры */
  scale?: number;
  /** или длина автомобиля, м */
  length?: number;
  body?: BodyType;
  layout?: 'front' | 'rear';
  driver?: 'l' | 'r';
  paint?: string[];
  /** искать капот/двери/крышку/бамперы как отдельные детали модели (по умолчанию — да) */
  panels?: boolean;
  /** правки пользователя, которые сохраняются при повторном анализе */
  keep?: Record<string, PartInfo>;
}

const RE_FRONT = /front|head|bonnet|hood|capot|nose|grille|bumper_f|\bfr[_\b.]/i;
const RE_REAR = /rear|back|tail|trunk|boot|bumper_r|exhaust|\brr[_\b.]/i;
const RE_LIGHT = /light|lamp|head_?l|tail_?l|signal|indicator|blinker|reflector|fara|foglamp/i;
const RE_GLASS = /glass|window|windshield|windscreen|wind_?screen|стекл/i;
const RE_PAINT = /paint|body|carpaint|lak|exterior|кузов|краск/i;
const RE_NOT_PAINT = /rubber|tire|tyre|black|plastic|chrome|silver|metal|interior|seat|leather|glass|window|light|lamp|carbon|steel|alu|wheel|rim|disc|brake|license|plate/i;
const RE_INTERIOR = /interior|int_|cabin|cockpit|seat|sofa|dashboard|dash_?bo|console|armrest|headliner|roof_?liner|upholster|carpet|floor_?mat|steering|door_?card|door_?panel|salon|салон|сидень|кресл|торпедо|обшивк/i;
const RE_BRAKE = /brake|caliper|rotor/i;
const RE_WHEEL = /wheel|tire|tyre|rim/i;

const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const inside = (c: Vec3, b: Box, pad = 0) => [0, 1, 2].every((a) => c[a] >= b.min[a] - pad && c[a] <= b.max[a] + pad);

interface GlassStats {
  side: { x: number[]; yMin: number; xMin: number; xMax: number };
  front: { xMin: number; xMax: number; n: number };
  rear: { xMin: number; xMax: number; n: number };
}

/** Классифицирует треугольники остекления в системе автомобиля: боковые / лобовое / заднее. */
function glassStats(parts: { pos: Float32Array; c: Vec3 }[], hw: number): GlassStats {
  const g: GlassStats = {
    side: { x: [], yMin: Infinity, xMin: Infinity, xMax: -Infinity },
    front: { xMin: Infinity, xMax: -Infinity, n: 0 },
    rear: { xMin: Infinity, xMax: -Infinity, n: 0 },
  };
  // стёкла могут быть замкнутыми оболочками, поэтому «перёд/зад» определяем по положению, а не по нормали
  const xMid = parts.length ? (Math.min(...parts.map((p) => p.c[0])) + Math.max(...parts.map((p) => p.c[0]))) / 2 : 0;
  for (const { pos } of parts) {
    for (let t = 0; t < pos.length; t += 9) {
      const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
      const vx = pos[t + 6] - pos[t], vy = pos[t + 7] - pos[t + 1], vz = pos[t + 8] - pos[t + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ax = Math.abs(nx), az = Math.abs(nz), ay = Math.abs(ny);
      if (ay > 0.92 * Math.hypot(nx, ny, nz)) continue; // горизонтальное (люк, крыша)
      const cx = (pos[t] + pos[t + 3] + pos[t + 6]) / 3;
      const cy = (pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3;
      const cz = (pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3;
      const x0 = pos[t], x1 = pos[t + 3], x2 = pos[t + 6];
      const minX = Math.min(x0, x1, x2);
      const maxX = Math.max(x0, x1, x2);
      if (az > ax) {
        if (Math.abs(cz) < 0.35 * hw) continue;
        g.side.x.push(cx);
        if (cy < g.side.yMin) g.side.yMin = cy;
        g.side.xMin = Math.min(g.side.xMin, minX);
        g.side.xMax = Math.max(g.side.xMax, maxX);
      } else {
        const bucket = cx > xMid ? g.front : g.rear;
        bucket.n++;
        bucket.xMin = Math.min(bucket.xMin, minX);
        bucket.xMax = Math.max(bucket.xMax, maxX);
      }
    }
  }
  return g;
}

/** Треугольный «суп» (9 чисел на треугольник) в системе автомобиля. */
function soup(p: RawPart, f: Frame): Float32Array {
  const v = transformed(p.pos, f);
  const out = new Float32Array(p.idx.length * 3);
  for (let i = 0; i < p.idx.length; i++) {
    out[i * 3] = v[p.idx[i] * 3];
    out[i * 3 + 1] = v[p.idx[i] * 3 + 1];
    out[i * 3 + 2] = v[p.idx[i] * 3 + 2];
  }
  return out;
}

export function analyze(parts: RawPart[], title: string, hint: AnalyzeHint = {}): Profile {
  if (!parts.length) throw new Error('В модели нет геометрии');
  const boxes = new Map(parts.map((p) => [p.id, bboxOf(p.pos)] as const));
  const B = (p: RawPart) => boxes.get(p.id)!;

  // ---------- 1. мусор: «пол»/подложки и дубликаты-оболочки ----------
  const hidden = new Set<string>();
  const flat = (b: Box) => {
    const s = sizeOf(b);
    return s[1] < 0.02 * Math.max(s[0], s[2]);
  };
  const solid = parts.filter((p) => !flat(B(p)));
  // устойчивые габариты: посторонние объекты сцены (подставка, «пол», стенд) не должны задавать
  // масштаб, землю и оси — иначе колесо «висит», а высота кузова оказывается вдвое больше реальной
  const U0 = trimmedBox((solid.length ? solid : parts).map(B));
  const fp = (b: Box) => sizeOf(b)[0] * sizeOf(b)[2];
  for (const p of parts) if (flat(B(p)) && solid.length && fp(B(p)) > 0.5 * fp(U0)) hidden.add(p.id);
  const vis0 = parts.filter((p) => !hidden.has(p.id));
  const U1 = trimmedBox(vis0.map(B));
  const s1 = sizeOf(U1);
  for (const p of vis0) {
    const s = sizeOf(B(p));
    if (p.alpha < 0.98 && s[0] >= 0.9 * s1[0] && s[1] >= 0.75 * s1[1] && s[2] >= 0.9 * s1[2] && vis0.length > 1) hidden.add(p.id);
  }
  // детали, лежащие заметно вне облака автомобиля (мусор сцены), не участвуют в разметке
  const margin: Vec3 = [0.06 * s1[0], 0.06 * s1[1], 0.06 * s1[2]];
  const outside = (b: Box) =>
    [0, 1, 2].some((a) => b.max[a] < U1.min[a] - margin[a] || b.min[a] > U1.max[a] + margin[a]);
  for (const p of vis0) if (!flat(B(p)) && outside(B(p))) hidden.add(p.id);
  const vis = parts.filter((p) => !hidden.has(p.id));
  const U = trimmedBox(vis.map(B));

  // ---------- 2. ориентация ----------
  const ext = sizeOf(U);
  let yaw = hint.yaw ?? (ext[0] >= ext[2] ? 0 : 90);
  if (hint.yaw === undefined) {
    const cU = yawBox(U, yaw);
    const mid = centerOf(cU)[0];
    let score = 0;
    for (const p of vis) {
      const name = `${p.name} ${p.material}`;
      const c = centerOf(yawBox(B(p), yaw))[0] - mid;
      if (RE_FRONT.test(name) && !RE_REAR.test(name)) score += Math.sign(c);
      if (RE_REAR.test(name) && !RE_FRONT.test(name)) score -= Math.sign(c);
    }
    if (score < 0) yaw = (yaw + 180) % 360;
  }
  const Y = new Map(vis.map((p) => [p.id, yawBox(B(p), yaw)] as const));
  const all = yawBox(U, yaw);
  const [L0, H0, W0] = [sizeOf(all)[0], sizeOf(all)[1], sizeOf(all)[2]];
  const midZ0 = centerOf(all)[2];

  // ---------- 3. колёса (шины) ----------
  interface Tire { p: RawPart; b: Box; merged: boolean }
  const cands: Tire[] = [];
  for (const p of vis) {
    const b = Y.get(p.id)!;
    const [dx, dy, dz] = sizeOf(b);
    const c = centerOf(b);
    if (dy <= 0 || dx / dy < 0.8 || dx / dy > 1.25) continue;
    if (dy < 0.1 * L0 || dy > 0.26 * L0) continue;
    if (b.min[1] - all.min[1] > 0.12 * H0) continue;
    const single = dz < 0.7 * dy && Math.abs(c[2] - midZ0) > 0.25 * W0;
    const merged = dz > 0.55 * W0 && Math.abs(c[2] - midZ0) < 0.15 * W0;
    if (single || merged) cands.push({ p, b, merged });
  }
  cands.sort((a, b) => sizeOf(b.b)[1] - sizeOf(a.b)[1]);
  const tires: Tire[] = [];
  for (const c of cands) if (!tires.some((t) => inside(centerOf(c.b), t.b, 0.02 * L0))) tires.push(c);

  const wheelMembers = new Set<string>();
  for (const t of tires) {
    const ts = sizeOf(t.b);
    for (const p of vis) {
      const b = Y.get(p.id)!;
      const s = sizeOf(b);
      if (s[0] <= ts[0] * 1.05 && s[1] <= ts[1] * 1.05 && s[2] <= ts[2] * 1.1 && inside(centerOf(b), t.b, 0.03 * ts[1])) wheelMembers.add(p.id);
    }
  }

  // ---------- 4. масштаб и положение ----------
  const tireDia = median(tires.map((t) => sizeOf(t.b)[1]));
  let scale = 1;
  if (hint.scale) scale = hint.scale;
  else if (hint.length) scale = hint.length / L0;
  else {
    scale = tireDia > 0 ? 0.66 / tireDia : 4.4 / L0;
    if (L0 * scale < 3.2 || L0 * scale > 5.9) scale = 4.4 / L0;
  }
  const xsT = tires.flatMap((t) => (t.merged ? [centerOf(t.b)[0]] : [centerOf(t.b)[0]]));
  let ax0 = xsT.length ? Math.max(...xsT) : 0;
  let ax1 = xsT.length ? Math.min(...xsT) : 0;
  const cx0 = centerOf(all)[0];
  if (!xsT.length || ax0 - ax1 < 0.15 * L0) {
    ax0 = cx0 + 0.31 * L0;
    ax1 = cx0 - 0.31 * L0;
  }
  const ground = tires.length ? Math.min(...tires.map((t) => t.b.min[1])) : all.min[1];
  const zT = tires.filter((t) => !t.merged).map((t) => centerOf(t.b)[2]);
  const zMid = zT.length ? (Math.max(...zT) + Math.min(...zT)) / 2 : midZ0;
  const frame: Frame = { yaw, scale, offset: [-((ax0 + ax1) / 2) * scale, -ground * scale, -zMid * scale] };
  const car = (b: Box): Box => {
    const f = (v: number, a: number) => v * scale + frame.offset[a];
    return { min: [f(b.min[0], 0), f(b.min[1], 1), f(b.min[2], 2)], max: [f(b.max[0], 0), f(b.max[1], 1), f(b.max[2], 2)] };
  };

  // ---------- 5. типы деталей (предварительно) ----------
  const kind = new Map<string, Kind>();
  const confidence = new Map<string, DataConfidence>();
  for (const p of parts) {
    const name = `${p.name} ${p.material}`;
    const sz = sizeOf(B(p));
    const small = Math.max(...sz) * scale < 0.3;
    let k: Kind = 'trim';
    let c: DataConfidence = 'low';
    if (hidden.has(p.id)) {
      k = 'hide';
      c = 'medium';
    } else if (wheelMembers.has(p.id)) {
      k = RE_BRAKE.test(name) ? 'brake' : 'wheel';
      c = RE_BRAKE.test(name) || RE_WHEEL.test(name) ? 'high' : 'medium';
    } else if (RE_LIGHT.test(name) || (p.emissive && p.alpha >= 0.98 && small)) {
      k = 'light';
      c = RE_LIGHT.test(name) ? 'high' : 'medium';
    } else if ((p.alpha < 0.97 || RE_GLASS.test(name)) && !small) {
      k = 'glass';
      c = RE_GLASS.test(name) ? 'high' : 'medium';
    }
    kind.set(p.id, k);
    confidence.set(p.id, c);
  }

  // материалы краски: по названию, иначе — материал с наибольшим числом треугольников в крупных деталях
  const free = vis.filter((p) => kind.get(p.id) === 'trim');
  let paintMats = hint.paint;
  let inferredPaintConfidence: DataConfidence = hint.paint ? 'high' : 'low';
  if (!paintMats) {
    const diag = (p: RawPart) => Math.hypot(...sizeOf(B(p))) * scale;
    const score = new Map<string, number>();
    const named = new Map<string, number>();
    for (const p of free) {
      if (RE_NOT_PAINT.test(`${p.material}`.replace(/material/gi, ''))) continue;
      const big = diag(p) > 0.45 * (L0 * scale);
      const tris = p.idx.length / 3;
      if (big) score.set(p.material, (score.get(p.material) ?? 0) + tris);
      if (RE_PAINT.test(p.material)) named.set(p.material, (named.get(p.material) ?? 0) + tris);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const namedPick = top(named);
    const scoredPick = top(score);
    const pick = namedPick ?? scoredPick ?? free[0]?.material;
    inferredPaintConfidence = namedPick ? 'high' : scoredPick ? 'medium' : 'low';
    paintMats = pick ? [pick] : [];
  }
  for (const p of free) {
    if (!paintMats.includes(p.material)) continue;
    kind.set(p.id, 'paint');
    confidence.set(p.id, hint.paint || RE_PAINT.test(p.material) ? 'high' : inferredPaintConfidence);
  }

  // ---------- 6. габариты ----------
  const paintBoxes = vis.filter((p) => kind.get(p.id) === 'paint').map((p) => car(yawBox(B(p), yaw)));
  const cAll = car(all);
  const pb = paintBoxes.length ? unionBox(paintBoxes) : cAll;
  const L = cAll.max[0] - cAll.min[0];
  const W = Math.min(pb.max[2] - pb.min[2], cAll.max[2] - cAll.min[2]);
  const H = pb.max[1];
  const xFront = cAll.max[0];
  const xRear = cAll.min[0];
  const wheelsCar = tires.map((t) => car(t.b));
  const axleF = wheelsCar.length ? Math.max(...wheelsCar.map((b) => centerOf(b)[0])) : 0.31 * L + (xFront + xRear) / 2;
  const axleR = wheelsCar.length ? Math.min(...wheelsCar.map((b) => centerOf(b)[0])) : (xFront + xRear) / 2 - 0.31 * L;
  const single = wheelsCar.filter((b) => sizeOf(b)[2] < 0.6 * W);
  const dims: Dims = {
    L, W, H, xFront, xRear,
    axleF: axleF - axleR > 0.3 * L ? axleF : (xFront + xRear) / 2 + 0.31 * L,
    axleR: axleF - axleR > 0.3 * L ? axleR : (xFront + xRear) / 2 - 0.31 * L,
    track: single.length ? single.reduce((s, b) => s + Math.abs(centerOf(b)[2]), 0) / single.length : 0.43 * W,
    wheelR: tireDia > 0 ? (tireDia * scale) / 2 : 0.33,
  };
  const hw = W / 2;

  // ---------- 7. границы панелей ----------
  // прозрачные детали ниже линии стёкол — это оптика, а не окна
  for (const p of vis) {
    if (kind.get(p.id) !== 'glass') continue;
    const c = centerOf(car(yawBox(B(p), yaw)));
    if (c[1] < 0.64 * H) kind.set(p.id, 'light');
  }
  const glassParts = vis.filter((p) => kind.get(p.id) === 'glass').map((p) => ({ pos: soup(p, frame), c: centerOf(car(yawBox(B(p), yaw))) }));
  const gs = glassStats(glassParts, hw);
  // пропорции BMW/Solaris — запасной вариант
  let cowl = xFront - 0.356 * L;
  let roofFront = cowl - 0.155 * L;
  let roofRear = xRear + 0.194 * L;
  let doorFront = cowl - 0.06;
  let doorRear = roofRear + 0.06;
  let doorSplit = doorFront - 0.54 * (doorFront - doorRear);
  let belt = 0.63 * H;
  let clusters = 2;
  let rearBase = xRear + 0.15 * L;
  if (gs.front.n > 4) {
    cowl = gs.front.xMax;
    roofFront = gs.front.xMin;
  }
  if (gs.rear.n > 4) {
    roofRear = gs.rear.xMax;
    rearBase = gs.rear.xMin;
  }
  if (gs.side.x.length > 6) {
    doorFront = Math.min(cowl, gs.side.xMax + 0.1);
    doorRear = gs.side.xMin - 0.05;
    belt = gs.side.yMin;
    const xs = [...gs.side.x].sort((a, b) => a - b);
    let gap = 0;
    let at = (doorFront + doorRear) / 2;
    for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) ((gap = xs[i] - xs[i - 1]), (at = (xs[i] + xs[i - 1]) / 2));
    clusters = gap > 0.1 ? 2 : 1;
    doorSplit = clusters === 2 ? at : doorRear;
  }
  let body: BodyType = hint.body ?? (clusters < 2 ? 'coupe' : rearBase - xRear >= 0.14 * L ? 'sedan' : 'hatch');
  if (body === 'coupe') {
    // у купе в боковом стекле есть и неподвижная «форточка» за дверью — дверь не длиннее ~1.3 м
    doorRear = Math.max(doorRear, doorFront - 0.3 * L);
    doorSplit = doorRear;
  }
  const lines: Lines = {
    bumperFront: xFront - 0.06 * L,
    cowl,
    doorFront,
    roofFront,
    doorSplit,
    roofRear,
    doorRear,
    trunkFront: body === 'hatch' ? Math.min(roofRear, doorRear) : Math.min(rearBase, doorRear),
    bumperRear: xRear + 0.06 * L,
    sill: 0.19 * H,
    belt,
    bumperTopF: 0.46 * H,
    bumperTopR: 0.46 * H,
    hoodHw: 0.74 * hw,
    trunkHw: 0.7 * hw,
  };

  let notesBody = '';
  // ---------- 8. реальные границы деталей (швы) ----------
  // Если капот/двери/крышка/бамперы лежат в модели отдельными мешами, узел и границы берём по ним:
  // резать кузов по прямым линиям в этом случае не нужно и получается «не по кромкам панелей».
  const toCar = (b: Box): Box => car(yawBox(b, yaw));
  const findings =
    hint.panels === false
      ? { panels: [], lines: {}, notes: [] }
      : detectPanels({
          parts: vis,
          hidden,
          kinds: kind,
          toCar,
          dims,
          lines,
          sideGlass: gs.side.x.length > 6 ? { xMin: gs.side.xMin, xMax: gs.side.xMax } : undefined,
        });
  const linePatch = findings.lines as Partial<Record<keyof Lines, number>>;
  // отдельные меши дверей — надёжнее стёкол: четыре двери исключают купе, две — ставят под сомнение седан
  const doorZones = findings.panels.filter((panel) => panel.zone.startsWith('door_')).map((panel) => panel.zone);
  if (hint.body === undefined && body === 'coupe' && doorZones.includes('door_rl') && doorZones.includes('door_rr')) {
    body = rearBase - xRear >= 0.14 * L ? 'sedan' : 'hatch';
    if (linePatch.trunkFront === undefined) {
      lines.trunkFront = body === 'hatch' ? Math.min(lines.roofRear, lines.doorRear) : Math.min(rearBase, lines.doorRear);
    }
    notesBody = `Найдены четыре двери: тип кузова уточнён как «${body === 'sedan' ? 'седан' : 'хэтчбек'}».`;
  }
  for (const key of Object.keys(linePatch) as (keyof Lines)[]) {
    const value = linePatch[key];
    if (value === undefined || !Number.isFinite(value)) continue;
    // защита от абсурдных значений: кромка не может уехать за пределы кузова
    const span = key === 'sill' || key === 'belt' || key === 'bumperTopF' || key === 'bumperTopR'
      ? [0, H]
      : key === 'hoodHw' || key === 'trunkHw'
        ? [0.15 * hw, hw * 0.98]
        : [xRear - 0.05, xFront + 0.05];
    if (value < span[0] || value > span[1]) continue;
    if (key === 'sill' || key === 'belt') {
      if (key === 'sill' && value > lines.belt - 0.05) continue;
      if (key === 'belt' && value < lines.sill + 0.05) continue;
    }
    (lines[key] as number) = value;
  }
  // границы дверей могли сдвинуться — пересчитываем производные линии (если кромку крышки не нашли по мешу)
  if (linePatch.doorRear !== undefined && linePatch.trunkFront === undefined && body !== 'coupe') {
    lines.trunkFront = body === 'hatch' ? Math.min(lines.roofRear, lines.doorRear) : Math.min(rearBase, lines.doorRear);
  }
  const notes = [...findings.notes];
  if (notesBody) notes.push(notesBody);
  const pinned = new Map<string, string>();
  for (const panel of findings.panels) {
    const target = remapPanelZone(panel.zone, body);
    for (const id of panel.parts) if (!pinned.has(id)) pinned.set(id, target);
  }
  if (findings.panels.some((p) => p.zone.startsWith('door_'))) {
    notes.push(`Края дверей: ${lines.doorFront.toFixed(2)} / ${lines.doorSplit.toFixed(2)} / ${lines.doorRear.toFixed(2)} м.`);
  }

  // ---------- 9. салон: детали внутри кабины ----------
  const cabinMinX = lines.doorRear - 0.3;
  const cabinMaxX = lines.cowl + 0.25;
  const insideCabin = (b: Box): boolean => {
    const c = centerOf(b);
    const s = sizeOf(b);
    if (s[0] > 0.95 * L || s[1] > 0.95 * H || s[2] > 1.05 * W) return false;
    if (c[0] < cabinMinX || c[0] > cabinMaxX) return false;
    if (Math.abs(c[2]) > 0.9 * hw) return false;
    if (c[1] < 0.06 * H || b.max[1] > H * 1.02) return false;
    return true;
  };
  for (const p of vis) {
    const k = kind.get(p.id);
    if (k !== 'trim' && k !== 'glass') continue;
    const name = `${p.name} ${p.material}`;
    const b = car(yawBox(B(p), yaw));
    const c = centerOf(b);
    const s = sizeOf(b);
    // по названию: обивка, сиденья, торпедо, потолок, карты дверей
    if (k === 'trim' && RE_INTERIOR.test(name) && insideCabin(b)) {
      kind.set(p.id, 'int');
      confidence.set(p.id, 'medium');
      continue;
    }
    // по геометрии: мелкая неокрашенная деталь внутри кабины
    if (
      k === 'trim' &&
      Math.abs(c[2]) < 0.6 * hw && c[1] > lines.sill * 0.5 && c[1] < lines.belt + 0.5 && c[0] > cabinMinX && c[0] < cabinMaxX &&
      b.max[1] < H * 0.97 && s[0] < 0.7 * L
    ) {
      kind.set(p.id, 'int');
      confidence.set(p.id, 'low');
    }
  }
  const interiorParts = vis.filter((p) => kind.get(p.id) === 'int').length;
  const hasInterior = interiorParts >= 2;
  if (hasInterior) notes.push(`Салон: найдено деталей — ${interiorParts}; узлы салона берутся из модели.`);
  else notes.push('Салон в модели не найден: узлы салона можно достроить процедурно или назначить детали вручную.');

  const infos: Record<string, PartInfo> = {};
  for (const p of parts) {
    const keep = hint.keep?.[p.id];
    if (keep?.u) {
      infos[p.id] = keep;
      continue;
    }
    const info: PartInfo = { n: p.name, k: kind.get(p.id) ?? 'trim', m: p.material, confidence: confidence.get(p.id) ?? 'low' };
    const zone = pinned.get(p.id);
    if (zone) {
      // деталь совпадает с реальной панелью кузова: узел берётся из меша, а не из разрезов
      info.z = zone;
      info.b = 1;
      info.confidence = findings.panels.find((x) => x.parts.includes(p.id))?.confidence ?? 'medium';
    }
    infos[p.id] = info;
  }
  return {
    v: 1,
    title,
    body,
    layout: hint.layout ?? 'front',
    driver: hint.driver ?? 'l',
    provenance: {
      dimensions: hint.length !== undefined ? 'manual' : 'auto',
      dimensionsConfidence: hint.length !== undefined ? 'medium' : 'low',
      panelBoundaries: hint.body !== undefined ? 'manual' : findings.panels.length ? 'auto' : 'auto',
      panelBoundariesConfidence: hint.body !== undefined ? 'medium' : findings.panels.length ? 'medium' : 'low',
    },
    autoNotes: notes.length ? notes.slice(0, 8) : undefined,
    frame,
    dims,
    lines,
    paint: paintMats,
    parts: infos,
  };
}

/** Узел панели с учётом типа кузова (у купе задних дверей нет). */
function remapPanelZone(zone: string, body: BodyType): string {
  if (body === 'coupe' && (zone === 'door_rl' || zone === 'door_rr')) return zone.replace('door_r', 'door_f');
  return zone;
}
