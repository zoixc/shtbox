/**
 * Мастер импорта модели: файл → обработка в Worker → разметка (ориентация, краска, узлы) → сохранение.
 * Загружается лениво: three.js, meshoptimizer и gltf-transform не попадают в стартовый бандл.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Box3, BufferGeometry, DoubleSide, GridHelper, Group, Material, Matrix4, Mesh, MeshBasicMaterial, Object3D, OctahedronGeometry, Quaternion, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import type { Viewer } from '../view3d/Viewer';
import { uid } from '../core/id';
import { patchProfile, splitGlb } from '../import/container';
import { estimatePreservedTextures } from '../import/texture-estimate';
import { ImportSession } from '../import/client';
import { filesToGlb, type SourceFile } from '../import/sources';
import { clearDraft, createHistory, loadDraft, loadPose, saveDraft, savePose, sourceKey } from '../import/history';
import { dragHinge, dragLine, mirrorHinge, mirrorRegion, mirrorZone, normalizePose } from '../import/gizmo';
import { centerProfile, groundProfile, runChecks, type Box3Like } from '../import/inspect';
import { buildReport, reportRows } from '../import/report';
import { applyPreset, deletePreset, loadPresets, makePreset, presetFromJson, presetToJson, savePreset } from '../import/presets';
import type { Preset } from '../import/presets';
import type { ImportOutcome } from '../import/client';
import { ImportCancelledError } from '../import/client';
import type { AnalyzeHint } from '../import/analyze';
import type { BodyType, DataConfidence, DataProvenance, HingeOverride, InteriorMode, Kind, Lines, PanelRegion, PartInfo, Profile } from '../import/types';
import { INTERIOR_MODES, KIND_LABEL, KINDS } from '../import/types';
import { parseProfile } from '../import/profile';
import { zonesFor } from '../import/zoneset';
import { createImportedRig, parsePackage } from '../models/imported';
import { USER_PREFIX, readUserModelFile, saveUserModel, userModels } from '../models/user';
import { PaintPicker } from './PaintPicker';
import type { PaintFinish } from '../data/paintFinish';
import type { CarModelDef } from '../models/types';
import { guard, store, toast, ui } from '../state';
import { Field } from './common';
import { PanelEditor } from './PanelEditor';
import type { ArmTarget, DragTarget, HingeView } from './PanelEditor';
import { ImportGizmo } from '../view3d/importGizmo';
import { PanelRegionEditor } from './PanelRegionEditor';

const MAX_FILE = 60 * 1024 * 1024;
/** Бюджет треугольников для автоупрощения: тот же смысл, что `DEFAULT_BUDGET` в конвейере. */
const DETAIL_LEVELS: [number, string][] = [
  [60_000, 'Экономно — до 60 тыс. треугольников'],
  [130_000, 'Обычно — до 130 тыс.'],
  [300_000, 'Подробно — до 300 тыс.'],
];
type Tab = 'orient' | 'paint' | 'parts' | 'panels' | 'done';
const TABS: [Tab, string][] = [
  ['orient', 'Ориентация'],
  ['paint', 'Краска'],
  ['parts', 'Узлы'],
  ['panels', 'Панели'],
  ['done', 'Готово'],
];
const INTERIOR_LABEL: Record<InteriorMode, string> = {
  fill: 'Из модели, недостающее — достроить',
  model: 'Только то, что есть в модели',
  template: 'Заменить процедурным салоном',
  none: 'Без салона',
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

/** Ставит гизмо на петлю или на плоскость реза (или снимает его, если режим выключен). */
const attachGizmo = (
  gizmo: ImportGizmo,
  drag: DragTarget | null,
  profile: Profile,
  marks: { zone: string; p: [number, number, number] }[],
): void => {
  if (!drag) {
    gizmo.detach();
    return;
  }
  if (drag.kind === 'line') {
    gizmo.attach({ kind: 'line', key: drag.key, value: profile.lines[drag.key] }, profile.dims);
    return;
  }
  const axis = (['x', 'y', 'z'] as const)[drag.axis];
  const mark = marks.find((m) => m.zone === drag.zone);
  const override = profile.hinges?.[drag.zone];
  gizmo.attach(
    {
      kind: 'hinge',
      zone: drag.zone,
      axis,
      position: [override?.x ?? mark?.p[0] ?? 0, override?.y ?? mark?.p[1] ?? 0, override?.z ?? mark?.p[2] ?? 0],
    },
    profile.dims,
  );
};

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
  const [colorCode, setColorCode] = useState('');
  const [finish, setFinish] = useState<PaintFinish | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [openAll, setOpenAll] = useState(false);
  const [stats, setStats] = useState<ImportOutcome['stats'] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [preserveTextures, setPreserveTextures] = useState(false);
  const [budget, setBudget] = useState(DETAIL_LEVELS[1][0]);
  const [textureEstimate, setTextureEstimate] = useState<{ bytes: number; textures: number; omitted: number } | null>(null);
  const [panelZone, setPanelZone] = useState('door_fl');
  const [armed, setArmed] = useState<ArmTarget | null>(null);
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pose, setPose] = useState<string[]>([]);
  const [marksRev, setMarksRev] = useState(0);
  const [pick, setPick] = useState<[number, number, number] | null>(null);
  const [histState, setHistState] = useState({ undo: false, redo: false });
  const [box, setBox] = useState<Box3Like | null>(null);
  const [ruler, setRuler] = useState(false);
  const [draftInfo, setDraftInfo] = useState<{ savedAt: number } | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState('');
  const history = useRef(createHistory<Profile>());
  const draftSource = useRef('');
  const draftTimer = useRef(0);

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
  /** точки петель из последней сборки: зона → позиция, ось, угол */
  const marks = useRef<{ zone: string; p: [number, number, number]; axis: 'x' | 'y' | 'z'; angle: number }[]>([]);
  const marksGroup = useRef<Group | null>(null);
  const armedRef = useRef<ArmTarget | null>(null);
  armedRef.current = armed;
  const dragRef = useRef<DragTarget | null>(null);
  dragRef.current = drag;
  const draggingRef = useRef(false);
  const poseRef = useRef<string[]>([]);
  poseRef.current = pose;
  const gizmoRef = useRef<ImportGizmo | null>(null);
  const poseApplied = useRef(false);
  const gizmoPreview = useRef<(value: number) => number | void>(() => undefined);
  const gizmoCommit = useRef<(value: number) => void>(() => undefined);
  const drawMarksRef = useRef<(() => void) | null>(null);
  const panelZoneRef = useRef(panelZone);
  panelZoneRef.current = panelZone;

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
      clearTimeout(draftTimer.current);
      if (profRef.current && draftSource.current) persistDraft(profRef.current, true);
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
        setColor(meta.profile.color ?? '#b9bec6');
        setColorCode(meta.profile.colorCode ?? '');
        setFinish(meta.profile.finish ?? null);
        draftSource.current = `model:${editing}`;
        await restoreDraft(meta.name);
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
      defaultFinish: finish ?? undefined,
      zones: zonesFor(p.body, p.layout),
      defaultMaintenance: [],
      create: async (c) => {
        try {
          const rig = createImportedRig(pk.scene, p, c, finish ?? undefined);
          // габарит в системе автомобиля: по нему работают проверки «на земле», симметрия и размеры
          try {
            const b = new Box3().setFromObject(rig.root);
            setBox({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] });
          } catch {
            setBox(null);
          }
          // запоминаем фактические петли, чтобы показать их в редакторе и на модели
          marks.current = [...rig.openables].map(([zone, open]) => ({
            zone,
            p: [open.pivot.position.x, open.pivot.position.y, open.pivot.position.z],
            axis: Math.abs(open.axis.x) > 0.5 ? 'x' : Math.abs(open.axis.y) > 0.5 ? 'y' : 'z',
            angle: open.angle,
          }));
          return rig;
        } catch (e) {
          toast(`Ошибка сборки модели: ${e instanceof Error ? e.message : e}`, 'err');
          throw e;
        }
      },
    };
    v.setModel(def, color, { keepView: n > 1, finish: finish ?? undefined });
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
      const v = new Viewer(host.current, {
        pick: () => undefined,
        place: () => undefined,
        openChanged: () => undefined,
        modelReady: () => {
          drawMarks();
          setMarksRev((n) => n + 1);
          if (!poseApplied.current && poseRef.current.length) {
            poseApplied.current = true;
            applyPoseRef.current?.(poseRef.current, false);
          }
        },
      });
      viewer.current = v;
      const gizmo = new ImportGizmo(v.scene, v.camera, v.renderer.domElement, v.controls, {
        onPreview: (value) => gizmoPreview.current(value),
        onCommit: (value) => gizmoCommit.current(value),
        onDragging: (value) => {
          draggingRef.current = value;
          setDragging(value);
          if (value) setArmed(null);
          v.invalidate();
        },
      });
      gizmoRef.current = gizmo;
      const ray = new Raycaster();
      let down: { x: number; y: number } | null = null;
      const el = v.renderer.domElement;
      const drawMarks = () => {
        if (marksGroup.current) {
          v.scene.remove(marksGroup.current);
          marksGroup.current.clear();
        }
        const group = new Group();
        group.name = 'hinge-marks';
        for (const mark of marks.current) {
          const active = mark.zone === panelZoneRef.current;
          const dot = new Mesh(
            new (active ? OctahedronGeometry : SphereGeometry)(active ? 0.06 : 0.035, 8),
            new MeshBasicMaterial({ color: active ? 0xff8a1f : 0x6fd0ff, transparent: true, opacity: active ? 1 : 0.75, depthTest: false }),
          );
          dot.position.set(mark.p[0], mark.p[1], mark.p[2]);
          dot.renderOrder = 30;
          group.add(dot);
        }
        marksGroup.current = group;
        v.scene.add(group);
        v.invalidate();
      };
      drawMarksRef.current = drawMarks;
      el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
      el.addEventListener('pointerup', (e) => {
        if (draggingRef.current || dragRef.current) return;
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || !pkg.current) return;
        const r = el.getBoundingClientRect();
        ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), v.camera);
        const meshes: Mesh[] = [];
        const info = profRef.current?.parts ?? {};
        pkg.current.scene.traverse((o) => {
          if ((o as Mesh).isMesh && info[o.name]?.k !== 'hide') meshes.push(o as Mesh);
        });
        const hits = ray.intersectObjects(meshes, false);
        const hit = hits[0];
        // точка попадания в системе автомобиля: сцена уже повёрнута матрицей frame
        if (hit) setPick([hit.point.x, hit.point.y, hit.point.z]);
        const target = armedRef.current;
        if (target) {
          if (!hit) return;
          setArmed(null);
          if (target.kind === 'line') {
            const p0 = profRef.current;
            if (!p0) return;
            const D = p0.dims;
            const byHeight = target.key === 'sill' || target.key === 'belt' || target.key === 'bumperTopF' || target.key === 'bumperTopR';
            const byWidth = target.key === 'hoodHw' || target.key === 'trunkHw';
            const value = byHeight ? hit.point.y : byWidth ? Math.abs(hit.point.z) : hit.point.x;
            const slot = byHeight ? [0.01, D.H] : byWidth ? [0.15, D.W / 2] : [D.xRear, D.xFront];
            if (value >= slot[0] && value <= slot[1]) setLine(target.key, Number(value.toFixed(3)));
            else toast('Точка вне допустимого диапазона — кликните ближе к кузову', 'err');
          } else {
            applyHinge(target.zone, { [target.axis === 0 ? 'x' : target.axis === 1 ? 'y' : 'z']: Number(hit.point[target.axis === 0 ? 'x' : target.axis === 1 ? 'y' : 'z'].toFixed(3)) });
          }
          return;
        }
        if (hit) {
          setSel(hit.object.name);
          setTab('parts');
        }
      });
      attachGizmo(gizmo, dragRef.current, profile, marks.current);
      rebuild(profile);
    });
    return () => {
      dead = true;
      gizmoRef.current?.dispose();
      gizmoRef.current = null;
    };
  }, [phase]);

  // гизмо следует за выбором в панели и за пересборкой модели (петли могли переехать)
  useEffect(() => {
    const gizmo = gizmoRef.current;
    const p = profRef.current;
    if (!gizmo || !p || phase !== 'edit') return;
    attachGizmo(gizmo, drag, p, marks.current);
    viewer.current?.invalidate();
  }, [drag, marksRev, phase]);

  // сохранённая поза открытых панелей подтягивается один раз при входе в редактор
  useEffect(() => {
    if (phase !== 'edit') return;
    void loadPose(store)
      .then((saved) => {
        setPose(saved);
        // модель уже собрана, а поза пришла позже — применяем её сразу, один раз
        if (saved.length && !poseApplied.current && viewer.current) {
          poseApplied.current = true;
          applyPoseRef.current?.(saved, false);
        }
      })
      .catch(() => undefined);
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

  // покрытие примеряем на месте, без пересборки модели
  useEffect(() => {
    viewer.current?.setFinish(finish ?? profile?.finish ?? 'satin');
  }, [finish, phase, profile?.finish]);

  // маркеры петель: подсвечиваем выбранную панель
  useEffect(() => {
    drawMarksRef.current?.();
  }, [panelZone, marksRev, tab]);

  // выбранная панель должна существовать для текущего типа кузова
  useEffect(() => {
    if (!profile) return;
    const openable = zonesFor(profile.body, profile.layout).filter((z) => z.openable).map((z) => z.id);
    if (!openable.includes(panelZone) && openable.length) setPanelZone(openable[0]);
  }, [profile?.body, profile?.layout]);

  // ---- действия
  const onFiles = async (picked: File[] | undefined) => {
    if (!picked?.length) return;
    setError('');
    setTextureEstimate(null);
    if (!picked.some((file) => /\.(glb|gltf|zip)$/i.test(file.name))) {
      return setError('Нужны файлы .glb, .gltf (вместе с .bin и текстурами) или .zip. Другие форматы конвертируются в Blender: File → Export → glTF 2.0.');
    }
    const totalSize = picked.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_FILE) return setError(`Файлы больше ${MAX_FILE >> 20} МБ — уменьшите модель или сохраните её как .glb`);
    const run = ++importRun.current;
    setPhase('busy');
    setProg({ stage: 'Чтение файла', frac: 0 });
    try {
      const sources: SourceFile[] = [];
      for (const file of picked) {
        sources.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        if (run !== importRun.current) return;
      }
      draftSource.current = sourceKey(picked);
      const converted = filesToGlb(sources);
      const extraWarnings = converted.warnings;
      const data = converted.glb;
      const dataBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const s = (sess.current = new ImportSession());
      const title = (converted.name || picked.find((file) => /\.(glb|gltf)$/i.test(file.name))?.name || picked[0].name)
        .replace(/\.(shtcar\.)?(glb|gltf|zip)$/i, '')
        .slice(0, 80);
      // готовый пакет shtbox (экспорт из приложения / CLI): разметка уже есть — берём как есть
      let ready: Profile | null = null;
      try {
        const { json } = splitGlb(data);
        setTextureEstimate(estimatePreservedTextures(json));
        const raw = (json.extras as { shtbox?: unknown } | undefined)?.shtbox;
        if (raw) ready = parseProfile(raw);
      } catch {
        setTextureEstimate(null);
        ready = null;
      }
      if (ready) {
        await s.loadPackage(dataBuffer);
        if (run !== importRun.current) return;
        const p = await parsePackage(dataBuffer);
        if (run !== importRun.current) return;
        pkg.current = { glb: new Uint8Array(dataBuffer), scene: p.scene };
        setProfile(ready);
        setName(ready.title || title);
        await restoreDraft(ready.title || title);
        setPhase('edit');
        return;
      }
      const r = await s.importFile(dataBuffer, title, undefined, (stage, frac) => {
        if (run === importRun.current) setProg({ stage, frac });
      }, { preserveTextures, budget });
      if (run !== importRun.current) return;
      const p = await parsePackage(r.glb.buffer.slice(r.glb.byteOffset, r.glb.byteOffset + r.glb.byteLength) as ArrayBuffer);
      if (run !== importRun.current) return;
      pkg.current = { glb: r.glb, scene: p.scene };
      setProfile(r.profile);
      setName(title);
      setStats(r.stats);
      setWarnings([...extraWarnings, ...r.warnings]);
      history.current.reset();
      syncHistory();
      await restoreDraft(title);
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

  const reanalyze = async (patch: Partial<AnalyzeHint>, base?: Profile) => {
    const p = base ?? profRef.current;
    if (!p || !sess.current) return;
    setBusy(true);
    try {
      const next = await sess.current.analyze(name, hintOf(p, patch));
      next.credits = p.credits;
      next.hinges = p.hinges;
      next.interior = p.interior;
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
      history.current.push(p);
      setProfile(next);
      persistDraft(next);
      syncHistory();
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
    history.current.push(p);
    setProfile(next);
    persistDraft(next);
    syncHistory();
    if (render) {
      if (now) rebuild(next);
      else scheduleRebuild(next);
    }
  };

  const syncHistory = () => setHistState({ undo: history.current.canUndo, redo: history.current.canRedo });

  // ---- пресеты разметки: перенос разметки на другую модель той же машины
  useEffect(() => {
    void loadPresets(store)
      .then((list) => {
        setPresets(list);
        setPresetId((current) => (list.some((preset) => preset.id === current) ? current : list[0]?.id ?? ''));
      })
      .catch(() => undefined);
  }, []);

  const refreshPresets = (list: Preset[], selectId?: string) => {
    setPresets(list);
    setPresetId(selectId ?? list[0]?.id ?? '');
  };

  const applySelectedPreset = () => {
    const p = profRef.current;
    const preset = presets.find((item) => item.id === presetId);
    if (!p || !preset) return;
    const { profile: next, changes } = applyPreset(p, preset.profile);
    edit(() => next, true);
    toast(`Пресет «${preset.name}»: ${changes.join('; ')}`);
  };

  const saveCurrentPreset = async () => {
    const p = profRef.current;
    if (!p) return;
    const preset = makePreset(p, name.trim() || p.title);
    refreshPresets(await savePreset(store, preset), preset.id);
    toast(`Пресет «${preset.name}» сохранён`);
  };

  const removePreset = async () => {
    if (!presetId) return;
    refreshPresets(await deletePreset(store, presetId));
  };

  const downloadPreset = () => {
    const p = profRef.current;
    if (!p) return;
    const preset = makePreset(p, name.trim() || p.title);
    const url = URL.createObjectURL(new Blob([presetToJson(preset)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(name.trim() || p.title).replace(/[^\w.-]+/g, '_')}.shtpreset.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importPreset = async (file: File | undefined) => {
    if (!file) return;
    try {
      const preset = presetFromJson(await file.text());
      refreshPresets(await savePreset(store, preset), preset.id);
      toast(`Пресет «${preset.name}» загружен`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Не удалось прочитать пресет разметки', 'err');
    }
  };

  /** Черновик пишется с задержкой: правки идут пачками (слайдеры, стрелки). */
  const persistDraft = (next: Profile, immediate = false) => {
    if (!draftSource.current) return;
    const write = () => {
      void saveDraft(store, {
        source: draftSource.current,
        savedAt: Date.now(),
        name: name.trim() || next.title,
        profile: next,
        color,
        colorCode,
        finish,
      })
        .then(() => setDraftInfo({ savedAt: Date.now() }))
        .catch(() => undefined);
    };
    clearTimeout(draftTimer.current);
    if (immediate) write();
    else draftTimer.current = window.setTimeout(write, 800);
  };

  const restoreDraft = async (fallbackName: string) => {
    const draft = await loadDraft(store).catch(() => null);
    if (!draft || draft.source !== draftSource.current) return;
    history.current.reset();
    syncHistory();
    setProfile(draft.profile);
    setName(draft.name || fallbackName);
    setColor(draft.color);
    setColorCode(draft.colorCode);
    setFinish(draft.finish);
    setDraftInfo({ savedAt: draft.savedAt });
    rebuild(draft.profile);
    toast('Черновик разметки восстановлен');
  };

  const discardDraft = () => {
    void clearDraft(store).catch(() => undefined);
    setDraftInfo(null);
  };

  const undo = () => {
    const current = profRef.current;
    const previous = current ? history.current.undo(current) : null;
    if (!previous) return;
    setProfile(previous);
    persistDraft(previous, true);
    syncHistory();
    rebuild(previous);
  };

  const redo = () => {
    const current = profRef.current;
    const next = current ? history.current.redo(current) : null;
    if (!next) return;
    setProfile(next);
    persistDraft(next, true);
    syncHistory();
    rebuild(next);
  };

  const keys = useRef({ undo, redo });
  keys.current = { undo, redo };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) keys.current.redo();
        else keys.current.undo();
      } else if (key === 'y') {
        event.preventDefault();
        keys.current.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // в фазе выбора показываем, есть ли несохранённый черновик
  useEffect(() => {
    if (phase !== 'pick') return;
    void loadDraft(store)
      .then((draft) => setDraftInfo(draft ? { savedAt: draft.savedAt } : null))
      .catch(() => setDraftInfo(null));
  }, [phase]);

  const updateProvenance = (patch: Partial<NonNullable<Profile['provenance']>>) => edit((p) => {
    p.provenance = { dimensions: 'auto', dimensionsConfidence: 'low', panelBoundaries: 'auto', panelBoundariesConfidence: 'low', ...p.provenance, ...patch };
    return p;
  }, false, undefined, false);

  const applyHinge = (zone: string, patch: HingeOverride) =>
    edit((p) => {
      const current = p.hinges?.[zone] ?? {};
      const next: HingeOverride = { ...current, ...patch };
      for (const key of ['x', 'y', 'z', 'angle', 'axis'] as const) if (next[key] === undefined) delete next[key];
      p.hinges = { ...(p.hinges ?? {}), [zone]: next };
      return p;
    }, true, 'panels');

  const resetHinge = (zone: string) =>
    edit((p) => {
      if (p.hinges) {
        delete p.hinges[zone];
        if (!Object.keys(p.hinges).length) delete p.hinges;
      }
      return p;
    }, true, 'panels');

  const setLine = (key: keyof Lines, value: number) =>
    edit((p) => ((p.lines[key] = Number(value.toFixed(3))), p), true, 'panels');

  // --- гизмо: живое значение при перетаскивании и ровно одна запись в историю на отпускание
  gizmoPreview.current = (value: number) => {
    const p = profRef.current;
    const target = dragRef.current;
    if (!p || !target) return value;
    if (target.kind === 'line') {
      const next = dragLine(target.key, value, p.dims);
      gizmoRef.current?.syncLine(target.key, next, p.dims);
      viewer.current?.invalidate();
      return next;
    }
    const axis = (['x', 'y', 'z'] as const)[target.axis];
    const patch = dragHinge(axis, value, p.dims) as Record<string, number>;
    return patch[axis];
  };

  gizmoCommit.current = (value: number) => {
    const p = profRef.current;
    const target = dragRef.current;
    if (!p || !target) return;
    if (target.kind === 'line') {
      const next = dragLine(target.key, value, p.dims);
      if (Math.abs(next - p.lines[target.key]) > 1e-4) setLine(target.key, next);
      else gizmoRef.current?.syncLine(target.key, next, p.dims);
      return;
    }
    const axis = (['x', 'y', 'z'] as const)[target.axis];
    applyHinge(target.zone, dragHinge(axis, value, p.dims));
  };

  /** Переносит петлю и маски панели на парную сторону (слева ↔ справа). */
  const mirrorPanel = (zone: string) => {
    const pair = mirrorZone(zone);
    if (!pair) {
      toast('У этого узла нет парной панели', 'err');
      return;
    }
    edit((p) => {
      const hinge = p.hinges?.[zone];
      const mirrored = hinge ? mirrorHinge(zone, hinge) : null;
      if (mirrored) p.hinges = { ...(p.hinges ?? {}), [pair]: mirrored };
      const regions = p.panelRegions ?? [];
      const copies = regions.filter((region) => region.zone === zone).map(mirrorRegion).filter((region): region is PanelRegion => region !== null);
      if (copies.length) p.panelRegions = [...regions, ...copies].slice(0, 48);
      for (const info of Object.values(p.parts)) if (info.z === zone) info.z = pair;
      return p;
    }, true, 'panels');
    toast(`Разметка «${zone}» перенесена на «${pair}»`);
  };

  /** Какие панели сейчас открыты (для памяти позы). */
  const openZones = (): { open: string[]; known: string[] } => {
    const list = viewer.current?.openableZones() ?? [];
    const known = list.map((z) => z.id);
    return { open: known.filter((id) => viewer.current?.isOpen(id)), known };
  };

  const rememberPose = () => {
    const { open, known } = openZones();
    const next = normalizePose(open, known);
    setPose(next);
    void savePose(store, next);
    toast(next.length ? `Поза запомнена: открыто ${next.length} (${next.join(', ')})` : 'Поза запомнена: все панели закрыты');
  };

  const applyPose = (zones: readonly string[], notify: boolean) => {
    const v = viewer.current;
    if (!v) return;
    const known = v.openableZones().map((z) => z.id);
    const want = normalizePose(zones, known);
    for (const id of known) v.setOpen(id, want.includes(id));
    if (notify) toast(want.length ? `Открыто по позе: ${want.join(', ')}` : 'Все панели закрыты');
  };
  const applyPoseRef = useRef<((zones: readonly string[], notify: boolean) => void) | null>(null);
  applyPoseRef.current = applyPose;

  const setInterior = (mode: InteriorMode) =>
    edit((p) => ((p.interior = mode), p), true, undefined, false);

  /** Возвращает деталь к результату авторазбора: снимаем `u` и пересобираем разметку. */
  const resetPart = (id: string) => {
    const p = profRef.current;
    if (!p) return;
    const next = structuredClone(p);
    if (next.parts[id]) {
      delete next.parts[id].u;
      delete next.parts[id].z;
    }
    setProfile(next);
    persistDraft(next, true);
    void reanalyze({}, next);
  };

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
    // цвет и покрытие, выбранные в мастере, становятся значениями по умолчанию для этой модели
    prof.color = color;
    prof.finish = finish ?? undefined;
    if (colorCode.trim()) prof.colorCode = colorCode.trim();
    else delete prof.colorCode;
    const bytes = patchProfile(pk.glb, prof);
    const id = editing ?? ui.replaceId.value ?? `${USER_PREFIX}${uid()}`;
    const ok = await guard(
      saveUserModel(store.backend, { id, name: finalName, body: prof.body, layout: prof.layout, size: bytes.byteLength, created: new Date().toISOString(), profile: prof }, bytes).then(() => true),
    );
    if (!ok) return;
    draftSource.current = '';
    clearTimeout(draftTimer.current);
    void clearDraft(store).catch(() => undefined);
    setDraftInfo(null);
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
    const bytes = patchProfile(pk.glb, {
      ...p,
      title: name.trim() || p.title,
      color,
      colorCode: colorCode.trim() || undefined,
      finish: finish ?? undefined,
    });
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || 'model').replace(/[^\w.-]+/g, '_')}.shtcar.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  useEffect(() => {
    const v = viewer.current;
    if (!v || !ruler) return;
    const grid = new GridHelper(12, 12, 0x8a8f98, 0x5a5f68);
    grid.position.y = 0.002;
    const material = grid.material as Material;
    material.transparent = true;
    material.opacity = 0.65;
    v.scene.add(grid);
    return () => {
      v.scene.remove(grid);
      grid.geometry.dispose();
      material.dispose();
    };
  }, [ruler, phase]);

  const checks = useMemo(() => (profile ? runChecks(profile, box) : []), [profile, box]);
  const checksWarn = checks.filter((check) => check.level !== 'ok').length;
  const report = useMemo(() => (profile && stats ? buildReport(stats, profile, warnings) : null), [profile, stats, warnings]);

  const zones = useMemo(() => (profile ? zonesFor(profile.body, profile.layout) : []), [profile?.body, profile?.layout]);
  /** текущая петля выбранной панели: правка из профиля или посчитанная сборщиком */
  const hingeView = useMemo<HingeView | null>(() => {
    void marksRev;
    if (!profile) return null;
    const mark = marks.current.find((m) => m.zone === panelZone);
    const ov = profile.hinges?.[panelZone];
    if (!mark && !ov) return null;
    return {
      x: ov?.x ?? mark?.p[0] ?? 0,
      y: ov?.y ?? mark?.p[1] ?? 0,
      z: ov?.z ?? mark?.p[2] ?? 0,
      angle: ov?.angle ?? mark?.angle ?? 1,
      axis: ov?.axis ?? mark?.axis ?? 'y',
    };
  }, [panelZone, profile?.hinges, marksRev, phase]);
  const interiorStats = useMemo(() => {
    const parts = Object.values(profile?.parts ?? {});
    return {
      interior: parts.filter((p) => p.k === 'int').length,
      pinned: parts.filter((p) => p.b).length,
      doors: parts.filter((p) => p.z?.startsWith('door_')).length,
    };
  }, [profile]);
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
            <button class={`btn ${ruler ? 'btn-primary' : 'btn-glass'}`} title="Сетка с шагом 1 метр" onClick={() => setRuler(!ruler)}>📏 1 м</button>
            <button class="btn btn-glass" title="Запомнить, какие панели открыты для проверки зазоров" onClick={rememberPose}>📌 Поза</button>
            <button class="btn btn-glass" disabled={!pose.length} title="Открыть панели, как в запомненной позе" onClick={() => applyPose(pose, true)}>Вернуть позу ({pose.length})</button>
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
              Выберите файл <b>.glb</b>, <b>.gltf</b> (вместе с .bin и текстурами) или <b>.zip</b> — всего до {MAX_FILE >> 20} МБ. Обработка идёт прямо в браузере, файлы никуда не отправляются.
              Модель будет упрощена, колёса, стёкла и панели кузова определятся автоматически — потом всё можно поправить.
            </p>
            <label class="btn btn-primary wizard-file">
              Выбрать файл(ы)…
              <input
                type="file"
                multiple
                accept=".glb,.gltf,.zip,.bin,model/gltf-binary,model/gltf+json,application/zip,image/*"
                hidden
                onChange={(e) => void onFiles(Array.from((e.target as HTMLInputElement).files ?? []))}
              />
            </label>
            <Field label="Детализация кузова" hint="Меньше треугольников — легче модель на телефоне; больше — точнее кромки панелей.">
              <select value={String(budget)} onChange={(e) => setBudget(Number((e.target as HTMLSelectElement).value))}>
                {DETAIL_LEVELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <label class="check">
              <input type="checkbox" checked={preserveTextures} onChange={(e) => setPreserveTextures((e.target as HTMLInputElement).checked)} />
              Сохранять встроенные текстуры кузова
            </label>
            <p class="hint">Необязательно: сохраняются встроенные PNG/JPEG/WebP-текстуры цвета и UV-координаты (лимит 32 МиБ). Пакет увеличится примерно на объём сохранённых изображений; во время упаковки дополнительно может понадобиться около 2× этого объёма памяти (до ~64 МиБ), не считая геометрии и исходника. Остальные карты материала остаются упрощёнными; файл не отправляется в сеть.</p>
            {textureEstimate && <p class="hint" role="status">В этом GLB найдено примерно {mib(textureEstimate.bytes)} поддерживаемых текстур цвета ({textureEstimate.textures} шт.).{textureEstimate.omitted ? ` Ещё ${textureEstimate.omitted} текстур не войдут в лимит.` : ''}</p>}
            {error && <p class="form-error" role="alert">{error}</p>}
            {draftInfo && (
              <p class="hint" role="status">
                Есть несохранённый черновик разметки от {new Date(draftInfo.savedAt).toLocaleString('ru-RU')} — он применится, если снова выбрать тот же файл.
                <button class="btn btn-ghost" onClick={discardDraft}>Удалить черновик</button>
              </p>
            )}
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
            <div class="wizard-bar">
              <button class="btn btn-ghost" disabled={!histState.undo} onClick={undo} title="Отменить правку (Ctrl+Z)">↩ Отменить</button>
              <button class="btn btn-ghost" disabled={!histState.redo} onClick={redo} title="Вернуть правку (Ctrl+Shift+Z)">↪ Вернуть</button>
              {draftInfo && <span class="hint">Черновик сохранён в {new Date(draftInfo.savedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>}
              {checksWarn > 0 && <span class="hint">⚠ Замечаний проверок: {checksWarn}</span>}
            </div>
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
                  <PaintPicker
                    color={color}
                    code={colorCode}
                    finish={finish}
                    defaultFinish={profile.finish ?? undefined}
                    onColor={setColor}
                    onCode={setColorCode}
                    onFinish={setFinish}
                  />
                  <p class="hint">Эти цвет и покрытие станут значениями по умолчанию для модели: их подставит диалог автомобиля, но у каждой машины их можно поменять отдельно.</p>
                </>
              )}

              {tab === 'parts' && (
                <>
                  <p class="hint">
                    Кликните по детали на модели — она подсветится в списке. «Авто» определяет узел по положению; можно назначить узел вручную или скрыть деталь.
                    Панели (капот, двери, крышка) и петли настраиваются на вкладке «Панели».
                  </p>
                  {!!profile.autoNotes?.length && (
                    <div class="auto-notes">
                      <b>Авторазбор:</b>
                      <ul>{profile.autoNotes.map((n) => <li key={n}>{n}</li>)}</ul>
                    </div>
                  )}
                  <section class="interior-editor">
                    <h4>Салон</h4>
                    <p class="hint">
                      {interiorStats.interior
                        ? `В модели найдено деталей салона: ${interiorStats.interior}. Они попадут в слой «Салон».`
                        : 'Деталей салона в модели не найдено: сиденья, торпедо и потолок можно достроить процедурно.'}
                      {' '}Если кликнуть по детали на модели, её тип можно сменить на «Салон» в списке ниже.
                    </p>
                    <Field label="Что делать с салоном" hint="Процедурный шаблон подгоняется по габаритам модели.">
                      <select value={profile.interior ?? 'fill'} disabled={busy} onChange={(e) => setInterior((e.target as HTMLSelectElement).value as InteriorMode)}>
                        {INTERIOR_MODES.map((mode) => <option key={mode} value={mode}>{INTERIOR_LABEL[mode]}</option>)}
                      </select>
                    </Field>
                    {sel && (
                      <button type="button" class="btn" disabled={busy} onClick={() => setPart(sel, { k: 'int', z: undefined })}>
                        Назначить деталь «{sel}» салоном
                      </button>
                    )}
                  </section>
                  <PanelRegionEditor
                    profile={profile}
                    disabled={busy}
                    onRegions={(regions) => edit((p) => ((p.panelRegions = regions.length ? regions.slice(0, 48) : undefined), p), true, 'panels')}
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
                            {i.u && (
                              <button
                                type="button"
                                class="btn btn-ghost btn-tiny"
                                title="Вернуть результат авторазбора"
                                disabled={busy}
                                onClick={(e) => { e.stopPropagation(); resetPart(id); }}
                              >
                                ↺ авто
                              </button>
                            )}
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

              {tab === 'panels' && (
                <>
                  {armed && (
                    <p class="hint armed-hint">
                      Режим указания: {armed.kind === 'hinge' ? `кликните по модели — там будет петля (${armed.zone})` : 'кликните по модели — по этой точке задастся граница'}.
                      {pick && ` Последняя точка: X ${pick[0].toFixed(2)}, Y ${pick[1].toFixed(2)}, Z ${pick[2].toFixed(2)}.`}
                      {' '}<button type="button" class="btn btn-ghost" onClick={() => setArmed(null)}>Отменить</button>
                    </p>
                  )}
                  {!armed && pick && <p class="hint">Последняя точка на модели: X {pick[0].toFixed(2)}, Y {pick[1].toFixed(2)}, Z {pick[2].toFixed(2)} м.</p>}
                  {drag && (
                    <p class="hint armed-hint">
                      Режим перетаскивания: тяните {drag.kind === 'hinge' ? `точку петли (${drag.zone})` : 'плоскость реза'} в 3D за жёлтую ручку вдоль подсвеченной оси.
                      {' '}<button type="button" class="btn btn-ghost" onClick={() => setDrag(null)}>Готово</button>
                    </p>
                  )}
                  {dragging && <p class="hint">Отпустите ручку — правка попадёт в историю одной записью.</p>}
                  <PanelEditor
                    profile={profile}
                    disabled={busy}
                    zone={panelZone}
                    onZone={(zone) => { setPanelZone(zone); setArmed(null); setDrag(null); }}
                    hinge={hingeView}
                    onHinge={(patch) => { gizmoRef.current?.syncHinge(panelZone, patch.axis ?? hingeView?.axis ?? 'y', [patch.x ?? hingeView?.x ?? 0, patch.y ?? hingeView?.y ?? 0, patch.z ?? hingeView?.z ?? 0]); applyHinge(panelZone, patch); }}
                    onResetHinge={() => resetHinge(panelZone)}
                    onLine={(key, value) => { gizmoRef.current?.syncLine(key, value, profile.dims); setLine(key, value); }}
                    armed={armed}
                    onArm={(target) => { setArmed(target); if (target) setDrag(null); }}
                    drag={drag}
                    onDrag={(target) => { setDrag(target); if (target) setArmed(null); }}
                    onMirror={() => mirrorPanel(panelZone)}
                    onCheckOpen={() => { setOpenAll(false); viewer.current?.setOpen(panelZone, true); }}
                  />
                  <details>
                    <summary>Все границы кузова (дополнительно)</summary>
                    <div class="lines">
                      {LINE_LABEL.filter(([k]) => !(profile.body === 'coupe' && k === 'doorSplit')).map(([k, label, t]) => {
                        const D = profile.dims;
                        const [lo, hi] = t === 'x' ? [D.xRear, D.xFront] : t === 'y' ? [0, D.H] : [0.2, D.W / 2];
                        return (
                          <label class="field" key={k}>
                            <span class="field-label">{label}: {profile.lines[k].toFixed(2)}</span>
                            <div class="row-inline">
                              <input type="range" min={lo} max={hi} step="0.01" value={profile.lines[k]} onInput={(e) => setLine(k, Number((e.target as HTMLInputElement).value))} />
                              <button
                                type="button"
                                class={`btn ${armed?.kind === 'line' && armed.key === k ? 'btn-primary' : ''}`}
                                disabled={busy}
                                onClick={() => setArmed(armed?.kind === 'line' && armed.key === k ? null : { kind: 'line', key: k })}
                              >
                                указать
                              </button>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                  <section class="interior-editor">
                    <h4>Поиск панелей в модели</h4>
                    <p class="hint">
                      Авторазбор ищет капот, двери, крышку и бамперы среди отдельных деталей модели и, если находит, берёт границы по их кромкам.
                      {' '}Найдено деталей-панелей: {interiorStats.pinned}, из них дверей: {interiorStats.doors}.
                    </p>
                    <div class="row2">
                      <button type="button" class="btn" disabled={busy} onClick={() => void reanalyze({ panels: true })}>Искать панели заново</button>
                      <button type="button" class="btn" disabled={busy} onClick={() => void reanalyze({ panels: false })}>Резать только по линиям</button>
                    </div>
                  </section>
                </>
              )}

              {tab === 'done' && (
                <>
                  <section class="presets">
                    <h4>Пресеты разметки</h4>
                    <p class="hint">
                      Пресет хранит разметку (линии, петли, маски, типы деталей, краску) без геометрии — его можно
                      применить к другой модели той же машины, сохранить в файл или перенести на другое устройство.
                    </p>
                    {presets.length ? (
                      <div class="row-inline">
                        <select value={presetId} onChange={(e) => setPresetId((e.target as HTMLSelectElement).value)} aria-label="Пресет">
                          {presets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name} · {new Date(preset.created).toLocaleDateString('ru-RU')}
                            </option>
                          ))}
                        </select>
                        <button class="btn" disabled={busy || !presetId} onClick={applySelectedPreset}>Применить</button>
                        <button class="btn btn-ghost" disabled={busy || !presetId} onClick={() => void removePreset()}>Удалить</button>
                      </div>
                    ) : (
                      <p class="hint">Пока пусто: сохраните текущую разметку как пресет.</p>
                    )}
                    <div class="row2">
                      <button class="btn" disabled={busy} onClick={() => void saveCurrentPreset()}>Сохранить как пресет</button>
                      <button class="btn btn-ghost" disabled={busy} onClick={downloadPreset}>Скачать .json</button>
                    </div>
                    <label class="btn btn-ghost wizard-file">
                      Загрузить пресет…
                      <input type="file" accept=".json,application/json" hidden onChange={(e) => { const file = (e.target as HTMLInputElement).files?.[0]; void importPreset(file); (e.target as HTMLInputElement).value = ''; }} />
                    </label>
                  </section>
                  <section class="checks">
                    <h4>Проверка модели</h4>
                    <ul class="check-list">
                      {checks.map((check) => (
                        <li key={check.id} class={`check check-${check.level}`}>
                          <span aria-hidden="true">{check.level === 'ok' ? '✓' : '⚠'}</span>
                          <div>
                            <b>{check.title}</b>
                            {check.hint && <p class="hint">{check.hint}</p>}
                            {check.action === 'ground' && box && (
                              <button class="btn btn-ghost" onClick={() => edit((p) => groundProfile(p, box) ?? p, true, 'dimensions')}>
                                Выровнять по земле
                              </button>
                            )}
                            {check.action === 'center' && box && (
                              <button class="btn btn-ghost" onClick={() => edit((p) => centerProfile(p, box) ?? p, true, 'dimensions')}>
                                Выровнять по центру
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                  {report && (
                    <section class="report">
                      <h4>Отчёт об импорте</h4>
                      <dl>
                        {reportRows(report).map((row) => (
                          <div class="report-row" key={row.label}>
                            <dt>{row.label}</dt>
                            <dd>{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  )}
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
