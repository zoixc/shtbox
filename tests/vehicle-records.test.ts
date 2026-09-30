import { describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/core/dates';
import { averageDailyMileage } from '../src/core/maintenance';
import { parseObdReport } from '../src/core/obd';
import { MemoryStorage } from '../src/core/db';
import { Store } from '../src/core/store';
import type { Car } from '../src/core/types';

const car: Car = {
  id: 'car1', name: 'Test car', modelId: 'sedan-solaris', color: '#b9bec6', plate: 'AB123CD', vin: 'WVWZZZ1JZXW000001',
  mileage: 0, createdAt: 0, updatedAt: 0,
};

describe('mileage history', () => {
  it('estimates a recent daily rate only from monotonic entries spanning at least a week', () => {
    const start = todayStr();
    const middle = addDays(start, 15);
    const end = addDays(start, 30);
    expect(averageDailyMileage([
      { date: start, mileage: 10000 },
      { date: middle, mileage: 10450 },
      { date: end, mileage: 10900 },
    ])).toBeCloseTo(30);
    expect(averageDailyMileage([{ date: start, mileage: 10 }, { date: addDays(start, 3), mileage: 100 }])).toBeUndefined();
    expect(averageDailyMileage([{ date: start, mileage: 1000 }, { date: end, mileage: 900 }])).toBeUndefined();
  });

  it('accepts dated backfill between readings but rejects decreasing or out-of-order odometers', async () => {
    const store = new Store(new MemoryStorage());
    await store.init();
    await store.addCar({ name: car.name, modelId: car.modelId, mileage: 50000 });
    const today = todayStr();
    const older = addDays(today, -60);
    const middle = addDays(today, -30);
    await store.addMileage({ date: older, mileage: 40000 });
    await store.addMileage({ date: middle, mileage: 45000 });
    await expect(store.addMileage({ date: middle, mileage: 39000 })).rejects.toThrow(/меньше предыдущего/);
    await expect(store.addMileage({ date: middle, mileage: 55000 })).rejects.toThrow(/больше следующего/);
    await expect(store.addMileage({ date: today, mileage: 49000 })).rejects.toThrow(/меньше предыдущего/);
    await expect(store.addMileage({ date: addDays(today, 1), mileage: 60000 })).rejects.toThrow(/не может быть в будущем/);
    expect(store.activeCar.value?.mileage).toBe(50000);
  });

  it('records mileage from OBD reports with the OBD provenance, without changing their code semantics', async () => {
    const store = new Store(new MemoryStorage());
    await store.init();
    await store.addCar({ name: car.name, modelId: car.modelId, mileage: 50000 });
    const report = await store.addDiagnostic({
      date: todayStr(), mileage: 50500, sourceName: 'scan.json', notes: '',
      codes: [{ code: 'P0420', description: 'Catalyst efficiency below threshold' }],
    });
    expect(report.codes[0].code).toBe('P0420');
    expect(store.carMileages.value.some((entry) => entry.source === 'obd' && entry.mileage === 50500)).toBe(true);
    expect(store.activeCar.value?.mileage).toBe(50500);
  });
});

describe('OBD-II report parser', () => {
  it('imports JSON codes and source-provided labels without manufacturing a diagnosis', () => {
    const codes = parseObdReport(JSON.stringify({ dtcs: [
      { code: 'p0420', description: 'Source text', module: 'ECM', status: 'stored' },
      { dtc: 'U0100' },
      { code: 'P0420', description: 'Duplicate', module: 'ECM', status: 'stored' },
    ] }), 'scanner.json');
    expect(codes).toHaveLength(2);
    expect(codes[0]).toEqual({ code: 'P0420', description: 'Source text', module: 'ECM', status: 'stored' });
    expect(codes[1].code).toBe('U0100');
    expect(codes[1].description).toBe('');
  });

  it('reads semicolon CSV and rejects exports without standard DTC codes', () => {
    expect(parseObdReport('code;description;status\nP0301;Misfire counter from scanner;pending')[0]).toEqual({
      code: 'P0301', description: 'Misfire counter from scanner', module: undefined, status: 'pending',
    });
    expect(() => parseObdReport('status,value\nready,true', 'empty.csv')).toThrow(/не найдено кодов/);
  });
});
