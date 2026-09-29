import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getModel } from './models/registry';
import { LAYERS } from './models/types';
import { Menu } from './ui/common';
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

export function ViewerPane() {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [openables, setOpenables] = useState<{ id: string; label: string }[]>([]);

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
          modelReady: () => setOpenables(v.openableZones()),
        });
        viewer = v;
        viewerCommands.setOpen = (z, o) => v.setOpen(z, o);
        viewerCommands.toggleOpen = (z) => v.toggleOpen(z);
        viewerCommands.setAllOpen = (o) => v.setAllOpen(o);
        viewerCommands.view = (p) => v.view(p as never);
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
            }
            v.setModel(getModel(car.modelId), ui.previewColor.value ?? car.color);
          }),
          effect(() => v.setLayer(ui.layer.value)),
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
