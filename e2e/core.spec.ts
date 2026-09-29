import { expect, test } from '@playwright/test';
import { PNG_16, createCar, modelReady, openDataDialog, openTab } from './helpers';

test('дефект на кузове: отметить на модели → выполнить → журнал → переживает перезагрузку', async ({ page }) => {
  await createCar(page, { name: 'E2E BMW GLB', mileage: '50000' }); // модель по умолчанию — детальная BMW 116i (GLB)
  await modelReady(page);

  await page.locator('.zrow', { hasText: 'Дверь передняя левая' }).click();
  await page.getByRole('button', { name: '+ Поломка / доделка / дефект' }).click();
  await page.getByRole('radio', { name: 'Скол' }).check();
  await page.getByLabel('Что нужно сделать / что сломалось').fill('Сколы у ручки');
  await page.getByRole('button', { name: 'Указать на модели' }).click();
  await expect(page.locator('.place-banner')).toBeVisible();

  // камера после выбора узла смотрит на дверь — центр холста попадает в кузов
  await page.waitForTimeout(1500);
  const box = (await page.locator('.viewer-host canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.55);
  await expect(page.getByText('Метка поставлена на кузове')).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await openTab(page, 'Дефекты');
  const item = page.locator('.item', { hasText: 'Сколы у ручки' });
  await expect(item).toContainText('отмечено на кузове');

  await item.getByRole('button', { name: '✓ Выполнено' }).click();
  await page.getByRole('button', { name: 'Готово — в журнал' }).click();
  await expect(page.locator('.item', { hasText: 'Сколы у ручки' })).toHaveCount(0);

  await openTab(page, 'Журнал');
  await expect(page.locator('.item', { hasText: 'Сколы у ручки' })).toBeVisible();

  await page.reload();
  await modelReady(page);
  await openTab(page, 'Журнал');
  await expect(page.locator('.item', { hasText: 'Сколы у ручки' })).toBeVisible();
});

test('регламент: добавить работу с периодичностью и отметить выполненной', async ({ page }) => {
  await createCar(page, { name: 'E2E ТО', model: 'sedan-solaris', mileage: '80000' });
  await openTab(page, 'ТО');
  await page.getByRole('button', { name: '+ Регламентная работа' }).click();
  await page.getByLabel('Название').fill('Промывка радиатора E2E');
  await page.getByLabel('Каждые, км').fill('60000');
  await page.getByLabel('Последний раз: пробег').fill('10000');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  const row = page.locator('.item', { hasText: 'Промывка радиатора E2E' });
  await expect(row).toContainText(/просроч/i);

  await row.getByRole('button', { name: '✓ Выполнено' }).click();
  await page.getByRole('button', { name: 'Выполнено — в журнал' }).click();
  await expect(row).not.toContainText(/просроч/i);
  await openTab(page, 'Журнал');
  await expect(page.locator('.item', { hasText: 'Промывка радиатора E2E' })).toBeVisible();
});

test('фото и чеки: прикрепить к дефекту, открыть, сохранить в копию', async ({ page }) => {
  await createCar(page, { name: 'E2E Фото', model: 'sedan-solaris' }); // лёгкая модель: сжатие фото не конкурирует с рендером в swiftshader
  await openTab(page, 'Узлы');
  await page.locator('.zrow', { hasText: 'Двигатель' }).first().click();
  await page.getByRole('button', { name: '+ Поломка / доделка / дефект' }).click();
  await page.getByLabel('Что нужно сделать / что сломалось').fill('Течь масла');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await openTab(page, 'Дефекты');
  const item = page.locator('.item', { hasText: 'Течь масла' });
  await item.locator('input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: PNG_16 });
  await expect(item.locator('.photo img')).toBeVisible();
  await item.locator('.photo').click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).last()).toBeVisible();
  await page.keyboard.press('Escape');

  await openDataDialog(page);
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать JSON' }).click();
  const file = await dl;
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8'));
  expect(json.issues.some((i: { title: string }) => i.title === 'Течь масла')).toBe(true);
  expect(json.attachments).toHaveLength(1);
});

test('BMW 116i (GLB): узлы хэтча, открываются все двери, регламент подставлен', async ({ page }) => {
  await createCar(page, { name: 'E2E BMW', model: 'hatch-bmw116i' });
  await modelReady(page);
  await page.getByRole('button', { name: 'Открыть двери, капот, багажник' }).click();
  for (const n of ['Капот', 'Задняя дверь', 'Дверь пер. левая', 'Дверь зад. левая', 'Дверь пер. правая', 'Дверь зад. правая']) {
    await expect(page.getByRole('menuitem', { name: n })).toBeVisible();
  }
  await page.getByRole('menuitem', { name: 'Открыть всё' }).click();
  await expect(page.getByText('Открыто: 6')).toBeVisible();
  await openTab(page, 'ТО');
  await expect(page.locator('.item').first()).toBeVisible();
  await expect(page.locator('.item', { hasText: /масл/i }).first()).toBeVisible();
});
