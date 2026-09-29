/**
 * Тонкая обёртка над IndexedDB. Все изменения идут пачкой в одной транзакции,
 * поэтому, например, «закрыть дефект + записать в журнал» атомарно.
 * Есть in-memory реализация (для тестов и на случай, когда IndexedDB недоступна).
 */
export const STORES = ['cars', 'issues', 'tasks', 'logs', 'attachments', 'blobs'] as const;
export type StoreName = (typeof STORES)[number];

export type Op = { store: StoreName; put: { id: string } } | { store: StoreName; del: string };

export interface Storage {
  readonly persistent: boolean;
  getAll<T>(store: StoreName): Promise<T[]>;
  get<T>(store: StoreName, id: string): Promise<T | undefined>;
  apply(ops: Op[]): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = 'shtbox';
const DB_VERSION = 2;

const wrap = <T>(req: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

const txDone = (tx: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('transaction aborted'));
  });

export class IdbStorage implements Storage {
  readonly persistent = true;
  private constructor(private db: IDBDatabase) {}

  static open(factory: IDBFactory = indexedDB): Promise<IdbStorage> {
    return new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) {
            const os = db.createObjectStore(s, { keyPath: 'id' });
            if (s !== 'cars') os.createIndex('carId', 'carId');
          }
        }
      };
      req.onsuccess = () => resolve(new IdbStorage(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB заблокирована другой вкладкой'));
    });
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    const tx = this.db.transaction(store, 'readonly');
    return wrap(tx.objectStore(store).getAll() as IDBRequest<T[]>);
  }

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    const tx = this.db.transaction(store, 'readonly');
    return wrap(tx.objectStore(store).get(id) as IDBRequest<T | undefined>);
  }

  async apply(ops: Op[]): Promise<void> {
    if (!ops.length) return;
    const names = [...new Set(ops.map((o) => o.store))];
    const tx = this.db.transaction(names, 'readwrite');
    for (const op of ops) {
      const os = tx.objectStore(op.store);
      if ('put' in op) os.put(op.put);
      else os.delete(op.del);
    }
    await txDone(tx);
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction([...STORES], 'readwrite');
    for (const s of STORES) tx.objectStore(s).clear();
    await txDone(tx);
  }
}

export class MemoryStorage implements Storage {
  readonly persistent = false;
  private data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));

  async getAll<T>(store: StoreName): Promise<T[]> {
    return structuredClone([...this.data.get(store)!.values()]) as T[];
  }
  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    const v = this.data.get(store)!.get(id);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async apply(ops: Op[]): Promise<void> {
    for (const op of ops) {
      const m = this.data.get(op.store)!;
      if ('put' in op) m.set(op.put.id, structuredClone(op.put));
      else m.delete(op.del);
    }
  }
  async clearAll(): Promise<void> {
    for (const m of this.data.values()) m.clear();
  }
}

export async function openStorage(): Promise<Storage> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no idb');
    return await IdbStorage.open();
  } catch (e) {
    console.warn('IndexedDB недоступна, данные не будут сохранены между сессиями', e);
    return new MemoryStorage();
  }
}
