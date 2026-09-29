import { useEffect, useState } from 'preact/hooks';
import { ViewerPane } from './ViewerPane';
import { guard, selectZone, store, ui } from './state';
import type { SidebarTab } from './state';
import { BackupDialog, CarDialog, HelpDialog } from './ui/Dialogs';
import { Empty } from './ui/common';
import { IssuesTab, LogTab, TasksTab, ZoneList } from './ui/Tabs';
import { ZonePanel } from './ui/ZonePanel';
import { fmtKm, parseNum } from './util';

function MileageEditor() {
  const car = store.activeCar.value!;
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState('');
  if (!editing)
    return (
      <button class="mileage" title="Обновить пробег" onClick={() => (setV(String(car.mileage)), setEditing(true))}>
        {fmtKm(car.mileage)} ✎
      </button>
    );
  const commit = async () => {
    const n = parseNum(v);
    setEditing(false);
    if (n !== undefined && n !== car.mileage) await guard(store.updateCar(car.id, { mileage: Math.round(n) }));
  };
  return (
    <input
      class="mileage-input"
      inputMode="numeric"
      value={v}
      autoFocus
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

function Topbar() {
  const cars = store.cars.value;
  const car = store.activeCar.value;
  return (
    <header class="topbar">
      <div class="brand"><img src="/icon.svg" alt="" width="26" height="26" /><span>ShtBox</span></div>
      {car && (
        <>
          <select class="car-select" value={car.id} onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === '__new') {
                (e.target as HTMLSelectElement).value = car.id;
                ui.dialog.value = 'car-new';
                return;
              }
              selectZone(null);
              store.setActiveCar(v);
            }} aria-label="Автомобиль">
            {cars.map((c) => (
              <option value={c.id} key={c.id}>{c.name}{c.plate ? ` · ${c.plate}` : ''}</option>
            ))}
            <option value="__new">+ Добавить автомобиль…</option>
          </select>
          <MileageEditor />
          <button class="btn btn-ghost" onClick={() => (ui.dialog.value = 'car-edit')}>Авто</button>
        </>
      )}
      <button class="btn btn-ghost hide-mobile" onClick={() => (ui.dialog.value = 'car-new')}>+ Авто</button>
      <span class="spacer" />
      <button class="btn btn-ghost" onClick={() => (ui.dialog.value = 'backup')}>Копия</button>
      <button class="btn btn-ghost" onClick={() => (ui.dialog.value = 'help')} aria-label="Справка">?</button>
    </header>
  );
}

const TABS: [SidebarTab, string][] = [
  ['zone', 'Узлы'],
  ['tasks', 'ТО'],
  ['issues', 'Дефекты'],
  ['log', 'Журнал'],
];

function Sidebar() {
  const tab = ui.tab.value;
  const zone = ui.selectedZone.value;
  const overdue = [...store.taskDue.value.values()].filter((d) => d.state === 'overdue').length;
  const open = store.carIssues.value.filter((i) => i.status === 'open').length;
  return (
    <aside class={`sidebar ${ui.sheetOpen.value ? '' : 'sheet-closed'}`}>
      <button class="sheet-handle" onClick={() => (ui.sheetOpen.value = !ui.sheetOpen.value)} aria-label="Показать/скрыть панель" />
      <nav class="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} class={`tab ${tab === id ? 'tab-on' : ''}`} onClick={() => ((ui.tab.value = id), (ui.sheetOpen.value = true))}>
            {label}
            {id === 'tasks' && overdue > 0 && <span class="dot dot-red">{overdue}</span>}
            {id === 'issues' && open > 0 && <span class="dot">{open}</span>}
          </button>
        ))}
      </nav>
      <div class="sidebar-body">
        {tab === 'zone' && (zone ? <ZonePanel zoneId={zone} key={zone} /> : <ZoneList />)}
        {tab === 'tasks' && <TasksTab />}
        {tab === 'issues' && <IssuesTab />}
        {tab === 'log' && <LogTab />}
      </div>
    </aside>
  );
}

export function App() {
  useEffect(() => {
    document.title = store.activeCar.value ? `${store.activeCar.value.name} — ShtBox` : 'ShtBox';
  });
  const dialog = ui.dialog.value;
  const hasCar = !!store.activeCar.value;
  return (
    <div class="app">
      <Topbar />
      <main class="main">
        <ViewerPane />
        {hasCar ? <Sidebar /> : <aside class="sidebar"><Empty>Добавьте первый автомобиль.</Empty></aside>}
      </main>
      {!hasCar && <CarDialog mode="new" forced />}
      {hasCar && dialog === 'car-new' && <CarDialog mode="new" />}
      {hasCar && dialog === 'car-edit' && <CarDialog mode="edit" />}
      {dialog === 'backup' && <BackupDialog />}
      {dialog === 'help' && <HelpDialog />}
      {store.error.value && <div class="toast toast-err" role="alert">{store.error.value}</div>}
      {ui.toast.value && <div class={`toast toast-${ui.toast.value.kind}`} role="status">{ui.toast.value.text}</div>}
    </div>
  );
}
