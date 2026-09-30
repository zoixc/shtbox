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

  // Салон: авторазбор отчитывается, режим подстановки переключается.
  await expect(wiz.locator('.auto-notes')).toContainText('Авторазбор');
  const interior = wiz.getByLabel('Что делать с салоном');
  await expect(interior).toHaveValue('fill');
  await interior.selectOption('model');
  await expect(interior).toHaveValue('model');
  await interior.selectOption('fill');

  // Панели: выбор панели, ручная петля (режим «указать») и открытие для проверки.
  await wiz.getByRole('tab', { name: 'Панели' }).click();
  const editor = wiz.locator('.panel-editor');
  await expect(editor).toBeVisible();
  const doorChip = editor.locator('.panel-chips .chip').filter({ hasText: 'Дверь передняя левая' });
  await expect(doorChip).toHaveCount(1);
  await doorChip.click();
  await expect(doorChip).toHaveClass(/chip-on/);
  // Поля петли появляются после первой сборки предпросмотра.
  await expect(editor.locator('.hinge-fields')).toBeVisible({ timeout: 120_000 });
  await editor.getByRole('button', { name: 'Открыть эту панель для проверки' }).click();
  await editor.locator('.hinge-fields .field').first().getByRole('button', { name: 'указать' }).click();
  await expect(wiz.locator('.armed-hint')).toBeVisible();
  await wiz.locator('.armed-hint').getByRole('button', { name: 'Отменить' }).click();
  await expect(wiz.locator('.armed-hint')).toHaveCount(0);
  // Кромку панели можно сдвинуть: значение ползунка меняется и профиль помечается как правленый вручную.
  const doorEdge = editor.locator('.lines .field').first().locator('input[type=range]');
  const before = await doorEdge.inputValue();
  await doorEdge.evaluate((el: HTMLInputElement) => {
    el.value = String(Number(el.value) - 0.1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(doorEdge).not.toHaveValue(before);

  // Краска: покрытие и цвет по коду из справочника.
  await wiz.getByRole('tab', { name: 'Краска' }).click();
  // точное совпадение: «Акрил (неметаллик)» тоже содержит подстроку «металлик»
  await wiz.locator('.paint-finishes .chip').filter({ hasText: /^Металлик$/ }).click();
  await expect(wiz.locator('.paint-finishes .chip-on')).toHaveText(/Металлик/);
  await wiz.locator('.paint-search input[type=search]').fill('RAL 9005');
  await wiz.locator('.paint-row').filter({ hasText: 'Jet black' }).first().click();
  await expect(wiz.locator('.paint-picker .field-hint').filter({ hasText: 'RAL 9005' })).toBeVisible();

  await wiz.getByRole('tab', { name: 'Готово' }).click();
  await wiz.getByLabel('Название модели').fill('E2E BMW import');
  await wiz.getByRole('button', { name: 'Сохранить и использовать' }).click();

  // Вернулись в диалог авто с выбранной моделью.
  await expect(wiz).toBeHidden();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Модель (3D)').locator('option:checked')).toHaveText('E2E BMW import');
  await dlg.getByLabel('Название').fill('Тестовый BMW');
  // Код краски: справочный и свой, коды марок хранятся только на устройстве.
  await dlg.locator('.paint-finishes .chip').filter({ hasText: /^Металлик$/ }).click();
  await dlg.locator('.paint-search input[type=search]').fill('RAL 9005');
  await dlg.locator('.paint-row').filter({ hasText: 'Jet black' }).first().click();
  await dlg.getByRole('button', { name: '+ Свой код краски (BMW 475, LC9Z…)' }).click();
  await dlg.getByPlaceholder('Код (BMW 475, LC9Z…)').fill('BMW 475');
  await dlg.getByRole('button', { name: /Запомнить/ }).click();
  await expect(dlg.locator('.paint-picker .field-hint').filter({ hasText: 'BMW 475' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Создать' }).click();
  await modelReady(page);

  // Узлы открываются и соответствуют выбранному типу кузова.
  await page.getByRole('button', { name: 'Открыть двери, капот, багажник' }).click();
  await expect(page.getByRole('menuitem', { name: /Капот/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Дверь/ }).first()).toBeVisible();
  if (body === 'coupe') await expect(page.getByRole('menuitem', { name: /Дверь зад/ })).toHaveCount(0);
  else await expect(page.getByRole('menuitem', { name: /Дверь зад/ })).toHaveCount(2);
  await page.keyboard.press('Escape');

  // Стёкла импортированной модели опускаются без резки геометрии (см. docs/ADDING_MODELS.md).
  const glassMenu = page.getByRole('button', { name: 'Опустить стёкла дверей' });
  await expect(glassMenu).toBeVisible();
  await glassMenu.click();
  await page.getByRole('menuitem', { name: 'Опустить все' }).click();
  await expect(glassMenu).toHaveText(/Стёкла опущены/);
  await glassMenu.click();
  await page.getByRole('menuitem', { name: 'Поднять все' }).click();
  await expect(glassMenu).toHaveText(/Стёкла/);

  // После перезагрузки пользовательская модель остаётся в локальном хранилище.
  await page.reload();
  await modelReady(page);
  await menu(page, /Модели автомобилей/);
  const list = page.getByRole('dialog', { name: 'Модели автомобилей' });
  await expect(list.getByText('E2E BMW import')).toBeVisible();
  // Модель используется авто — удалить нельзя.
  await expect(list.getByRole('button', { name: 'Удалить' })).toBeDisabled();
  await list.locator('.form-actions').getByRole('button', { name: 'Закрыть' }).click();

  // Цвет и покрытие автомобиля пережили перезагрузку, а свой код остался в библиотеке.
  await menu(page, /Изменить автомобиль/);
  const edit = page.getByRole('dialog', { name: 'Автомобиль' });
  await expect(edit.locator('.paint-finishes .chip-on')).toHaveText('Металлик');
  await expect(edit.locator('.field-hint').filter({ hasText: 'BMW 475' })).toBeVisible();
});
