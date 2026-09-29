import { signal } from '@preact/signals';
import { todayStr } from './core/dates';
import { NOTIFIED_KEY, REMINDERS_KEY, collectDue, notificationFor, pickFresh } from './core/reminders';
import type { NotifiedMap, RemindersSettings } from './core/reminders';
import type { Store } from './core/store';

/** Напоминания о ТО. Показ — когда приложение открыто (и при возвращении на вкладку) + в фоне через periodicsync, где браузер это умеет. */
export const remindersOn = signal(false);

export const remindersSupported = (): boolean => typeof Notification !== 'undefined';
export const permission = (): NotificationPermission | 'unsupported' => (remindersSupported() ? Notification.permission : 'unsupported');

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return (await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 1500))])) ?? null;
  } catch {
    return null;
  }
}

async function setPeriodic(on: boolean): Promise<void> {
  const reg = (await registration()) as (ServiceWorkerRegistration & { periodicSync?: { register(tag: string, o: { minInterval: number }): Promise<void>; unregister(tag: string): Promise<void> } }) | null;
  if (!reg?.periodicSync) return;
  try {
    if (on) await reg.periodicSync.register('shtbox-due', { minInterval: 12 * 3600 * 1000 });
    else await reg.periodicSync.unregister('shtbox-due');
  } catch {
    /* нет разрешения/не установлено как PWA — остаётся показ при открытом приложении */
  }
}

export async function initReminders(store: Store): Promise<void> {
  const s = await store.getMeta<RemindersSettings>(REMINDERS_KEY);
  remindersOn.value = !!s?.enabled && permission() === 'granted';
  if (remindersOn.value) {
    void checkReminders(store);
    void setPeriodic(true);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkReminders(store);
  });
  setInterval(() => void checkReminders(store), 3600 * 1000);
}

/** true — включено; false — пользователь запретил уведомления в браузере. */
export async function enableReminders(store: Store): Promise<boolean> {
  if (!remindersSupported()) return false;
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (p !== 'granted') return false;
  await store.setMeta(REMINDERS_KEY, { enabled: true } satisfies RemindersSettings);
  remindersOn.value = true;
  void setPeriodic(true);
  await checkReminders(store, true);
  return true;
}

export async function disableReminders(store: Store): Promise<void> {
  await store.setMeta(REMINDERS_KEY, { enabled: false } satisfies RemindersSettings);
  remindersOn.value = false;
  void setPeriodic(false);
}

export async function checkReminders(store: Store, force = false): Promise<number> {
  if (!remindersOn.value || permission() !== 'granted') return 0;
  const today = todayStr();
  store.today.value = today;
  const notified = force ? {} : (await store.getMeta<NotifiedMap>(NOTIFIED_KEY)) ?? {};
  const { fresh, next } = pickFresh(collectDue(store.cars.value, store.tasks.value, today), notified, today);
  if (!fresh.length) return 0;
  const reg = await registration();
  for (const e of fresh) {
    const n = notificationFor(e);
    if (reg) await reg.showNotification(n.title, { body: n.body, tag: n.tag, icon: '/icon.svg' });
    else new Notification(n.title, { body: n.body, tag: n.tag, icon: '/icon.svg' });
  }
  await store.setMeta(NOTIFIED_KEY, next);
  return fresh.length;
}
