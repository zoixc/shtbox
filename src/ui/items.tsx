import { useState } from 'preact/hooks';
import { addDays, formatDate } from '../core/dates';
import { averageDailyMileage } from '../core/maintenance';
import type { DueInfo } from '../core/maintenance';
import { ISSUE_KIND_LABEL, LOG_KIND_LABEL, PRIORITY_LABEL } from '../core/types';
import type { Issue, LogEntry, MaintenanceTask } from '../core/types';
import { guard, selectZone, store, ui, zoneLabel } from '../state';
import { fmtKm, fmtMoney } from '../util';
import { Chip, ConfirmButton } from './common';
import { CompleteForm, LogForm, TaskForm } from './forms';
import { Photos } from './Photos';
import type { Draft } from '../state';

export function dueText(d: DueInfo | undefined): { text: string; tone: 'red' | 'amber' | 'green' | 'gray' } {
  if (!d || d.state === 'unknown') return { text: 'нет отметки о выполнении', tone: 'gray' };
  const parts: string[] = [];
  if (d.leftKm !== undefined) parts.push(d.leftKm <= 0 ? `просрочено на ${fmtKm(-d.leftKm)}` : `через ${fmtKm(d.leftKm)}`);
  if (d.leftDays !== undefined) parts.push(d.leftDays <= 0 ? `просрочено на ${-d.leftDays} дн.` : `через ${d.leftDays} дн.`);
  const tone = d.state === 'overdue' ? 'red' : d.state === 'soon' ? 'amber' : 'green';
  return { text: parts.join(' · '), tone };
}

const KIND_TONE = { breakdown: 'red', todo: 'blue', rust: 'amber', dent: 'amber', chip: 'amber', scratch: 'amber' } as const;

export function IssueItem(props: { issue: Issue; showZone?: boolean }) {
  const i = props.issue;
  const inspection = i.inspectionId ? store.inspections.value.find((x) => x.id === i.inspectionId) : undefined;
  const [completing, setCompleting] = useState(false);
  const edit = () => {
    const d: Draft = { editId: i.id, zoneId: i.zoneId, kind: i.kind, title: i.title, notes: i.notes, priority: i.priority, cost: i.cost !== undefined ? String(i.cost) : '', spot: i.spot };
    selectZone(i.zoneId);
    ui.draft.value = d;
  };
  return (
    <div class={`item item-p${i.priority}`}>
      <div class="item-main">
        <div class="item-title">
          <Chip tone={KIND_TONE[i.kind]}>{ISSUE_KIND_LABEL[i.kind]}</Chip>
          <strong>{i.title}</strong>
          {i.priority > 0 && <Chip tone={i.priority === 2 ? 'red' : 'amber'}>{PRIORITY_LABEL[i.priority]}</Chip>}
        </div>
        {props.showZone && (
          <button class="link" onClick={() => selectZone(i.zoneId)}>
            {zoneLabel(i.zoneId)}
          </button>
        )}
        {i.notes && <p class="item-notes">{i.notes}</p>}
        {inspection && <p class="item-meta">Создано по осмотру «{inspection.title}» от {formatDate(inspection.date)}</p>}
        <p class="item-meta">
          с {formatDate(new Date(i.createdAt).toISOString().slice(0, 10))}
          {i.cost !== undefined && ` · ≈ ${fmtMoney(i.cost)}`}
          {i.spot && ' · отмечено на кузове'}
        </p>
        <Photos type="issue" id={i.id} />
      </div>
      {completing ? (
        <CompleteForm
          label="Готово — в журнал"
          defaultCost={i.cost}
          onCancel={() => setCompleting(false)}
          onSubmit={async (c) => {
            await guard(store.completeIssue(i.id, c));
            setCompleting(false);
          }}
        />
      ) : (
        <div class="item-actions">
          <button class="btn btn-ok" onClick={() => setCompleting(true)}>✓ Выполнено</button>
          <button class="btn btn-ghost" onClick={edit}>Изменить</button>
          <ConfirmButton label="Удалить" onConfirm={() => void guard(store.deleteIssue(i.id))} />
        </div>
      )}
    </div>
  );
}

export function TaskItem(props: { task: MaintenanceTask; showZone?: boolean }) {
  const t = props.task;
  const [mode, setMode] = useState<'none' | 'done' | 'edit'>('none');
  const due = store.taskDue.value.get(t.id);
  const dt = dueText(due);
  const dailyKm = averageDailyMileage(store.carMileages.value);
  const estimateDays = due?.leftKm !== undefined && due.leftKm > 0 && dailyKm ? Math.ceil(due.leftKm / dailyKm) : undefined;
  const estimateDate = estimateDays !== undefined && estimateDays <= 3650 ? addDays(store.today.value, estimateDays) : undefined;
  const every = [t.everyKm ? `${fmtKm(t.everyKm)}` : '', t.everyMonths ? `${t.everyMonths} мес.` : ''].filter(Boolean).join(' / ');
  if (mode === 'edit') return <TaskForm task={t} zoneId={t.zoneId} onDone={() => setMode('none')} />;
  return (
    <div class={`item due-${due?.state ?? 'unknown'}`}>
      <div class="item-main">
        <div class="item-title">
          <Chip tone={dt.tone}>{due?.state === 'overdue' ? 'Просрочено' : due?.state === 'soon' ? 'Скоро' : due?.state === 'ok' ? 'В норме' : 'Нет данных'}</Chip>
          <strong>{t.title}</strong>
        </div>
        {props.showZone && (
          <button class="link" onClick={() => selectZone(t.zoneId)}>
            {zoneLabel(t.zoneId)}
          </button>
        )}
        <p class="item-meta">каждые {every}</p>
        <p class={`item-due tone-${dt.tone}`}>{dt.text}</p>
        {estimateDate && due?.leftKm !== undefined && <p class="item-meta">Оценка по истории пробега: около {formatDate(estimateDate)} ({estimateDays} дн.). Это ориентир, не замена регламенту.</p>}
        <p class="item-meta">
          Последний раз: {formatDate(t.lastDate)}
          {t.lastKm !== undefined && ` · ${fmtKm(t.lastKm)}`}
          {due?.nextKm !== undefined && ` · след. ${fmtKm(due.nextKm)}`}
          {due?.nextDate && ` · до ${formatDate(due.nextDate)}`}
        </p>
        {t.notes && <p class="item-notes">{t.notes}</p>}
      </div>
      {mode === 'done' ? (
        <CompleteForm
          label="Выполнено — в журнал"
          onCancel={() => setMode('none')}
          onSubmit={async (c) => {
            await guard(store.completeTask(t.id, c));
            setMode('none');
          }}
        />
      ) : (
        <div class="item-actions">
          <button class="btn btn-ok" onClick={() => setMode('done')}>✓ Выполнено</button>
          <button class="btn btn-ghost" onClick={() => setMode('edit')}>Изменить</button>
          <ConfirmButton label="Удалить" onConfirm={() => void guard(store.deleteTask(t.id))} />
        </div>
      )}
    </div>
  );
}

const LOG_TONE = { maintenance: 'green', repair: 'red', todo: 'blue', bodywork: 'amber', other: 'gray' } as const;

export function LogItem(props: { log: LogEntry; showZone?: boolean }) {
  const l = props.log;
  const [editing, setEditing] = useState(false);
  if (editing) return <LogForm log={l} zoneId={l.zoneId} onDone={() => setEditing(false)} />;
  const issue = l.ref?.type === 'issue' ? store.issues.value.find((i) => i.id === l.ref!.id) : undefined;
  return (
    <div class="item log">
      <div class="item-main">
        <div class="item-title">
          <Chip tone={LOG_TONE[l.kind]}>{LOG_KIND_LABEL[l.kind]}</Chip>
          <strong>{l.title}</strong>
        </div>
        {props.showZone && (
          <button class="link" onClick={() => selectZone(l.zoneId)}>
            {zoneLabel(l.zoneId)}
          </button>
        )}
        <p class="item-meta">
          {formatDate(l.date)}
          {l.mileage !== undefined && ` · ${fmtKm(l.mileage)}`}
          {l.cost !== undefined && ` · ${fmtMoney(l.cost)}`}
        </p>
        {l.notes && <p class="item-notes">{l.notes}</p>}
        {issue && <Photos type="issue" id={issue.id} addLabel="+ Фото до" />}
        <Photos type="log" id={l.id} addLabel={issue ? '+ Фото после / чек' : '+ Чек / фото'} />
      </div>
      <div class="item-actions">
        <button class="btn btn-ghost" onClick={() => setEditing(true)}>Изменить</button>
        {issue?.status === 'done' && (
          <ConfirmButton label="Вернуть в работу" confirm="Вернуть? Запись журнала удалится" onConfirm={() => void guard(store.reopenIssue(issue.id))} />
        )}
        <ConfirmButton label="Удалить" onConfirm={() => void guard(store.deleteLog(l.id))} />
      </div>
    </div>
  );
}
