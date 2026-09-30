/**
 * Мастер импорта модели: файл → обработка в Worker → разметка (ориентация, краска, узлы) → сохранение.
 * Загружается лениво: three.js, meshoptimizer и gltf-transform не попадают в стартовый бандл.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BufferGeometry, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { Viewer } from '../view3d/Viewer';
import { uid } from '../core/id';
import { patchProfile, splitGlb } from '../import/container';
import { estimatePreservedTextures } from '../import/texture-estimate';
import { ImportSession } from '../import/client';
import type { ImportOutcome } from '../import/client';
import { ImportCancelledError } from '../import/client';
import type { AnalyzeHint } from '../import/analyze';
import type { BodyType, DataConfidence, DataProvenance, Kind, Lines, PartInfo, Profile } from '../import/types';
import { KINDS } from '../import/types';
import { parseProfile } from '../import/profile';
import { zonesFor } from '../import/zoneset';
import { createImportedRig, parsePackage } from '../models/imported';
import { USER_PREFIX, readUserModelFile, saveUserModel, userModels } from '../models/user';
import type { CarModelDef } from '../models/types';
import { guard, store, toast, ui } from '../state';
import { Field } from './common';
import { PanelRegionEditor } from './PanelRegionEditor';

const MAX_FILE = 60 * 1024 * 1024;
type Tab = 'orient' | 'paint' | 'parts' | 'done';
const TABS: [Tab, string][] = [
  ['orient', 'Ориентация'],
  ['paint', 'Краска'],
  ['parts', 'Узлы'],
  ['done', 'Готово'],
];
const KIND_LABEL: Record<Kind, string> = {
  paint: 'Окрашиваемая панель', glass: 'Стекло', light: 'Оптика', wheel: 'Колесо', brake: 'Тормоза', trim: 'Накладка / прочее', int: 'Салон', hide: 'Скрыть',
};
const PROVENANCE_OPTIONS: [DataProvenance, string][] = [
  ['auto', 'Автооценка'], ['manual', 'Исправлено вручную'], ['document', 'Сверено с документом'], ['oem', 'Подтверждено OEM'],
];
const CONFIDENCE_OPTIONS: [DataConfidence, string][] = [['low', 'Низкая'], ['medium', 'Средняя'], ['high', 'Высокая']];
const LINE_LABEL: [keyof Lines, string, 'x' | 'y' | 'w'][] = [
  ['cowl', 'Капот ↔ лобовое стекло (X)', 'x'],
  ['doorFront', 'Передний край двери (X)', 'x'],
  ['doorSplit', 'Граница передней и задней двери (X)', 'x'],
  ['doorRear', 'Задний край двери (X)', 'x'],
  ['trunkFront', 'Передний край багажника / крышки (X)', 'x'],
  ['belt', 'Линия окон (высота)', 'y'],
  ['sill', 'Порог (высота)', 'y'],
  ['bumperTopF', 'Верх переднего бампера (высота)', 'y'],
  ['bumperTopR', 'Верх заднего бампера (высота)', 'y'],
  ['hoodHw', 'Половина ширины капота', 'w'],
  ['trunkHw', 'Половина ширины багажника', 'w'],
];

const rad = (d: number) => (d * Math.PI) / 180;
const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
const frameMatrix = (p: Profile) =>
  new Matrix4().compose(new Vector3(...p.frame.offset), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rad(p.frame.yaw)), new Vector3(p.frame.scale, p.frame.scale, p.frame.scale));

const hintOf = (p: Profile, patch: Partial<AnalyzeHint> = {}): AnalyzeHint => ({
  yaw: p.frame.yaw,
  scale: p.frame.scale,
  body: p.body,
  layout: p.layout,
  driver: p.driver,
  paint: p.paint,
  keep: Object.fromEntries(Object.entries(p.parts).filter(([, v]) => v.u)),
  ...patch,
});

export default function ImportWizard() {
  const editing = ui.editModel.value;
  const [phase, setPhase] = useState<'pick' | 'busy' | 'edit'>(editing ? 'busy' : 'pick');
  const [prog, setProg] = useState({ stage: 'Подготовка', frac: 0 });
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [tab, setTab] = useState<Tab>('orient');
  const [color, setColor] = useState('#b9bec6');
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [openAll, setOpenAll] = useState(false);
  const [stats, setStats] = useState<ImportOutcome['stats'] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [preserveTextures, setPreserveTextures] = useState(false);
  const [textureEstimate, setTextureEstimate] = useState<{ bytes: number; textures: number; omitted: number } | null>(null);

  const sess = useRef<ImportSession | null>(null);
  const importRun = useRef(0);
  const pkg = useRef<{ glb: Uint8Array; scene: Object3D } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const buildN = useRef(0);
  const timer = useRef(0);
  const overlay = useRef<Mesh | null>(null);
  const profRef = useRef<Profile | null>(null);
  profRef.current = profile;

  const close = () => {
    const back = ui.importReturn.value;
    const fromBanner = ui.replaceId.value !== null;
    ui.editModel.value = null;
    ui.replaceId.value = null;
    ui.dialog.value = back ? 'car-new' : fromBanner ? null : 'models';
  };

  useEffect(
    () => () => {
      importRun.current++;
      clearTimeout(timer.current);
      sess.current?.close();
      viewer.current?.dispose();
    },
    [],
  );

  // ---- загрузка существующей модели для правки
  useEffect(() => {
    if (!editing) return;
    void (async () => {
      try {
        const meta = userModels().find((m) => m.id === editing);
        if (!meta) throw new Error('Модель не найдена');
        const bytes = await readUserModelFile(store.backend, editing);
        const s = (sess.current = new ImportSession());
        await s.loadPackage(bytes.buffer.slice(0) as ArrayBuffer);
        const p = await parsePackage(bytes.buffer.slice(0) as ArrayBuffer);
        pkg.current = { glb: bytes, scene: p.scene };
        setName(meta.name);
        setProfile(meta.profile);
        setPhase('edit');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('pick');
      }
    })();
  }, []);

  // ---- 3D-предпросмотр
  const rebuild = (p: Profile) => {
    const v = viewer.current;
    const pk = pkg.current;
    if (!v || !pk) return;
    const n = ++buildN.current;
    pk.scene.matrixAutoUpdate = false;
    pk.scene.matrix.copy(frameMatrix(p));
    pk.scene.updateMatrixWorld(true);
    const def: CarModelDef = {
      id: `preview-${n}`,
      name: 'preview',
      description: '',
      defaultColor: color,
      zones: zonesFor(p.body, p.layout),
      defaultMaintenance: [],
      create: async (c) => {
        try {
          return createImportedRig(pk.scene, p, c);
        } catch (e) {
          toast(`Ошибка сборки модели: ${e instanceof Error ? e.message : e}`, 'err');
          throw e;
        }
      },
    };
    v.setModel(def, color, { keepView: n > 1 });
    if (openAll) window.setTimeout(() => v.setAllOpen(true), 400);
  };
  const scheduleRebuild = (p: Profile) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => rebuild(p), 250);
  };

  useEffect(() => {
    if (phase !== 'edit' || !host.current || viewer.current || !profile) return;
    let dead = false;
    void import('../view3d/Viewer').then(({ Viewer }) => {
      if (dead || !host.current) return;
      const v = new Viewer(host.current, { pick: () => undefined, place: () => undefined, openChanged: () => undefined });
      viewer.current = v;
      const ray = new Raycaster();
      let down: { x: number; y: number } | null = null;
      const el = v.renderer.domElement;
      el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
      el.addEventListener('pointerup', (e) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || !pkg.current) return;
        const r = el.getBoundingClientRect();
        ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
        const meshes: Mesh[] = [];
        const info = profRef.current?.parts ?? {};
        pkg.current.scene.traverse((o) => {
          if ((o as Mesh).isMesh && info[o.name]?.k !== 'hide') meshes.push(o as Mesh);
        });
        const hit = ray.intersectObjects(meshes, false)[0];
        if (hit) {
          setSel(hit.object.name);
          setTab('parts');
        }
      });
      rebuild(profile);
    });
    return () => {
      dead = true;
    };
  }, [phase]);

  // подсветка выбранной детали
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    if (overlay.current) {
      v.scene.remove(overlay.current);
      overlay.current = null;
    }
    const src = sel ? (pkg.current?.scene.getObjectByName(sel) as Mesh | undefined) : undefined;
    if (src?.isMesh && profile) {
      const m = new Mesh(src.geometry as BufferGeometry, new MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.65, depthTest: false, side: DoubleSide }));
      m.matrixAutoUpdate = false;
      m.matrix.copy(frameMatrix(profile));
      m.renderOrder = 20;
      v.scene.add(m);
      overlay.current = m;
    }
    v.invalidate();
  }, [sel, profile?.frame.yaw, profile?.frame.scale, phase]);

  useEffect(() => {
    viewer.current?.setColor(color);
  }, [color]);

  // ---- действия
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setTextureEstimate(null);
    if (!/\.glb$/i.test(file.name)) return setError('Нужен файл .glb (бинарный glTF). Другие форматы конвертируются в Blender: File → Export → glTF 2.0 (.glb).');
    if (file.size > MAX_FILE) return setError(`Файл больше ${MAX_FILE >> 20} МБ`);
    const run = ++importRun.current;
    setPhase('busy');
    setProg({ stage: 'Чтение файла', frac: 0 });
    try {
      const data = await file.arrayBuffer();
      if (run !== importRun.current) return;
      const s = (sess.current = new ImportSession());
      const title = file.name.replace(/\.(shtcar\.)?glb$/i, '').slice(0, 80);
      // готовый пакет shtbox (экспорт из приложения / CLI): разметка уже есть — берём как есть
      let ready: Profile | null = null;
      try {
        const { json } = splitGlb(new Uint8Array(data));
        setTextureEstimate(estimatePreservedTextures(json));
        const raw = (json.extras as { shtbox?: unknown } | undefined)?.shtbox;
        if (raw) ready = parseProfile(raw);
      } catch {
        setTextureEstimate(null);
        ready = null;
      }
      if (ready) {
        await s.loadPackage(data.slice(0));
        if (run !== importRun.current) return;
        const p = await parsePackage(data.slice(0));
        if (run !== importRun.current) return;
        pkg.current = { glb: new Uint8Array(data), scene: p.scene };
        setProfile(ready);
        setName(ready.title || title);
        setPhase('edit');
        return;
      }
      const r = await s.importFile(data, title, undefined, (stage, frac) => {
        if (run === importRun.current) setProg({ stage, frac });
      }, { preserveTextures });
      if (run !== importRun.current) return;
      const p = await parsePackage(r.glb.buffer.slice(r.glb.byteOffset, r.glb.byteOffset + r.glb.byteLength) as ArrayBuffer);
      if (run !== importRun.current) return;
      pkg.current = { glb: r.glb, scene: p.scene };
      setProfile(r.profile);
      setName(title);
      setStats(r.stats);
      setWarnings(r.warnings);
      setPhase('edit');
    } catch (e) {
      if (run !== importRun.current || e instanceof ImportCancelledError) return;
      sess.current?.close();
      sess.current = null;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('pick');
    }
  };

  const cancelImport = () => {
    importRun.current++;
    sess.current?.close();
    sess.current = null;
    setTextureEstimate(null);
    setError('Импорт отменён. Исходный файл не изменён.');
    setPhase('pick');
  };

  const reanalyze = async (patch: Partial<AnalyzeHint>) => {
    const p = profRef.current;
    if (!p || !sess.current) return;
    setBusy(true);
    try {
      const next = await sess.current.analyze(name, hintOf(p, patch));
      next.credits = p.credits;
      next.hinges = p.hinges;
      const maskScale = next.frame.scale / p.frame.scale;
      next.panelRegions = p.panelRegions?.map((region) => ({
        ...region,
        zone: next.body === 'coupe' && region.zone === 'door_rl' ? 'door_fl'
          : next.body === 'coupe' && region.zone === 'door_rr' ? 'door_fr'
            : next.body === 'hatch' && region.zone === 'rear_glass' ? 'trunk' : region.zone,
        minAbsZ: region.minAbsZ === undefined ? undefined : region.minAbsZ * maskScale,
        points: region.points.map(([x, y]) => [x * maskScale, y * maskScale]),
      }));
      next.provenance = {
        dimensions: p.provenance?.dimensions ?? 'auto',
        dimensionsConfidence: p.provenance?.dimensionsConfidence ?? 'low',
        panelBoundaries: p.provenance?.panelBoundaries ?? 'auto',
        panelBoundariesConfidence: p.provenance?.panelBoundariesConfidence ?? 'low',
        reference: p.provenance?.reference,
      };
      if (patch.length !== undefined) { next.provenance.dimensions = 'manual'; next.provenance.dimensionsConfidence = 'medium'; }
      if (patch.body !== undefined) { next.provenance.panelBoundaries = 'manual'; next.provenance.panelBoundariesConfidence = 'medium'; }
      setProfile(next);
      rebuild(next);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Ошибка анализа', 'err');
    } finally {
      setBusy(false);
    }
  };

  const edit = (fn: (p: Profile) => Profile, now = false, provenance?: 'dimensions' | 'panels', render = true) => {
    const p = profRef.current;
    if (!p) return;
    const next = fn(structuredClone(p));
    if (provenance) {
      const key = provenance === 'dimensions' ? 'dimensions' : 'panelBoundaries';
      const confidenceKey = provenance === 'dimensions' ? 'dimensionsConfidence' : 'panelBoundariesConfidence';
      next.provenance = {
        dimensions: next.provenance?.dimensions ?? 'auto',
        dimensionsConfidence: next.provenance?.dimensionsConfidence ?? 'low',
        panelBoundaries: next.provenance?.panelBoundaries ?? 'auto',
        panelBoundariesConfidence: next.provenance?.panelBoundariesConfidence ?? 'low',
        reference: next.provenance?.reference,
        [key]: 'manual',
        [confidenceKey]: 'medium',
      };
    }
    setProfile(next);
    if (render) {
      if (now) rebuild(next);
      else scheduleRebuild(next);
    }
  };

  const updateProvenance = (patch: Partial<NonNullable<Profile['provenance']>>) => edit((p) => {
    p.provenance = { dimensions: 'auto', dimensionsConfidence: 'low', panelBoundaries: 'auto', panelBoundariesConfidence: 'low', ...p.provenance, ...patch };
    return p;
  }, false, undefined, false);

  const setPart = (id: string, patch: Partial<PartInfo>) =>
    edit((p) => {
      p.parts[id] = { ...p.parts[id], ...patch, u: 1 };
      delete p.parts[id].confidence;
      if (patch.z === '') delete p.parts[id].z;
      return p;
    }, true, 'panels');

  const save = async () => {
    const p = profRef.current;
    const pk = pkg.current;
    if (!p || !pk) return;
    const finalName = name.trim() || p.title;
    const prof: Profile = { ...p, title: finalName };
    const bytes = patchProfile(pk.glb, prof);
    const id = editing ?? ui.replaceId.value ?? `${USER_PREFIX}${uid()}`;
    const ok = await guard(
      saveUserModel(store.backend, { id, name: finalName, body: prof.body, layout: prof.layout, size: bytes.byteLength, created: new Date().toISOString(), profile: prof }, bytes).then(() => true),
    );
    if (!ok) return;
    toast('Модель сохранена');
    const back = ui.importReturn.value;
    const fromBanner = ui.replaceId.value !== null;
    ui.editModel.value = null;
    ui.replaceId.value = null;
    ui.modelsRev.value++;
    if (back) ui.importReturn.value = { modelId: id };
    ui.dialog.value = back ? 'car-new' : fromBanner ? null : 'models';
  };

  const download = () => {
    const p = profRef.current;
    const pk = pkg.current;
    if (!p || !pk) return;
    const bytes = patchProfile(pk.glb, { ...p, title: name.trim() || p.title });
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || 'model').replace(/[^\w.-]+/g, '_')}.shtcar.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const zones = useMemo(() => (profile ? zonesFor(profile.body, profile.layout) : []), [profile?.body, profile?.layout]);
  const materials = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of Object.values(profile?.parts ?? {})) m.set(i.m, (m.get(i.m) ?? 0) + 1);
    return [...m.entries()];
  }, [profile]);

  // ---------- разметка ----------
  return (
    <div class="wizard" role="dialog" aria-label="Импорт модели">
      <div class="wizard-view">
        <div class="viewer-host" ref={host} />
        {phase !== 'edit' && <div class="viewer-msg">Предпросмотр появится после обработки файла</div>}
        {phase === 'edit' && (
          <div class="wiz-bar">
            <button class="btn btn-glass" onClick={() => (setOpenAll(!openAll), viewer.current?.setAllOpen(!openAll))}>{openAll ? 'Закрыть всё' : 'Открыть всё'}</button>
            <button class="btn btn-glass" onClick={() => viewer.current?.view('iso')}>Вид</button>
            <input type="color" value={color} aria-label="Цвет предпросмотра" onInput={(e) => setColor((e.target as HTMLInputElement).value)} />
            {busy && <span class="hint">Пересчёт…</span>}
          </div>
        )}
      </div>
      <div class="wizard-panel">
        <header class="wizard-head">
          <h2>{editing ? 'Разметка модели' : 'Загрузить свою модель'}</h2>
          <button class="btn btn-ghost" onClick={close} aria-label="Закрыть">✕</button>
        </header>

        {phase === 'pick' && (
          <div class="wizard-body">
            <p class="hint">
              Выберите файл <b>.glb</b> (до {MAX_FILE >> 20} МБ). Обработка идёт прямо в браузере, файл никуда не отправляется. Модель будет упрощена, колёса, стёкла и панели кузова определятся
              автоматически — потом всё можно поправить.
            </p>
            <label class="btn btn-primary wizard-file">
              Выбрать .glb…
              <input type="file" accept=".glb,model/gltf-binary" hidden onChange={(e) => void onFile((e.target as HTMLInputElement).files?.[0])} />
            </label>
            <label class="check">
              <input type="checkbox" checked={preserveTextures} onChange={(e) => setPreserveTextures((e.target as HTMLInputElement).checked)} />
              Сохранять встроенные текстуры кузова
            </label>
            <p class="hint">Необязательно: сохраняются встроенные PNG/JPEG/WebP-текстуры цвета и UV-координаты (лимит 32 МиБ). Пакет увеличится примерно на объём сохранённых изображений; во время упаковки дополнительно может понадобиться около 2× этого объёма памяти (до ~64 МиБ), не считая геометрии и исходника. Остальные карты материала остаются упрощёнными; файл не отправляется в сеть.</p>
            {textureEstimate && <p class="hint" role="status">В этом GLB найдено примерно {mib(textureEstimate.bytes)} поддерживаемых текстур цвета ({textureEstimate.textures} шт.).{textureEstimate.omitted ? ` Ещё ${textureEstimate.omitted} текстур не войдут в лимит.` : ''}</p>}
            {error && <p class="form-error" role="alert">{error}</p>}
            <p class="hint">
              Если у модели есть готовая разметка shtbox (файл «пакет» <code>.shtcar.glb</code> из этого приложения), она подхватится сразу. Формат для Blender —
              в <code>docs/ADDING_MODELS.md</code>.
            </p>
          </div>
        )}

        {phase === 'busy' && (
          <div class="wizard-body">
            <p>{prog.stage}…</p>
            <progress max={1} value={prog.frac} style="width:100%" />
            {textureEstimate && <p class="hint" role="status">
              {preserveTextures
                ? `Сохранение включено: ${mib(textureEstimate.bytes)} текстур цвета добавят примерно столько же к пакету и около ${mib(textureEstimate.bytes * 2)} временной памяти сверх геометрии.`
                : `Сохранение выключено. Если включить, в этом GLB будет добавлено около ${mib(textureEstimate.bytes)} текстур; ориентир временной памяти — ещё ${mib(textureEstimate.bytes * 2)} сверх геометрии.`}
              {textureEstimate.omitted ? ` Ещё ${textureEstimate.omitted} текстур не войдут в лимит.` : ''}
            </p>}
            <div class="form-actions">
              <button class="btn" onClick={cancelImport}>Отменить импорт</button>
            </div>
          </div>
        )}

        {phase === 'edit' && profile && (
          <>
            <nav class="tabs" role="tablist">
              {TABS.map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} class={`tab ${tab === id ? 'tab-on' : ''}`} onClick={() => setTab(id)}>{label}</button>
              ))}
            </nav>
            <div class="wizard-body">
              {tab === 'orient' && (
                <>
                  <p class="hint">Проверьте, что машина стоит на колёсах, а носом смотрит вперёд (там, где фары). Размеры: {profile.dims.L.toFixed(2)} × {profile.dims.W.toFixed(2)} × {profile.dims.H.toFixed(2)} м, колёсная база {(profile.dims.axleF - profile.dims.axleR).toFixed(2)} м.</p>
                  <div class="row2">
                    <button class="btn" disabled={busy} onClick={() => void reanalyze({ yaw: (profile.frame.yaw + 180) % 360 })}>⇄ Перед ↔ зад</button>
                    <button class="btn" disabled={busy} onClick={() => void reanalyze({ yaw: (profile.frame.yaw + 90) % 360 })}>↻ Повернуть на 90°</button>
                  </div>
                  <Field label="Длина автомобиля, м" hint="Масштаб определён по колёсам; если размеры не те — укажите длину.">
                    <input
                      type="number" step="0.01" min="2" max="9" value={profile.dims.L.toFixed(2)}
                      onChange={(e) => {
                        const n = Number((e.target as HTMLInputElement).value);
                        if (n >= 2 && n <= 9) void reanalyze({ length: n, scale: undefined });
                      }}
                    />
                  </Field>
                  <Field label="Тип кузова">
                    <select value={profile.body} onChange={(e) => void reanalyze({ body: (e.target as HTMLSelectElement).value as BodyType })}>
                      <option value="sedan">Седан (4 двери, багажник)</option>
                      <option value="hatch">Хэтчбек / универсал (4 двери, задняя дверь)</option>
                      <option value="coupe">Купе (2 двери)</option>
                    </select>
                  </Field>
                  <div class="row2">
                    <Field label="Двигатель">
                      <select value={profile.layout} onChange={(e) => edit((p) => ((p.layout = (e.target as HTMLSelectElement).value as 'front' | 'rear'), p), true)}>
                        <option value="front">Спереди (под капотом)</option>
                        <option value="rear">Сзади (заднемоторная компоновка)</option>
                      </select>
                    </Field>
                    <Field label="Руль">
                      <select value={profile.driver} onChange={(e) => edit((p) => ((p.driver = (e.target as HTMLSelectElement).value as 'l' | 'r'), p), true)}>
                        <option value="l">Слева</option>
                        <option value="r">Справа</option>
                      </select>
                    </Field>
                  </div>
                </>
              )}

              {tab === 'paint' && (
                <>
                  <p class="hint">Отметьте материалы, которые являются краской кузова: они будут перекрашиваться выбранным цветом и на них можно ставить метки ржавчины, сколов и вмятин. Остальное сохранит цвет модели.</p>
                  {materials.map(([m, n]) => (
                    <label class="check" key={m}>
                      <input
                        type="checkbox" checked={profile.paint.includes(m)} disabled={busy}
                        onClick={() => void reanalyze({ paint: profile.paint.includes(m) ? profile.paint.filter((x) => x !== m) : [...profile.paint, m] })}
                      />
                      {m} <span class="hint">· деталей: {n}</span>
                    </label>
                  ))}
                  <Field label="Цвет для проверки">
                    <input type="color" value={color} onInput={(e) => setColor((e.target as HTMLInputElement).value)} />
                  </Field>
                </>
              )}

              {tab === 'parts' && (
                <>
                  <p class="hint">Кликните по детали на модели — она подсветится в списке. «Авто» определяет узел по положению; можно назначить узел вручную или скрыть деталь. Если двери/капот вырезались неровно — подвиньте границы.</p>
                  <details>
                    <summary>Границы панелей</summary>
                    <div class="lines">
                      {LINE_LABEL.filter(([k]) => !(profile.body === 'coupe' && k === 'doorSplit')).map(([k, label, t]) => {
                        const D = profile.dims;
                        const [lo, hi] = t === 'x' ? [D.xRear, D.xFront] : t === 'y' ? [0, D.H] : [0.2, D.W / 2];
                        return (
                          <label class="field" key={k}>
                            <span class="field-label">{label}: {profile.lines[k].toFixed(2)}</span>
                            <input type="range" min={lo} max={hi} step="0.01" value={profile.lines[k]} onInput={(e) => edit((p) => ((p.lines[k] = Number((e.target as HTMLInputElement).value)), p), false, 'panels')} />
                          </label>
                        );
                      })}
                    </div>
                  </details>
                  <PanelRegionEditor
                    profile={profile}
                    disabled={busy}
                    onAdd={(regions) => edit((p) => ((p.panelRegions = [...(p.panelRegions ?? []), ...regions]), p), true, 'panels')}
                    onDelete={(index) => edit((p) => ((p.panelRegions = (p.panelRegions ?? []).filter((_, i) => i !== index)), p), true, 'panels')}
                  />
                  <input placeholder="Фильтр деталей…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
                  <div class="parts">
                    {Object.entries(profile.parts)
                      .filter(([id, i]) => !filter || `${i.n} ${i.m} ${id}`.toLowerCase().includes(filter.toLowerCase()))
                      .map(([id, i]) => (
                        <div key={id} class={`part ${sel === id ? 'part-on' : ''} ${i.k === 'hide' ? 'part-hidden' : ''}`} ref={(el) => void (sel === id && el?.scrollIntoView({ block: 'nearest' }))} onClick={() => setSel(sel === id ? null : id)}>
                          <div class="part-name" title={`${i.n} · ${i.m}`}>
                            {i.n} <span class="hint">{i.m}</span>
                            <span class="hint" title={i.u ? 'Назначено вручную' : 'Оценка эвристической авторазметки, не измеренная точность'}>
                              {i.u ? '· вручную' : `· авто: ${CONFIDENCE_OPTIONS.find(([value]) => value === i.confidence)?.[1] ?? 'Низкая уверенность'}`}
                            </span>
                          </div>
                          <select value={i.k} onClick={(e) => e.stopPropagation()} onChange={(e) => setPart(id, { k: (e.target as HTMLSelectElement).value as Kind })} aria-label="Тип детали">
                            {KINDS.map((k) => <option value={k} key={k}>{KIND_LABEL[k]}</option>)}
                          </select>
                          <select value={i.z ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => setPart(id, { z: (e.target as HTMLSelectElement).value })} aria-label="Узел" disabled={i.k === 'hide'}>
                            <option value="">Авто</option>
                            {zones.filter((z) => !z.virtual).map((z) => <option value={z.id} key={z.id}>{z.label}</option>)}
                          </select>
                        </div>
                      ))}
                  </div>
                </>
              )}

              {tab === 'done' && (
                <>
                  <Field label="Название модели">
                    <input value={name} maxLength={80} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
                  </Field>
                  <Field label="Автор модели" hint="Если модель не ваша — укажите автора и лицензию (например, CC BY 4.0): это требование большинства лицензий.">
                    <input value={profile.credits?.author ?? ''} maxLength={200} onInput={(e) => edit((p) => ((p.credits = { ...p.credits, author: (e.target as HTMLInputElement).value }), p), false)} />
                  </Field>
                  <div class="row2">
                    <Field label="Лицензия">
                      <input value={profile.credits?.license ?? ''} maxLength={120} onInput={(e) => edit((p) => ((p.credits = { ...p.credits, license: (e.target as HTMLInputElement).value }), p), false)} />
                    </Field>
                    <Field label="Источник модели (ссылка)">
                      <input value={profile.credits?.source ?? ''} maxLength={300} onInput={(e) => edit((p) => ((p.credits = { ...p.credits, source: (e.target as HTMLInputElement).value }), p), false)} />
                    </Field>
                  </div>
                  <div class="row2">
                    <Field label="Источник размеров">
                      <select value={profile.provenance?.dimensions ?? 'auto'} onChange={(e) => updateProvenance({ dimensions: (e.target as HTMLSelectElement).value as DataProvenance })}>
                        {PROVENANCE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </Field>
                    <Field label="Источник границ панелей">
                      <select value={profile.provenance?.panelBoundaries ?? 'auto'} onChange={(e) => updateProvenance({ panelBoundaries: (e.target as HTMLSelectElement).value as DataProvenance })}>
                        {PROVENANCE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </Field>
                  </div>
                  <div class="row2">
                    <Field label="Уверенность в размерах">
                      <select value={profile.provenance?.dimensionsConfidence ?? 'low'} onChange={(e) => updateProvenance({ dimensionsConfidence: (e.target as HTMLSelectElement).value as DataConfidence })}>
                        {CONFIDENCE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </Field>
                    <Field label="Уверенность в границах панелей">
                      <select value={profile.provenance?.panelBoundariesConfidence ?? 'low'} onChange={(e) => updateProvenance({ panelBoundariesConfidence: (e.target as HTMLSelectElement).value as DataConfidence })}>
                        {CONFIDENCE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </Field>
                  </div>
                  <Field label="Документ / ссылка для сверки" hint="Указывайте CoC, руководство или источник проверки. Выберите OEM только после фактической сверки.">
                    <input value={profile.provenance?.reference ?? ''} maxLength={300} onInput={(e) => updateProvenance({ reference: (e.target as HTMLInputElement).value })} />
                  </Field>
                  {stats && (
                    <p class="hint">
                      Исходно {stats.srcTris.toLocaleString('ru')} треугольников → {stats.tris.toLocaleString('ru')}, деталей: {stats.parts}, пакет {(stats.bytes / 1048576).toFixed(1)} МБ. Модель хранится только на этом устройстве.
                    </p>
                  )}
                  {warnings.map((w) => <p class="hint" key={w}>⚠ {w}</p>)}
                  <div class="form-actions">
                    <button class="btn btn-primary" onClick={() => void save()}>{editing ? 'Сохранить' : 'Сохранить и использовать'}</button>
                    <button class="btn" onClick={download}>Скачать пакет (.glb)</button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
