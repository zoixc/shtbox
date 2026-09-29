import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/core/db';
import { collectDue, notificationFor, pickFresh } from '../src/core/reminders';
import { Store } from '../src/core/store';
import type { MaintenanceTask } from '../src/core/types';

const car = { id: 'c1', name: 'Solaris', mileage: 50000 };
const task = (o: Partial<MaintenanceTask>): MaintenanceTask => ({ id: 't', carId: 'c1', zoneId: 'engine', title: 'Масло', notes: '', createdAt: 0, ...o });

describe('reminders', () => {
  const today = '2026-09-29';
  it('collects overdue and soon per car, ignores ok/unknown', () => {
    const tasks = [
      task({ id: '1', title: 'Просрочено', everyKm: 10000, lastKm: 30000 }),
      task({ id: '2', title: 'Скоро', everyKm: 10000, lastKm: 41000 }),
      task({ id: '3', title: 'Ок', everyKm: 10000, lastKm: 49000 }),
      task({ id: '4', title: 'Нет данных', everyKm: 10000 }),
      task({ id: '5', carId: 'other', title: 'Чужое', everyKm: 10000, lastKm: 0 }),
    ];
    const [e, ...rest] = collectDue([car], tasks, today);
    expect(rest).toHaveLength(0);
    expect(e.overdue).toEqual(['Просрочено']);
    expect(e.soon).toEqual(['Скоро']);
    expect(collectDue([car], [tasks[2], tasks[3]], today)).toEqual([]);
  });

  it('builds a compact notification', () => {
    const n = notificationFor({ carId: 'c1', carName: 'Solaris', overdue: ['A', 'B', 'C', 'D', 'E'], soon: ['F'] });
    expect(n.title).toBe('Solaris: ТО — просрочено: 5, скоро: 1');
    expect(n.body).toBe('A, B, C и ещё 3 работы');
    expect(n.tag).toBe('shtbox-due-c1');
  });

  it('notifies at most once a day per car', () => {
    const e = { carId: 'c1', carName: 'S', overdue: ['x'], soon: [] };
    const first = pickFresh([e], {}, today);
    expect(first.fresh).toHaveLength(1);
    expect(pickFresh([e], first.next, today).fresh).toHaveLength(0);
    expect(pickFresh([e], first.next, '2026-09-30').fresh).toHaveLength(1);
    // авто, по которым напоминать больше не о чем, из карты удаляются
    expect(pickFresh([], first.next, today).next).toEqual({});
  });
});

describe('meta storage', () => {
  it('survives «replace all data» import', async () => {
    const store = new Store(new MemoryStorage());
    await store.init();
    await store.setMeta('reminders', { enabled: true });
    await store.importBackup({ app: 'shtbox', version: 1, exportedAt: '', cars: [], issues: [], tasks: [], logs: [] }, 'replace');
    expect(await store.getMeta('reminders')).toEqual({ enabled: true });
    expect(await store.getMeta('nope')).toBeUndefined();
  });
});
