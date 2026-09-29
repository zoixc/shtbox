import type { LogEntry, LogKind } from './types';

export interface ExpenseStats {
  total: number;
  byYear: { year: string; sum: number }[];
  byKind: { kind: LogKind; sum: number }[];
  /** ₽ на км по журналу: сумма / (макс. пробег − мин. пробег среди записей); undefined, если данных мало */
  perKm?: number;
}

export function expenseStats(logs: readonly LogEntry[]): ExpenseStats {
  const year = new Map<string, number>();
  const kind = new Map<LogKind, number>();
  let total = 0;
  let minKm = Infinity;
  let maxKm = -Infinity;
  for (const l of logs) {
    if (l.mileage !== undefined) {
      minKm = Math.min(minKm, l.mileage);
      maxKm = Math.max(maxKm, l.mileage);
    }
    const c = l.cost ?? 0;
    if (!c) continue;
    total += c;
    year.set(l.date.slice(0, 4), (year.get(l.date.slice(0, 4)) ?? 0) + c);
    kind.set(l.kind, (kind.get(l.kind) ?? 0) + c);
  }
  const span = maxKm - minKm;
  return {
    total,
    byYear: [...year].map(([y, sum]) => ({ year: y, sum })).sort((a, b) => b.year.localeCompare(a.year)),
    byKind: [...kind].map(([k, sum]) => ({ kind: k, sum })).sort((a, b) => b.sum - a.sum),
    perKm: total > 0 && span >= 500 ? total / span : undefined,
  };
}
