import { dueInfo } from './maintenance';
import type { Car, DateStr, MaintenanceTask } from './types';

export interface RemindersSettings {
  enabled: boolean;
}
export const REMINDERS_KEY = 'reminders';
export const NOTIFIED_KEY = 'notified';
/** carId → дата (YYYY-MM-DD), когда по этому авто уже показывали напоминание */
export type NotifiedMap = Record<string, DateStr>;

export interface DueEntry {
  carId: string;
  carName: string;
  overdue: string[];
  soon: string[];
}

/** Что просрочено/скоро — по всем авто (общая логика для приложения и service worker). */
export function collectDue(cars: readonly Pick<Car, 'id' | 'name' | 'mileage'>[], tasks: readonly MaintenanceTask[], today: DateStr): DueEntry[] {
  const out: DueEntry[] = [];
  for (const car of cars) {
    const e: DueEntry = { carId: car.id, carName: car.name, overdue: [], soon: [] };
    for (const t of tasks) {
      if (t.carId !== car.id) continue;
      const d = dueInfo(t, car.mileage, today);
      if (d.state === 'overdue') e.overdue.push(t.title);
      else if (d.state === 'soon') e.soon.push(t.title);
    }
    if (e.overdue.length || e.soon.length) out.push(e);
  }
  return out;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

export function notificationFor(e: DueEntry): { title: string; body: string; tag: string } {
  const parts: string[] = [];
  if (e.overdue.length) parts.push(`просрочено: ${e.overdue.length}`);
  if (e.soon.length) parts.push(`скоро: ${e.soon.length}`);
  const list = [...e.overdue, ...e.soon];
  const shown = list.slice(0, 3).join(', ');
  const rest = list.length - 3;
  return {
    title: `${e.carName}: ТО — ${parts.join(', ')}`,
    body: rest > 0 ? `${shown} и ещё ${rest} ${plural(rest, 'работа', 'работы', 'работ')}` : shown,
    tag: `shtbox-due-${e.carId}`,
  };
}

/** Не чаще одного напоминания в сутки на авто. */
export function pickFresh(entries: DueEntry[], notified: NotifiedMap, today: DateStr): { fresh: DueEntry[]; next: NotifiedMap } {
  const fresh = entries.filter((e) => notified[e.carId] !== today);
  const next: NotifiedMap = {};
  for (const e of entries) next[e.carId] = notified[e.carId] === today ? today : notified[e.carId] ?? '';
  for (const e of fresh) next[e.carId] = today;
  for (const k of Object.keys(next)) if (!next[k]) delete next[k];
  return { fresh, next };
}
