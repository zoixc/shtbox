/**
 * Поиск настоящих границ кузовных деталей («швов») в геометрии модели.
 *
 * Многие загруженные модели уже собраны из отдельных мешей: капот, крышка багажника, двери, крылья,
 * бамперы лежат отдельными деталями. Тогда резать кузов по прямым линиям (`Profile.lines`) не нужно —
 * у детали уже есть свои кромки, и открываться панель должна именно по ним.
 *
 * Модуль ищет детали, форма и положение которых соответствуют двери/капоту/крышке/бамперу, попарно
 * сопоставляет левые и правые детали (симметрия — сильный признак) и возвращает:
 *  — `panels`: зоны, целиком покрытые отдельными мешами (их детали «закрепляются» за узлом);
 *  — `lines`: уточнённые по реальным кромкам линии (капот↔лобовое, края дверей, порог, бамперы).
 *
 * Это эвристика по геометрии: результат приблизительный, показывается с уровнем уверенности и
 * правится вручную в мастере импорта.
 */
import type { Box } from './frame';
import { bboxOf, centerOf, sizeOf, unionBox } from './frame';
import type { DataConfidence, Dims, Kind, Lines, RawPart, Vec3 } from './types';

export interface PanelPart {
  zone: string;
  /** детали модели, из которых состоит панель */
  parts: string[];
  /** габариты панели в системе автомобиля (одна сторона) */
  box: Box;
  confidence: DataConfidence;
}

export interface PanelFindings {
  panels: PanelPart[];
  /** линии, уточнённые по кромкам найденных деталей */
  lines: Partial<Lines>;
  notes: string[];
}

export interface PanelInput {
  parts: RawPart[];
  /** детали, отнесённые к скрытым (мусор/подложка) */
  hidden: ReadonlySet<string>;
  /** тип детали после первичной классификации */
  kinds: ReadonlyMap<string, Kind>;
  /** перевод габарита детали в систему автомобиля */
  toCar: (box: Box) => Box;
  dims: Dims;
  lines: Lines;
  /** диапазон X боковых стёкол (если найдены) — дверь обязана быть под стеклом */
  sideGlass?: { xMin: number; xMax: number };
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const ratio = (a0: number, a1: number, b0: number, b1: number): number => {
  const o = overlap(a0, a1, b0, b1);
  const len = Math.min(a1 - a0, b1 - b0);
  return len > 1e-9 ? o / len : 0;
};

/**
 * Устойчивые габариты сцены: посторонние объекты (подставка, «пол», детали сцены), вынесенные
 * из общего облака, не должны растягивать коробку — иначе ломаются масштаб, земля и поиск колёс.
 * Отбрасываем детали, чей центр далеко от медианного.
 */
export function trimmedBox(boxes: Box[]): Box {
  if (!boxes.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const centers = boxes.map(centerOf);
  const sizes = boxes.map(sizeOf);
  const med = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
  const median = [0, 1, 2].map((a) => med(centers.map((c) => c[a])));
  const span = [0, 1, 2].map((a) => {
    const lo = Math.min(...centers.map((c) => c[a]));
    const hi = Math.max(...centers.map((c) => c[a]));
    return Math.max(hi - lo, med(sizes.map((s) => s[a])));
  });
  // допуск — половина размаха центров по оси: отсекаются вынесенные объекты,
  // но остаются законные свесы, бамперы и зеркала
  const picked = boxes.filter((b) => {
    const c = centerOf(b);
    return [0, 1, 2].every((a) => Math.abs(c[a] - median[a]) <= 0.5 * span[a]);
  });
  return unionBox(picked.length >= 4 ? picked : boxes);
}

interface Candidate {
  /** детали, из которых состоит панель: дверь может лежать полотном и надставкой */
  parts: RawPart[];
  box: Box;
  size: Vec3;
  center: Vec3;
  tris: number;
}

const asCandidate = (part: RawPart, box: Box): Candidate => ({
  parts: [part],
  box,
  size: sizeOf(box),
  center: centerOf(box),
  tris: part.idx.length / 3,
});

/** Полотно двери: узкая по Z пластина на одном борту, длиной примерно с дверь. */
function sidePlate(c: Candidate, D: Dims): boolean {
  const hw = D.W / 2;
  if (c.size[0] < 0.5 || c.size[0] > 1.65) return false;
  if (c.size[1] < 0.3 || c.size[1] > 0.98) return false;
  if (c.size[2] > 0.55 * hw) return false;
  if (Math.abs(c.center[2]) < 0.3 * hw) return false;
  if (c.box.min[1] < 0.03 * D.H || c.box.max[1] > 0.98 * D.H) return false;
  return c.center[0] > D.xRear + 0.12 * D.L && c.center[0] < D.xFront - 0.15 * D.L;
}

/** Пары «левая + правая» с совпадающими габаритами: двери, крылья, накладки порогов. */
interface Pair {
  left: Candidate;
  right: Candidate;
  box: Box;
}

function pairSides(cands: Candidate[]): Pair[] {
  const used = new Set<Candidate>();
  const pairs: Pair[] = [];
  const pick = [...cands].sort((a, b) => b.tris - a.tris);
  for (const a of pick) {
    if (used.has(a)) continue;
    const mate = pick.find((b) => {
      if (b === a || used.has(b) || Math.sign(b.center[2]) === Math.sign(a.center[2])) return false;
      if (Math.abs(a.center[0] - b.center[0]) > 0.1 || Math.abs(a.center[1] - b.center[1]) > 0.1) return false;
      if (Math.abs(Math.abs(a.center[2]) - Math.abs(b.center[2])) > 0.1) return false;
      return Math.abs(a.size[0] - b.size[0]) < 0.12 && Math.abs(a.size[1] - b.size[1]) < 0.12;
    });
    if (!mate) continue;
    const left = a.center[2] < 0 ? a : mate;
    const right = left === a ? mate : a;
    used.add(left);
    used.add(right);
    pairs.push({ left, right, box: unionBox([left.box, right.box]) });
  }
  return pairs;
}

/** Склеивает детали одной панели: дверь может состоять из полотна и надставки/рамки. */
function mergeStacked(cands: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => b.tris - a.tris)) {
    const same = out.find((o) => Math.sign(o.center[2]) === Math.sign(c.center[2])
      && ratio(o.box.min[0], o.box.max[0], c.box.min[0], c.box.max[0]) > 0.7
      && ratio(o.box.min[1], o.box.max[1], c.box.min[1], c.box.max[1]) > 0.7);
    if (same) {
      same.parts.push(...c.parts);
      same.box = unionBox([same.box, c.box]);
      same.size = sizeOf(same.box);
      same.center = centerOf(same.box);
      same.tris += c.tris;
      continue;
    }
    out.push({ ...c, parts: [...c.parts], box: { min: [...c.box.min] as Vec3, max: [...c.box.max] as Vec3 } });
  }
  return out;
}

export function detectPanels(input: PanelInput): PanelFindings {
  const { parts, hidden, kinds, toCar, dims: D, lines, sideGlass } = input;
  const candidates: Candidate[] = [];
  for (const p of parts) {
    if (hidden.has(p.id)) continue;
    const k = kinds.get(p.id);
    if (k !== 'paint' && k !== 'trim') continue;
    candidates.push(asCandidate(p, toCar(bboxOf(p.pos))));
  }
  const panels: PanelPart[] = [];
  const linesOut: Partial<Lines> = {};
  const notes: string[] = [];
  const hw = D.W / 2;

  // ---------- двери ----------
  const pairs = pairSides(mergeStacked(candidates.filter((c) => sidePlate(c, D))));
  const underGlass = (p: Pair) =>
    !sideGlass || ratio(p.box.min[0], p.box.max[0], sideGlass.xMin, sideGlass.xMax) > 0.25;
  // передняя дверь — пара, передняя кромка которой сходится с линией капота (стойкой A)
  const ranked = [...pairs].sort((a, b) => Math.abs(a.box.max[0] - lines.cowl) - Math.abs(b.box.max[0] - lines.cowl));
  const front = ranked.find(underGlass);
  if (front) {
    const frontMatch = Math.abs(front.box.max[0] - lines.cowl) < 0.35;
    // задняя дверь — пара, стоящая вплотную за передней
    const rear = pairs
      .filter((p) => p !== front && p.box.max[0] <= front.box.min[0] + 0.08 && p.box.max[0] > front.box.min[0] - 0.35)
      .sort((a, b) => b.box.max[0] - a.box.max[0])[0];
    const conf: DataConfidence = frontMatch && rear ? 'high' : 'medium';
    panels.push({ zone: 'door_fl', parts: front.left.parts.map((p) => p.id), box: front.left.box, confidence: conf });
    panels.push({ zone: 'door_fr', parts: front.right.parts.map((p) => p.id), box: front.right.box, confidence: conf });
    if (rear) {
      panels.push({ zone: 'door_rl', parts: rear.left.parts.map((p) => p.id), box: rear.left.box, confidence: conf });
      panels.push({ zone: 'door_rr', parts: rear.right.parts.map((p) => p.id), box: rear.right.box, confidence: conf });
    }
    linesOut.doorFront = front.box.max[0];
    linesOut.doorRear = rear ? rear.box.min[0] : front.box.min[0];
    linesOut.doorSplit = rear ? (front.box.min[0] + rear.box.max[0]) / 2 : linesOut.doorRear;
    const doors = rear ? [front, rear] : [front];
    const bottom = Math.min(...doors.map((p) => p.box.min[1]));
    const top = Math.max(...doors.map((p) => p.box.max[1]));
    if (bottom > 0.04 * D.H && bottom < 0.45 * D.H) linesOut.sill = bottom;
    if (top > 0.4 * D.H && top < 0.85 * D.H) linesOut.belt = top;
    notes.push(rear ? 'Двери найдены отдельными деталями: края панелей взяты по кромкам мешей.' : 'Найдена пара дверей: края взяты по кромкам мешей.');
  }

  // ---------- капот ----------
  const sheets = candidates.filter((c) => c.size[2] > 0.45 * D.W && c.size[1] < 0.34);
  const cowl = Math.max(lines.cowl, lines.roofFront);
  const hood = sheets
    .filter((c) => c.center[0] > 0 && c.box.min[0] > cowl - 0.35 && c.center[1] > 0.45 * D.H && c.size[1] < 0.28)
    .sort((a, b) => b.size[0] * b.size[2] - a.size[0] * a.size[2])[0];
  if (hood) {
    panels.push({ zone: 'hood', parts: hood.parts.map((p) => p.id), box: hood.box, confidence: 'medium' });
    if (hood.box.min[0] > D.xRear + 0.2 * D.L && hood.box.min[0] < D.xFront - 0.15 * D.L) linesOut.cowl = hood.box.min[0];
    const half = hood.size[2] / 2;
    if (half > 0.5 * hw && half < 0.95 * hw) linesOut.hoodHw = half;
    notes.push('Капот найден отдельной деталью.');
  }

  // ---------- крышка багажника / задняя дверь ----------
  const tailPool = candidates
    .filter((c) => c.size[2] > 0.45 * D.W && c.box.max[0] < Math.min(lines.roofRear, linesOut.doorRear ?? lines.doorRear) + 0.15 && c.center[1] > 0.5 * D.H && c.box.max[1] < 0.95 * D.H)
    .sort((a, b) => b.size[1] * b.size[2] - a.size[1] * a.size[2]);
  const tail = tailPool[0];
  if (tail) {
    panels.push({ zone: 'trunk', parts: tail.parts.map((p) => p.id), box: tail.box, confidence: 'medium' });
    const half = tail.size[2] / 2;
    if (half > 0.4 * hw && half < 0.98 * hw) linesOut.trunkHw = half;
    if (tail.size[0] < 0.4 * D.L && tail.box.max[0] < (linesOut.doorRear ?? lines.doorRear)) linesOut.trunkFront = tail.box.min[0];
    notes.push('Крышка багажника / задняя дверь найдена отдельной деталью.');
  }

  // ---------- бамперы ----------
  for (const frontSide of [true, false]) {
    const band = candidates
      .filter((c) => c.size[2] > 0.5 * D.W && c.size[1] > 0.12 && c.box.max[1] < 0.62 * D.H)
      .filter((c) => (frontSide ? c.center[0] > D.xFront - 0.22 * D.L : c.center[0] < D.xRear + 0.22 * D.L))
      .sort((a, b) => b.size[2] * b.size[1] - a.size[2] * a.size[1])[0];
    if (!band) continue;
    panels.push({ zone: frontSide ? 'bumper_f' : 'bumper_r', parts: band.parts.map((p) => p.id), box: band.box, confidence: 'medium' });
    if (frontSide) {
      linesOut.bumperFront = band.box.max[0];
      if (band.box.max[1] > 0.2 * D.H) linesOut.bumperTopF = band.box.max[1];
    } else {
      linesOut.bumperRear = band.box.min[0];
      if (band.box.max[1] > 0.2 * D.H) linesOut.bumperTopR = band.box.max[1];
    }
    notes.push(frontSide ? 'Передний бампер найден отдельной деталью.' : 'Задний бампер найден отдельной деталью.');
  }

  return { panels, lines: linesOut, notes };
}

export const panelOf = (panels: PanelPart[], zone: string): PanelPart | undefined => panels.find((p) => p.zone === zone);
