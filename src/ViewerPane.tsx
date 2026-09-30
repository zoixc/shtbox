import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getModel } from './models/registry';
import { LAYERS } from './models/types';
import { Menu } from './ui/common';
import { DEFAULT_FINISH } from './data/paintFinish';
import { selectZone, setLayer, store, ui, viewerCommands } from './state';
import type { Viewer } from './view3d/Viewer';

const VIEWS: [string, string][] = [
  ['iso', '3/4'],
  ['front', 'Спереди'],
  ['rear', 'Сзади'],
  ['left', 'Слева'],
  ['right', 'Справа'],
  ['top', 'Сверху'],
  ['under', 'Снизу'],
  ['cabin', 'Из салона'],
];
const LIGHTING: Array<['studio' | 'daylight' | 'inspection', string]> = [
  ['studio', 'Студия'], ['daylight', 'Дневной свет'], ['inspection', 'Осмотр'],
];

export function ViewerPane() {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [openables, setOpenables] = useState<{ id: string; label: string }[]>([]);
  const [windows, setWindows] = useState<{ id: string; label: string }[]>([]);
  const [windowsDown, setWindowsDown] = useState(0);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    let viewer: Viewer | undefined;

    import('./view3d/Viewer')
      .then(({ Viewer }) => {
        if (disposed || !host.current) return;
        const v = new Viewer(host.current, {
          pick: (z) => selectZone(z),
          place: (zone, spot) => {
            const d = ui.draft.value;
            if (!d) return;
            ui.draft.value = { ...d, zoneId: zone, spot };
            ui.placing.value = false;
            ui.selectedZone.value = zone;
          },
          openChanged: (o) => (ui.openZones.value = o),
          modelReady: () => {
            setOpenables(v.openableZones());
            setWindows(v.windowsList().map(({ id, label }) => ({ id, label })));
          },
        });
        viewer = v;
        viewerCommands.setOpen = (z, o) => v.setOpen(z, o);
        viewerCommands.toggleOpen = (z) => v.toggleOpen(z);
        viewerCommands.setAllOpen = (o) => v.setAllOpen(o);
        viewerCommands.setWindows = (f) => {
          v.setWindows(f);
          setWindowsDown(f);
        };
        viewerCommands.setWindow = (z, f) => v.setWindow(z, f);
        viewerCommands.windowsList = () => v.windowsList().map(({ id, label }) => ({ id, label }));
        viewerCommands.view = (p) => v.view(p as never);
        viewerCommands.lighting = (preset) => v.setLightingPreset(preset);
        if (import.meta.env.DEV) (window as unknown as { __viewer: Viewer }).__viewer = v;

        let lastCar = '';
        cleanups.push(
          effect(() => {
            const car = store.activeCar.value;
            void ui.modelsRev.value;
            if (!car) return;
            if (car.id !== lastCar) {
              lastCar = car.id;
              v.markInstant();
              // у другой машины стёкла снова подняты
              v.setWindows(0);
              setWindowsDown(0);
            }
            v.setModel(getModel(car.modelId), ui.previewColor.value ?? car.color, {
              finish: ui.previewFinish.value ?? car.finish,
            });
          }),
          effect(() => {
            const car = store.activeCar.value;
            if (!car) return;
            // смена покрытия не пересоздаёт модель: материал краски обновляется на месте
            v.setFinish(ui.previewFinish.value ?? car.finish ?? getModel(car.modelId).defaultFinish ?? DEFAULT_FINISH);
          }),
          effect(() => v.setLayer(ui.layer.value)),
          effect(() => v.setBlueprint(ui.blueprint.value)),
          effect(() => v.setLightingPreset(ui.lightingPreset.value)),
          effect(() => v.setSelected(ui.selectedZone.value)),
          effect(() => {
            const editId = ui.draft.value?.editId;
            v.setIssues(store.carIssues.value.filter((i) => i.id !== editId));
          }),
          effect(() => v.setSummary(store.zoneSummary.value)),
          effect(() => {
            const d = ui.draft.value;
            v.setDraft(d?.spot ? { zone: d.zoneId, spot: d.spot, kind: d.kind } : null);
          }),
          effect(() => {
            const d = ui.draft.value;
            v.setPlacing(ui.placing.value && d ? { kind: d.kind, r: d.spot?.r ?? ui.radius.value } : null);
          }),
        );
        setState('ready');
      })
      .catch((e) => {
        console.error(e);
        setState('error');
      });

    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
      viewer?.dispose();
    };
  }, []);

  const open = ui.openZones.value;
  return (
    <div class="viewer-pane">
      <div class="viewer-host" ref={host} />
      {state === 'loading' && <div class="viewer-msg">Загрузка 3D…</div>}
      {state === 'error' && <div class="viewer-msg">Не удалось запустить WebGL. Списки узлов и журнал работают без 3D.</div>}

      {state === 'ready' && store.activeCar.value && (<>
      <div class="layer-tabs" role="tablist">
        {LAYERS.map((l) => (
          <button key={l.id} role="tab" aria-selected={ui.layer.value === l.id} class={`tab ${ui.layer.value === l.id ? 'tab-on' : ''}`} onClick={() => setLayer(l.id)}>
            {l.label}
          </button>
        ))}
      </div>

      {ui.placing.value && (
        <div class="place-banner">
          <span>Кликните по кузову, чтобы поставить метку</span>
          <button class="btn" onClick={() => (ui.placing.value = false)}>Отмена</button>
        </div>
      )}

      <div class="view-bar">
        <Menu
          up
          class="btn-glass"
          label="Вид ▴"
          ariaLabel="Ракурс камеры"
          items={VIEWS.map(([id, label]) => ({ label, onSelect: () => viewerCommands.view?.(id) }))}
        />
        <Menu
          up
          class="btn-glass"
          label="Свет ▴"
          title="Визуальные пресеты, не измеренный режим освещения"
          ariaLabel="Пресет освещения 3D-модели"
          items={LIGHTING.map(([id, label]) => ({ label, active: ui.lightingPreset.value === id, hint: ui.lightingPreset.value === id ? 'выбран' : undefined, onSelect: () => (ui.lightingPreset.value = id) }))}
        />
        <button
          type="button"
          class={`btn btn-glass blueprint-toggle ${ui.blueprint.value ? 'btn-blueprint-on' : ''}`}
          aria-pressed={ui.blueprint.value}
          title="Полупрозрачная модель с пунктирными рёбрами геометрии"
          onClick={() => (ui.blueprint.value = !ui.blueprint.value)}
        >
          Чертёж
        </button>
        {windows.length > 0 && (
          <Menu
            up
            class="btn-glass"
            label={windowsDown > 0.5 ? 'Стёкла опущены ▴' : 'Стёкла ▴'}
            title="Стёкла дверей опускаются маской в шейдере: геометрия стекла не режется (см. docs/ADDING_MODELS.md)"
            ariaLabel="Опустить стёкла дверей"
            items={[
              { label: 'Опустить все', active: windowsDown > 0.5, onSelect: () => viewerCommands.setWindows?.(1) },
              { label: 'Наполовину', active: windowsDown > 0.2 && windowsDown < 0.8, onSelect: () => viewerCommands.setWindows?.(0.45) },
              { label: 'Поднять все', active: windowsDown <= 0.2, onSelect: () => viewerCommands.setWindows?.(0) },
              { separator: true, label: '', onSelect: () => {} },
              ...windows.map((w) => ({
                label: w.label,
                keepOpen: true,
                onSelect: () => viewerCommands.setWindow?.(w.id, 1),
              })),
            ]}
          />
        )}
        <Menu
          up
          class="btn-glass"
          label={open.length ? `Открыто: ${open.length} ▴` : 'Открыть ▴'}
          ariaLabel="Открыть двери, капот, багажник"
          items={[
            ...openables.map((o) => ({ label: o.label, active: open.includes(o.id), hint: open.includes(o.id) ? 'открыто' : undefined, keepOpen: true, onSelect: () => viewerCommands.toggleOpen?.(o.id) })),
            { separator: true, label: '', onSelect: () => {} },
            { label: open.length ? 'Закрыть всё' : 'Открыть всё', onSelect: () => viewerCommands.setAllOpen?.(open.length === 0) },
          ]}
        />
      </div>
      </>)}
    </div>
  );
}
