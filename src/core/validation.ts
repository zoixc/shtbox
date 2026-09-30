/**
 * Санитайзеры для данных из внешних источников (импорт JSON, IndexedDB после миграций).
 * Ничего не доверяем: типы, диапазоны, длины строк проверяются и обрезаются.
 * Неизвестные поля отбрасываются (белый список).
 */
import { isDateStr } from './dates';
import { b64ToBytes } from './b64';
import { ATTACHMENT_MIMES, BODY_KINDS } from './types';
import type { Attachment, AttachmentMime, AttachmentOwner, Backup, BackupAttachment, Car, DiagnosticCode, DiagnosticReport, ID, Inspection, InspectionItem, Issue, IssueKind, LogEntry, LogKind, MaintenanceTask, MileageEntry, Spot } from './types';

export class ValidationError extends Error {}

const ISSUE_KINDS: readonly IssueKind[] = ['breakdown', 'todo', 'rust', 'dent', 'chip', 'scratch'];
const LOG_KINDS: readonly LogKind[] = ['maintenance', 'repair', 'todo', 'bodywork', 'other'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ZONE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const LIMITS = { name: 120, text: 4000, records: 50000, maxKm: 5_000_000, maxCost: 1e9 } as const;
/** Вложения: на запись — не больше 12 файлов, файл — до 6 МБ (после сжатия обычно 200–600 КБ), миниатюра — до 200 КБ. */
export const ATTACH_LIMITS = { perOwner: 12, fileBytes: 6 * 1024 * 1024, thumbBytes: 200 * 1024, maxCount: 3000, maxDim: 12000 } as const;

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
    inspectionId: typeof o.inspectionId === 'string' && ID_RE.test(o.inspectionId) ? o.inspectionId : undefined,
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
    if ((r.type === 'issue' || r.type === 'task') && typeof r.id === 'string' && ID_RE.test(r.id)) ref = { type: r.type, id: r.id };
  }
  return {
    id: id(o.id, 'log.id'), carId: id(o.carId, 'log.carId'), zoneId: zone(o.zoneId, 'log.zoneId'), kind,
    title: str(o.title, LIMITS.name, 'log.title', true), notes: str(o.notes, LIMITS.text, 'log.notes'), date: d,
    mileage: num(o.mileage, 0, LIMITS.maxKm), cost: num(o.cost, 0, LIMITS.maxCost), ref, createdAt: ts(o.createdAt),
  };
}

export function sanitizeMileageEntry(v: unknown): MileageEntry {
  const o = obj(v, 'mileage');
  const d = date(o.date);
  if (!d) throw new ValidationError('mileage.date: некорректная дата');
  const km = num(o.mileage, 0, LIMITS.maxKm);
  if (km === undefined) throw new ValidationError('mileage.mileage: некорректный пробег');
  const source = o.source === 'service' || o.source === 'obd' ? o.source : 'manual';
  return { id: id(o.id, 'mileage.id'), carId: id(o.carId, 'mileage.carId'), date: d, mileage: Math.round(km), source, notes: str(o.notes, LIMITS.text, 'mileage.notes'), createdAt: ts(o.createdAt) };
}

const INSPECTION_STATES = ['ok', 'watch', 'repair'] as const;
export function sanitizeInspection(v: unknown): Inspection {
  const o = obj(v, 'inspection');
  const d = date(o.date);
  if (!d) throw new ValidationError('inspection.date: некорректная дата');
  const rawItems = o.items;
  if (!Array.isArray(rawItems) || rawItems.length > 100) throw new ValidationError('inspection.items: некорректный список');
  const items = rawItems.map((raw, index): InspectionItem => {
    const x = obj(raw, `inspection.items[${index}]`);
    if (!INSPECTION_STATES.includes(x.state as (typeof INSPECTION_STATES)[number])) throw new ValidationError('inspection.item.state: неизвестный статус');
    return {
      id: id(x.id, 'inspection.item.id'),
      title: str(x.title, LIMITS.name, 'inspection.item.title', true),
      zoneId: zone(x.zoneId, 'inspection.item.zoneId'),
      state: x.state as InspectionItem['state'],
      notes: str(x.notes, LIMITS.text, 'inspection.item.notes'),
    };
  });
  if (new Set(items.map((x) => x.id)).size !== items.length) throw new ValidationError('inspection.items: повторяющиеся id');
  return {
    id: id(o.id, 'inspection.id'), carId: id(o.carId, 'inspection.carId'), date: d,
    mileage: num(o.mileage, 0, LIMITS.maxKm), title: str(o.title, LIMITS.name, 'inspection.title') || 'Осмотр',
    notes: str(o.notes, LIMITS.text, 'inspection.notes'), items, createdAt: ts(o.createdAt),
  };
}

const DTC_RE = /^[PBCU][0-3][0-9A-F]{3}$/;
export function sanitizeDiagnosticReport(v: unknown): DiagnosticReport {
  const o = obj(v, 'diagnostic');
  const d = date(o.date);
  if (!d) throw new ValidationError('diagnostic.date: некорректная дата');
  if (!Array.isArray(o.codes) || o.codes.length < 1 || o.codes.length > 100) throw new ValidationError('diagnostic.codes: некорректный список');
  const codes = o.codes.map((raw): DiagnosticCode => {
    const x = obj(raw, 'diagnostic.code');
    const code = str(x.code, 8, 'diagnostic.code', true).toUpperCase();
    if (!DTC_RE.test(code)) throw new ValidationError('diagnostic.code: некорректный DTC');
    return { code, description: str(x.description, 500, 'diagnostic.description'), module: str(x.module, 100, 'diagnostic.module') || undefined, status: str(x.status, 60, 'diagnostic.status') || undefined };
  });
  return {
    id: id(o.id, 'diagnostic.id'), carId: id(o.carId, 'diagnostic.carId'), date: d,
    mileage: num(o.mileage, 0, LIMITS.maxKm), sourceName: str(o.sourceName, 200, 'diagnostic.sourceName') || 'OBD report',
    notes: str(o.notes, LIMITS.text, 'diagnostic.notes'), codes, createdAt: ts(o.createdAt),
  };
}

/** Определяет тип по «магическим байтам» (расширению и заявленному mime не доверяем). */
export function sniffMime(b: Uint8Array): AttachmentMime | undefined {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return undefined;
}

function attachmentMeta(o: Obj) {
  const owner = o.ownerType as AttachmentOwner;
  if (owner !== 'issue' && owner !== 'log' && owner !== 'task' && owner !== 'inspection') throw new ValidationError('attachment.ownerType: неизвестный тип');
  const mime = o.mime as AttachmentMime;
  if (!ATTACHMENT_MIMES.includes(mime)) throw new ValidationError('attachment.mime: допустимы только JPEG/PNG/WebP');
  const dim = (v: unknown) => num(v, 1, ATTACH_LIMITS.maxDim) ?? 0;
  const phase: Attachment['phase'] = o.phase === 'before' || o.phase === 'after' || o.phase === 'general' ? o.phase as Attachment['phase'] : undefined;
  return {
    id: id(o.id, 'attachment.id'),
    carId: id(o.carId, 'attachment.carId'),
    ownerType: owner,
    ownerId: id(o.ownerId, 'attachment.ownerId'),
    phase,
    name: str(o.name, LIMITS.name, 'attachment.name') || 'photo',
    mime,
    size: num(o.size, 1, ATTACH_LIMITS.fileBytes) ?? 0,
    w: dim(o.w),
    h: dim(o.h),
    createdAt: ts(o.createdAt),
  };
}

/** Вложение из IndexedDB / из приложения: миниатюра должна быть Blob-изображением разумного размера. */
export function sanitizeAttachment(v: unknown): Attachment {
  const o = obj(v, 'attachment');
  const meta = attachmentMeta(o);
  const t = o.thumb;
  if (typeof Blob === 'undefined' || !(t instanceof Blob) || t.size === 0 || t.size > ATTACH_LIMITS.thumbBytes) throw new ValidationError('attachment.thumb: некорректная миниатюра');
  return { ...meta, thumb: t };
}

/** Вложение из JSON-копии: base64 декодируется и проверяется по сигнатуре файла. */
export function sanitizeBackupAttachment(v: unknown): BackupAttachment {
  const o = obj(v, 'attachment');
  const meta = attachmentMeta(o);
  const check = (b64: unknown, max: number, what: string) => {
    if (typeof b64 !== 'string' || b64.length > Math.ceil((max * 4) / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ValidationError(`${what}: некорректные данные`);
    const bytes = b64ToBytes(b64);
    if (bytes.length > max || sniffMime(bytes) === undefined) throw new ValidationError(`${what}: это не изображение`);
    return b64;
  };
  const data = check(o.data, ATTACH_LIMITS.fileBytes, 'attachment.data');
  const thumb = check(o.thumb, ATTACH_LIMITS.thumbBytes, 'attachment.thumb');
  return { ...meta, size: Math.min(meta.size || 1, ATTACH_LIMITS.fileBytes), data, thumb };
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
  const issues = list(o.issues, sanitizeIssue, 'issues').filter(keepCar);
  const tasks = list(o.tasks, sanitizeTask, 'tasks').filter(keepCar);
  const logs = list(o.logs, sanitizeLog, 'logs').filter(keepCar);
  const mileages = list(o.mileages, sanitizeMileageEntry, 'mileages').filter(keepCar);
  const inspections = list(o.inspections, sanitizeInspection, 'inspections').filter(keepCar);
  const diagnostics = list(o.diagnostics, sanitizeDiagnosticReport, 'diagnostics').filter(keepCar);
  const owners: Record<AttachmentOwner, Set<string>> = {
    issue: new Set(issues.map((x) => x.id)), task: new Set(tasks.map((x) => x.id)), log: new Set(logs.map((x) => x.id)),
    inspection: new Set(inspections.map((x) => x.id)),
  };
  let attachments: BackupAttachment[] | undefined;
  if (o.attachments !== undefined) {
    if (Array.isArray(o.attachments) && o.attachments.length > ATTACH_LIMITS.maxCount) throw new ValidationError('attachments: слишком много файлов');
    attachments = list(o.attachments, sanitizeBackupAttachment, 'attachments').filter((a) => keepCar(a) && owners[a.ownerType].has(a.ownerId));
  }
  return {
    app: 'shtbox',
    version: 1,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt.slice(0, 40) : new Date().toISOString(),
    cars,
    issues,
    tasks,
    logs,
    mileages,
    inspections,
    diagnostics,
    ...(attachments ? { attachments } : {}),
  };
}

export function parseBackupText(text: string): Backup {
  if (text.length > 120 * 1024 * 1024) throw new ValidationError('Файл слишком большой');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError('Файл не является корректным JSON');
  }
  return parseBackup(json);
}
