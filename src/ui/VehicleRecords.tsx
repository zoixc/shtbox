import { useState } from 'preact/hooks';
import { formatDate, todayStr } from '../core/dates';
import { parseObdReport } from '../core/obd';
import type { InspectionItem, InspectionState, DateStr } from '../core/types';
import { activeModel, guard, store, toast } from '../state';
import { fmtKm } from '../util';
import { Chip, ConfirmButton, Empty, Field } from './common';
import { Photos } from './Photos';

const CHECKLIST: Array<{ title: string; zoneId: string }> = [
  { title: 'Кузов: видимые повреждения и коррозия', zoneId: 'bumper_f' },
  { title: 'Стёкла и обзорность', zoneId: 'windshield' },
  { title: 'Шины и колёса: видимый осмотр', zoneId: 'wheel_fl' },
  { title: 'Наружное освещение и сигналы', zoneId: 'lights_f' },
  { title: 'Подкапотное пространство: видимые утечки', zoneId: 'engine_bay' },
  { title: 'Тормоза: замечания по работе / внешнему осмотру', zoneId: 'brakes_f' },
  { title: 'Салон и предупреждающие индикаторы', zoneId: 'dashboard' },
  { title: 'Подвеска и днище (при безопасном доступе)', zoneId: 'susp_f' },
];
const STATE_LABEL: Record<InspectionState, string> = { ok: 'Без замечаний', watch: 'Наблюдать', repair: 'Требуется ремонт' };

function blankItems(): InspectionItem[] {
  const model = activeModel();
  return CHECKLIST.map((item, index) => ({
    id: `check-${index + 1}`,
    title: item.title,
    zoneId: model.zones.some((z) => z.id === item.zoneId) ? item.zoneId : 'general',
    state: 'ok',
    notes: '',
  }));
}

export function InspectionsPanel() {
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState<DateStr>(todayStr());
  const [mileage, setMileage] = useState('');
  const [title, setTitle] = useState('Плановый осмотр');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<InspectionItem[]>(blankItems);
  const inspections = store.carInspections.value;

  const begin = () => {
    setDate(todayStr());
    setMileage(String(store.activeCar.value?.mileage ?? ''));
    setTitle('Плановый осмотр');
    setNotes('');
    setItems(blankItems());
    setAdding((x) => !x);
  };
  const updateItem = (index: number, patch: Partial<InspectionItem>) => setItems((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  const submit = async (e: Event) => {
    e.preventDefault();
    const km = mileage.trim() ? Number(mileage) : undefined;
    if (km !== undefined && (!Number.isFinite(km) || km < 0 || km > 5_000_000)) return toast('Некорректный пробег осмотра.', 'err');
    const saved = await guard(store.addInspection({ date, mileage: km, title, notes, items }));
    if (saved) setAdding(false);
  };
  const createIssue = async (inspectionId: string, inspectionTitle: string, item: InspectionItem) => {
    const issue = await guard(store.addIssue({
      zoneId: item.zoneId,
      kind: 'breakdown',
      title: item.title,
      notes: item.notes || `Создано по результату осмотра «${inspectionTitle}».`,
      priority: 1,
      inspectionId,
    }));
    if (issue) toast('Дефект создан и связан с осмотром.');
  };

  return (
    <section class="section records-panel">
      <header class="section-head">
        <h3>Осмотры <span class="count">{inspections.length}</span></h3>
        <button type="button" class="btn btn-primary" onClick={begin}>{adding ? 'Отмена' : '+ Осмотр'}</button>
      </header>
      <p class="field-hint">Чек-лист помогает зафиксировать наблюдения и фотографии; это не техническое заключение и не замена профессиональной диагностике.</p>
      {adding && (
        <form class="form inspection-form" onSubmit={submit}>
          <div class="row2">
            <Field label="Название"><input value={title} maxLength={120} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} required /></Field>
            <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value as DateStr)} required /></Field>
          </div>
          <Field label="Пробег, км"><input type="number" min="0" max="5000000" step="1" value={mileage} onInput={(e) => setMileage((e.target as HTMLInputElement).value)} /></Field>
          <div class="inspection-checklist">
            {items.map((item, index) => <div class="inspection-edit-row" key={item.id}>
              <b>{item.title}</b>
              <select aria-label={`Статус: ${item.title}`} value={item.state} onChange={(e) => updateItem(index, { state: (e.target as HTMLSelectElement).value as InspectionState })}>
                <option value="ok">{STATE_LABEL.ok}</option><option value="watch">{STATE_LABEL.watch}</option><option value="repair">{STATE_LABEL.repair}</option>
              </select>
              <input aria-label={`Примечание: ${item.title}`} value={item.notes} maxLength={1000} placeholder="Примечание (необязательно)" onInput={(e) => updateItem(index, { notes: (e.target as HTMLInputElement).value })} />
            </div>)}
          </div>
          <Field label="Общие заметки"><textarea rows={3} maxLength={4000} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} /></Field>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Сохранить осмотр</button><button type="button" class="btn btn-ghost" onClick={() => setAdding(false)}>Отмена</button></div>
        </form>
      )}
      {!inspections.length ? <Empty>Осмотров пока нет.</Empty> : (
        <div class="record-list">
          {inspections.map((inspection) => {
            const repairCount = inspection.items.filter((x) => x.state === 'repair').length;
            const watchCount = inspection.items.filter((x) => x.state === 'watch').length;
            return <details class="record-card" key={inspection.id}>
              <summary><b>{inspection.title}</b><span>{formatDate(inspection.date)}{inspection.mileage !== undefined ? ` · ${fmtKm(inspection.mileage)}` : ''} · {repairCount} к ремонту · {watchCount} наблюдать</span></summary>
              {inspection.notes && <p class="item-notes">{inspection.notes}</p>}
              <div class="inspection-results">
                {inspection.items.map((item) => {
                  const linked = store.carIssues.value.some((issue) => issue.inspectionId === inspection.id && issue.zoneId === item.zoneId && issue.title === item.title);
                  return <div class="inspection-result" key={item.id}>
                    <div><Chip tone={item.state === 'repair' ? 'red' : item.state === 'watch' ? 'amber' : 'green'}>{STATE_LABEL[item.state]}</Chip> <b>{item.title}</b><span class="item-meta"> · {item.zoneId}</span>
                      {item.notes && <p class="item-notes">{item.notes}</p>}
                    </div>
                    {item.state === 'repair' && (linked ? <Chip tone="blue">Связанный дефект создан</Chip> : <button type="button" class="btn btn-ghost" onClick={() => void createIssue(inspection.id, inspection.title, item)}>Создать дефект</button>)}
                  </div>;
                })}
              </div>
              <div class="inspection-photo-pair">
                <div><span class="field-label">До</span><Photos type="inspection" id={inspection.id} phase="before" addLabel="+ Фото до" /></div>
                <div><span class="field-label">После</span><Photos type="inspection" id={inspection.id} phase="after" addLabel="+ Фото после" /></div>
              </div>
              <div class="form-actions"><ConfirmButton label="Удалить осмотр" confirm="Удалить осмотр и фото?" onConfirm={() => void guard(store.deleteInspection(inspection.id))} /></div>
            </details>;
          })}
        </div>
      )}
    </section>
  );
}

export function DiagnosticsPanel() {
  const [date, setDate] = useState<DateStr>(todayStr());
  const [mileage, setMileage] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const reports = store.carDiagnostics.value;
  const importFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('OBD-файл слишком большой (максимум 5 МБ).');
      const codes = parseObdReport(await file.text(), file.name);
      const km = mileage.trim() ? Number(mileage) : undefined;
      if (km !== undefined && (!Number.isFinite(km) || km < 0 || km > 5_000_000)) throw new Error('Некорректный пробег отчёта.');
      const report = await guard(store.addDiagnostic({ date, mileage: km, sourceName: file.name, notes, codes }));
      if (report) {
        setNotes('');
        toast(`Сохранён OBD-отчёт: ${codes.length} код(ов). Автоматический диагноз не формировался.`);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Не удалось прочитать OBD-отчёт.', 'err');
    } finally { setBusy(false); }
  };
  return (
    <section class="section records-panel">
      <header class="section-head"><h3>OBD-II отчёты <span class="count">{reports.length}</span></h3></header>
      <p class="safety-note">Сохраняются только коды и текст из исходного отчёта. Приложение не ставит диагноз и не предлагает ремонт по OBD-коду.</p>
      <div class="row2">
        <Field label="Дата отчёта"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value as DateStr)} /></Field>
        <Field label="Пробег, км (если известен)"><input type="number" min="0" max="5000000" step="1" value={mileage} onInput={(e) => setMileage((e.target as HTMLInputElement).value)} /></Field>
      </div>
      <Field label="Примечание"><input maxLength={4000} value={notes} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} /></Field>
      <label class="btn obd-file">{busy ? 'Чтение…' : 'Импортировать CSV / JSON'}<input type="file" accept=".csv,.json,.txt,.log,text/csv,application/json,text/plain" disabled={busy} onChange={importFile} /></label>
      <p class="field-hint">Импорт поддерживает CSV/JSON с DTC-кодами (например, P0420); неизвестные форматы лучше экспортировать в CSV или JSON из приложения сканера.</p>
      {!reports.length ? <Empty>OBD-отчётов пока нет.</Empty> : (
        <div class="record-list">
          {reports.map((report) => <article class="record-card" key={report.id}>
            <header class="section-head"><div><b>{formatDate(report.date)} · {report.sourceName}</b><span class="item-meta">{report.mileage !== undefined ? ` · ${fmtKm(report.mileage)}` : ''}{report.notes ? ` · ${report.notes}` : ''}</span></div><ConfirmButton label="Удалить" onConfirm={() => void guard(store.deleteDiagnostic(report.id))} /></header>
            <div class="dtc-list">{report.codes.map((code, i) => <div class="dtc-row" key={`${code.code}-${code.module ?? ''}-${i}`}>
              <code>{code.code}</code>{code.module && <span class="item-meta">{code.module}</span>}{code.status && <span class="item-meta">{code.status}</span>}
              {code.description && <p>{code.description}</p>}
            </div>)}</div>
            <p class="field-hint">Коды приведены как в источнике; они сами по себе не подтверждают неисправность компонента.</p>
          </article>)}
        </div>
      )}
    </section>
  );
}
