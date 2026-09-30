import { useState } from 'preact/hooks';
import { averageDailyMileage } from '../core/maintenance';
import { formatDate, todayStr } from '../core/dates';
import type { DateStr } from '../core/types';
import { guard, store, toast } from '../state';
import { fmtKm } from '../util';
import { ConfirmButton, Empty, Field } from './common';

const SOURCE_LABEL = { manual: 'вручную', service: 'из записи о работе', obd: 'из OBD-отчёта' } as const;

export function MileageHistory() {
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState<DateStr>(todayStr());
  const [value, setValue] = useState('');
  const [notes, setNotes] = useState('');
  const [showAll, setShowAll] = useState(false);
  const entries = store.carMileages.value;
  const car = store.activeCar.value;
  const trend = averageDailyMileage(entries);
  const onSubmit = async (e: Event) => {
    e.preventDefault();
    const mileage = Number(value);
    if (!Number.isFinite(mileage) || mileage < 0) return toast('Введите пробег в километрах.', 'err');
    const saved = await guard(store.addMileage({ date, mileage: Math.round(mileage), source: 'manual', notes }));
    if (!saved) return;
    setAdding(false);
    setValue('');
    setNotes('');
  };
  const visible = showAll ? entries : entries.slice(0, 20);

  return (
    <section class="section mileage-history">
      <header class="section-head">
        <h3>История пробега <span class="count">{entries.length}</span></h3>
        <button class="btn btn-primary" type="button" onClick={() => { setDate(todayStr()); setValue(String(car?.mileage ?? '')); setAdding((x) => !x); }}>{adding ? 'Отмена' : '+ Показание'}</button>
      </header>
      <p class="item-meta">Одометр: <b>{fmtKm(car?.mileage ?? 0)}</b>{trend !== undefined && ` · средний темп ≈ ${Math.round(trend).toLocaleString('ru-RU')} км/день (по записям)`}</p>
      {adding && (
        <form class="form mileage-form" onSubmit={onSubmit}>
          <div class="row2">
            <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value as DateStr)} required /></Field>
            <Field label="Пробег, км"><input type="number" min="0" max="5000000" step="1" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} required /></Field>
          </div>
          <Field label="Источник / примечание"><input maxLength={4000} value={notes} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} placeholder="Например: фото одометра, акт сервиса" /></Field>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Сохранить показание</button></div>
          <p class="field-hint">Дата не может быть в будущем; пробег проверяется относительно соседних показаний по датам.</p>
        </form>
      )}
      {!entries.length ? <Empty>Добавьте датированные показания: они помогут заметить ошибку и оценить срок следующего ТО.</Empty> : (
        <div class="mileage-list">
          {visible.map((entry) => <div class="mileage-row" key={entry.id}>
            <span><b>{fmtKm(entry.mileage)}</b><small>{formatDate(entry.date)} · {SOURCE_LABEL[entry.source]}{entry.notes ? ` · ${entry.notes}` : ''}</small></span>
            <ConfirmButton label="Удалить" onConfirm={() => void guard(store.deleteMileage(entry.id))} />
          </div>)}
          {entries.length > 20 && <button class="link" type="button" onClick={() => setShowAll((x) => !x)}>{showAll ? 'Свернуть' : `Показать все (${entries.length})`}</button>}
        </div>
      )}
    </section>
  );
}
