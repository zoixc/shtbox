/**
 * Service worker: офлайн-кэш (сеть в приоритете) + фоновые напоминания о ТО (periodicsync) + клик по уведомлению.
 * Собирается esbuild-плагином из vite.config.ts в dist/sw.js и делит код расчёта ТО с приложением.
 */
import { todayStr } from './core/dates';
import { NOTIFIED_KEY, REMINDERS_KEY, collectDue, notificationFor, pickFresh } from './core/reminders';
import type { NotifiedMap, RemindersSettings } from './core/reminders';
import type { Car, MaintenanceTask } from './core/types';

interface SwScope {
  location: { origin: string };
  registration: { showNotification(title: string, o?: { body?: string; tag?: string; icon?: string; data?: unknown }): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(o: { type: 'window' }): Promise<{ focus(): Promise<unknown> }[]>; openWindow(url: string): Promise<unknown> };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, cb: (e: never) => void): void;
}
type ExtEvent = { waitUntil(p: Promise<unknown>): void };
const sw = self as unknown as SwScope;

const CACHE = 'shtbox-v3';

sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', ((e: ExtEvent) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => sw.clients.claim()));
}) as never);

sw.addEventListener('fetch', ((e: ExtEvent & { request: Request; respondWith(r: Promise<Response>): void }) => {
  const req = e.request;
  const url = new URL(req.url);
  // API синхронизации (шифртекст, заголовки авторизации) и всё чужое в кэш не кладём
  if (req.method !== 'GET' || url.origin !== sw.location.origin || url.pathname.startsWith('/sync/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) ?? (await caches.match('/index.html')) ?? Response.error()),
  );
}) as never);

// ---------- фоновые напоминания ----------
const idb = <T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open('shtbox');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => fn(req.result).then(resolve, reject).finally(() => req.result.close());
  });
const wrap = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
const has = (db: IDBDatabase, s: string) => db.objectStoreNames.contains(s);

async function backgroundCheck(): Promise<void> {
  await idb(async (db) => {
    if (!has(db, 'meta') || !has(db, 'cars') || !has(db, 'tasks')) return;
    const read = <T>(store: string, key: string) => wrap(db.transaction(store).objectStore(store).get(key) as IDBRequest<{ value: T } | undefined>).then((r) => r?.value);
    const settings = await read<RemindersSettings>('meta', REMINDERS_KEY);
    if (!settings?.enabled) return;
    const cars = (await wrap(db.transaction('cars').objectStore('cars').getAll())) as Car[];
    const tasks = (await wrap(db.transaction('tasks').objectStore('tasks').getAll())) as MaintenanceTask[];
    const today = todayStr();
    const notified = (await read<NotifiedMap>('meta', NOTIFIED_KEY)) ?? {};
    const { fresh, next } = pickFresh(collectDue(cars, tasks, today), notified, today);
    for (const e of fresh) {
      const n = notificationFor(e);
      await sw.registration.showNotification(n.title, { body: n.body, tag: n.tag, icon: '/icon.svg' });
    }
    if (fresh.length) {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ id: NOTIFIED_KEY, value: next });
      await new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onerror = () => rej(tx.error))));
    }
  });
}

sw.addEventListener('periodicsync', ((e: ExtEvent & { tag: string }) => {
  if (e.tag === 'shtbox-due') e.waitUntil(backgroundCheck().catch(() => undefined));
}) as never);

sw.addEventListener('notificationclick', ((e: ExtEvent & { notification: { close(): void } }) => {
  e.notification.close();
  e.waitUntil(sw.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : sw.clients.openWindow('/'))));
}) as never);
