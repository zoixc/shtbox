/**
 * Типы покрытия кузова: общий словарь для ядра, модели и интерфейса.
 *
 * Файл намеренно без зависимостей (в том числе без three), чтобы описания и валидация
 * использовались в `core` и в разметке моделей, а параметры шейдера жили в
 * `view3d/paintMaterial.ts`.
 */

export type PaintFinish = 'matte' | 'satin' | 'solid' | 'semi-gloss' | 'gloss' | 'metallic' | 'pearl';

/** Порядок в списках интерфейса: от матового к перламутру. */
export const PAINT_FINISHES: readonly PaintFinish[] = ['matte', 'satin', 'solid', 'semi-gloss', 'gloss', 'metallic', 'pearl'];

/** Покрытие по умолчанию для процедурных моделей и импорта без явного выбора. */
export const DEFAULT_FINISH: PaintFinish = 'gloss';

export const FINISH_LABEL: Record<PaintFinish, string> = {
  matte: 'Матовый',
  satin: 'Сатин (полуматовый)',
  solid: 'Акрил (неметаллик)',
  'semi-gloss': 'Полуглянцевый',
  gloss: 'Глянцевый',
  metallic: 'Металлик',
  pearl: 'Перламутр',
};

/** Короткое пояснение для интерфейса: как выглядит и где встречается. */
export const FINISH_HINT: Record<PaintFinish, string> = {
  matte: 'Без блика, шёлковая поверхность: плёнка, заводская матовая окраска.',
  satin: 'Лёгкий отблеск, популярен для импортных сканов: скрывает шумные нормали.',
  solid: 'Обычная однослойная эмаль без блёстки: недорогая перекраска, старые модели.',
  'semi-gloss': 'Умеренный блеск: компромисс между глянцем и сатином.',
  gloss: 'Классический автомобильный лак: резкие блики, глубокая поверхность.',
  metallic: 'С алюминиевой пудрой: искрится на солнце, самый частый заводской тип.',
  pearl: 'Перламутр: сдвиг оттенка в зависимости от угла обзора.',
};

export function isPaintFinish(v: unknown): v is PaintFinish {
  return typeof v === 'string' && (PAINT_FINISHES as readonly string[]).includes(v);
}
