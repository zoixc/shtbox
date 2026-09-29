import { describe, expect, it } from 'vitest';
import { buildIcs, foldLine, icsText } from '../src/core/ics';
import { expenseStats } from '../src/core/stats';
import type { LogEntry, MaintenanceTask } from '../src/core/types';

const task = (o: Partial<MaintenanceTask> = {}): MaintenanceTask => ({
  id: 't1', carId: 'c1', zoneId: 'engine', title: 'Масло', notes: '', createdAt: 0, everyMonths: 12, lastDate: '2026-03-01', ...o,
});

describe('ics', () => {
  it('escapes text and blocks line injection', () => {
    expect(icsText('a,b;c\\d\r\nEND:VEVENT')).toBe('a\\,b\\;c\\\\d\\nEND:VEVENT');
  });
  it('folds long lines by octets without splitting characters', () => {
    const folded = foldLine('SUMMARY:' + 'ж'.repeat(80));
    for (const part of folded.split('\r\n')) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe('SUMMARY:' + 'ж'.repeat(80));
  });
  it('builds all-day event with alarm; skips km-only tasks; empty when nothing to export', () => {
    const car = { name: 'Solaris', mileage: 50000 };
    const ics = buildIcs(car, [task(), task({ id: 't2', everyMonths: undefined, everyKm: 10000, lastKm: 45000, lastDate: undefined })], '2026-09-29', new Date('2026-09-29T10:00:00Z'));
    expect(ics).toContain('DTSTART;VALUE=DATE:20270301');
    expect(ics).toContain('DTEND;VALUE=DATE:20270302');
    expect(ics).toContain('TRIGGER:-P7D');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(buildIcs(car, [task({ everyMonths: undefined })], '2026-09-29')).toBe('');
  });
});

describe('expenseStats', () => {
  const log = (o: Partial<LogEntry>): LogEntry => ({ id: 'l', carId: 'c', zoneId: 'z', kind: 'repair', title: '', notes: '', date: '2026-01-01', createdAt: 0, ...o });
  it('sums by year/kind and computes cost per km', () => {
    const s = expenseStats([
      log({ cost: 1000, mileage: 10000, date: '2025-05-01', kind: 'maintenance' }),
      log({ cost: 3000, mileage: 12000, date: '2026-05-01' }),
      log({ mileage: 11000 }),
    ]);
    expect(s.total).toBe(4000);
    expect(s.byYear).toEqual([{ year: '2026', sum: 3000 }, { year: '2025', sum: 1000 }]);
    expect(s.byKind[0]).toEqual({ kind: 'repair', sum: 3000 });
    expect(s.perKm).toBeCloseTo(2);
  });
  it('no perKm on short span', () => {
    expect(expenseStats([log({ cost: 100, mileage: 1000 })]).perKm).toBeUndefined();
  });
});
