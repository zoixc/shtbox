import { expect, test } from '@playwright/test';
import { menu, modelReady } from './helpers';

test('своя модель: загрузить пакет → мастер → сохранить → создать авто → переживает перезагрузку', async ({ page }) => {
  await page.goto('/');
  const dlg = page.getByRole('dialog', { name: /Новый автомобиль/ });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Модель (3D)').selectOption('__import');

  const wiz = page.getByRole('dialog', { name: 'Импорт модели' });
  await expect(wiz).toBeVisible();
  await wiz.locator('input[type=file]').setInputFiles('public/models/porsche-930.glb');
  await expect(wiz.getByRole('tab', { name: 'Ориентация' })).toBeVisible({ timeout: 120_000 });

  // разметка из пакета подхвачена: купе, двигатель сзади
  await expect(wiz.getByLabel('Тип кузова')).toHaveValue('coupe');
  await expect(wiz.getByLabel('Двигатель')).toHaveValue('rear');

  await wiz.getByRole('tab', { name: 'Узлы' }).click();
  await expect(wiz.locator('.part').first()).toBeVisible();
  await wiz.getByRole('tab', { name: 'Готово' }).click();
  await wiz.getByLabel('Название модели').fill('E2E Порше');
  await wiz.getByLabel('Автор модели').fill('Lexyc16');
  await wiz.getByRole('button', { name: 'Сохранить и использовать' }).click();

  // вернулись в диалог авто с выбранной моделью
  await expect(wiz).toBeHidden();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Модель (3D)').locator('option:checked')).toHaveText('E2E Порше');
  await dlg.getByLabel('Название').fill('Мой 911');
  await dlg.getByRole('button', { name: 'Создать' }).click();
  await modelReady(page);

  // узлы купе с задним мотором: капот = передний багажник, нет задних дверей
  await page.getByRole('button', { name: 'Открыть двери, капот, багажник' }).click();
  await expect(page.getByRole('menuitem', { name: /Капот/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Дверь левая' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Дверь зад/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // после перезагрузки модель на месте
  await page.reload();
  await modelReady(page);
  await menu(page, /Модели автомобилей/);
  const list = page.getByRole('dialog', { name: 'Модели автомобилей' });
  await expect(list.getByText('E2E Порше')).toBeVisible();
  // модель используется авто — удалить нельзя
  await expect(list.getByRole('button', { name: 'Удалить' })).toBeDisabled();
});
