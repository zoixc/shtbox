/**
 * Проверки модели перед сохранением: правдоподобность размеров, колёса на земле,
 * симметрия по Z, найденные колёса/стёкла/панели и честность `provenance`.
 *
 * Проверки делятся на две части: числовые (только по профилю) и геометрические (по мировому
 * bbox сцены после применения рамки). Геометрические не считаются, если bbox ещё не посчитан,
 * чтобы не показывать ложных предупреждений.
 */
import type { Profile } from './types';

export type CheckLevel = 'ok' | 'warn' | 'error';
export type CheckAction = 'ground' | 'center';

export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SanityCheck {
  id: string;
  level: CheckLevel;
  title: string;
  hint?: string;
  /** Кнопка быстрого исправления в мастере. */
  action?: CheckAction;
}

const RANGES = {
  length: [2.2, 7.0],
  width: [1.2, 2.6],
  height: [0.9, 2.3],
  wheelbase: [1.6, 4.0],
  /** `dims.track` — это среднее |Z| колёс, то есть половина колеи (полная ~1.5 м). */
  track: [0.5, 1.25],
  wheelR: [0.2, 0.55],
} as const;

const m = (value: number, digits = 2) => `${value.toFixed(digits)} м`;

/**
 * «Похоже на дюймы»: если числовое значение длины во столько раз больше метра —
 * значит, исходник, скорее всего, в этой единице. Подсказка даёт готовое число в метрах.
 */
const UNITS: [string, number, number][] = [
  ['дюймах', 0.0254, 1],
  ['сантиметрах', 0.01, 100],
  ['миллиметрах', 0.001, 1000],
];

function unitHint(length: number): string | undefined {
  for (const [name, factor] of UNITS) {
    const meters = length * factor;
    if (meters >= 2.2 && meters <= 7) {
      return `Похоже, исходник в ${name}: ${length.toFixed(0)} — это ${meters.toFixed(2)} м. Укажите длину в метрах на вкладке «Ориентация», остальное пересчитается.`;
    }
  }
  return undefined;
}

function inRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

function countOf(profile: Profile, kind: string): number {
  return Object.values(profile.parts).filter((part) => part.k === kind).length;
}

/** Числовые проверки: работают всегда, даже пока сцена не собрана. */
export function profileChecks(profile: Profile): SanityCheck[] {
  const checks: SanityCheck[] = [];
  const { L, W, H, axleF, axleR, track, wheelR } = profile.dims;
  const wheelbase = axleF - axleR;

  checks.push(
    inRange(L, RANGES.length)
      ? { id: 'length', level: 'ok', title: `Длина ${m(L)} выглядит правдоподобно` }
      : {
          id: 'length',
          level: 'warn',
          title: `Длина ${m(L, 1)} выглядит неправдоподобно`,
          hint: unitHint(L) ?? 'Проверьте длину на вкладке «Ориентация» — масштаб мог определиться по неверной детали.',
        },
  );

  checks.push(
    inRange(wheelbase, RANGES.wheelbase)
      ? { id: 'wheelbase', level: 'ok', title: `Колёсная база ${m(wheelbase)} в норме` }
      : { id: 'wheelbase', level: 'warn', title: `Колёсная база ${m(wheelbase)} не похожа на легковую`, hint: 'Колёса найдены неверно или модель масштабирована не по автомобилю.' },
  );

  const sizeNote: string[] = [];
  if (!inRange(W, RANGES.width)) sizeNote.push(`ширина ${m(W)}`);
  if (!inRange(H, RANGES.height)) sizeNote.push(`высота ${m(H)}`);
  if (!inRange(track, RANGES.track)) sizeNote.push(`половина колеи ${m(track)}`);
  if (!inRange(wheelR, RANGES.wheelR)) sizeNote.push(`радиус колеса ${m(wheelR)}`);
  checks.push(
    sizeNote.length
      ? { id: 'proportions', level: 'warn', title: `Странные пропорции: ${sizeNote.join(', ')}`, hint: 'Проверьте тип кузова и размеры; возможно, колёса определены по неверным деталям.' }
      : { id: 'proportions', level: 'ok', title: 'Ширина, высота, колея и радиус колеса в норме' },
  );

  const wheels = countOf(profile, 'wheel');
  checks.push(
    wheels === 4
      ? { id: 'wheels', level: 'ok', title: 'Найдены все 4 колеса' }
      : {
          id: 'wheels',
          level: 'warn',
          title: wheels === 0 ? 'Колёса не найдены — масштаб определён по габаритам' : `Найдено колёс: ${wheels} из 4`,
          hint: 'Отметьте колёса вручную на вкладке «Узлы» — от них зависят масштаб, посадка и база.',
        },
  );

  const glass = countOf(profile, 'glass');
  checks.push(
    glass >= 2
      ? { id: 'glass', level: 'ok', title: `Стёкла найдены (${glass})` }
      : { id: 'glass', level: 'warn', title: glass === 0 ? 'Стёкла не найдены' : 'Найдено только одно стекло', hint: 'Проверьте материалы стёкол на вкладке «Узлы».' },
  );

  const panels = countOf(profile, 'paint');
  checks.push(
    panels >= 4
      ? { id: 'panels', level: 'ok', title: `Окрашиваемых панелей: ${panels}` }
      : { id: 'panels', level: 'warn', title: `Окрашиваемых панелей мало (${panels})`, hint: 'Проверьте границы панелей на вкладке «Панели».' },
  );

  const provenance = profile.provenance;
  const dimensionsVerified = provenance?.dimensions && provenance.dimensions !== 'auto';
  checks.push(
    dimensionsVerified || provenance?.dimensionsConfidence === 'high'
      ? { id: 'provenance', level: 'ok', title: 'Источник размеров указан' }
      : {
          id: 'provenance',
          level: 'warn',
          title: 'Размеры не сверены с документом',
          hint: 'На вкладке «Готово» укажите источник размеров (CoC, руководство) — это повысит доверие к данным.',
        },
  );

  return checks;
}

/** Геометрические проверки по мировому bbox (после применения рамки). */
export function geometryChecks(profile: Profile, box: Box3Like | null): SanityCheck[] {
  if (!box) return [];
  const checks: SanityCheck[] = [];
  const { L, W, H } = profile.dims;

  const ground = box.min[1];
  checks.push(
    Math.abs(ground) <= 0.03
      ? { id: 'ground', level: 'ok', title: 'Модель стоит на земле (y ≈ 0)' }
      : {
          id: 'ground',
          level: 'warn',
          title: ground < 0 ? `Часть геометрии ниже уровня шин на ${m(Math.abs(ground))}` : `Модель висит над землёй на ${m(ground)}`,
          hint: 'Можно выровнять одним нажатием: низ модели встанет на y = 0.',
          action: 'ground',
        },
  );

  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]] as const;
  const mismatch: string[] = [];
  if (Math.abs(size[0] - L) > Math.max(0.12 * L, 0.12)) mismatch.push(`длина ${m(size[0])} вместо ${m(L)}`);
  if (Math.abs(size[1] - H) > Math.max(0.12 * H, 0.1)) mismatch.push(`высота ${m(size[1])} вместо ${m(H)}`);
  if (Math.abs(size[2] - W) > Math.max(0.12 * W, 0.1)) mismatch.push(`ширина ${m(size[2])} вместо ${m(W)}`);
  checks.push(
    mismatch.length
      ? { id: 'size', level: 'warn', title: `Габариты модели и разметки расходятся: ${mismatch.join(', ')}`, hint: 'Обычно это низкие/высокие детали (спойлер, багажник на крыше) — сверьтесь с источником размеров.' }
      : { id: 'size', level: 'ok', title: 'Габариты модели совпадают с разметкой' },
  );

  const centerZ = (box.min[2] + box.max[2]) / 2;
  checks.push(
    Math.abs(centerZ) <= Math.max(0.06 * W, 0.06)
      ? { id: 'symmetry', level: 'ok', title: 'Симметрия по Z в норме' }
      : { id: 'symmetry', level: 'warn', title: `Модель смещена вбок на ${m(Math.abs(centerZ))}`, hint: 'Так бывает из-за зеркал, антенны или односторонней детали — проверьте, что руль и двери на своих сторонах. Если смещение не мешает, выравнивать не нужно.', action: 'center' },
  );

  return checks;
}

export function runChecks(profile: Profile, box: Box3Like | null): SanityCheck[] {
  return [...profileChecks(profile), ...geometryChecks(profile, box)];
}

/** Сдвигает рамку по Y так, чтобы низ модели встал на y = 0. Возвращает null, если правка не нужна. */
export function groundProfile(profile: Profile, box: Box3Like): Profile | null {
  if (Math.abs(box.min[1]) <= 0.005) return null;
  const next = structuredClone(profile);
  next.frame.offset[1] -= box.min[1];
  return next;
}

/** Сдвигает рамку по Z так, чтобы габарит встал по оси симметрии. Возвращает null, если правка не нужна. */
export function centerProfile(profile: Profile, box: Box3Like): Profile | null {
  const offset = (box.min[2] + box.max[2]) / 2;
  if (Math.abs(offset) <= 0.005) return null;
  const next = structuredClone(profile);
  next.frame.offset[2] -= offset;
  return next;
}
