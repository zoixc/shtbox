import { computed, signal } from '@preact/signals';
import type { ReadonlySignal } from '@preact/signals';
import type { Op, Storage } from './db';
import { todayStr } from './dates';
import { uid } from './id';
import { dueInfo, worstState } from './maintenance';
import type { DueInfo, DueState } from './maintenance';
import { sanitizeCar, sanitizeIssue, sanitizeLog, sanitizeTask } from './validation';
import { BODY_KINDS } from './types';
import type { Backup, Car, DateStr, Issue, IssueKind, LogEntry, LogKind, MaintenanceTask } from './types';

export interface ZoneSummary {
  open: number;
  maxPriority: 0 | 1 | 2;
  due: DueState;
}

export type NewCar = Pick<Car, 'name' | 'modelId'> & Partial<Pick<Car, 'color' | 'plate' | 'vin' | 'year' | 'mileage'>>;
export type NewIssue = Pick<Issue, 'zoneId' | 'kind' | 'title'> & Partial<Pick<Issue, 'notes' | 'priority' | 'cost' | 'spot'>>;
export type NewTask = Pick<MaintenanceTask, 'zoneId' | 'title'> &
  Partial<Pick<MaintenanceTask, 'notes' | 'everyKm' | 'everyMonths' | 'lastDate' | 'lastKm'>>;
export type NewLog = Pick<LogEntry, 'zoneId' | 'title' | 'date'> &
  Partial<Pick<LogEntry, 'kind' | 'notes' | 'mileage' | 'cost'>>;
export interface Completion {
  date: DateStr;
  mileage?: number;
  cost?: number;
  notes?: string;
}

const ACTIVE_KEY = 'shtbox.activeCar';

function logKindForIssue(k: IssueKind): LogKind {
  if (k === 'breakdown') return 'repair';
  if (k === 'todo') return 'todo';
  return BODY_KINDS.includes(k) ? 'bodywork' : 'other';
}

/**
 * Хранилище состояния: реактивные signals + запись-сквозь в Storage.
 * Сначала транзакция в БД, потом обновление signals — состояние в UI никогда
 * не расходится с тем, что реально сохранено.
 */
export class Store {
  readonly cars = signal<Car[]>([]);
  readonly issues = signal<Issue[]>([]);
  readonly tasks = signal<MaintenanceTask[]>([]);
  readonly logs = signal<LogEntry[]>([]);
  readonly activeCarId = signal<string | null>(null);
  readonly ready = signal(false);
  readonly error = signal<string | null>(null);
  /** «сегодня» — signal, чтобы статусы ТО пересчитывались при смене суток */
  readonly today = signal<DateStr>(todayStr());

  readonly activeCar: ReadonlySignal<Car | undefined> = computed(() => {
    const id = this.activeCarId.value;
    return this.cars.value.find((c) => c.id === id) ?? this.cars.value[0];
  });
  readonly carIssues = computed(() => {
    const id = this.activeCar.value?.id;
    return this.issues.value.filter((i) => i.carId === id);
  });
  readonly carTasks = computed(() => {
    const id = this.activeCar.value?.id;
    return this.tasks.value.filter((i) => i.carId === id);
  });
  readonly carLogs = computed(() => {
    const id = this.activeCar.value?.id;
    return this.logs.value
      .filter((l) => l.carId === id)
      .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
  });
  /** статус регламентных работ активного авто */
  readonly taskDue = computed(() => {
    const car = this.activeCar.value;
    const m = new Map<string, DueInfo>();
    if (!car) return m;
    for (const t of this.carTasks.value) m.set(t.id, dueInfo(t, car.mileage, this.today.value));
    return m;
  });
  readonly zoneSummary = computed(() => {
    const m = new Map<string, ZoneSummary>();
    const get = (z: string) => {
      let s = m.get(z);
      if (!s) m.set(z, (s = { open: 0, maxPriority: 0, due: 'ok' }));
      return s;
    };
    for (const i of this.carIssues.value) {
      if (i.status !== 'open') continue;
      const s = get(i.zoneId);
      s.open++;
      if (i.priority > s.maxPriority) s.maxPriority = i.priority;
    }
    for (const t of this.carTasks.value) {
      const d = this.taskDue.value.get(t.id);
      if (!d || d.state === 'ok' || d.state === 'unknown') continue;
      const s = get(t.zoneId);
      s.due = worstState(s.due, d.state);
    }
    return m;
  });

  constructor(private storage: Storage) {}

  get persistent(): boolean {
    return this.storage.persistent;
  }

  async init(): Promise<void> {
    const [cars, issues, tasks, logs] = await Promise.all([
      this.storage.getAll<unknown>('cars'),
      this.storage.getAll<unknown>('issues'),
      this.storage.getAll<unknown>('tasks'),
      this.storage.getAll<unknown>('logs'),
    ]);
    // повторная санитаризация: данные в БД тоже не считаем безусловно доверенными
    const safe = <T,>(arr: unknown[], fn: (x: unknown) => T): T[] => {
      const out: T[] = [];
      for (const x of arr) {
        try {
          out.push(fn(x));
        } catch (e) {
          console.warn('Пропущена повреждённая запись', e);
        }
      }
      return out;
    };
    this.cars.value = safe(cars, sanitizeCar);
    this.issues.value = safe(issues, sanitizeIssue);
    this.tasks.value = safe(tasks, sanitizeTask);
    this.logs.value = safe(logs, sanitizeLog);
    try {
      const saved = localStorage.getItem(ACTIVE_KEY);
      if (saved && this.cars.value.some((c) => c.id === saved)) this.activeCarId.value = saved;
    } catch {
      /* localStorage может быть недоступен */
    }
    this.ready.value = true;
  }

  refreshToday(): void {
    const t = todayStr();
    if (t !== this.today.value) this.today.value = t;
  }

  setActiveCar(id: string): void {
    this.activeCarId.value = id;
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* ignore */
    }
  }

  private async commit(ops: Op[], apply: () => void): Promise<void> {
    try {
      await this.storage.apply(ops);
      apply();
      this.error.value = null;
    } catch (e) {
      console.error(e);
      this.error.value = 'Не удалось сохранить данные: ' + (e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  // ---------- Автомобили ----------
  async addCar(input: NewCar): Promise<Car> {
    const now = Date.now();
    const car = sanitizeCar({ color: '#c9ccd1', plate: '', vin: '', mileage: 0, ...input, id: uid(), createdAt: now, updatedAt: now });
    await this.commit([{ store: 'cars', put: car }], () => (this.cars.value = [...this.cars.value, car]));
    this.setActiveCar(car.id);
    return car;
  }

  async updateCar(id: string, patch: Partial<Omit<Car, 'id' | 'createdAt'>>): Promise<void> {
    const cur = this.cars.value.find((c) => c.id === id);
    if (!cur) return;
    const next = sanitizeCar({ ...cur, ...patch, id, updatedAt: Date.now() });
    await this.commit([{ store: 'cars', put: next }], () => (this.cars.value = this.cars.value.map((c) => (c.id === id ? next : c))));
  }

  async deleteCar(id: string): Promise<void> {
    const ops: Op[] = [{ store: 'cars', del: id }];
    for (const i of this.issues.value) if (i.carId === id) ops.push({ store: 'issues', del: i.id });
    for (const t of this.tasks.value) if (t.carId === id) ops.push({ store: 'tasks', del: t.id });
    for (const l of this.logs.value) if (l.carId === id) ops.push({ store: 'logs', del: l.id });
    await this.commit(ops, () => {
      this.cars.value = this.cars.value.filter((c) => c.id !== id);
      this.issues.value = this.issues.value.filter((c) => c.carId !== id);
      this.tasks.value = this.tasks.value.filter((c) => c.carId !== id);
      this.logs.value = this.logs.value.filter((c) => c.carId !== id);
    });
    if (this.activeCarId.value === id) this.activeCarId.value = null;
  }

  /** Возвращает op для обновления пробега, если новое значение больше текущего. */
  private mileageOp(carId: string, km: number | undefined): { op?: Op; car?: Car } {
    const car = this.cars.value.find((c) => c.id === carId);
    if (!car || km === undefined || km <= car.mileage) return {};
    const next = { ...car, mileage: Math.round(km), updatedAt: Date.now() };
    return { op: { store: 'cars', put: next }, car: next };
  }

  // ---------- Дефекты / доделки ----------
  async addIssue(input: NewIssue): Promise<Issue> {
    const car = this.activeCar.value;
    if (!car) throw new Error('Нет активного автомобиля');
    const issue = sanitizeIssue({
      notes: '',
      priority: 0,
      ...input,
      id: uid(),
      carId: car.id,
      status: 'open',
      createdAt: Date.now(),
    });
    await this.commit([{ store: 'issues', put: issue }], () => (this.issues.value = [...this.issues.value, issue]));
    return issue;
  }

  async updateIssue(id: string, patch: Partial<Pick<Issue, 'title' | 'notes' | 'priority' | 'cost' | 'zoneId' | 'spot' | 'kind'>>): Promise<void> {
    const cur = this.issues.value.find((i) => i.id === id);
    if (!cur) return;
    const next = sanitizeIssue({ ...cur, ...patch });
    await this.commit([{ store: 'issues', put: next }], () => (this.issues.value = this.issues.value.map((i) => (i.id === id ? next : i))));
  }

  /** Отметить выполненным: закрывает дефект и пишет запись в журнал (атомарно). */
  async completeIssue(id: string, c: Completion): Promise<void> {
    const cur = this.issues.value.find((i) => i.id === id);
    if (!cur || cur.status === 'done') return;
    const cost = c.cost ?? cur.cost;
    const issue = sanitizeIssue({ ...cur, status: 'done', doneDate: c.date, cost });
    const log = sanitizeLog({
      id: uid(),
      carId: cur.carId,
      zoneId: cur.zoneId,
      kind: logKindForIssue(cur.kind),
      title: cur.title,
      notes: c.notes || cur.notes,
      date: c.date,
      mileage: c.mileage,
      cost,
      ref: { type: 'issue', id },
      createdAt: Date.now(),
    });
    const { op, car } = this.mileageOp(cur.carId, c.mileage);
    const ops: Op[] = [
      { store: 'issues', put: issue },
      { store: 'logs', put: log },
    ];
    if (op) ops.push(op);
    await this.commit(ops, () => {
      this.issues.value = this.issues.value.map((i) => (i.id === id ? issue : i));
      this.logs.value = [...this.logs.value, log];
      if (car) this.cars.value = this.cars.value.map((x) => (x.id === car.id ? car : x));
    });
  }

  /** Вернуть в работу (например, ошибочно отметили): удаляет связанную запись журнала. */
  async reopenIssue(id: string): Promise<void> {
    const cur = this.issues.value.find((i) => i.id === id);
    if (!cur || cur.status === 'open') return;
    const issue = sanitizeIssue({ ...cur, status: 'open', doneDate: undefined });
    const stale = this.logs.value.filter((l) => l.ref?.type === 'issue' && l.ref.id === id);
    const ops: Op[] = [{ store: 'issues', put: issue }, ...stale.map((l): Op => ({ store: 'logs', del: l.id }))];
    await this.commit(ops, () => {
      this.issues.value = this.issues.value.map((i) => (i.id === id ? issue : i));
      this.logs.value = this.logs.value.filter((l) => !stale.includes(l));
    });
  }

  async deleteIssue(id: string): Promise<void> {
    await this.commit([{ store: 'issues', del: id }], () => (this.issues.value = this.issues.value.filter((i) => i.id !== id)));
  }

  // ---------- Регламент ТО ----------
  async addTask(input: NewTask): Promise<MaintenanceTask> {
    const car = this.activeCar.value;
    if (!car) throw new Error('Нет активного автомобиля');
    const task = sanitizeTask({ notes: '', ...input, id: uid(), carId: car.id, createdAt: Date.now() });
    await this.commit([{ store: 'tasks', put: task }], () => (this.tasks.value = [...this.tasks.value, task]));
    return task;
  }

  async addTasks(inputs: NewTask[]): Promise<void> {
    const car = this.activeCar.value;
    if (!car) throw new Error('Нет активного автомобиля');
    const created = inputs.map((i) => sanitizeTask({ notes: '', ...i, id: uid(), carId: car.id, createdAt: Date.now() }));
    await this.commit(
      created.map((t): Op => ({ store: 'tasks', put: t })),
      () => (this.tasks.value = [...this.tasks.value, ...created]),
    );
  }

  async updateTask(id: string, patch: Partial<Omit<MaintenanceTask, 'id' | 'carId' | 'createdAt'>>): Promise<void> {
    const cur = this.tasks.value.find((t) => t.id === id);
    if (!cur) return;
    const next = sanitizeTask({ ...cur, ...patch });
    await this.commit([{ store: 'tasks', put: next }], () => (this.tasks.value = this.tasks.value.map((t) => (t.id === id ? next : t))));
  }

  async deleteTask(id: string): Promise<void> {
    await this.commit([{ store: 'tasks', del: id }], () => (this.tasks.value = this.tasks.value.filter((t) => t.id !== id)));
  }

  /** ТО выполнено: запись в журнал + сдвиг «последнего выполнения». */
  async completeTask(id: string, c: Completion): Promise<void> {
    const cur = this.tasks.value.find((t) => t.id === id);
    const car = cur && this.cars.value.find((x) => x.id === cur.carId);
    if (!cur || !car) return;
    const km = c.mileage ?? car.mileage;
    const task = sanitizeTask({ ...cur, lastDate: c.date, lastKm: km });
    const log = sanitizeLog({
      id: uid(),
      carId: cur.carId,
      zoneId: cur.zoneId,
      kind: 'maintenance',
      title: cur.title,
      notes: c.notes ?? '',
      date: c.date,
      mileage: km,
      cost: c.cost,
      ref: { type: 'task', id },
      createdAt: Date.now(),
    });
    const { op, car: nextCar } = this.mileageOp(cur.carId, km);
    const ops: Op[] = [
      { store: 'tasks', put: task },
      { store: 'logs', put: log },
    ];
    if (op) ops.push(op);
    await this.commit(ops, () => {
      this.tasks.value = this.tasks.value.map((t) => (t.id === id ? task : t));
      this.logs.value = [...this.logs.value, log];
      if (nextCar) this.cars.value = this.cars.value.map((x) => (x.id === nextCar.id ? nextCar : x));
    });
  }

  // ---------- Журнал ----------
  async addLog(input: NewLog): Promise<void> {
    const car = this.activeCar.value;
    if (!car) throw new Error('Нет активного автомобиля');
    const log = sanitizeLog({ kind: 'repair', notes: '', ...input, id: uid(), carId: car.id, createdAt: Date.now() });
    const { op, car: nextCar } = this.mileageOp(car.id, log.mileage);
    const ops: Op[] = [{ store: 'logs', put: log }];
    if (op) ops.push(op);
    await this.commit(ops, () => {
      this.logs.value = [...this.logs.value, log];
      if (nextCar) this.cars.value = this.cars.value.map((x) => (x.id === nextCar.id ? nextCar : x));
    });
  }

  async updateLog(id: string, patch: Partial<Pick<LogEntry, 'title' | 'notes' | 'date' | 'mileage' | 'cost' | 'kind' | 'zoneId'>>): Promise<void> {
    const cur = this.logs.value.find((l) => l.id === id);
    if (!cur) return;
    const next = sanitizeLog({ ...cur, ...patch });
    await this.commit([{ store: 'logs', put: next }], () => (this.logs.value = this.logs.value.map((l) => (l.id === id ? next : l))));
  }

  async deleteLog(id: string): Promise<void> {
    const cur = this.logs.value.find((l) => l.id === id);
    if (!cur) return;
    const ops: Op[] = [{ store: 'logs', del: id }];
    let nextTask: MaintenanceTask | undefined;
    if (cur.ref?.type === 'task') {
      const rest = this.logs.value
        .filter((l) => l.id !== id && l.ref?.type === 'task' && l.ref.id === cur.ref!.id)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const task = this.tasks.value.find((t) => t.id === cur.ref!.id);
      if (task && rest.length) {
        nextTask = { ...task, lastDate: rest[0].date, lastKm: rest[0].mileage ?? task.lastKm };
        ops.push({ store: 'tasks', put: nextTask });
      }
    }
    await this.commit(ops, () => {
      this.logs.value = this.logs.value.filter((l) => l.id !== id);
      if (nextTask) this.tasks.value = this.tasks.value.map((t) => (t.id === nextTask!.id ? nextTask! : t));
    });
  }

  // ---------- Резервные копии ----------
  exportBackup(): Backup {
    return {
      app: 'shtbox',
      version: 1,
      exportedAt: new Date().toISOString(),
      cars: this.cars.value,
      issues: this.issues.value,
      tasks: this.tasks.value,
      logs: this.logs.value,
    };
  }

  /** merge — добавить/обновить записи по id; replace — заменить все данные. */
  async importBackup(b: Backup, mode: 'merge' | 'replace'): Promise<void> {
    if (mode === 'replace') await this.storage.clearAll();
    const ops: Op[] = [
      ...b.cars.map((x): Op => ({ store: 'cars', put: x })),
      ...b.issues.map((x): Op => ({ store: 'issues', put: x })),
      ...b.tasks.map((x): Op => ({ store: 'tasks', put: x })),
      ...b.logs.map((x): Op => ({ store: 'logs', put: x })),
    ];
    await this.commit(ops, () => {
      const upsert = <T extends { id: string }>(cur: T[], add: T[]): T[] => {
        const m = new Map(mode === 'replace' ? [] : cur.map((x) => [x.id, x] as const));
        for (const x of add) m.set(x.id, x);
        return [...m.values()];
      };
      this.cars.value = upsert(this.cars.value, b.cars);
      this.issues.value = upsert(this.issues.value, b.issues);
      this.tasks.value = upsert(this.tasks.value, b.tasks);
      this.logs.value = upsert(this.logs.value, b.logs);
    });
    if (!this.cars.value.some((c) => c.id === this.activeCarId.value) && this.cars.value[0]) this.setActiveCar(this.cars.value[0].id);
  }
}
