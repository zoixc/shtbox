/** Доменная модель. Все данные хранятся локально (IndexedDB), сервера нет. */

export type ID = string;
/** Дата без времени в формате YYYY-MM-DD (локальная). */
export type DateStr = string;

export interface Car {
  id: ID;
  name: string;
  /** id модели из реестра моделей (src/models/registry.ts) */
  modelId: string;
  /** цвет кузова, #rrggbb */
  color: string;
  plate: string;
  vin: string;
  year?: number;
  /** текущий пробег, км */
  mileage: number;
  createdAt: number;
  updatedAt: number;
}

export type IssueKind = 'breakdown' | 'todo' | 'rust' | 'dent' | 'chip' | 'scratch';

/** Виды повреждений кузова, которые рисуются на 3D-модели. */
export const BODY_KINDS: readonly IssueKind[] = ['rust', 'dent', 'chip', 'scratch'];

/** Точка на поверхности детали, в локальных координатах меша детали. */
export interface Spot {
  p: [number, number, number];
  n: [number, number, number];
  /** радиус пятна, м */
  r: number;
}

export interface Issue {
  id: ID;
  carId: ID;
  zoneId: string;
  kind: IssueKind;
  title: string;
  notes: string;
  /** 0 — обычный, 1 — важный, 2 — срочный */
  priority: 0 | 1 | 2;
  status: 'open' | 'done';
  createdAt: number;
  doneDate?: DateStr;
  /** ориентировочная стоимость */
  cost?: number;
  spot?: Spot;
  /** Осмотр, из которого создан дефект. */
  inspectionId?: ID;
}

export interface MaintenanceTask {
  id: ID;
  carId: ID;
  zoneId: string;
  title: string;
  notes: string;
  /** периодичность по пробегу, км */
  everyKm?: number;
  /** периодичность по времени, мес. */
  everyMonths?: number;
  lastDate?: DateStr;
  lastKm?: number;
  createdAt: number;
}

export type LogKind = 'maintenance' | 'repair' | 'todo' | 'bodywork' | 'other';

/** Запись журнала выполненных работ — неизменяемая история по авто. */
export interface LogEntry {
  id: ID;
  carId: ID;
  zoneId: string;
  kind: LogKind;
  title: string;
  notes: string;
  date: DateStr;
  mileage?: number;
  cost?: number;
  ref?: { type: 'issue' | 'task'; id: ID };
  createdAt: number;
}

export type MileageSource = 'manual' | 'service' | 'obd';
export interface MileageEntry {
  id: ID;
  carId: ID;
  date: DateStr;
  mileage: number;
  source: MileageSource;
  notes: string;
  createdAt: number;
}

export type InspectionState = 'ok' | 'watch' | 'repair';
export interface InspectionItem {
  id: string;
  title: string;
  zoneId: string;
  state: InspectionState;
  notes: string;
}
export interface Inspection {
  id: ID;
  carId: ID;
  date: DateStr;
  mileage?: number;
  title: string;
  notes: string;
  items: InspectionItem[];
  createdAt: number;
}

export interface DiagnosticCode {
  code: string;
  description: string;
  module?: string;
  status?: string;
}
export interface DiagnosticReport {
  id: ID;
  carId: ID;
  date: DateStr;
  mileage?: number;
  sourceName: string;
  notes: string;
  codes: DiagnosticCode[];
  createdAt: number;
}

/** Владелец вложения: фото/чек привязывается к записи. */
export type AttachmentOwner = 'issue' | 'log' | 'task' | 'inspection';
export const ATTACHMENT_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];

/** Метаданные вложения + миниатюра (полный файл лежит в отдельном хранилище `blobs`). */
export interface Attachment {
  id: ID;
  carId: ID;
  ownerType: AttachmentOwner;
  ownerId: ID;
  /** Для фото осмотра: до ремонта, после ремонта или без этапа. */
  phase?: 'before' | 'after' | 'general';
  name: string;
  mime: AttachmentMime;
  size: number;
  w: number;
  h: number;
  createdAt: number;
  thumb: Blob;
}

/** Вложение в JSON-копии: файлы в base64. */
export interface BackupAttachment extends Omit<Attachment, 'thumb'> {
  data: string;
  thumb: string;
}

export interface Backup {
  app: 'shtbox';
  version: 1;
  exportedAt: string;
  cars: Car[];
  issues: Issue[];
  tasks: MaintenanceTask[];
  logs: LogEntry[];
  /** Новые разделы необязательны для совместимости со старыми .shtbox. */
  mileages?: MileageEntry[];
  inspections?: Inspection[];
  diagnostics?: DiagnosticReport[];
  attachments?: BackupAttachment[];
}

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  breakdown: 'Поломка',
  todo: 'Доделка',
  rust: 'Ржавчина',
  dent: 'Вмятина',
  chip: 'Скол',
  scratch: 'Царапина',
};

export const LOG_KIND_LABEL: Record<LogKind, string> = {
  maintenance: 'ТО',
  repair: 'Ремонт',
  todo: 'Доделка',
  bodywork: 'Кузовные',
  other: 'Прочее',
};

export const PRIORITY_LABEL = ['Обычный', 'Важный', 'Срочный'] as const;
