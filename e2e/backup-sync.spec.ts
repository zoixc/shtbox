import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createCar, modelReady, openDataDialog, openTab } from './helpers';

test('зашифрованная копия: скачать → не содержит открытых данных → импорт по паролю', async ({ page }) => {
  await createCar(page, { name: 'Секретная-Машина' });
  await openDataDialog(page);
  await page.getByLabel(/зашифровать паролем/).check();
  await page.getByLabel('Пароль (от 8 символов)').fill('correct horse');
  await page.getByLabel('Повторите пароль').fill('correct horse');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать .shtbox' }).click();
  const file = await dl;
  const path = (await file.path())!;
  const text = await readFile(path, 'utf8');
  expect(text).not.toContain('Секретная-Машина');

  await page.locator('input[type=file][accept*=shtbox]').setInputFiles(path);
  await expect(page.getByText('Файл зашифрован')).toBeVisible();
  await page.getByLabel('Пароль', { exact: true }).last().fill('wrong password');
  await page.getByRole('button', { name: 'Расшифровать' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Пароль', { exact: true }).last().fill('correct horse');
  await page.getByRole('button', { name: 'Расшифровать' }).click();
  await expect(page.getByText(/автомобилей — 1/)).toBeVisible();
});

test('синхронизация двух устройств с шифрованием на клиенте', async ({ browser }) => {
  // устройство A
  const ctxA = await browser.newContext({ locale: 'ru-RU' });
  const a = await ctxA.newPage();
  await createCar(a, { name: 'Общая машина', mileage: '12345' });
  await openDataDialog(a);
  await a.getByRole('button', { name: 'Включить синхронизацию' }).click();
  if (await a.getByRole('button', { name: 'Показать' }).isVisible()) await a.getByRole('button', { name: 'Показать' }).click();
  const key = (await a.locator('.sync-key code').innerText()).trim();
  expect(key).toMatch(/^([A-Z0-9]{4}-){7}[A-Z0-9]{4}$/);
  const put = a.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/sync/v1/'));
  await a.getByRole('button', { name: 'Отправить на сервер' }).click();
  await expect(a.getByText(/Ревизия 1/)).toBeVisible();

  // на сервер ушёл шифртекст: ни названия машины, ни JSON-структуры в теле запроса нет
  const body = (await (await put).postDataBuffer())!.toString('latin1');
  expect(body.length).toBeGreaterThan(100);
  expect(body).not.toContain('Общая машина');
  expect(body).not.toContain('"cars"');

  // устройство B
  const ctxB = await browser.newContext({ locale: 'ru-RU' });
  const b = await ctxB.newPage();
  await b.goto('/');
  await expect(b.getByRole('dialog', { name: /Новый автомобиль/ })).toBeVisible();
  await b.getByLabel('Название').fill('Локальная B');
  await b.getByRole('button', { name: 'Создать' }).click();
  await openDataDialog(b);
  await b.getByRole('button', { name: /Подключить это устройство/ }).click();
  await b.getByLabel('Ключ синхронизации').fill(key);
  await b.getByRole('button', { name: 'Подключить', exact: true }).click();
  await b.getByRole('button', { name: 'Получить с сервера' }).click();
  await b.getByRole('button', { name: 'Импортировать' }).click();
  await b.locator('select[aria-label="Автомобиль"]').selectOption({ label: 'Общая машина' });
  await expect(b.locator('select[aria-label="Автомобиль"] option:checked')).toHaveText('Общая машина');

  // чужой ключ: по нему на сервере ничего нет — данные устройства A недоступны
  const ctxC = await browser.newContext({ locale: 'ru-RU' });
  const c = await ctxC.newPage();
  await createCar(c, { name: 'Чужак' });
  await openDataDialog(c);
  await c.getByRole('button', { name: /Подключить это устройство/ }).click();
  await c.getByLabel('Ключ синхронизации').fill('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
  await c.getByRole('button', { name: 'Подключить', exact: true }).click();
  await c.getByRole('button', { name: 'Получить с сервера' }).click();
  await expect(c.getByRole('status')).toContainText('На сервере пока пусто');
  await expect(c.getByRole('button', { name: 'Импортировать' })).toHaveCount(0);
  await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()]);
});

test('напоминания о ТО: уведомление приходит для просроченной работы, повторно в тот же день — нет', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  await ctx.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:4173' });
  // Headless-Chromium отдаёт Notification.permission === 'denied' и отказывает showNotification даже при выданном разрешении,
  // поэтому подменяем показ и проверяем то, что приложение пытается показать (логика: что, когда и не чаще раза в сутки).
  await ctx.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    ServiceWorkerRegistration.prototype.showNotification = async function (title: string, o?: NotificationOptions) {
      const list = JSON.parse(localStorage.getItem('e2e.notes') ?? '[]');
      list.push(title + ' | ' + (o?.body ?? ''));
      localStorage.setItem('e2e.notes', JSON.stringify(list));
    };
  });
  const page = await ctx.newPage();
  await createCar(page, { name: 'E2E Напоминания', mileage: '90000' });
  await openTab(page, 'ТО');
  await page.getByRole('button', { name: '+ Регламентная работа' }).click();
  await page.getByLabel('Название').fill('Просроченная замена');
  await page.getByLabel('Каждые, км').fill('10000');
  await page.getByLabel('Последний раз: пробег').fill('10000');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await openDataDialog(page);
  await page.getByLabel(/уведомлять о просроченном/).click();
  await expect(page.getByLabel(/уведомлять о просроченном/)).toBeChecked();
  const shown = () => page.evaluate(() => JSON.parse(localStorage.getItem('e2e.notes') ?? '[]') as string[]);
  await expect.poll(shown).toEqual([expect.stringContaining('просрочено: 1')]);
  expect((await shown())[0]).toContain('Просроченная замена');

  await page.reload();
  await modelReady(page);
  await page.waitForTimeout(1500);
  expect(await shown()).toHaveLength(1);
  await ctx.close();
});
