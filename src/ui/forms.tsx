import { useState } from 'preact/hooks';
import { todayStr, isDateStr } from '../core/dates';
import { BODY_KINDS, ISSUE_KIND_LABEL, LOG_KIND_LABEL, PRIORITY_LABEL } from '../core/types';
import type { IssueKind, LogEntry, LogKind, MaintenanceTask } from '../core/types';
import type { Completion } from '../core/store';
import { activeModel, guard, store, ui, zoneLabel } from '../state';
import { parseNum } from '../util';
import { Field } from './common';

const KIND_ORDER: IssueKind[] = ['breakdown', 'todo', 'rust', 'dent', 'chip', 'scratch'];
const DEFAULT_R: Record<string, number> = { rust: 0.1, dent: 0.09, chip: 0.07, scratch: 0.14 };

export function ZoneSelect(props: { value: string; onChange: (v: string) => void }) {
  const zones = activeModel().zones;
  const groups = [...new Set(zones.map((z) => z.group))];
  return (
    <select value={props.value} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}>
      {groups.map((g) => (
        <optgroup label={g} key={g}>
          {zones.filter((z) => z.group === g).map((z) => (
            <option value={z.id} key={z.id}>{z.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Форма дефекта/доделки. Состояние — в ui.draft, чтобы 3D-модель показывала превью метки. */
export function IssueForm() {
  const d = ui.draft.value;
  if (!d) return null;
  const zone = activeModel().zones.find((z) => z.id === d.zoneId);
  const isBody = BODY_KINDS.includes(d.kind);
  const paintable = !!zone?.paintable;
  const set = (patch: Partial<typeof d>) => (ui.draft.value = { ...d, ...patch });

  const cancel = () => {
    ui.draft.value = null;
    ui.placing.value = false;
  };
  const save = async () => {
    const title = d.title.trim() || `${ISSUE_KIND_LABEL[d.kind]}: ${zoneLabel(d.zoneId)}`;
    const data = {
      zoneId: d.zoneId,
      kind: d.kind,
      title,
      notes: d.notes,
      priority: d.priority,
      cost: parseNum(d.cost),
      spot: isBody ? d.spot : undefined,
    };
    const ok = d.editId ? await guard(store.updateIssue(d.editId, data).then(() => true)) : await guard(store.addIssue(data).then(() => true));
    if (ok) cancel();
  };

  return (
    <form class="card form" onSubmit={(e) => (e.preventDefault(), void save())}>
      <h4>{d.editId ? 'Изменить запись' : 'Новая запись'}</h4>
      <div class="kind-row" role="radiogroup" aria-label="Тип записи">
        {KIND_ORDER.map((k) => (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={d.kind === k}
            class={`pill ${d.kind === k ? 'pill-on' : ''} kind-${k}`}
            onClick={() => set({ kind: k, spot: BODY_KINDS.includes(k) && d.spot ? { ...d.spot, r: DEFAULT_R[k] ?? d.spot.r } : d.spot })}
          >
            {ISSUE_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <Field label="Что нужно сделать / что сломалось">
        <input
          value={d.title}
          maxLength={120}
          placeholder={`${ISSUE_KIND_LABEL[d.kind]}: ${zoneLabel(d.zoneId)}`}
          onInput={(e) => set({ title: (e.target as HTMLInputElement).value })}
          autoFocus
        />
      </Field>
      <div class="row2">
        <Field label="Узел">
          <ZoneSelect value={d.zoneId} onChange={(v) => set({ zoneId: v, spot: undefined })} />
        </Field>
        <Field label="Важность">
          <select value={d.priority} onChange={(e) => set({ priority: Number((e.target as HTMLSelectElement).value) as 0 | 1 | 2 })}>
            {PRIORITY_LABEL.map((l, i) => (
              <option value={i} key={l}>{l}</option>
            ))}
          </select>
        </Field>
      </div>

      {isBody && (
        <div class="spot-box">
          {paintable ? (
            <>
              <div class="spot-head">
                <span>{d.spot ? 'Метка поставлена на кузове' : 'Место на кузове не указано'}</span>
                <div class="spot-actions">
                  <button type="button" class={`btn ${ui.placing.value ? 'btn-primary' : ''}`} onClick={() => (ui.placing.value = !ui.placing.value)}>
                    {ui.placing.value ? 'Отмена (Esc)' : d.spot ? 'Переставить' : 'Указать на модели'}
                  </button>
                  {d.spot && (
                    <button type="button" class="btn btn-ghost" onClick={() => set({ spot: undefined })}>
                      Убрать
                    </button>
                  )}
                </div>
              </div>
              {d.spot && (
                <label class="slider">
                  <span>Размер: {Math.round(d.spot.r * 200)} см</span>
                  <input
                    type="range"
                    min="0.02"
                    max="0.3"
                    step="0.005"
                    value={d.spot.r}
                    onInput={(e) => {
                      const r = Number((e.target as HTMLInputElement).value);
                      ui.radius.value = r;
                      set({ spot: { ...d.spot!, r } });
                    }}
                  />
                </label>
              )}
            </>
          ) : (
            <p class="hint">Для этого узла метка на модели недоступна — запись сохранится в списке узла.</p>
          )}
        </div>
      )}

      <div class="row2">
        <Field label="Ориентир. стоимость, ₽">
          <input inputMode="decimal" value={d.cost} onInput={(e) => set({ cost: (e.target as HTMLInputElement).value })} placeholder="необязательно" />
        </Field>
      </div>
      <Field label="Заметки">
        <textarea rows={2} maxLength={4000} value={d.notes} onInput={(e) => set({ notes: (e.target as HTMLTextAreaElement).value })} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Сохранить</button>
        <button type="button" class="btn btn-ghost" onClick={cancel}>Отмена</button>
      </div>
    </form>
  );
}

/** «Выполнено»: дата, пробег, стоимость, комментарий. */
export function CompleteForm(props: { label: string; defaultCost?: number; onSubmit: (c: Completion) => Promise<unknown>; onCancel: () => void }) {
  const car = store.activeCar.value!;
  const [date, setDate] = useState(todayStr());
  const [km, setKm] = useState(String(car.mileage));
  const [cost, setCost] = useState(props.defaultCost !== undefined ? String(props.defaultCost) : '');
  const [notes, setNotes] = useState('');
  return (
    <form
      class="card form inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!isDateStr(date)) return;
        void props.onSubmit({ date, mileage: parseNum(km), cost: parseNum(cost), notes: notes.trim() || undefined });
      }}
    >
      <div class="row3">
        <Field label="Дата">
          <input type="date" value={date} max={todayStr()} required onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Пробег, км">
          <input inputMode="numeric" value={km} onInput={(e) => setKm((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Стоимость, ₽">
          <input inputMode="decimal" value={cost} onInput={(e) => setCost((e.target as HTMLInputElement).value)} placeholder="0" />
        </Field>
      </div>
      <Field label="Комментарий (что сделано, детали, запчасти)">
        <input value={notes} maxLength={4000} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />
      </Field>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">{props.label}</button>
        <button class="btn btn-ghost" type="button" onClick={props.onCancel}>Отмена</button>
      </div>
    </form>
  );
}

export function TaskForm(props: { task?: MaintenanceTask; zoneId: string; onDone: () => void }) {
  const t = props.task;
  const [title, setTitle] = useState(t?.title ?? '');
  const [zoneId, setZone] = useState(t?.zoneId ?? props.zoneId);
  const [everyKm, setEveryKm] = useState(t?.everyKm ? String(t.everyKm) : '');
  const [everyMonths, setEveryMonths] = useState(t?.everyMonths ? String(t.everyMonths) : '');
  const [lastDate, setLastDate] = useState(t?.lastDate ?? '');
  const [lastKm, setLastKm] = useState(t?.lastKm !== undefined ? String(t.lastKm) : '');
  const [notes, setNotes] = useState(t?.notes ?? '');
  const [err, setErr] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    const km = parseNum(everyKm);
    const mo = parseNum(everyMonths);
    if (!title.trim()) return setErr('Укажите название работы');
    if (!km && !mo) return setErr('Задайте периодичность: по пробегу и/или по времени');
    if (lastDate && !isDateStr(lastDate)) return setErr('Некорректная дата');
    const data = {
      title: title.trim(), zoneId, notes,
      everyKm: km ? Math.round(km) : undefined,
      everyMonths: mo ? Math.round(mo) : undefined,
      lastDate: lastDate || undefined,
      lastKm: parseNum(lastKm),
    };
    const ok = t ? await guard(store.updateTask(t.id, data).then(() => true)) : await guard(store.addTask(data).then(() => true));
    if (ok) props.onDone();
  };

  return (
    <form class="card form" onSubmit={submit}>
      <h4>{t ? 'Изменить регламент' : 'Новая регламентная работа'}</h4>
      <Field label="Название">
        <input value={title} maxLength={120} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder="Замена масла в КПП" autoFocus />
      </Field>
      <Field label="Узел">
        <ZoneSelect value={zoneId} onChange={setZone} />
      </Field>
      <div class="row2">
        <Field label="Каждые, км">
          <input inputMode="numeric" value={everyKm} onInput={(e) => setEveryKm((e.target as HTMLInputElement).value)} placeholder="15000" />
        </Field>
        <Field label="Каждые, мес.">
          <input inputMode="numeric" value={everyMonths} onInput={(e) => setEveryMonths((e.target as HTMLInputElement).value)} placeholder="12" />
        </Field>
      </div>
      <div class="row2">
        <Field label="Последний раз: дата">
          <input type="date" value={lastDate} max={todayStr()} onInput={(e) => setLastDate((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Последний раз: пробег">
          <input inputMode="numeric" value={lastKm} onInput={(e) => setLastKm((e.target as HTMLInputElement).value)} />
        </Field>
      </div>
      <Field label="Заметки">
        <input value={notes} maxLength={4000} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />
      </Field>
      {err && <p class="form-error">{err}</p>}
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Сохранить</button>
        <button class="btn btn-ghost" type="button" onClick={props.onDone}>Отмена</button>
      </div>
    </form>
  );
}

const LOG_KINDS: LogKind[] = ['maintenance', 'repair', 'todo', 'bodywork', 'other'];

/** Ручная запись в журнал (выполненная работа, которой не было в списке). */
export function LogForm(props: { log?: LogEntry; zoneId: string; onDone: () => void }) {
  const l = props.log;
  const car = store.activeCar.value!;
  const [title, setTitle] = useState(l?.title ?? '');
  const [zoneId, setZone] = useState(l?.zoneId ?? props.zoneId);
  const [kind, setKind] = useState<LogKind>(l?.kind ?? 'repair');
  const [date, setDate] = useState(l?.date ?? todayStr());
  const [km, setKm] = useState(l?.mileage !== undefined ? String(l.mileage) : String(car.mileage));
  const [cost, setCost] = useState(l?.cost !== undefined ? String(l.cost) : '');
  const [notes, setNotes] = useState(l?.notes ?? '');
  const [err, setErr] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!title.trim()) return setErr('Укажите, что было сделано');
    if (!isDateStr(date)) return setErr('Некорректная дата');
    const data = { title: title.trim(), zoneId, kind, date, mileage: parseNum(km), cost: parseNum(cost), notes };
    const ok = l ? await guard(store.updateLog(l.id, data).then(() => true)) : await guard(store.addLog(data).then(() => true));
    if (ok) props.onDone();
  };
  return (
    <form class="card form" onSubmit={submit}>
      <h4>{l ? 'Изменить запись журнала' : 'Выполненная работа'}</h4>
      <Field label="Что сделано">
        <input value={title} maxLength={120} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} autoFocus />
      </Field>
      <div class="row2">
        <Field label="Узел">
          <ZoneSelect value={zoneId} onChange={setZone} />
        </Field>
        <Field label="Тип">
          <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as LogKind)}>
            {LOG_KINDS.map((k) => (
              <option value={k} key={k}>{LOG_KIND_LABEL[k]}</option>
            ))}
          </select>
        </Field>
      </div>
      <div class="row3">
        <Field label="Дата">
          <input type="date" value={date} max={todayStr()} required onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Пробег, км">
          <input inputMode="numeric" value={km} onInput={(e) => setKm((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Стоимость, ₽">
          <input inputMode="decimal" value={cost} onInput={(e) => setCost((e.target as HTMLInputElement).value)} />
        </Field>
      </div>
      <Field label="Заметки">
        <input value={notes} maxLength={4000} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />
      </Field>
      {err && <p class="form-error">{err}</p>}
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Сохранить</button>
        <button class="btn btn-ghost" type="button" onClick={props.onDone}>Отмена</button>
      </div>
    </form>
  );
}

export function startDraft(zoneId: string, kind: IssueKind = 'breakdown'): void {
  ui.draft.value = { zoneId, kind, title: '', notes: '', priority: 0, cost: '' };
}
