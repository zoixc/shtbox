/**
 * Отчёт об импорте: что получилось из исходного файла и что в нём не поддержано.
 * Отчёт строится из того, что уже есть у мастера (статистика конвейера, профиль, предупреждения),
 * поэтому его одинаково показывают интерфейс и CLI.
 */
import { KIND_LABEL } from './types';
import type { Kind, Profile } from './types';

export interface ImportStats {
  srcTris: number;
  tris: number;
  parts: number;
  bytes: number;
  /** Сколько дало перекодирование сохранённых текстур цвета (если оно было). */
  textures?: { before: number; after: number; converted: number; kept: number };
}

export interface ImportReport {
  sourceTris: number;
  tris: number;
  /** Сколько треугольников срезано упрощением (в процентах от исходного). */
  removed: number;
  removedPercent: number;
  bytes: number;
  parts: number;
  /** Детали, помеченные «скрыть» — они не участвуют в разметке. */
  hidden: number;
  kinds: { kind: Kind; label: string; count: number }[];
  glass: number;
  wheels: number;
  panels: number;
  masks: number;
  hinges: number;
  wheelbase: number;
  /** Экономия на текстурах: необязательная строка отчёта. */
  textures?: { before: number; after: number; converted: number };
  warnings: string[];
  credits: Profile['credits'];
}

const KIND_ORDER: Kind[] = ['paint', 'glass', 'wheel', 'brake', 'light', 'trim', 'int', 'hide'];

/** Сводка «что получилось»: одна и та же для вкладки «Готово» и для CLI. */
export function buildReport(stats: ImportStats, profile: Profile, warnings: readonly string[]): ImportReport {
  const counts = new Map<Kind, number>();
  for (const part of Object.values(profile.parts)) counts.set(part.k, (counts.get(part.k) ?? 0) + 1);
  const removed = Math.max(0, stats.srcTris - stats.tris);
  return {
    sourceTris: stats.srcTris,
    tris: stats.tris,
    removed,
    removedPercent: stats.srcTris > 0 ? (removed / stats.srcTris) * 100 : 0,
    bytes: stats.bytes,
    parts: stats.parts,
    hidden: counts.get('hide') ?? 0,
    kinds: KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({ kind, label: KIND_LABEL[kind], count: counts.get(kind)! })),
    glass: counts.get('glass') ?? 0,
    wheels: counts.get('wheel') ?? 0,
    panels: counts.get('paint') ?? 0,
    masks: profile.panelRegions?.length ?? 0,
    hinges: Object.keys(profile.hinges ?? {}).length,
    wheelbase: profile.dims.axleF - profile.dims.axleR,
    textures: stats.textures ? { before: stats.textures.before, after: stats.textures.after, converted: stats.textures.converted } : undefined,
    warnings: [...warnings],
    credits: profile.credits,
  };
}

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;

export function reportRows(report: ImportReport): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: 'Треугольники', value: `${report.sourceTris.toLocaleString('ru')} → ${report.tris.toLocaleString('ru')} (срезано ${report.removedPercent.toFixed(0)}%)` },
    { label: 'Размер пакета', value: mib(report.bytes) },
    { label: 'Детали', value: `${report.parts}, скрыто ${report.hidden}` },
    { label: 'Колёсная база', value: `${report.wheelbase.toFixed(2)} м` },
  ];
  if (report.textures) rows.push({ label: 'Текстуры цвета', value: `${mib(report.textures.before)} → ${mib(report.textures.after)} (${report.textures.converted} шт. в JPEG)` });
  if (report.kinds.length) rows.push({ label: 'По видам', value: report.kinds.map((k) => `${k.label.toLowerCase()} — ${k.count}`).join(', ') });
  if (report.masks || report.hinges) rows.push({ label: 'Ручная разметка', value: `масок ${report.masks}, петель ${report.hinges}` });
  if (report.credits && (report.credits.author || report.credits.license)) {
    rows.push({ label: 'Атрибуция', value: [report.credits.author, report.credits.license, report.credits.source].filter(Boolean).join(' — ') });
  }
  return rows;
}

/** Строки для консоли CLI. */
export function formatReportLines(report: ImportReport): string[] {
  return reportRows(report).map((row) => `${row.label}: ${row.value}`);
}
