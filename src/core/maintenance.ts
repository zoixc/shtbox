import { addMonths, daysBetween } from './dates';
import type { DateStr, MaintenanceTask, MileageEntry } from './types';

export type DueState = 'ok' | 'soon' | 'overdue' | 'unknown';

export interface DueInfo {
  state: DueState;
  /** пробег следующего ТО */
  nextKm?: number;
  /** дата следующего ТО */
  nextDate?: DateStr;
  /** осталось км (отрицательное — просрочено) */
  leftKm?: number;
  /** осталось дней (отрицательное — просрочено) */
  leftDays?: number;
}

/** Порог «скоро»: 10% интервала, но не меньше 500 км и 14 дней (и не больше 2000 км / 45 дней). */
export function soonKm(everyKm: number): number {
  return Math.min(2000, Math.max(500, everyKm * 0.1));
}
export function soonDays(everyMonths: number): number {
  return Math.min(45, Math.max(14, everyMonths * 30 * 0.1));
}

/**
 * Усреднённый дневной пробег по датированным одометрам за последние 180 дней.
 * Требует минимум 7 дней между точками и игнорирует повторы/сбросы показаний.
 * Значение — ориентировочная скорость для прогноза, не регламентный интервал.
 */
export function averageDailyMileage(entries: Pick<MileageEntry, 'date' | 'mileage'>[]): number | undefined {
  const byDay = new Map<DateStr, number>();
  for (const item of entries) {
    if (!Number.isFinite(item.mileage) || item.mileage < 0) continue;
    byDay.set(item.date, Math.max(byDay.get(item.date) ?? 0, item.mileage));
  }
  const points = [...byDay].map(([date, mileage]) => ({ date, mileage })).sort((a, b) => a.date.localeCompare(b.date));
  const last = points.at(-1);
  if (!last) return undefined;
  const window = points.filter((p) => daysBetween(p.date, last.date) <= 180);
  const first = window[0];
  if (!first) return undefined;
  const days = daysBetween(first.date, last.date);
  const km = last.mileage - first.mileage;
  if (days < 7 || km <= 0) return undefined;
  const rate = km / days;
  return Number.isFinite(rate) && rate <= 1000 ? rate : undefined;
}

/**
 * Считает статус регламентной работы. Срабатывает то условие (км или время),
 * которое наступает раньше. Если работа ещё ни разу не выполнялась (нет ни lastKm,
 * ни lastDate) — состояние `unknown` (нужно отметить первое выполнение).
 */
export function dueInfo(t: MaintenanceTask, currentKm: number, today: DateStr): DueInfo {
  const out: DueInfo = { state: 'unknown' };
  let overdue = false;
  let soon = false;
  let known = false;

  if (t.everyKm && t.everyKm > 0 && t.lastKm !== undefined) {
    known = true;
    out.nextKm = t.lastKm + t.everyKm;
    out.leftKm = out.nextKm - currentKm;
    if (out.leftKm <= 0) overdue = true;
    else if (out.leftKm <= soonKm(t.everyKm)) soon = true;
  }
  if (t.everyMonths && t.everyMonths > 0 && t.lastDate) {
    known = true;
    out.nextDate = addMonths(t.lastDate, t.everyMonths);
    out.leftDays = daysBetween(today, out.nextDate);
    if (out.leftDays <= 0) overdue = true;
    else if (out.leftDays <= soonDays(t.everyMonths)) soon = true;
  }
  if (!known) return out;
  out.state = overdue ? 'overdue' : soon ? 'soon' : 'ok';
  return out;
}

const RANK: Record<DueState, number> = { overdue: 3, soon: 2, unknown: 1, ok: 0 };
export function worstState(a: DueState, b: DueState): DueState {
  return RANK[a] >= RANK[b] ? a : b;
}
export function stateRank(s: DueState): number {
  return RANK[s];
}
