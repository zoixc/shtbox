import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Первый запуск: диалог «Новый автомобиль». */
export async function createCar(page: Page, o: { name?: string; model?: string; mileage?: string } = {}) {
  await page.goto('/');
  const dlg = page.getByRole('dialog', { name: /Новый автомобиль/ });
  await expect(dlg).toBeVisible();
  if (o.name) await dlg.getByLabel('Название').fill(o.name);
  if (o.model) await dlg.getByLabel('Модель (3D)').selectOption(o.model);
  if (o.mileage) await dlg.getByLabel('Текущий пробег, км').fill(o.mileage);
  await dlg.getByRole('button', { name: 'Создать' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
}

/** Ждём, пока 3D-модель загрузится (появляются кнопки «Открыть»). */
export async function modelReady(page: Page) {
  await expect(page.locator('.open-bar .chip-btn').first()).toBeVisible({ timeout: 60_000 });
}

export const openTab = (page: Page, name: string) => page.locator('.tabs .tab, .tab').filter({ hasText: name }).first().click();

/** Крошечный валидный PNG 16×16 для загрузки вложений. */
export const PNG_16 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM4YaNBEmIY1TCqYfhqAAAeBCwQMwPSngAAAABJRU5ErkJggg==',
  'base64',
);
