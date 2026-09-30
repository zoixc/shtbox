/**
 * Поиск цвета по коду и названию: HEX, `rgb(...)`, RAL, слова по-русски и по-английски,
 * а также собственные коды производителя (BMW 475, VW LC9Z…), которые пользователь
 * добавляет сам: открытого официального реестра таких кодов нет, поэтому они живут
 * в localStorage (см. `loadCustomColors`/`saveCustomColors`).
 */
import { PAINT_COLORS } from './paintColors';
import type { PaintColor } from './paintColors';
import type { PaintFinish } from './paintFinish';

export const CUSTOM_COLOR_KEY = 'shtbox.paint.custom';
export const MAX_CUSTOM_COLORS = 200;

export interface CustomColor extends PaintColor {
  /** пользовательский цвет: введён вручную */
  custom: true;
}

const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/i;
const HSL = /^hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%/i;

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number) => clamp255(n).toString(16).padStart(2, '0');

export const toHex = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return { h, s, l };
}

/** Разбирает ввод как цвет: `#0a0a0a`, `0a0a0a`, `#abc`, `rgb(...)`, `hsl(...)`. */
export function parseColorInput(text: string): string | null {
  const v = text.trim().toLowerCase();
  const h6 = HEX6.exec(v);
  if (h6) return `#${h6[1]}`;
  const h3 = HEX3.exec(v);
  if (h3) return `#${h3[1].split('').map((c) => c + c).join('')}`;
  const rgb = RGB.exec(v);
  if (rgb) return toHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const hsl = HSL.exec(v);
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
  return null;
}

/** Нормализация кода: «RAL 9005», «ral9005» и «9005» должны находиться одинаково. */
const norm = (v: string) => v.toLowerCase().replace(/[\s\-_/.()]/g, '');

interface HueWord { words: string[]; test(h: { h: number; s: number; l: number }): boolean }

const HUE_WORDS: HueWord[] = [
  { words: ['белый', 'white'], test: ({ s, l }) => s < 0.14 && l > 0.8 },
  { words: ['чёрный', 'черный', 'черн', 'black'], test: ({ l }) => l < 0.16 },
  { words: ['серый', 'grey', 'gray', 'серебро', 'серебристый', 'silver'], test: ({ s, l }) => s < 0.16 && l >= 0.16 && l <= 0.8 },
  { words: ['красный', 'красн', 'red', 'бордовый'], test: ({ h, s }) => (h < 20 || h >= 345) && s > 0.25 },
  { words: ['оранжевый', 'orange'], test: ({ h, s }) => h >= 20 && h < 45 && s > 0.3 },
  { words: ['жёлтый', 'желтый', 'yellow', 'золотой', 'gold'], test: ({ h, s }) => h >= 45 && h < 70 && s > 0.2 },
  { words: ['зелёный', 'зеленый', 'green'], test: ({ h, s }) => h >= 70 && h < 170 && s > 0.1 },
  { words: ['голубой', 'бирюзовый', 'teal'], test: ({ h, s, l }) => h >= 170 && h < 200 && s > 0.15 && l > 0.35 },
  { words: ['синий', 'blue'], test: ({ h, s }) => h >= 200 && h < 260 && s > 0.15 },
  { words: ['фиолетовый', 'сиреневый', 'purple'], test: ({ h, s }) => h >= 260 && h < 320 && s > 0.12 },
  { words: ['розовый', 'малиновый', 'pink'], test: ({ h, s, l }) => (h >= 320 || h < 12) && s > 0.15 && l > 0.45 },
  { words: ['коричневый', 'бежевый', 'песочный', 'brown', 'beige', 'sand'], test: ({ h, s, l }) => h >= 15 && h < 60 && s > 0.1 && l < 0.62 },
];

const FINISH_WORDS: [string, PaintFinish][] = [
  ['матов', 'matte'], ['matte', 'matte'],
  ['сатин', 'satin'], ['полумат', 'satin'], ['satin', 'satin'],
  ['металл', 'metallic'], ['metallic', 'metallic'],
  ['перламутр', 'pearl'], ['pearl', 'pearl'],
  ['глян', 'gloss'], ['gloss', 'gloss'],
  ['акрил', 'solid'], ['неметалл', 'solid'], ['solid', 'solid'],
];

export interface SearchResult { item: PaintColor; custom: boolean }

/** Ищет цвета по коду, названию или слову-подсказке («белый», «металлик»). */
export function searchColors(query: string, extra: readonly CustomColor[] = [], limit = 60): SearchResult[] {
  const q = query.trim();
  if (!q) return [];
  const direct = parseColorInput(q);
  if (direct) return [{ item: { code: direct, name: direct, hex: direct, group: 'Свой цвет' }, custom: true }];
  const nq = norm(q);
  const all: SearchResult[] = [
    ...PAINT_COLORS.map((item) => ({ item, custom: false })),
    ...extra.map((item) => ({ item, custom: true })),
  ];
  const score = ({ item }: SearchResult): number => {
    const code = norm(item.code ?? '');
    const name = norm(item.name);
    if (code === nq) return 0;
    if (code && nq.length >= 2 && code.includes(nq)) return 1;
    if (name === nq) return 2;
    if (name.startsWith(nq)) return 3;
    if (name.includes(nq)) return 4;
    return 99;
  };
  const hits = all.map((r) => ({ r, s: score(r) })).filter((x) => x.s < 99)
    .sort((a, b) => a.s - b.s || a.r.item.name.length - b.r.item.name.length)
    .map((x) => x.r);
  if (hits.length) return hits.slice(0, limit);

  const finishHit = FINISH_WORDS.find(([w]) => nq.includes(w));
  const hue = HUE_WORDS.find((w) => w.words.some((x) => nq.includes(norm(x))));
  const merged: SearchResult[] = [];
  const push = (r: SearchResult) => { if (!merged.some((m) => m.item.hex === r.item.hex && m.item.name === r.item.name)) merged.push(r); };
  if (hue) for (const r of all) if (hue.test(hexToHsl(r.item.hex))) push(r);
  if (finishHit) for (const r of all) if (r.item.finish === finishHit[1]) push(r);
  return merged.slice(0, limit);
}

// ---------- пользовательские коды ----------

function sanitizeColor(raw: unknown): CustomColor | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const hex = typeof o.hex === 'string' ? parseColorInput(o.hex) : null;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
  const code = typeof o.code === 'string' ? o.code.trim().slice(0, 24) : '';
  if (!hex || (!name && !code)) return null;
  return { hex, name: name || code, code: code || undefined, group: 'Свои коды', custom: true };
}

export function loadCustomColors(raw: string | null | undefined): CustomColor[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    const out: CustomColor[] = [];
    for (const row of data) {
      const c = sanitizeColor(row);
      if (c && !out.some((x) => norm(x.code ?? x.name) === norm(c.code ?? c.name))) out.push(c);
      if (out.length >= MAX_CUSTOM_COLORS) break;
    }
    return out;
  } catch { return []; }
}

export function addCustomColor(list: readonly CustomColor[], color: Omit<CustomColor, 'custom' | 'group'>): CustomColor[] {
  const next = sanitizeColor({ ...color, group: 'Свои коды' });
  if (!next) return [...list];
  const key = norm(next.code ?? next.name);
  return [next, ...list.filter((c) => norm(c.code ?? c.name) !== key)].slice(0, MAX_CUSTOM_COLORS);
}

export function saveCustomColors(colors: readonly CustomColor[]): string {
  return JSON.stringify(colors.map(({ code, name, hex }) => ({ code, name, hex })));
}
