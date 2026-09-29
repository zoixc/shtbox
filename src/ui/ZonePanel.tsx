import { useState } from 'preact/hooks';
import { activeModel, selectZone, store, ui, viewerCommands } from '../state';
import { Empty, Section } from './common';
import { IssueForm, LogForm, TaskForm, startDraft } from './forms';
import { IssueItem, LogItem, TaskItem } from './items';
import { LAYERS } from '../models/types';

export function ZonePanel(props: { zoneId: string }) {
  const model = activeModel();
  const zone = model.zones.find((z) => z.id === props.zoneId);
  const [addingTask, setAddingTask] = useState(false);
  const [addingLog, setAddingLog] = useState(false);
  if (!zone) return <Empty>Узел не найден в модели</Empty>;

  const issues = store.carIssues.value.filter((i) => i.zoneId === zone.id && i.status === 'open');
  const tasks = store.carTasks.value.filter((t) => t.zoneId === zone.id);
  const logs = store.carLogs.value.filter((l) => l.zoneId === zone.id);
  const draft = ui.draft.value;
  const isOpen = ui.openZones.value.includes(zone.id);

  return (
    <div class="zone-panel">
      <div class="zone-head">
        <button class="btn btn-ghost back" onClick={() => selectZone(null)} aria-label="К списку узлов">←</button>
        <div>
          <h2>{zone.label}</h2>
          <p class="sub">
            {zone.group}
            {!zone.virtual && ` · слой «${LAYERS.find((l) => l.id === zone.layer)?.label}»`}
          </p>
        </div>
      </div>
      <div class="zone-tools">
        {zone.openable && (
          <button class="btn" onClick={() => viewerCommands.toggleOpen?.(zone.id)}>
            {isOpen ? 'Закрыть' : 'Открыть'}
          </button>
        )}
        <button class="btn btn-primary" onClick={() => startDraft(zone.id)}>+ Поломка / доделка / дефект</button>
      </div>

      {draft && <IssueForm />}

      <Section title="Открытые записи" count={issues.length}>
        {issues.length ? issues.map((i) => <IssueItem issue={i} key={i.id} />) : <Empty>Замечаний нет.</Empty>}
      </Section>

      <Section
        title="Регламент ТО"
        count={tasks.length}
        action={!addingTask && <button class="btn btn-ghost" onClick={() => setAddingTask(true)}>+ Добавить</button>}
      >
        {addingTask && <TaskForm zoneId={zone.id} onDone={() => setAddingTask(false)} />}
        {tasks.length ? tasks.map((t) => <TaskItem task={t} key={t.id} />) : !addingTask && <Empty>Регламентных работ для узла нет.</Empty>}
      </Section>

      <Section
        title="История работ"
        count={logs.length}
        action={!addingLog && <button class="btn btn-ghost" onClick={() => setAddingLog(true)}>+ Записать работу</button>}
      >
        {addingLog && <LogForm zoneId={zone.id} onDone={() => setAddingLog(false)} />}
        {logs.length ? logs.map((l) => <LogItem log={l} key={l.id} />) : !addingLog && <Empty>Выполненных работ пока нет.</Empty>}
      </Section>
    </div>
  );
}
