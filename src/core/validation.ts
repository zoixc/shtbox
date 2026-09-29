/**
 * Санитайзеры для данных из внешних источников (импорт JSON, IndexedDB после миграций).
 * Ничего не доверяем: типы, диапазоны, длины строк проверяются и обрезаются.
 * Неизвестные поля отбрасываются (белый список).
 */
import { isDateStr } from './dates';
import { BODY_KINDS } from './types';
import type { Backup, Car, ID, Issue, IssueKind, LogEntry, LogKind, MaintenanceTask, Spot } from './types';

export class ValidationError extends Error {}

const ISSUE_KINDS: readonly IssueKind[] = ['breakdown', 'todo', 'rust', 'dent', 'chip', 'scratch'];
const LOG_KINDS: readonly LogKind[] = ['maintenance', 'repair', 'todo', 'bodywork', 'other'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ZONE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const LIMITS = { name: 120, text: 4000, records: 50000, maxKm: 5_000_000, maxCost: 1e9 } as const;

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError(`${what}: ожидался объект`);
  return v as Obj;
}
function str(v: unknown, max: number, what: string, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new ValidationError(`${what}: обязательное поле`);
    return '';
  }
  if (typeof v !== 'string') throw new ValidationError(`${what}: ожидалась строка`);
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
  if (required && !s) throw new ValidationError(`${what}: не может быть пустым`);
  return s;
}
function id(v: unknown, what: string): ID {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ValidationError(`${what}: некорректный id`);
  return v;
}
function zone(v: unknown, what: string): string {
  if (typeof v !== 'string' || !ZONE_RE.test(v)) throw new ValidationError(`${what}: некорректный узел`);
  return v;
}
function num(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return undefined;
  return v;
}
function date(v: unknown): string | undefined {
  return isDateStr(v) ? v : undefined;
}
function ts(v: unknown): number {
  return num(v, 0, 8.64e15) ?? Date.now();
}
function vec3(v: unknown, what: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) throw new ValidationError(`${what}: ожидался вектор [x,y,z]`);
  const r = v.map((x) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 1000) throw new ValidationError(`${what}: некорректное число`);
    return x;
  });
  return r as [number, number, number];
}

export function sanitizeSpot(v: unknown): Spot | undefined {
  if (v === undefined || v === null) return undefined;
  try {
    const o = obj(v, 'spot');
    const r = num(o.r, 0.005, 2);
    if (r === undefined) return undefined;
    return { p: vec3(o.p, 'spot.p'), n: vec3(o.n, 'spot.n'), r };
  } catch {
    return undefined;
  }
}

export function sanitizeCar(v: unknown): Car {
  const o = obj(v, 'car');
  const now = Date.now();
  return {
    id: id(o.id, 'car.id'),
    name: str(o.name, LIMITS.name, 'car.name', true),
    modelId: str(o.modelId, 64, 'car.modelId', true),
    color: typeof o.color === 'string' && COLOR_RE.test(o.color) ? o.color : '#c9ccd1',
    plate: str(o.plate, 20, 'car.plate'),
    vin: str(o.vin, 32, 'car.vin'),
    year: num(o.year, 1900, 2100),
    mileage: Math.round(num(o.mileage, 0, LIMITS.maxKm) ?? 0),
    createdAt: ts(o.createdAt ?? now),
    updatedAt: ts(o.updatedAt ?? now),
  };
}

export function sanitizeIssue(v: unknown): Issue {
  const o = obj(v, 'issue');
  const kind = o.kind as IssueKind;
  if (!ISSUE_KINDS.includes(kind)) throw new ValidationError('issue.kind: неизвестный тип');
  const status = o.status === 'done' ? 'done' : 'open';
  const pr = num(o.priority, 0, 2);
  const spot = BODY_KINDS.includes(kind) ? sanitizeSpot(o.spot) : undefined;
  return {
    id: id(o.id, 'issue.id'),
    carId: id(o.carId, 'issue.carId'),
    zoneId: zone(o.zoneId, 'issue.zoneId'),
    kind,
    title: str(o.title, LIMITS.name, 'issue.title', true),
    notes: str(o.notes, LIMITS.text, 'issue.notes'),
    priority: (pr === 1 || pr === 2 ? pr : 0) as 0 | 1 | 2,
    status,
    createdAt: ts(o.createdAt),
    doneDate: status === 'done' ? date(o.doneDate) : undefined,
    cost: num(o.cost, 0, LIMITS.maxCost),
    spot,
  };
}

export function sanitizeTask(v: unknown): MaintenanceTask {
  const o = obj(v, 'task');
  const everyKm = num(o.everyKm, 1, LIMITS.maxKm);
  const everyMonths = num(o.everyMonths, 1, 1200);
  return {
    id: id(o.id, 'task.id'),
    carId: id(o.carId, 'task.carId'),
    zoneId: zone(o.zoneId, 'task.zoneId'),
    title: str(o.title, LIMITS.name, 'task.title', true),
    notes: str(o.notes, LIMITS.text, 'task.notes'),
    everyKm: everyKm === undefined ? undefined : Math.round(everyKm),
    everyMonths: everyMonths === undefined ? undefined : Math.round(everyMonths),
    lastDate: date(o.lastDate),
    lastKm: num(o.lastKm, 0, LIMITS.maxKm),
    createdAt: ts(o.createdAt),
  };
}

export function sanitizeLog(v: unknown): LogEntry {
  const o = obj(v, 'log');
  const kind = o.kind as LogKind;
  if (!LOG_KINDS.includes(kind)) throw new ValidationError('log.kind: неизвестный тип');
  const d = date(o.date);
  if (!d) throw new ValidationError('log.date: некорректная дата');
  let ref: LogEntry['ref'];
  if (o.ref !== undefined && o.ref !== null) {
    const r = obj(o.ref, 'log.ref');
    if ((r.type === 'issue' || r.type === 'task') && typeof r.id === 'string' && ID_RE.test(r.id)) {
      ref = { type: r.type, id: r.id };
    }
  }
  return {
    id: id(o.id, 'log.id'),
    carId: id(o.carId, 'log.carId'),
    zoneId: zone(o.zoneId, 'log.zoneId'),
    kind,
    title: str(o.title, LIMITS.name, 'log.title', true),
    notes: str(o.notes, LIMITS.text, 'log.notes'),
    date: d,
    mileage: num(o.mileage, 0, LIMITS.maxKm),
    cost: num(o.cost, 0, LIMITS.maxCost),
    ref,
    createdAt: ts(o.createdAt),
  };
}

function list<T>(v: unknown, fn: (x: unknown) => T, what: string): T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${what}: ожидался массив`);
  if (v.length > LIMITS.records) throw new ValidationError(`${what}: слишком много записей`);
  return v.map(fn);
}

/** Разбор и проверка файла резервной копии. Бросает ValidationError. */
export function parseBackup(raw: unknown): Backup {
  const o = obj(raw, 'backup');
  if (o.app !== 'shtbox') throw new ValidationError('Это не файл резервной копии ShtBox');
  if (o.version !== 1) throw new ValidationError('Неподдерживаемая версия файла');
  const cars = list(o.cars, sanitizeCar, 'cars');
  const carIds = new Set(cars.map((c) => c.id));
  const keepCar = <T extends { carId: ID }>(x: T) => carIds.has(x.carId);
  return {
    app: 'shtbox',
    version: 1,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt.slice(0, 40) : new Date().toISOString(),
    cars,
    issues: list(o.issues, sanitizeIssue, 'issues').filter(keepCar),
    tasks: list(o.tasks, sanitizeTask, 'tasks').filter(keepCar),
    logs: list(o.logs, sanitizeLog, 'logs').filter(keepCar),
  };
}

export function parseBackupText(text: string): Backup {
  if (text.length > 50 * 1024 * 1024) throw new ValidationError('Файл слишком большой');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError('Файл не является корректным JSON');
  }
  return parseBackup(json);
}
