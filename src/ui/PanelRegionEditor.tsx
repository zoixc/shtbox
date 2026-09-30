import { useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { PanelRegion, Profile } from '../import/types';
import { zonesFor } from '../import/zoneset';
import { Field } from './common';

const VIEW_W = 500;
const VIEW_H = 240;
const kindLabels: Record<'all' | 'paint' | 'glass' | 'trim', string> = {
  all: 'Краска, стекло и накладки', paint: 'Краска', glass: 'Стекло', trim: 'Накладки / прочее',
};

export function PanelRegionEditor(props: { profile: Profile; disabled?: boolean; onAdd: (regions: PanelRegion[]) => void; onDelete: (index: number) => void }) {
  const { profile } = props;
  const [projection, setProjection] = useState<'side' | 'top'>('side');
  const [zone, setZone] = useState('door_fl');
  const [side, setSide] = useState<'left' | 'right' | 'both'>('left');
  const [kind, setKind] = useState<'all' | 'paint' | 'glass' | 'trim'>('paint');
  const [draft, setDraft] = useState<[number, number][]>([]);
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
  const toData = (e: JSX.TargetedMouseEvent<SVGSVGElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    return [
      D.xRear + u * (D.xFront - D.xRear),
      projection === 'side' ? D.H * (1 - v) : D.W * (0.5 - v),
    ];
  };
  const addDraft = (e: JSX.TargetedMouseEvent<SVGSVGElement>) => {
    if (props.disabled || draft.length >= 64) return;
    setDraft((current) => [...current, toData(e)]);
  };
  const makeRegion = (): PanelRegion => ({
    zone,
    projection,
    side,
    ...(kind === 'all' ? {} : { kinds: [kind] as Array<'paint' | 'glass' | 'trim'> }),
    points: draft.map((p) => [p[0], p[1]]),
  });
  const save = (withMirror = false) => {
    if (draft.length < 3 || props.disabled || regions.length + (withMirror ? 2 : 1) > 48) return;
    const first = makeRegion();
    const result = [first];
    if (withMirror && !(projection === 'side' && side === 'both')) {
      const mirroredSide = side === 'left' ? 'right' : side === 'right' ? 'left' : 'both';
      result.push({
        ...first,
        side: mirroredSide,
        points: projection === 'top' ? first.points.map(([x, z]) => [x, -z]) : first.points.map(([x, y]) => [x, y]),
      });
    }
    props.onAdd(result);
    setDraft([]);
  };
  const displayRegions = regions.map((region, index) => ({ region, index })).filter(({ region }) => region.projection === projection);
  const draftSvg = draft.map(toSvg);
  const labelFor = (id: string) => zones.find((x) => x.id === id)?.label ?? id;

  return (
    <section class="panel-region-editor">
      <h4>Ручные маски панелей (приближённые)</h4>
      <p class="hint">Кликните по проекции, чтобы поставить вершины контура; нужно минимум три точки. Это ручная визуальная разметка, не заводской CAD-шов. Проверяйте результат в 3D.</p>
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
      <svg class="panel-draw" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={projection === 'side' ? 'Боковая проекция: клик добавляет точку' : 'Верхняя проекция: клик добавляет точку'} onClick={addDraft}>
        <rect x="0" y="0" width={VIEW_W} height={VIEW_H} rx="8" class="panel-draw-bg" />
        {Array.from({ length: 5 }, (_, i) => <line key={`grid-x-${i}`} x1={(VIEW_W * i) / 4} x2={(VIEW_W * i) / 4} y1="0" y2={VIEW_H} class="panel-draw-grid" />)}
        {Array.from({ length: 3 }, (_, i) => <line key={`grid-y-${i}`} x1="0" x2={VIEW_W} y1={(VIEW_H * i) / 2} y2={(VIEW_H * i) / 2} class="panel-draw-grid" />)}
        <text x="12" y="20" class="panel-draw-label">ЗАДНЯЯ ЧАСТЬ</text><text x={VIEW_W - 12} y="20" text-anchor="end" class="panel-draw-label">ПЕРЕД</text>
        {displayRegions.map(({ region, index }) => <polygon key={`saved-${index}`} points={region.points.map((p) => toSvg(p).join(',')).join(' ')} class="panel-draw-saved" />)}
        {draftSvg.length > 0 && <polyline points={draftSvg.map((p) => p.join(',')).join(' ')} class="panel-draw-draft" />}
        {draftSvg.map(([x, y], i) => <circle key={`point-${i}`} cx={x} cy={y} r="5" class="panel-draw-point" />)}
      </svg>
      <p class="hint">Точек: {draft.length}/64 · {projection === 'side' ? 'слева направо: задняя часть → перед автомобиля' : 'слева направо: задняя часть → перед автомобиля'}</p>
      <div class="form-actions">
        <button type="button" class="btn" disabled={props.disabled || !draft.length} onClick={() => setDraft((x) => x.slice(0, -1))}>Отменить точку</button>
        <button type="button" class="btn" disabled={props.disabled || !draft.length} onClick={() => setDraft([])}>Очистить контур</button>
        <button type="button" class="btn btn-primary" disabled={props.disabled || draft.length < 3 || regions.length >= 48} onClick={() => save(false)}>Добавить маску</button>
        <button type="button" class="btn" disabled={props.disabled || draft.length < 3 || regions.length > 46 || (projection === 'side' && side === 'both')} onClick={() => save(true)}>Добавить + зеркальную</button>
      </div>
      {displayRegions.length > 0 && (
        <div class="panel-region-list">
          {displayRegions.map(({ region, index }) => <div class="panel-region-row" key={index}>
            <span>{labelFor(region.zone)} · {region.side === 'left' ? 'левая' : region.side === 'right' ? 'правая' : 'обе'} · {region.kinds?.map((x) => kindLabels[x]).join(', ') ?? kindLabels.all}</span>
            <button type="button" class="btn btn-ghost" disabled={props.disabled} onClick={() => props.onDelete(index)}>Удалить</button>
          </div>)}
        </div>
      )}
    </section>
  );
}
