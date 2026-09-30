/**
 * Выбор краски: покрытие, цвет по коду из справочника и свои коды.
 *
 * Справочник (RAL + автомобильные названия) — см. `src/data/paintColors.ts`. Коды производителей
 * в открытом виде не лицензируются, поэтому их пользователь добавляет сам: свой код хранится
 * на устройстве и участвует в поиске.
 */
import { useMemo, useState } from 'preact/hooks';
import { FINISH_HINT, FINISH_LABEL, PAINT_FINISHES } from '../data/paintFinish';
import type { PaintFinish } from '../data/paintFinish';
import { searchColors } from '../data/paintSearch';
import type { CustomColor } from '../data/paintSearch';
import { paintLibrary, rememberColor } from '../state';

export interface PaintPickerProps {
  color: string;
  /** выбранное покрытие; null — «как у модели» */
  finish: PaintFinish | null;
  /** код краски, показывается в поисковой строке при открытии */
  code?: string;
  /** покрытие модели по умолчанию — подписываем пункт «как у модели» */
  defaultFinish?: PaintFinish;
  onColor: (hex: string) => void;
  onFinish: (finish: PaintFinish | null) => void;
  onCode: (code: string) => void;
}

export function PaintPicker(props: PaintPickerProps) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [customCode, setCustomCode] = useState('');
  const [customName, setCustomName] = useState('');
  const library = paintLibrary.value;
  const results = useMemo(() => searchColors(query, library, 36), [query, library]);
  const [group, setGroup] = useState<string>('Все');
  const shown = group === 'Все' ? results : results.filter((r) => (r.custom && group === 'Свои') || r.item.group === group);

  const choose = (hex: string, code?: string, name?: string) => {
    props.onColor(hex);
    props.onCode(code ?? name ?? '');
  };

  const saveCustom = async () => {
    const hex = props.color;
    const saved = await rememberColor({ code: customCode.trim() || undefined, name: customName.trim() || customCode.trim() || hex, hex });
    if (saved) {
      props.onCode(saved.code ?? saved.name);
      setAdding(false);
      setCustomCode('');
      setCustomName('');
    }
  };

  return (
    <div class="paint-picker">
      <div class="field">
        <span class="field-label">Покрытие</span>
        <div class="paint-finishes">
          <button
            type="button"
            class={`chip ${props.finish === null ? 'chip-on' : ''}`}
            title={props.defaultFinish ? `Покрытие модели: ${FINISH_LABEL[props.defaultFinish]}` : 'Покрытие по умолчанию'}
            onClick={() => props.onFinish(null)}
          >
            {props.defaultFinish ? `Как у модели · ${FINISH_LABEL[props.defaultFinish]}` : 'Как у модели'}
          </button>
          {PAINT_FINISHES.map((f) => (
            <button
              type="button"
              key={f}
              class={`chip ${props.finish === f ? 'chip-on' : ''}`}
              title={FINISH_HINT[f]}
              aria-pressed={props.finish === f}
              onClick={() => props.onFinish(f)}
            >
              {FINISH_LABEL[f]}
            </button>
          ))}
        </div>
        <span class="field-hint">
          {props.finish ? FINISH_HINT[props.finish] : 'Покрытие не задано: возьмём то, что настроено у самой модели.'}
        </span>
      </div>

      <div class="field">
        <span class="field-label">Цвет по коду или названию</span>
        <div class="paint-search">
          <input
            type="search"
            placeholder="RAL 9005, «белый», «металлик», #1f4e8c…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <input type="color" value={props.color} aria-label="Палитра" onInput={(e) => {
            const hex = (e.target as HTMLInputElement).value;
            props.onColor(hex);
            props.onCode(hex);
          }} />
        </div>
        {props.code && <span class="field-hint">Код: <b>{props.code}</b> · HEX <b>{props.color}</b></span>}
        {query.trim() === '' && <span class="field-hint">Поиск понимает код (RAL 9005), слово («белый», «графит») и тип покрытия («металлик»).</span>}
      </div>

      {results.length > 0 && (
        <>
          <div class="paint-groups">
            {['Все', 'RAL Classic', 'RAL Effect (металлики)', 'Автомобильные названия', 'Свои'].map((g) => (
              <button type="button" key={g} class={`chip ${group === g ? 'chip-on' : ''}`} onClick={() => setGroup(g)}>{g}</button>
            ))}
          </div>
          <div class="paint-results">
            {shown.map((r) => (
              <button
                type="button"
                key={`${r.item.group}:${r.item.code ?? ''}:${r.item.name}:${r.item.hex}`}
                class={`paint-row ${r.item.hex === props.color && (r.item.code ?? r.item.name) === props.code ? 'paint-row-on' : ''}`}
                onClick={() => choose(r.item.hex, r.item.code, r.item.name)}
              >
                <i style={{ background: r.item.hex }} />
                <span class="paint-row-name">{r.item.name}</span>
                <span class="paint-row-code">{r.item.code ?? r.item.group}{r.item.finish ? ` · ${FINISH_LABEL[r.item.finish]}` : ''}{r.custom ? ' · свой' : ''}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {query.trim() !== '' && results.length === 0 && (
        <span class="field-hint">Ничего не нашлось в справочнике. Добавьте свой код — он останется на этом устройстве.</span>
      )}

      {adding ? (
        <div class="paint-add">
          <input placeholder="Код (BMW 475, LC9Z…)" maxLength={24} value={customCode} onInput={(e) => setCustomCode((e.target as HTMLInputElement).value)} />
          <input placeholder="Название" maxLength={60} value={customName} onInput={(e) => setCustomName((e.target as HTMLInputElement).value)} />
          <button type="button" class="btn btn-primary" disabled={!customCode.trim() && !customName.trim()} onClick={() => void saveCustom()}>
            Запомнить «{props.color}»
          </button>
          <button type="button" class="btn btn-ghost" onClick={() => setAdding(false)}>Отмена</button>
        </div>
      ) : (
        <button type="button" class="btn btn-ghost paint-add-btn" onClick={() => { setAdding(true); setCustomCode(props.code ?? ''); }}>
          + Свой код краски (BMW 475, LC9Z…)
        </button>
      )}

      <span class="field-hint">
        Справочник: RAL Classic, металлики RAL Effect и общепринятые автомобильные названия
        (пакеты `ral-colors` и `@tclohm/car-colors`, MIT). Коды конкретных марок не публикуются открыто —
        их добавляют вручную, они хранятся на устройстве и не выгружаются в резервные копии.
      </span>
    </div>
  );
}

export type { CustomColor };
