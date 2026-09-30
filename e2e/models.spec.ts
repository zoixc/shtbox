import { expect, test } from '@playwright/test';
import { menu, modelReady } from './helpers';

test('своя модель: загрузить BMW GLB → мастер → сохранить → создать авто → переживает перезагрузку', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  const dlg = page.getByRole('dialog', { name: /Новый автомобиль/ });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Модель (3D)').selectOption('__import');

  const wiz = page.getByRole('dialog', { name: 'Импорт модели' });
  await expect(wiz).toBeVisible();
  // The packaged BMW asset exercises the automatic-import path without retaining a second test-only car model.
  await wiz.locator('input[type=file]').setInputFiles('public/models/bmw116i.glb');
  await expect(wiz.getByRole('tab', { name: 'Ориентация' })).toBeVisible({ timeout: 180_000 });

  const bodySelect = wiz.getByLabel('Тип кузова');
  // Auto-detection is a best-effort for unlabeled GLB; explicitly correct this known hatchback in the wizard.
  await bodySelect.selectOption('hatch');
  const body = await bodySelect.inputValue();
  await expect(bodySelect).toHaveValue('hatch');
  await expect(wiz.getByLabel('Двигатель')).toHaveValue(/^(front|rear)$/);

  await wiz.getByRole('tab', { name: 'Узлы' }).click();
  await expect(wiz.locator('.part').first()).toBeVisible();
  await wiz.getByRole('tab', { name: 'Готово' }).click();
  await wiz.getByLabel('Название модели').fill('E2E BMW import');
  await wiz.getByRole('button', { name: 'Сохранить и использовать' }).click();

  // Вернулись в диалог авто с выбранной моделью.
  await expect(wiz).toBeHidden();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Модель (3D)').locator('option:checked')).toHaveText('E2E BMW import');
  await dlg.getByLabel('Название').fill('Тестовый BMW');
  await dlg.getByRole('button', { name: 'Создать' }).click();
  await modelReady(page);

  // Узлы открываются и соответствуют выбранному типу кузова.
  await page.getByRole('button', { name: 'Открыть двери, капот, багажник' }).click();
  await expect(page.getByRole('menuitem', { name: /Капот/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Дверь/ }).first()).toBeVisible();
  if (body === 'coupe') await expect(page.getByRole('menuitem', { name: /Дверь зад/ })).toHaveCount(0);
  else await expect(page.getByRole('menuitem', { name: /Дверь зад/ })).toHaveCount(2);
  await page.keyboard.press('Escape');

  // После перезагрузки пользовательская модель остаётся в локальном хранилище.
  await page.reload();
  await modelReady(page);
  await menu(page, /Модели автомобилей/);
  const list = page.getByRole('dialog', { name: 'Модели автомобилей' });
  await expect(list.getByText('E2E BMW import')).toBeVisible();
  // Модель используется авто — удалить нельзя.
  await expect(list.getByRole('button', { name: 'Удалить' })).toBeDisabled();
});
