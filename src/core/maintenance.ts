import { addMonths, daysBetween } from './dates';
import type { DateStr, MaintenanceTask } from './types';

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
