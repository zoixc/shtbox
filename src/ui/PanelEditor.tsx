/**
 * Ручная правка кузовных панелей: где проходят кромки (линии разреза) и где петли.
 *
 * Значения берутся из авторазбора, пока пользователь их не поправил (`Profile.hinges` / `Profile.lines`).
 * Любую координату можно указать прямо на 3D-модели: кнопка «указать» включает режим, в котором
 * следующий клик по кузову задаёт значение.
 */
import { LINE_KIND, mirrorZone } from '../import/gizmo';
import type { HingeOverride, Lines, Profile } from '../import/types';
import { zonesFor } from '../import/zoneset';
import { Field } from './common';

export type ArmTarget =
  | { kind: 'hinge'; zone: string; axis: 0 | 1 | 2 }
  | { kind: 'line'; key: keyof Lines };

/** Что тянем в 3D гизмо: точка петли (по одной оси) или плоскость реза. */
export type DragTarget =
  | { kind: 'hinge'; zone: string; axis: 0 | 1 | 2 }
  | { kind: 'line'; key: keyof Lines };

export interface HingeView {
  x: number;
  y: number;
  z: number;
  angle: number;
  axis: 'x' | 'y' | 'z';
}

/** Подписи линий; тип координаты берётся из `LINE_KIND` (`src/import/gizmo.ts`), чтобы он был один на проект. */
const LINE_LABELS: Record<keyof Lines, string> = {
  bumperFront: 'Передний бампер: передняя кромка',
  cowl: 'Капот ↔ лобовое стекло',
  doorFront: 'Передний край двери',
  roofFront: 'Передняя кромка крыши',
  doorSplit: 'Стык передней и задней двери',
  roofRear: 'Задняя кромка крыши',
  doorRear: 'Задний край двери',
  trunkFront: 'Крышка багажника: передняя кромка',
  bumperRear: 'Задний бампер: задняя кромка',
  sill: 'Порог (высота)',
  belt: 'Линия окон (высота)',
  bumperTopF: 'Верх переднего бампера',
  bumperTopR: 'Верх заднего бампера',
  hoodHw: 'Половина ширины капота',
  trunkHw: 'Половина ширины крышки',
};
const LINE_META: Record<keyof Lines, { label: string; type: 'x' | 'y' | 'w' }> =
  Object.fromEntries(Object.entries(LINE_LABELS).map(([k, label]) => [k, { label, type: LINE_KIND[k as keyof Lines] }])) as Record<keyof Lines, { label: string; type: 'x' | 'y' | 'w' }>;

/** Какие линии управляют выбранной панелью. */
export function linesFor(zone: string, body: string): (keyof Lines)[] {
  if (zone === 'hood') return ['cowl', 'bumperTopF', 'hoodHw'];
  if (zone === 'trunk') return ['trunkFront', 'roofRear', 'bumperRear', 'bumperTopR', 'trunkHw'];
  const keys: (keyof Lines)[] = ['doorFront', 'doorRear', 'belt', 'sill'];
  if (body !== 'coupe') keys.splice(1, 0, 'doorSplit');
  return keys;
}

const AXES: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
const AXIS_HINT = ['вдоль кузова', 'вертикальная', 'поперёк кузова'];

export function PanelEditor(props: {
  profile: Profile;
  disabled?: boolean;
  /** выбранная открывающаяся панель (узел) */
  zone: string;
  onZone: (zone: string) => void;
  /** текущее положение петли: из профиля или посчитанное сборщиком модели */
  hinge: HingeView | null;
  onHinge: (patch: HingeOverride) => void;
  onResetHinge: () => void;
  onLine: (key: keyof Lines, value: number) => void;
  armed: ArmTarget | null;
  onArm: (target: ArmTarget | null) => void;
  /** активное перетаскивание гизмо в 3D */
  drag: DragTarget | null;
  onDrag: (target: DragTarget | null) => void;
  /** перенести разметку панели на парную сторону (слева ↔ справа) */
  onMirror: () => void;
  onCheckOpen: () => void;
}) {
  const { profile, hinge } = props;
  const panels = zonesFor(profile.body, profile.layout).filter((z) => z.openable);
  const override = profile.hinges?.[props.zone];
  const D = profile.dims;
  const bound = (type: 'x' | 'y' | 'w'): [number, number] =>
    type === 'x' ? [D.xRear, D.xFront] : type === 'y' ? [0, D.H] : [0.2, D.W / 2];
  const armedHinge = (axis: number) => props.armed?.kind === 'hinge' && props.armed.zone === props.zone && props.armed.axis === axis;
  const armedLine = (key: keyof Lines) => props.armed?.kind === 'line' && props.armed.key === key;
  const dragHinge = (axis: number) => props.drag?.kind === 'hinge' && props.drag.zone === props.zone && props.drag.axis === axis;
  const dragLine = (key: keyof Lines) => props.drag?.kind === 'line' && props.drag.key === key;
  const pair = mirrorZone(props.zone);

  return (
    <section class="panel-editor">
      <h4>Панели и петли</h4>
      <p class="hint">
        Если капот, двери и крышка багажника лежат в модели отдельными деталями, они открываются по своим кромкам —
        тогда ничего настраивать не нужно. Иначе кузов режется по линиям ниже: подвиньте их или укажите прямо на модели.
      </p>
      <div class="panel-chips">
        {panels.map((z) => (
          <button
            key={z.id}
            type="button"
            class={`chip ${props.zone === z.id ? 'chip-on' : ''}`}
            disabled={props.disabled}
            onClick={() => props.onZone(z.id)}
          >
            {z.label}
          </button>
        ))}
        {pair && (
          <button type="button" class="chip chip-ghost" disabled={props.disabled} onClick={props.onMirror} title={`Скопировать петлю и маски на «${pair}»`}>
            ⇄ зеркалить на «{pair}»
          </button>
        )}
      </div>

      {!hinge && <p class="hint">Петли появятся после сборки предпросмотра.</p>}
      {hinge && (
        <div class="hinge-fields">
          <div class="hinge-head">
            <b>Петля: {override ? 'задана вручную' : 'авто по кромке детали'}</b>
            <button type="button" class="btn btn-ghost" disabled={props.disabled || !override} onClick={props.onResetHinge}>
              Сбросить
            </button>
          </div>
          {AXES.map((axis, index) => {
            const value = axis === 'x' ? hinge.x : axis === 'y' ? hinge.y : hinge.z;
            const [lo, hi] = axis === 'x' ? [D.xRear, D.xFront] : axis === 'y' ? [0, D.H] : [-D.W / 2, D.W / 2];
            return (
              <label class="field" key={axis}>
                <span class="field-label">
                  {axis.toUpperCase()} ({AXIS_HINT[index]}): {value.toFixed(2)} м
                </span>
                <div class="row-inline">
                  <input
                    type="range" min={lo} max={hi} step="0.01" value={value} disabled={props.disabled}
                    onInput={(e) => props.onHinge({ [axis]: Number((e.target as HTMLInputElement).value) })}
                  />
                  <button
                    type="button"
                    class={`btn ${armedHinge(index) ? 'btn-primary' : ''}`}
                    disabled={props.disabled}
                    onClick={() => props.onArm(armedHinge(index) ? null : { kind: 'hinge', zone: props.zone, axis: index as 0 | 1 | 2 })}
                  >
                    указать
                  </button>
                  <button
                    type="button"
                    class={`btn ${dragHinge(index) ? 'btn-primary' : ''}`}
                    disabled={props.disabled}
                    title="Потянуть эту координату гизмо прямо в 3D"
                    onClick={() => props.onDrag(dragHinge(index) ? null : { kind: 'hinge', zone: props.zone, axis: index as 0 | 1 | 2 })}
                  >
                    тянуть
                  </button>
                </div>
              </label>
            );
          })}
          <div class="row2">
            <Field label="Ось шарнира" hint="Авто: двери — вертикальная, капот и крышка — поперёк.">
              <select
                value={override?.axis ?? ''}
                disabled={props.disabled}
                onChange={(e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  props.onHinge({ axis: value === '' ? undefined : (value as 'x' | 'y' | 'z') });
                }}
              >
                <option value="">Авто</option>
                <option value="x">X — вдоль кузова</option>
                <option value="y">Y — вертикальная (двери)</option>
                <option value="z">Z — поперёк (капот, багажник)</option>
              </select>
            </Field>
            <Field label={`Угол открытия: ${((((override?.angle ?? hinge.angle) * 180) / Math.PI)).toFixed(0)}°`}>
              <input
                type="range" min={-2} max={2} step="0.05" value={override?.angle ?? hinge.angle} disabled={props.disabled}
                onInput={(e) => props.onHinge({ angle: Number((e.target as HTMLInputElement).value) })}
              />
            </Field>
          </div>
          <button type="button" class="btn" disabled={props.disabled} onClick={props.onCheckOpen}>
            Открыть эту панель для проверки
          </button>
        </div>
      )}

      <h4>Кромки панели</h4>
      <div class="lines">
        {linesFor(props.zone, profile.body).map((key) => {
          const [lo, hi] = bound(LINE_META[key].type);
          return (
            <label class="field" key={key}>
              <span class="field-label">
                {LINE_META[key].label}: {profile.lines[key].toFixed(2)} м
              </span>
              <div class="row-inline">
                <input
                  type="range" min={lo} max={hi} step="0.01" value={profile.lines[key]} disabled={props.disabled}
                  onInput={(e) => props.onLine(key, Number((e.target as HTMLInputElement).value))}
                />
                <button
                  type="button"
                  class={`btn ${armedLine(key) ? 'btn-primary' : ''}`}
                  disabled={props.disabled}
                  onClick={() => props.onArm(armedLine(key) ? null : { kind: 'line', key })}
                >
                  указать
                </button>
                <button
                  type="button"
                  class={`btn ${dragLine(key) ? 'btn-primary' : ''}`}
                  disabled={props.disabled}
                  title="Потянуть плоскость реза прямо в 3D"
                  onClick={() => props.onDrag(dragLine(key) ? null : { kind: 'line', key })}
                >
                  тянуть
                </button>
              </div>
            </label>
          );
        })}
      </div>
      <p class="hint">
        «Указать» включает режим: следующий клик по кузову задаст значение (для линий по X — координата вперёд,
        для высоты — по вертикали, для ширины — расстояние от оси). «Тянуть» включает гизмо: двигайте оранжевую
        ручку в 3D, плоскость реза показывается на месте. Затем проверьте зазор, открыв панель.
        {pair && ` «Зеркалить» переносит петлю и маски этой панели на «${pair}».`}
      </p>
    </section>
  );
}
