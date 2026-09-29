import { useState } from 'preact/hooks';
import { formatDate } from '../core/dates';
import { stateRank } from '../core/maintenance';
import { LOG_KIND_LABEL } from '../core/types';
import type { LogKind } from '../core/types';
import { activeModel, guard, selectZone, store, toast } from '../state';
import { csvCell, download, fmtKm, fmtMoney } from '../util';
import { Chip, Empty, Section } from './common';
import { LogForm, TaskForm } from './forms';
import { IssueItem, LogItem, TaskItem } from './items';
import { zoneLabel } from '../state';

export function ZoneList() {
  const model = activeModel();
  const [q, setQ] = useState('');
  const sum = store.zoneSummary.value;
  const groups = [...new Set(model.zones.map((z) => z.group))];
  const needle = q.trim().toLowerCase();
  const openTotal = store.carIssues.value.filter((i) => i.status === 'open').length;
  const overdue = [...store.taskDue.value.values()].filter((d) => d.state === 'overdue').length;
  const soon = [...store.taskDue.value.values()].filter((d) => d.state === 'soon').length;
  return (
    <div>
      <div class="stats">
        <div class="stat"><b>{openTotal}</b><span>открытых записей</span></div>
        <div class={`stat ${overdue ? 'stat-red' : ''}`}><b>{overdue}</b><span>ТО просрочено</span></div>
        <div class={`stat ${soon ? 'stat-amber' : ''}`}><b>{soon}</b><span>ТО скоро</span></div>
      </div>
      <p class="hint">Кликните по узлу на 3D-модели или выберите из списка. Двойной клик по двери/капоту/багажнику — открыть.</p>
      <input class="search" type="search" placeholder="Поиск узла…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {groups.map((g) => {
        const zs = model.zones.filter((z) => z.group === g && (!needle || z.label.toLowerCase().includes(needle)));
        if (!zs.length) return null;
        return (
          <div class="zgroup" key={g}>
            <h4>{g}</h4>
            {zs.map((z) => {
              const s = sum.get(z.id);
              return (
                <button class="zrow" key={z.id} onClick={() => selectZone(z.id)}>
                  <span>{z.label}</span>
                  <span class="zrow-badges">
                    {s && s.open > 0 && <Chip tone={s.maxPriority === 2 ? 'red' : s.maxPriority === 1 ? 'amber' : 'blue'}>{s.open}</Chip>}
                    {s && s.due === 'overdue' && <Chip tone="red">ТО</Chip>}
                    {s && s.due === 'soon' && <Chip tone="amber">ТО</Chip>}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function TasksTab() {
  const [adding, setAdding] = useState(false);
  const model = activeModel();
  const tasks = store.carTasks.value;
  const due = store.taskDue.value;
  const sorted = [...tasks].sort((a, b) => {
    const da = due.get(a.id), db = due.get(b.id);
    const r = stateRank(db?.state ?? 'unknown') - stateRank(da?.state ?? 'unknown');
    if (r) return r;
    return (da?.leftKm ?? 1e9) - (db?.leftKm ?? 1e9);
  });
  const missing = model.defaultMaintenance.filter((t) => !tasks.some((x) => x.title === t.title && x.zoneId === t.zoneId));
  return (
    <div>
      <div class="tab-actions">
        <button class="btn btn-primary" onClick={() => setAdding(true)}>+ Регламентная работа</button>
        {missing.length > 0 && (
          <button
            class="btn"
            onClick={async () => {
              await guard(store.addTasks(missing));
              toast(`Добавлено работ: ${missing.length}. Укажите, когда они выполнялись последний раз.`);
            }}
          >
            Типовой регламент ({missing.length})
          </button>
        )}
      </div>
      {adding && <TaskForm zoneId="general" onDone={() => setAdding(false)} />}
      {sorted.length ? sorted.map((t) => <TaskItem task={t} key={t.id} showZone />) : <Empty>Регламент пока пуст. Добавьте типовой набор работ или создайте свои.</Empty>}
    </div>
  );
}

export function IssuesTab() {
  const open = store.carIssues.value.filter((i) => i.status === 'open').sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);
  const total = open.reduce((s, i) => s + (i.cost ?? 0), 0);
  return (
    <div>
      <div class="totals">
        <span>Открытых: <b>{open.length}</b></span>
        {total > 0 && <span>Ориентировочно: <b>{fmtMoney(total)}</b></span>}
      </div>
      {open.length ? open.map((i) => <IssueItem issue={i} key={i.id} showZone />) : <Empty>Открытых поломок и доделок нет. Выберите узел на модели, чтобы добавить.</Empty>}
    </div>
  );
}

export function LogTab() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<LogKind | ''>('');
  const [adding, setAdding] = useState(false);
  const all = store.carLogs.value;
  const needle = q.trim().toLowerCase();
  const list = all.filter((l) => (!kind || l.kind === kind) && (!needle || `${l.title} ${l.notes} ${zoneLabel(l.zoneId)}`.toLowerCase().includes(needle)));
  const total = list.reduce((s, l) => s + (l.cost ?? 0), 0);
  const car = store.activeCar.value;

  const exportCsv = () => {
    const rows = [['Дата', 'Пробег', 'Тип', 'Узел', 'Работа', 'Стоимость', 'Заметки'].map(csvCell).join(';')];
    for (const l of list) rows.push([l.date, l.mileage, LOG_KIND_LABEL[l.kind], zoneLabel(l.zoneId), l.title, l.cost, l.notes].map(csvCell).join(';'));
    download(`journal-${(car?.name ?? 'car').replace(/[^\w-]+/g, '_')}.csv`, '\ufeff' + rows.join('\r\n'), 'text/csv;charset=utf-8');
  };

  return (
    <div>
      <div class="tab-actions">
        <button class="btn btn-primary" onClick={() => setAdding(true)}>+ Записать работу</button>
        <button class="btn" onClick={exportCsv} disabled={!list.length}>CSV</button>
      </div>
      {adding && <LogForm zoneId="general" onDone={() => setAdding(false)} />}
      <div class="filters">
        <input type="search" placeholder="Поиск по журналу…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as LogKind | '')}>
          <option value="">Все типы</option>
          {(Object.keys(LOG_KIND_LABEL) as LogKind[]).map((k) => (
            <option value={k} key={k}>{LOG_KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>
      <div class="totals">
        <span>Записей: <b>{list.length}</b></span>
        <span>Потрачено: <b>{fmtMoney(total)}</b></span>
        {all[0] && <span>Последняя: <b>{formatDate(all[0].date)}</b>{all[0].mileage !== undefined && ` · ${fmtKm(all[0].mileage)}`}</span>}
      </div>
      {list.length ? list.map((l) => <LogItem log={l} key={l.id} showZone />) : <Empty>Журнал пуст: здесь появятся все выполненные работы.</Empty>}
    </div>
  );
}

export { Section };
