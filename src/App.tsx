import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ViewerPane } from './ViewerPane';
import { guard, missingModel, selectZone, store, ui } from './state';
import type { SidebarTab } from './state';
import { BackupDialog } from './ui/BackupDialog';
import { CarDialog, HelpDialog, PhotoDialog } from './ui/Dialogs';
import { Empty, Menu } from './ui/common';
import { ModelsDialog } from './ui/ModelsDialog';
import { IssuesTab, LogTab, TasksTab, ZoneList } from './ui/Tabs';
import { ZonePanel } from './ui/ZonePanel';
import { ReportDialog } from './ui/ReportDialog';
import { fmtKm, parseNum } from './util';

/** Мастер импорта тянет three/meshoptimizer — грузим только по требованию. */
function LazyWizard() {
  const [C, setC] = useState<(() => VNode) | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    import('./ui/ImportWizard').then((m) => setC(() => m.default), () => setErr('Не удалось загрузить мастер (нет сети?)'));
  }, []);
  if (C) return <C />;
  return <div class="wizard wizard-loading">{err || 'Загрузка мастера…'}{err && <button class="btn" onClick={() => (ui.dialog.value = 'models')}>Закрыть</button>}</div>;
}

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
        </>
      )}
      <span class="spacer" />
      <Menu
        align="right"
        ariaLabel="Меню"
        label="☰"
        title="Меню"
        class="btn-ghost menu-btn"
        items={[
          ...(car ? [{ label: 'Изменить автомобиль…', onSelect: () => (ui.dialog.value = 'car-edit') }] : []),
          { label: 'Добавить автомобиль…', onSelect: () => (ui.dialog.value = 'car-new') },
          { label: 'Модели автомобилей…', onSelect: () => (ui.dialog.value = 'models') },
          ...(car ? [{ label: 'Отчёт по автомобилю · PDF…', onSelect: () => (ui.dialog.value = 'report' as const) }] : []),
          { separator: true, label: '', onSelect: () => {} },
          { label: 'Данные, синхронизация, напоминания', onSelect: () => (ui.dialog.value = 'backup') },
          { separator: true, label: '', onSelect: () => {} },
          { label: 'Справка', onSelect: () => (ui.dialog.value = 'help') },
        ]}
      />
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
  void ui.modelsRev.value;
  const missing = missingModel();
  return (
    <div class={`app ${dialog === 'report' ? 'app-report-mode' : ''}`}>
      <Topbar />
      {missing && <div class="model-missing" role="alert">3D-модель этого автомобиля недоступна на устройстве. Записи сохранены; загрузите GLB-пакет, чтобы восстановить разметку. <button class="btn" onClick={() => ((ui.replaceId.value = missing), (ui.editModel.value = null), (ui.importReturn.value = null), (ui.dialog.value = 'import'))}>Загрузить файл</button></div>}
      <main class="main">
        <ViewerPane />
        {hasCar ? <Sidebar /> : <aside class="sidebar"><Empty>Добавьте первый автомобиль.</Empty></aside>}
      </main>
      {!hasCar && <CarDialog mode="new" forced />}
      {hasCar && (dialog === 'car-new' || (dialog === 'import' && ui.importReturn.value)) && <CarDialog mode="new" />}
      {hasCar && dialog === 'car-edit' && <CarDialog mode="edit" />}
      {dialog === 'models' && <ModelsDialog />}
      {dialog === 'import' && <LazyWizard />}
      {dialog === 'backup' && <BackupDialog />}
      {dialog === 'report' && <ReportDialog />}
      {dialog === 'help' && <HelpDialog />}
      {ui.lightbox.value && <PhotoDialog id={ui.lightbox.value} />}
      {store.error.value && <div class="toast toast-err" role="alert">{store.error.value}</div>}
      {ui.toast.value && <div class={`toast toast-${ui.toast.value.kind}`} role="status">{ui.toast.value.text}</div>}
    </div>
  );
}
