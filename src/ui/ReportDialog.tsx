import { useState } from 'preact/hooks';
import { formatDate } from '../core/dates';
import { dueText } from './items';
import { activeModel, store, ui } from '../state';
import { fmtKm, fmtMoney } from '../util';
import { Modal } from './Dialogs';

export function ReportDialog() {
  const [includeVin, setIncludeVin] = useState(true);
  const [includePlate, setIncludePlate] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);
  const close = () => (ui.dialog.value = null);
  const car = store.activeCar.value;
  if (!car) return null;
  const issues = store.carIssues.value;
  const tasks = store.carTasks.value;
  const logs = store.carLogs.value;
  const mileages = store.carMileages.value;
  const inspections = store.carInspections.value;
  const diagnostics = store.carDiagnostics.value;
  const printedAt = new Date().toLocaleString('ru-RU');
  const notes = (value: string) => includeNotes && value ? <p class="report-note">{value}</p> : null;

  return (
    <Modal title="Отчёт по автомобилю · PDF" onClose={close} wide>
      <div class="form report-options">
        <p>Предпросмотр можно распечатать или сохранить в PDF через диалог печати браузера.</p>
        <fieldset>
          <legend>Конфиденциальные сведения</legend>
          <label class="check"><input type="checkbox" checked={includeVin} onChange={(e) => setIncludeVin((e.target as HTMLInputElement).checked)} /> Включить VIN</label>
          <label class="check"><input type="checkbox" checked={includePlate} onChange={(e) => setIncludePlate((e.target as HTMLInputElement).checked)} /> Включить госномер</label>
          <label class="check"><input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes((e.target as HTMLInputElement).checked)} /> Включить заметки из записей</label>
        </fieldset>
        <p class="field-hint">В отчёт входят автомобиль, дефекты, регламент, последние 200 записей журнала и пробега, осмотры и OBD-коды. Фотографии и другие вложения не добавляются.</p>
        <div class="form-actions"><button type="button" class="btn btn-primary" onClick={() => window.print()}>Печать / сохранить PDF</button><button type="button" class="btn btn-ghost" onClick={close}>Закрыть</button></div>
      </div>
      <article class="report-print">
        <header class="report-header"><h1>Отчёт по автомобилю</h1><p>Сформирован {printedAt} · данные ShtBox хранятся локально</p></header>
        <h2>Автомобиль</h2>
        <table class="report-table report-meta"><tbody>
          <tr><th>Автомобиль</th><td>{car.name}</td></tr>
          <tr><th>Модель 3D</th><td>{activeModel().name}</td></tr>
          <tr><th>Год выпуска</th><td>{car.year ?? '—'}</td></tr>
          {includePlate && <tr><th>Госномер</th><td>{car.plate || '—'}</td></tr>}
          {includeVin && <tr><th>VIN</th><td>{car.vin || '—'}</td></tr>}
          <tr><th>Одометр</th><td>{fmtKm(car.mileage)}</td></tr>
        </tbody></table>

        <h2>Дефекты и регламентные работы</h2>
        <h3>Дефекты ({issues.length})</h3>
        {issues.length ? <table class="report-table"><thead><tr><th>Описание / узел</th><th>Статус / приоритет</th><th>Стоимость</th></tr></thead><tbody>
          {issues.map((issue) => <tr key={issue.id}><td><b>{issue.title}</b><small>{issue.zoneId}</small>{notes(issue.notes)}</td><td>{issue.status === 'open' ? 'Открыт' : `Закрыт ${formatDate(issue.doneDate)}`} · {issue.priority === 2 ? 'Срочный' : issue.priority === 1 ? 'Важный' : 'Обычный'}</td><td>{issue.cost === undefined ? '—' : fmtMoney(issue.cost)}</td></tr>)}
        </tbody></table> : <p class="report-muted">Нет записей.</p>}
        <h3>Регламент ТО ({tasks.length})</h3>
        {tasks.length ? <table class="report-table"><thead><tr><th>Работа / узел</th><th>Статус / следующий срок</th><th>Интервал</th></tr></thead><tbody>
          {tasks.map((task) => {
            const due = store.taskDue.value.get(task.id);
            const text = dueText(due);
            return <tr key={task.id}><td><b>{task.title}</b><small>{task.zoneId}</small>{notes(task.notes)}</td><td>{text.text}{due?.nextDate && <small>По дате: {formatDate(due.nextDate)}</small>}{due?.nextKm !== undefined && <small>По пробегу: {fmtKm(due.nextKm)}</small>}</td><td>{task.everyKm ? fmtKm(task.everyKm) : '—'} / {task.everyMonths ? `${task.everyMonths} мес.` : '—'}</td></tr>;
          })}
        </tbody></table> : <p class="report-muted">Нет записей.</p>}

        <h2>История обслуживания ({Math.min(logs.length, 200)} последних записей)</h2>
        {logs.length ? <table class="report-table"><thead><tr><th>Дата</th><th>Работа / узел</th><th>Пробег</th><th>Стоимость</th></tr></thead><tbody>
          {logs.slice(0, 200).map((log) => <tr key={log.id}><td>{formatDate(log.date)}</td><td><b>{log.title}</b><small>{log.zoneId}</small>{notes(log.notes)}</td><td>{log.mileage === undefined ? '—' : fmtKm(log.mileage)}</td><td>{log.cost === undefined ? '—' : fmtMoney(log.cost)}</td></tr>)}
        </tbody></table> : <p class="report-muted">Нет записей.</p>}

        <h2>История пробега ({Math.min(mileages.length, 200)} последних показаний)</h2>
        {mileages.length ? <table class="report-table"><thead><tr><th>Дата</th><th>Показание</th><th>Источник</th></tr></thead><tbody>
          {mileages.slice(0, 200).map((entry) => <tr key={entry.id}><td>{formatDate(entry.date)}</td><td>{fmtKm(entry.mileage)}</td><td>{entry.source === 'obd' ? 'OBD' : entry.source === 'service' ? 'Работа / сервис' : 'Вручную'}{notes(entry.notes)}</td></tr>)}
        </tbody></table> : <p class="report-muted">Нет записей.</p>}

        <h2>Осмотры ({inspections.length})</h2>
        {inspections.length ? inspections.map((inspection) => <section class="report-card" key={inspection.id}>
          <h3>{inspection.title}<small>{formatDate(inspection.date)}{inspection.mileage !== undefined ? ` · ${fmtKm(inspection.mileage)}` : ''}</small></h3>
          {notes(inspection.notes)}
          <table class="report-table"><thead><tr><th>Пункт / узел</th><th>Статус</th></tr></thead><tbody>
            {inspection.items.map((item) => <tr key={item.id}><td><b>{item.title}</b><small>{item.zoneId}</small>{notes(item.notes)}</td><td>{item.state === 'repair' ? 'Требуется ремонт' : item.state === 'watch' ? 'Наблюдать' : 'Без замечаний'}</td></tr>)}
          </tbody></table>
        </section>) : <p class="report-muted">Нет записей.</p>}

        <h2>OBD-отчёты ({diagnostics.length})</h2>
        <p class="report-warning">Коды OBD приведены из исходных файлов и не являются диагнозом приложения или подтверждённым заключением о неисправности.</p>
        {diagnostics.length ? diagnostics.map((report) => <section class="report-card" key={report.id}>
          <h3>{formatDate(report.date)} · {report.sourceName}<small>{report.mileage === undefined ? '' : fmtKm(report.mileage)}</small></h3>
          {notes(report.notes)}
          <table class="report-table"><thead><tr><th>Код</th><th>Модуль / статус / описание из файла</th></tr></thead><tbody>
            {report.codes.map((code, i) => <tr key={`${code.code}-${i}`}><td><code>{code.code}</code></td><td>{[code.module, code.status, code.description].filter(Boolean).join(' · ') || '—'}</td></tr>)}
          </tbody></table>
        </section>) : <p class="report-muted">Нет записей.</p>}
        <footer class="report-footer">Отчёт сформирован из пользовательских записей и не является официальной сервисной историей или экспертным заключением.</footer>
      </article>
    </Modal>
  );
}
