/**
 * Ручные маски панелей (P1, п. 8).
 *
 * Три способа задать контур: точки по клику, лассо (обвести мышью) и кисть (провести с радиусом).
 * Уже сохранённые маски можно объединять, вычитать, пересекать и зеркалить на другую сторону —
 * операции считает `src/import/maskOps.ts` (polygon-clipping, MIT).
 *
 * Это по-прежнему приближённая визуальная разметка, а не заводской CAD-шов: результат надо проверять в 3D.
 */
import { useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { mirrorRegion } from '../import/gizmo';
import { MAX_POINTS, cleanRing, intersectRegions, mergeRegions, ringArea, simplifyToLimit, strokeRing, subtractRegion } from '../import/maskOps';
import type { PanelRegion, Profile } from '../import/types';
import { zonesFor } from '../import/zoneset';
import { Field } from './common';

const VIEW_W = 500;
const VIEW_H = 240;
const kindLabels: Record<'all' | 'paint' | 'glass' | 'trim', string> = {
  all: 'Краска, стекло и накладки', paint: 'Краска', glass: 'Стекло', trim: 'Накладки / прочее',
};
const modeLabels: Record<'points' | 'lasso' | 'brush', string> = {
  points: 'Точки по клику', lasso: 'Лассо (обвести)', brush: 'Кисть',
};

export function PanelRegionEditor(props: {
  profile: Profile;
  disabled?: boolean;
  /** Полный список масок после правки — проще, чем отдельные add/delete: операции меняют список целиком. */
  onRegions: (regions: PanelRegion[]) => void;
}) {
  const { profile } = props;
  const [projection, setProjection] = useState<'side' | 'top'>('side');
  const [zone, setZone] = useState('door_fl');
  const [side, setSide] = useState<'left' | 'right' | 'both'>('left');
  const [kind, setKind] = useState<'all' | 'paint' | 'glass' | 'trim'>('paint');
  const [mode, setMode] = useState<'points' | 'lasso' | 'brush'>('points');
  const [brushRadius, setBrushRadius] = useState(0.06);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [stroke, setStroke] = useState<[number, number][]>([]);
  const [subject, setSubject] = useState(0);
  const [operand, setOperand] = useState(-1);
  const [status, setStatus] = useState('');
  const zones = useMemo(() => zonesFor(profile.body, profile.layout).filter((x) => x.layer === 'body' && !x.virtual && (x.paintable || x.id === 'windshield' || x.id === 'rear_glass')), [profile.body, profile.layout]);
  const regions = profile.panelRegions ?? [];
  const D = profile.dims;

  const toSvg = (p: readonly [number, number]): [number, number] => {
    const x = ((p[0] - D.xRear) / Math.max(0.01, D.xFront - D.xRear)) * VIEW_W;
    const y = projection === 'side'
      ? (1 - p[1] / Math.max(0.01, D.H)) * VIEW_H
      : (0.5 - p[1] / Math.max(0.01, D.W)) * VIEW_H;
    return [x, y];
  };
  const toData = (e: JSX.TargetedMouseEvent<SVGSVGElement> | JSX.TargetedPointerEvent<SVGSVGElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    return [
      D.xRear + u * (D.xFront - D.xRear),
      projection === 'side' ? D.H * (1 - v) : D.W * (0.5 - v),
    ];
  };
  const addDraft = (e: JSX.TargetedMouseEvent<SVGSVGElement>) => {
    if (props.disabled || mode !== 'points' || draft.length >= MAX_POINTS) return;
    setDraft((current) => [...current, toData(e)]);
  };
  const makeRegion = (points = draft): PanelRegion => ({
    zone,
    projection,
    side,
    ...(kind === 'all' ? {} : { kinds: [kind] as Array<'paint' | 'glass' | 'trim'> }),
    points: points.map((p) => [p[0], p[1]]),
  });
  const save = (withMirror = false) => {
    if (draft.length < 3 || props.disabled) return;
    const first = makeRegion();
    const result = [first];
    if (withMirror && !(projection === 'side' && side === 'both')) {
      const mirrored = mirrorRegion(first);
      if (mirrored) result.push(mirrored);
    }
    if (regions.length + result.length > 48) {
      setStatus('Больше 48 масок профиль не хранит — удалите лишние.');
      return;
    }
    props.onRegions([...regions, ...result]);
    setDraft([]);
    setOperatorAfterAdd(regions.length);
    setStatus(`Маска добавлена: ${result.length === 2 ? 'основная и зеркальная' : 'одна'}.`);
  };

  /** После добавления удобно сразу работать с новой маской. */
  const setOperatorAfterAdd = (index: number) => {
    setSubject(index);
    setOperand(-1);
  };

  // ---- лассо и кисть: указатель ведёт контур, отпускание фиксирует черновик
  const pointerDown = (e: JSX.TargetedPointerEvent<SVGSVGElement>) => {
    if (props.disabled || mode === 'points') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = toData(e);
    setStroke([point]);
    if (mode === 'lasso') setDraft([point]);
  };
  const pointerMove = (e: JSX.TargetedPointerEvent<SVGSVGElement>) => {
    if (props.disabled || mode === 'points' || !stroke.length) return;
    const point = toData(e);
    const last = stroke[stroke.length - 1];
    const minStep = mode === 'brush' ? brushRadius / 3 : 0.01;
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < minStep) return;
    const next = [...stroke, point];
    setStroke(next);
    if (mode === 'lasso') setDraft(next);
  };
  const pointerUp = () => {
    if (props.disabled || mode === 'points' || !stroke.length) return;
    if (mode === 'lasso') {
      const cleaned = simplifyToLimit(cleanRing(stroke), MAX_POINTS, 0.02);
      setDraft(cleaned.length >= 3 ? cleaned : []);
      setStatus(cleaned.length >= 3 ? `Лассо: ${cleaned.length} точек контура.` : 'Лассо слишком короткое — обведите область ещё раз.');
    } else {
      const ring = strokeRing(stroke, brushRadius);
      if (ring && ring.length >= 3) {
        setDraft(ring);
        setStatus(`Кисть: контур из ${ring.length} точек, радиус ${(brushRadius * 100).toFixed(0)} см.`);
      } else {
        setStatus('Проведите кистью по проекции.');
      }
    }
    setStroke([]);
  };

  // ---- операции над сохранёнными масками
  const runOp = (op: 'union' | 'subtract' | 'intersect' | 'mirror') => {
    const a = regions[subject];
    if (!a) {
      setStatus('Выберите основную маску.');
      return;
    }
    if (op === 'mirror') {
      const mirrored = mirrorRegion(a);
      if (!mirrored) {
        setStatus('Эта маска уже на обе стороны — зеркалить нечего.');
        return;
      }
      props.onRegions([...regions.slice(0, subject), mirrored, ...regions.slice(subject + 1)]);
      setStatus(`Маска №${subject + 1} перенесена на другую сторону.`);
      return;
    }
    const b = regions[operand];
    if (!b) {
      setStatus('Выберите вторую маску (или добавьте её в списке).');
      return;
    }
    const result = op === 'union' ? mergeRegions(a, b) : op === 'subtract' ? subtractRegion(a, b) : intersectRegions(a, b);
    if (!result) {
      setStatus('Операция неприменима: маски должны быть на одной панели, стороне и поверхности.');
      return;
    }
    const next = regions.filter((_, index) => index !== subject && index !== operand);
    const insertAt = Math.min(subject, next.length);
    next.splice(insertAt, 0, result.region);
    props.onRegions(next);
    setSubject(insertAt);
    setOperand(-1);
    const notes = [
      result.parts > 1 ? `частей: ${result.parts}, оставлена крупнейшая` : '',
      result.holes > 0 ? `отверстий: ${result.holes} — профиль хранит только внешний контур` : '',
    ].filter(Boolean);
    setStatus(`${op === 'union' ? 'Объединено' : op === 'subtract' ? 'Вычтено' : 'Пересечено'}: площадь ${ringArea(result.region.points).toFixed(2)} м²${notes.length ? ` (${notes.join('; ')})` : ''}.`);
  };

  const displayRegions = regions.map((region, index) => ({ region, index })).filter(({ region }) => region.projection === projection);
  const draftSvg = draft.map(toSvg);
  const strokeSvg = stroke.map(toSvg);
  const labelFor = (id: string) => zones.find((x) => x.id === id)?.label ?? id;

  return (
    <section class="panel-region-editor">
      <h4>Ручные маски панелей (приближённые)</h4>
      <p class="hint">
        Контур задаётся точками, лассо или кистью; сохранённые маски можно объединять, вычитать и зеркалить.
        Это ручная визуальная разметка, не заводской CAD-шов. Проверяйте результат в 3D.
      </p>
      <div class="row2">
        <Field label="Проекция">
          <select value={projection} disabled={props.disabled} onChange={(e) => { setProjection((e.target as HTMLSelectElement).value as 'side' | 'top'); setDraft([]); }}>
            <option value="side">Сбоку (X / Y)</option>
            <option value="top">Сверху (X / Z)</option>
          </select>
        </Field>
        <Field label="Панель / узел">
          <select value={zone} disabled={props.disabled} onChange={(e) => setZone((e.target as HTMLSelectElement).value)}>
            {zones.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </Field>
      </div>
      <div class="row2">
        <Field label="Сторона">
          <select value={side} disabled={props.disabled} onChange={(e) => setSide((e.target as HTMLSelectElement).value as typeof side)}>
            <option value="left">Левая</option><option value="right">Правая</option><option value="both">Обе стороны</option>
          </select>
        </Field>
        <Field label="Поверхность">
          <select value={kind} disabled={props.disabled} onChange={(e) => setKind((e.target as HTMLSelectElement).value as typeof kind)}>
            {Object.entries(kindLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </Field>
      </div>
      <div class="row2">
        <Field label="Способ">
          <select value={mode} disabled={props.disabled} onChange={(e) => { setMode((e.target as HTMLSelectElement).value as typeof mode); setStroke([]); setDraft([]); }}>
            {Object.entries(modeLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </Field>
        <Field label={`Радиус кисти: ${(brushRadius * 100).toFixed(0)} см`}>
          <input type="range" min="0.02" max="0.2" step="0.01" value={brushRadius} disabled={props.disabled || mode !== 'brush'} onInput={(e) => setBrushRadius(Number((e.target as HTMLInputElement).value))} />
        </Field>
      </div>
      <svg
        class="panel-draw"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={mode === 'points' ? 'Проекция: клик добавляет точку' : mode === 'lasso' ? 'Проекция: обведите область лассо' : 'Проекция: проведите кистью'}
        onClick={addDraft}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <rect x="0" y="0" width={VIEW_W} height={VIEW_H} rx="8" class="panel-draw-bg" />
        {Array.from({ length: 5 }, (_, i) => <line key={`grid-x-${i}`} x1={(VIEW_W * i) / 4} x2={(VIEW_W * i) / 4} y1="0" y2={VIEW_H} class="panel-draw-grid" />)}
        {Array.from({ length: 3 }, (_, i) => <line key={`grid-y-${i}`} x1="0" x2={VIEW_W} y1={(VIEW_H * i) / 2} y2={(VIEW_H * i) / 2} class="panel-draw-grid" />)}
        <text x="12" y="20" class="panel-draw-label">ЗАДНЯЯ ЧАСТЬ</text><text x={VIEW_W - 12} y="20" text-anchor="end" class="panel-draw-label">ПЕРЕД</text>
        {displayRegions.map(({ region, index }) => (
          <polygon key={`saved-${index}`} points={region.points.map((p) => toSvg(p).join(',')).join(' ')} class={`panel-draw-saved ${index === subject ? 'panel-draw-subject' : ''}`} />
        ))}
        {draftSvg.length > 0 && <polyline points={[...draftSvg, draftSvg[0]].map((p) => p.join(',')).join(' ')} class="panel-draw-draft" />}
        {strokeSvg.length > 1 && <polyline points={strokeSvg.map((p) => p.join(',')).join(' ')} class="panel-draw-stroke" />}
        {mode === 'points' && draftSvg.map(([x, y], i) => <circle key={`point-${i}`} cx={x} cy={y} r="5" class="panel-draw-point" />)}
      </svg>
      <p class="hint">
        Точек в контуре: {draft.length}/{MAX_POINTS} · площадь {(draft.length > 2 ? ringArea(draft) : 0).toFixed(2)} м² ·{' '}
        {mode === 'points' ? 'клик добавляет точку' : mode === 'lasso' ? 'обведите область при зажатой кнопке' : 'проведите кистью при зажатой кнопке'}
      </p>
      <div class="form-actions">
        <button type="button" class="btn" disabled={props.disabled || !draft.length} onClick={() => setDraft((x) => x.slice(0, -1))}>Отменить точку</button>
        <button type="button" class="btn" disabled={props.disabled || !draft.length} onClick={() => setDraft([])}>Очистить контур</button>
        <button type="button" class="btn btn-primary" disabled={props.disabled || draft.length < 3 || regions.length >= 48} onClick={() => save(false)}>Добавить маску</button>
        <button
          type="button"
          class="btn"
          disabled={props.disabled || draft.length < 3 || regions.length > 46 || (projection === 'side' && side === 'both')}
          onClick={() => save(true)}
        >
          Добавить + зеркальную
        </button>
      </div>

      {regions.length > 0 && (
        <>
          <h4>Готовые маски: операции</h4>
          <div class="row2">
            <Field label="Основная маска">
              <select value={String(subject)} disabled={props.disabled} onChange={(e) => setSubject(Number((e.target as HTMLSelectElement).value))}>
                {regions.map((region, index) => (
                  <option key={index} value={index}>
                    №{index + 1} · {labelFor(region.zone)} · {region.projection === 'side' ? 'сбоку' : 'сверху'} · {region.side === 'left' ? 'левая' : region.side === 'right' ? 'правая' : 'обе'} · {(ringArea(region.points)).toFixed(2)} м²
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Вторая маска (для операций)">
              <select value={String(operand)} disabled={props.disabled} onChange={(e) => setOperand(Number((e.target as HTMLSelectElement).value))}>
                <option value={-1}>не выбрана</option>
                {regions.map((region, index) => (
                  <option key={index} value={index}>№{index + 1} · {labelFor(region.zone)} · {region.projection === 'side' ? 'сбоку' : 'сверху'}</option>
                ))}
              </select>
            </Field>
          </div>
          <div class="form-actions">
            <button type="button" class="btn" disabled={props.disabled || operand < 0} onClick={() => runOp('union')}>∪ Объединить</button>
            <button type="button" class="btn" disabled={props.disabled || operand < 0} onClick={() => runOp('subtract')}>− Вычесть вторую</button>
            <button type="button" class="btn" disabled={props.disabled || operand < 0} onClick={() => runOp('intersect')}>∩ Пересечь</button>
            <button type="button" class="btn" disabled={props.disabled} onClick={() => runOp('mirror')}>⇄ Зеркалить основную</button>
          </div>
        </>
      )}
      {status && <p class="hint" role="status">{status}</p>}
      {displayRegions.length > 0 && (
        <div class="panel-region-list">
          {displayRegions.map(({ region, index }) => (
            <div class={`panel-region-row ${index === subject ? 'panel-region-on' : ''}`} key={index}>
              <span>
                №{index + 1} · {labelFor(region.zone)} · {region.side === 'left' ? 'левая' : region.side === 'right' ? 'правая' : 'обе'} ·{' '}
                {region.kinds?.map((x) => kindLabels[x]).join(', ') ?? kindLabels.all} · {region.points.length} точек
              </span>
              <button type="button" class="btn btn-ghost" disabled={props.disabled} onClick={() => { props.onRegions(regions.filter((_, i) => i !== index)); setSubject(0); setOperand(-1); }}>Удалить</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
