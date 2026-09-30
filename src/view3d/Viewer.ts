import {
  ACESFilmicToneMapping,
  AmbientLight,
  CanvasTexture,
  Clock,
  DirectionalLight,
  Group,
  HemisphereLight,
  LineDashedMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createBlueprintEdges } from './blueprint';
import type { Issue, Spot } from '../core/types';
import { BODY_KINDS } from '../core/types';
import type { ZoneSummary } from '../core/store';
import type { CarModelDef, Layer, ModelRig } from '../models/types';
import { SpotType, globalTime, setHighlight, setSpots, updateNormalMatrix } from './paintMaterial';
import type { PaintFinish, SpotTypeId } from './paintMaterial';
import { DEFAULT_FINISH } from '../data/paintFinish';

export type ViewPreset = 'iso' | 'front' | 'rear' | 'left' | 'right' | 'top' | 'under' | 'cabin';
export type LightingPreset = 'studio' | 'daylight' | 'inspection';

export interface ViewerEvents {
  /** клик по узлу (или пустому месту → null) */
  pick(zoneId: string | null): void;
  /** клик в режиме расстановки метки на кузове */
  place(zoneId: string, spot: Spot): void;
  /** изменилось состояние открытых элементов */
  openChanged(open: string[]): void;
  /** 3D-модель загружена (или сменилась) */
  modelReady?(): void;
}

interface SpotEntry {
  zone: string;
  type: SpotTypeId;
  p: [number, number, number];
  n: [number, number, number];
  r: number;
  seed: number;
  strength: number;
  target: number;
}

const KIND_TYPE: Record<string, SpotTypeId> = { rust: SpotType.rust, dent: SpotType.dent, chip: SpotType.chip, scratch: SpotType.scratch };

function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 100;
}

const HI_SELECT = 0.42;
const HI_HOVER = 0.18;

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(36, 1, 0.05, 60);
  readonly controls: OrbitControls;
  private carGroup = new Group();
  private rig: ModelRig | null = null;
  private def: CarModelDef | null = null;
  private layer: Layer = 'body';
  private selected: string | null = null;
  private hovered: string | null = null;
  private raycaster = new Raycaster();
  private clock = new Clock();
  private needsRender = true;
  private raf = 0;
  private disposed = false;
  private ro: ResizeObserver;
  private overlay: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private badgeEls = new Map<string, HTMLButtonElement>();
  private summary = new Map<string, ZoneSummary>();
  private openTarget = new Map<string, number>();
  private openValue = new Map<string, number>();
  private spots = new Map<string, SpotEntry>();
  private dirtyZones = new Set<string>();
  private placing: { type: SpotTypeId; r: number } | null = null;
  private draftIds: string[] = [];
  private camAnim: { t: number; dur: number; fromP: Vector3; toP: Vector3; fromT: Vector3; toT: Vector3 } | null = null;
  private zoneMeshes = new Map<string, Mesh[]>();
  private ghostBase = new WeakMap<Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  private environmentMap!: Texture;
  private hemiLight!: HemisphereLight;
  private ambientLight!: AmbientLight;
  private keyLight!: DirectionalLight;
  private rimLight!: DirectionalLight;
  private lightingPreset: LightingPreset = 'studio';
  private groundSurface!: Mesh;
  private groundShadow!: Mesh;
  private blueprint = false;
  private blueprintMaterial: LineDashedMaterial | null = null;
  private blueprintLines = new Map<Mesh, LineSegments>();
  private blueprintBuildToken = 0;
  private blueprintBuilding = false;
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private tmp = new Vector3();
  private tmpQ = new Quaternion();
  private continuous = 0;
  private lastPulse = 0;

  constructor(
    private container: HTMLElement,
    private events: ViewerEvents,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.domElement.className = 'viewer-canvas';
    container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement('div');
    this.overlay.className = 'viewer-overlay';
    container.appendChild(this.overlay);
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'viewer-tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    const pmrem = new PMREMGenerator(this.renderer);
    const environmentScene = new RoomEnvironment();
    this.environmentMap = pmrem.fromScene(environmentScene, 0.04).texture;
    environmentScene.dispose();
    this.scene.environment = this.environmentMap;
    pmrem.dispose();
    this.hemiLight = new HemisphereLight(0xdfe9ff, 0x2a2f38, 0.35);
    this.ambientLight = new AmbientLight(0xffffff, 0.15);
    this.keyLight = new DirectionalLight(0xffffff, 1.6);
    this.keyLight.position.set(3, 6, 4);
    this.rimLight = new DirectionalLight(0x9fc4ff, 0.7);
    this.rimLight.position.set(-4, 3, -3);
    this.scene.add(this.hemiLight, this.ambientLight, this.keyLight, this.rimLight);
    this.scene.add(this.carGroup);
    this.groundSurface = this.makeGroundSurface();
    this.groundShadow = this.makeGroundShadow();
    this.scene.add(this.groundSurface, this.groundShadow);

    this.camera.position.set(4.6, 2.2, 5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 14;
    this.controls.target.set(0, 0.65, 0);
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => {
      this.camAnim = null;
    });

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('dblclick', this.onDbl);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop();
  }

  // ---------- модель ----------
  private token = 0;
  private color = '#b9bec6';
  private finish: PaintFinish = DEFAULT_FINISH;
  /** Опускание стёкол по узлам: целевая и текущая доля (0 — подняты, 1 — опущены) */
  private windowTargets = new Map<string, number>();
  private windowValues = new Map<string, number>();
  private issuesCache: Issue[] = [];
  private draftCache: { zone: string; spot: Spot; kind: string } | null = null;

  setModel(def: CarModelDef, color: string, opts: { keepView?: boolean; finish?: PaintFinish } = {}): void {
    this.color = color;
    this.finish = opts.finish ?? def.defaultFinish ?? DEFAULT_FINISH;
    if (this.def === def) {
      this.rig?.setColor(color);
      this.rig?.setFinish?.(this.finish);
      this.invalidate();
      return;
    }
    this.clearModel();
    this.def = def;
    const tok = ++this.token;
    void def.create(color, this.finish).then((rig) => {
      if (tok !== this.token || this.disposed) {
        rig.dispose();
        return;
      }
      rig.setColor(this.color);
      rig.setFinish?.(this.finish);
      this.rig = rig;
      for (const [zone, w] of rig.windows ?? []) w.set(this.windowValues.get(zone) ?? 0);
      this.fitGroundToRig(rig);
      this.carGroup.add(rig.root);
      this.zoneMeshes.clear();
      for (const [zone, objs] of rig.pick) {
        const list: Mesh[] = [];
        for (const o of objs) o.traverse((c) => (c as Mesh).isMesh && list.push(c as Mesh));
        this.zoneMeshes.set(zone, list);
      }
      this.applyLayer();
      if (this.blueprint) this.buildBlueprintLines();
      this.applyHighlights();
      if (!opts.keepView) this.view(this.layer === 'body' ? 'iso' : this.layer === 'interior' ? 'cabin-out' : 'mech', true);
      this.spotsInstant = true;
      this.setIssues(this.issuesCache);
      this.setDraft(this.draftCache);
      this.refreshBadges();
      this.events.modelReady?.();
      this.invalidate();
    });
  }
  private spotsInstant = true;
  /** следующая синхронизация меток — без анимации (смена авто/загрузка) */
  markInstant(): void {
    this.spotsInstant = true;
  }

  private clearModel(): void {
    this.token++;
    this.def = null;
    this.clearBlueprintLines();
    if (!this.rig) return;
    this.carGroup.remove(this.rig.root);
    this.rig.dispose();
    this.rig = null;
    this.spots.clear();
    this.openTarget.clear();
    this.openValue.clear();
    this.badgeEls.forEach((e) => e.remove());
    this.badgeEls.clear();
  }

  setColor(color: string): void {
    this.rig?.setColor(color);
    this.invalidate();
  }

  /** Тип покрытия кузова: матовый, металлик, перламутр… (см. `FINISH` в paintMaterial.ts). */
  setFinish(finish: PaintFinish): void {
    this.finish = finish;
    this.rig?.setFinish?.(finish);
    this.invalidate();
  }

  /** Стёкла дверей, которые умеет опускать эта модель, и их текущее положение. */
  windowsList(): { id: string; label: string; value: number }[] {
    if (!this.rig?.windows) return [];
    return [...this.rig.windows].map(([id, w]) => ({ id, label: w.label, value: this.windowValues.get(id) ?? 0 }));
  }

  /** Опускает/поднимает одно стекло: 0 — поднято, 1 — опущено, 0.5 — наполовину. */
  setWindow(zone: string, fraction: number): void {
    if (!this.rig?.windows?.has(zone)) return;
    this.windowTargets.set(zone, Math.max(0, Math.min(1, fraction)));
    this.windowValues.set(zone, this.windowValues.get(zone) ?? 0);
    this.invalidate();
  }

  /** То же для всех стёкол сразу. */
  setWindows(fraction: number): void {
    for (const zone of this.rig?.windows?.keys() ?? []) this.setWindow(zone, fraction);
  }

  /** Плавно подтягивает створки к цели; возвращает true, пока есть движение. */
  private stepWindows(dt: number): boolean {
    let moving = false;
    for (const [zone, w] of this.rig?.windows ?? []) {
      const target = this.windowTargets.get(zone) ?? 0;
      let value = this.windowValues.get(zone) ?? 0;
      if (Math.abs(value - target) < 0.002) {
        if (value !== target) {
          this.windowValues.set(zone, target);
          w.set(target);
        }
        continue;
      }
      value += (target - value) * (1 - Math.exp(-dt * 6));
      if (Math.abs(value - target) < 0.003) value = target;
      this.windowValues.set(zone, value);
      w.set(value);
      moving = true;
    }
    return moving;
  }

  /** Невымеренные визуальные пресеты; студийный свет сохраняет прежние настройки по умолчанию. */
  setLightingPreset(preset: LightingPreset): void {
    if (preset === this.lightingPreset) return;
    this.lightingPreset = preset;
    if (preset === 'studio') {
      this.hemiLight.color.set(0xdfe9ff); this.hemiLight.groundColor.set(0x2a2f38); this.hemiLight.intensity = 0.35;
      this.ambientLight.intensity = 0.15;
      this.keyLight.color.set(0xffffff); this.keyLight.intensity = 1.6; this.keyLight.position.set(3, 6, 4);
      this.rimLight.color.set(0x9fc4ff); this.rimLight.intensity = 0.7; this.rimLight.position.set(-4, 3, -3);
      this.renderer.toneMappingExposure = 0.85;
    } else if (preset === 'daylight') {
      this.hemiLight.color.set(0xcfe7ff); this.hemiLight.groundColor.set(0x6f6b63); this.hemiLight.intensity = 0.7;
      this.ambientLight.intensity = 0.22;
      this.keyLight.color.set(0xfff4df); this.keyLight.intensity = 1.55; this.keyLight.position.set(-3, 8, 4);
      this.rimLight.color.set(0xb2d8ff); this.rimLight.intensity = 0.35; this.rimLight.position.set(4, 2, -5);
      this.renderer.toneMappingExposure = 0.9;
    } else {
      this.hemiLight.color.set(0xe6edf4); this.hemiLight.groundColor.set(0x777777); this.hemiLight.intensity = 0.65;
      this.ambientLight.intensity = 0.4;
      this.keyLight.color.set(0xffffff); this.keyLight.intensity = 1.1; this.keyLight.position.set(0, 8, 1);
      this.rimLight.color.set(0xffffff); this.rimLight.intensity = 0.45; this.rimLight.position.set(-5, 2, -3);
      this.renderer.toneMappingExposure = 0.92;
    }
    this.invalidate();
  }

  /** Переключает полупрозрачный режим со штриховыми рёбрами геометрии (это не OEM-швы). */
  setBlueprint(enabled: boolean): void {
    if (enabled === this.blueprint) return;
    this.blueprint = enabled;
    if (!enabled) for (const line of this.blueprintLines.values()) line.visible = false;
    this.applyLayer();
    if (enabled) this.buildBlueprintLines();
    this.invalidate();
  }

  private buildBlueprintLines(): void {
    const rig = this.rig;
    if (!rig || this.blueprintBuilding || this.blueprintLines.size) return;
    this.blueprintMaterial ??= new LineDashedMaterial({
      color: 0x70dcff,
      dashSize: 0.055,
      gapSize: 0.035,
      opacity: 0.94,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const token = ++this.blueprintBuildToken;
    this.blueprintBuilding = true;
    const meshes = [...new Set(rig.paint.values())];
    window.setTimeout(() => void this.buildBlueprintLinesInFrames(rig, token, meshes), 0);
  }

  private async buildBlueprintLinesInFrames(rig: ModelRig, token: number, meshes: Mesh[]): Promise<void> {
    try {
      for (const mesh of meshes) {
        if (token !== this.blueprintBuildToken || rig !== this.rig || this.disposed) return;
        const source = mesh.geometry.getAttribute('position');
        if (mesh.isMesh && source) {
          try {
            const edges = createBlueprintEdges(mesh.geometry);
            if (edges) {
              const line = new LineSegments(edges, this.blueprintMaterial!);
              line.name = `${mesh.name}:blueprint`;
              line.renderOrder = 2;
              line.visible = this.blueprint;
              line.raycast = () => {};
              line.computeLineDistances();
              mesh.add(line);
              this.blueprintLines.set(mesh, line);
              this.invalidate();
            }
          } catch (error) {
            console.warn('Не удалось построить линии blueprint для детали', mesh.name, error);
          }
        }
        // Yield between panels so a large model does not freeze input for the whole build.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally {
      if (token === this.blueprintBuildToken) this.blueprintBuilding = false;
    }
  }

  private clearBlueprintLines(): void {
    this.blueprintBuildToken++;
    this.blueprintBuilding = false;
    for (const [mesh, line] of this.blueprintLines) {
      mesh.remove(line);
      line.geometry.dispose();
    }
    this.blueprintLines.clear();
  }

  // ---------- слои ----------
  setLayer(layer: Layer): void {
    if (layer === this.layer) return;
    this.layer = layer;
    this.applyLayer();
    this.refreshBadges();
    this.view(layer === 'body' ? 'iso' : layer === 'interior' ? 'cabin-out' : 'mech');
    this.invalidate();
  }

  private applyLayer(): void {
    const rig = this.rig;
    if (!rig) return;
    const ghost = this.layer !== 'body';
    const seen = new Set<Material>();
    for (const o of rig.shell) {
      const mats: Material[] = [];
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (m) mats.push(...(Array.isArray(m) ? m : [m]));
      for (const mat of mats) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        let base = this.ghostBase.get(mat);
        if (!base) {
          base = { opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite };
          this.ghostBase.set(mat, base);
        }
        const isLine = (o as Object3D & { isLineSegments?: boolean }).isLineSegments;
        if (this.blueprint) {
          mat.transparent = true;
          mat.depthWrite = false;
          mat.opacity = base.opacity * (ghost ? 0.1 : isLine ? 0.3 : 0.2);
        } else if (ghost) {
          mat.transparent = true;
          mat.depthWrite = false;
          mat.opacity = base.opacity * (isLine ? 0.35 : 0.08);
        } else {
          mat.transparent = base.transparent;
          mat.depthWrite = base.depthWrite;
          mat.opacity = base.opacity;
        }
        mat.needsUpdate = true;
      }
    }
    for (const line of this.blueprintLines.values()) line.visible = this.blueprint;
    rig.root.traverse((o) => {
      if (o.userData.inner) o.visible = !ghost;
      if (o.userData.layerGroup === 'interior') o.visible = this.layer !== 'mech';
      if (o.userData.layerGroup === 'mech') o.visible = this.layer !== 'interior';
    });
  }

  // ---------- выбор и подсветка ----------
  /** Выбор мышью: камеру не трогаем (пользователь и так смотрит на узел). */
  private userPicked: string | null = null;
  private scenePick(zone: string | null): void {
    this.userPicked = zone;
    this.events.pick(zone);
  }

  /** Плавно подводит камеру к узлу, выбранному из списка. */
  focusZone(zone: string): void {
    const rig = this.rig;
    const a = rig?.anchors.get(zone);
    if (!rig || !a) return;
    const target = a.getWorldPosition(new Vector3());
    const cur = this.camera.position.clone().sub(this.controls.target);
    let dir = cur.clone().normalize();
    const f = rig.facing.get(zone);
    if (f && this.layer === 'body') {
      const fv = new Vector3(f[0], 0, f[2]).normalize();
      if (dir.dot(fv) < 0.45) dir = fv.multiplyScalar(0.9).add(new Vector3(0, 0.35, 0)).normalize();
    }
    const R = rig.bounds.radius;
    const dist = Math.min(cur.length(), this.def?.zones.find((z) => z.id === zone)?.paintable ? R * 0.95 : R * 1.3);
    const toP = target.clone().add(dir.multiplyScalar(dist));
    this.camAnim = { t: 0, dur: 0.6, fromP: this.camera.position.clone(), toP, fromT: this.controls.target.clone(), toT: target };
    this.invalidate();
  }

  setSelected(zone: string | null): void {
    if (zone === this.selected) return;
    const external = zone !== null && zone !== this.userPicked;
    this.userPicked = null;
    this.selected = zone;
    if (external && zone) this.focusZone(zone);
    this.applyHighlights();
    this.refreshBadges();
    this.invalidate();
  }

  private applyHighlights(): void {
    for (const [zone, meshes] of this.zoneMeshes) {
      const v = zone === this.selected ? HI_SELECT : zone === this.hovered ? HI_HOVER : 0;
      for (const m of meshes) {
        const mat = m.material as Material | Material[];
        if (Array.isArray(mat)) mat.forEach((x) => setHighlight(x, v));
        else setHighlight(mat, v);
      }
    }
  }

  /** Узлы, которые можно выбирать мышью в текущем состоянии. */
  private candidates(): Object3D[] {
    const rig = this.rig;
    const def = this.def;
    if (!rig || !def) return [];
    if (this.placing) return [...rig.paint.values()];
    const out: Object3D[] = [];
    for (const z of def.zones) {
      if (z.layer !== this.layer) continue;
      if (z.requiresOpen && (this.openTarget.get(z.requiresOpen) ?? 0) < 0.5) continue;
      const objs = rig.pick.get(z.id);
      if (objs) out.push(...objs);
    }
    return out;
  }

  private pick(clientX: number, clientY: number): { zone: string; mesh: Mesh; point: Vector3; normal: Vector3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.candidates(), true);
    for (const h of hits) {
      const zone = h.object.userData.zone as string | undefined;
      if (!zone) continue;
      const n = h.face ? h.face.normal.clone() : new Vector3(0, 1, 0);
      return { zone, mesh: h.object as Mesh, point: h.point.clone(), normal: n };
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  private onUp = (e: PointerEvent) => {
    const d = this.pointerDown;
    this.pointerDown = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
    const hit = this.pick(e.clientX, e.clientY);
    if (this.placing) {
      if (hit) {
        const local = hit.mesh.worldToLocal(hit.point.clone());
        this.events.place(hit.zone, {
          p: [round(local.x), round(local.y), round(local.z)],
          n: [round(hit.normal.x), round(hit.normal.y), round(hit.normal.z)],
          r: this.placing.r,
        });
      }
      return;
    }
    this.scenePick(hit ? hit.zone : null);
  };
  private onDbl = (e: MouseEvent) => {
    const hit = this.pick(e.clientX, e.clientY);
    if (hit && this.rig?.openables.has(hit.zone)) this.toggleOpen(hit.zone);
  };
  private onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const hit = this.pick(e.clientX, e.clientY);
    const zone = hit?.zone ?? null;
    const rect = this.container.getBoundingClientRect();
    if (zone) {
      const label = this.def?.zones.find((z) => z.id === zone)?.label ?? zone;
      this.tooltip.textContent = this.placing ? `Поставить метку: ${label}` : label;
      this.tooltip.style.transform = `translate(${e.clientX - rect.left + 14}px, ${e.clientY - rect.top + 14}px)`;
      this.tooltip.hidden = false;
    } else this.tooltip.hidden = true;
    this.renderer.domElement.style.cursor = zone ? (this.placing ? 'crosshair' : 'pointer') : this.placing ? 'not-allowed' : 'grab';
    if (zone !== this.hovered) {
      this.hovered = zone;
      this.applyHighlights();
      this.invalidate();
    }
  };
  private onLeave = () => {
    this.tooltip.hidden = true;
    if (this.hovered) {
      this.hovered = null;
      this.applyHighlights();
      this.invalidate();
    }
  };

  // ---------- открытие частей ----------
  isOpen(zone: string): boolean {
    return (this.openTarget.get(zone) ?? 0) > 0.5;
  }
  openableZones(): { id: string; label: string }[] {
    if (!this.rig) return [];
    return [...this.rig.openables].map(([id, o]) => ({ id, label: o.label }));
  }
  setOpen(zone: string, open: boolean): void {
    if (!this.rig?.openables.has(zone)) return;
    this.openTarget.set(zone, open ? 1 : 0);
    this.emitOpen();
    this.refreshBadges();
    this.invalidate();
  }
  toggleOpen(zone: string): void {
    this.setOpen(zone, !this.isOpen(zone));
  }
  setAllOpen(open: boolean): void {
    for (const z of this.rig?.openables.keys() ?? []) this.openTarget.set(z, open ? 1 : 0);
    this.emitOpen();
    this.refreshBadges();
    this.invalidate();
  }
  private emitOpen() {
    this.events.openChanged([...this.openTarget].filter(([, v]) => v > 0.5).map(([k]) => k));
  }

  // ---------- метки повреждений ----------
  setIssues(issues: Issue[]): void {
    this.issuesCache = issues;
    if (!this.rig) return;
    const instant = this.spotsInstant;
    this.spotsInstant = false;
    const alive = new Set<string>();
    for (const i of issues) {
      if (!i.spot || !BODY_KINDS.includes(i.kind) || !this.rig?.paint.has(i.zoneId)) continue;
      alive.add(i.id);
      const type = KIND_TYPE[i.kind];
      const cur = this.spots.get(i.id);
      const target = i.status === 'open' ? 1 : 0;
      if (cur) {
        cur.target = target;
        cur.zone = i.zoneId;
        cur.p = i.spot.p;
        cur.n = i.spot.n;
        cur.r = i.spot.r;
        cur.type = type;
        this.dirtyZones.add(i.zoneId);
      } else if (target > 0 || !instant) {
        // только что закрытые при первой загрузке не показываем; при работе — плавно гасим
        this.spots.set(i.id, {
          zone: i.zoneId, type, p: i.spot.p, n: i.spot.n, r: i.spot.r,
          seed: hashSeed(i.id), strength: instant ? target : target, target,
        });
        this.dirtyZones.add(i.zoneId);
      }
    }
    for (const [id, s] of this.spots) {
      if (id.startsWith('__')) continue;
      if (!alive.has(id)) {
        this.spots.delete(id);
        this.dirtyZones.add(s.zone);
      }
    }
    this.invalidate();
  }

  /** Расстановка новой метки: режим «прицела» + предпросмотр. */
  setPlacing(p: { kind: string; r: number } | null): void {
    this.placing = p ? { type: KIND_TYPE[p.kind] ?? SpotType.rust, r: p.r } : null;
    this.renderer.domElement.style.cursor = p ? 'crosshair' : 'grab';
    if (!p) this.setDraft(null);
    this.continuous = p ? 1 : 0;
    this.invalidate();
  }

  setDraft(d: { zone: string; spot: Spot; kind: string } | null): void {
    this.draftCache = d;
    if (!this.rig) return;
    for (const id of this.draftIds) {
      const s = this.spots.get(id);
      if (s) this.dirtyZones.add(s.zone);
      this.spots.delete(id);
    }
    this.draftIds = [];
    if (d && this.rig?.paint.has(d.zone)) {
      const type = KIND_TYPE[d.kind] ?? SpotType.rust;
      const base = { zone: d.zone, p: d.spot.p, n: d.spot.n, r: d.spot.r, seed: 7.7, strength: 1, target: 1 };
      this.spots.set('__draft_fx', { ...base, type });
      this.spots.set('__draft_mk', { ...base, type: SpotType.marker });
      this.draftIds = ['__draft_fx', '__draft_mk'];
      this.dirtyZones.add(d.zone);
    }
    this.invalidate();
  }

  private stepSpots(dt: number): boolean {
    let animating = false;
    for (const [id, s] of this.spots) {
      if (s.strength !== s.target) {
        const step = dt * 0.9;
        s.strength = s.strength < s.target ? Math.min(s.target, s.strength + step) : Math.max(s.target, s.strength - step);
        this.dirtyZones.add(s.zone);
        animating = true;
        if (s.strength === 0 && s.target === 0) {
          this.spots.delete(id);
        }
      }
    }
    if (this.dirtyZones.size && this.rig) {
      for (const zone of this.dirtyZones) {
        const mesh = this.rig.paint.get(zone);
        if (!mesh) continue;
        const list = [...this.spots.values()].filter((s) => s.zone === zone).map((s) => ({ ...s }));
        // маркер и превью — поверх остальных
        list.sort((a, b) => (a.type === SpotType.marker ? 1 : 0) - (b.type === SpotType.marker ? 1 : 0));
        setSpots(mesh.material as Material, list);
      }
      this.dirtyZones.clear();
    }
    return animating;
  }

  // ---------- камера ----------
  view(preset: ViewPreset | 'cabin-out' | 'mech', instant = false): void {
    const c = new Vector3(...(this.rig?.bounds.center ?? [0, 0.7, 0]));
    const R = this.rig?.bounds.radius ?? 3;
    let dir = new Vector3(0.62, 0.34, 0.7);
    let dist = R * 2;
    let target = c.clone();
    switch (preset) {
      case 'iso': break;
      case 'front': dir.set(1, 0.16, 0); dist = R * 2.1; break;
      case 'rear': dir.set(-1, 0.16, 0); dist = R * 2.1; break;
      case 'left': dir.set(0, 0.14, -1); dist = R * 2.1; break;
      case 'right': dir.set(0, 0.14, 1); dist = R * 2.1; break;
      case 'top': dir.set(0.02, 1, 0.001); dist = R * 2.2; break;
      case 'under': dir.set(0.5, -1, 0.6); dist = R * 1.9; target = new Vector3(0, 0.2, 0); break;
      case 'cabin-out': dir.set(-0.75, 0.75, 0.85); dist = R * 1.75; target = new Vector3(-0.2, 0.7, 0); break;
      case 'mech': dir.set(0.7, 0.55, 0.95); dist = R * 1.85; target = new Vector3(0.1, 0.4, 0); break;
      case 'cabin': {
        target = new Vector3(0.45, 0.85, -0.05);
        dir = new Vector3(-1.3, 0.35, 0.15);
        dist = 1.5;
        break;
      }
    }
    if (preset !== 'cabin') {
      const aspect = this.camera.aspect || 1.5;
      if (aspect < 1.5) dist *= Math.min(1.8, 1.5 / aspect);
    }
    const toP = target.clone().add(dir.normalize().multiplyScalar(dist));
    if (instant) {
      this.camera.position.copy(toP);
      this.controls.target.copy(target);
      this.controls.update();
    } else {
      this.camAnim = { t: 0, dur: 0.7, fromP: this.camera.position.clone(), toP, fromT: this.controls.target.clone(), toT: target };
    }
    this.invalidate();
  }

  // ---------- бейджи ----------
  setSummary(summary: Map<string, ZoneSummary>): void {
    this.summary = summary;
    this.refreshBadges();
  }

  private badgeVisibleZone(zoneId: string): boolean {
    const z = this.def?.zones.find((x) => x.id === zoneId);
    if (!z || z.virtual) return false;
    if (z.layer !== this.layer) return false;
    if (z.requiresOpen && !this.isOpen(z.requiresOpen)) return false;
    return true;
  }

  private refreshBadges(): void {
    if (!this.rig) return;
    const want = new Set<string>();
    for (const [zone, s] of this.summary) {
      if ((s.open > 0 || s.due === 'overdue' || s.due === 'soon') && this.badgeVisibleZone(zone) && this.rig.anchors.has(zone)) want.add(zone);
    }
    for (const [zone, el] of this.badgeEls) {
      if (!want.has(zone)) {
        el.remove();
        this.badgeEls.delete(zone);
      }
    }
    for (const zone of want) {
      const s = this.summary.get(zone)!;
      let el = this.badgeEls.get(zone);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.scenePick(zone);
        });
        this.overlay.appendChild(el);
        this.badgeEls.set(zone, el);
      }
      const sev = s.maxPriority === 2 || s.due === 'overdue' ? 'high' : s.maxPriority === 1 || s.due === 'soon' ? 'mid' : 'low';
      el.className = `badge badge-${sev}${zone === this.selected ? ' badge-sel' : ''}`;
      el.textContent = s.open > 0 ? String(s.open) : 'ТО';
      el.title = this.def?.zones.find((z) => z.id === zone)?.label ?? zone;
    }
    this.positionBadges();
  }

  private positionBadges(): void {
    const rig = this.rig;
    if (!rig || !this.badgeEls.size) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const cam = this.camera.position;
    for (const [zone, el] of this.badgeEls) {
      const a = rig.anchors.get(zone)!;
      a.getWorldPosition(this.tmp);
      const facing = rig.facing.get(zone);
      let visible = true;
      if (facing && this.layer === 'body') {
        const open = this.isOpen(zone);
        if (!open) {
          // грубая проверка «смотрим с обратной стороны»
          const dx = cam.x - this.tmp.x, dy = cam.y - this.tmp.y, dz = cam.z - this.tmp.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          visible = (dx * facing[0] + dy * facing[1] + dz * facing[2]) / len > 0.05;
        }
      }
      this.tmp.project(this.camera);
      if (this.tmp.z > 1 || this.tmp.z < -1) visible = false;
      el.style.display = visible ? '' : 'none';
      if (visible) el.style.transform = `translate(${((this.tmp.x + 1) / 2) * w}px, ${((1 - this.tmp.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  }

  // ---------- рендер ----------
  invalidate(): void {
    this.needsRender = true;
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    // на узких экранах — шире поле зрения, чтобы машина влезала
    this.camera.fov = w / h < 0.7 ? 62 : w / h < 0.9 ? 52 : 36;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    let animating = false;

    if (this.camAnim) {
      const a = this.camAnim;
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(a.fromP, a.toP, e);
      this.controls.target.lerpVectors(a.fromT, a.toT, e);
      if (k >= 1) this.camAnim = null;
      animating = true;
    }
    if (this.controls.update()) animating = true;

    // открытие/закрытие
    if (this.rig) {
      for (const [zone, o] of this.rig.openables) {
        const target = this.openTarget.get(zone) ?? 0;
        const cur = this.openValue.get(zone) ?? 0;
        if (cur !== target) {
          let next = cur + (target - cur) * (1 - Math.exp(-dt * 7));
          if (Math.abs(next - target) < 0.002) next = target;
          this.openValue.set(zone, next);
          o.pivot.quaternion.copy(this.tmpQ.setFromAxisAngle(o.axis, o.angle * next));
          animating = true;
        }
      }
    }
    if (this.stepWindows(dt)) animating = true;
    if (this.stepSpots(dt)) animating = true;
    if (this.continuous) {
      // анимация метки — не чаще ~30 к/с
      const now = performance.now();
      if (now - this.lastPulse > 33) {
        this.lastPulse = now;
        globalTime.value = now / 1000;
        animating = true;
      }
    }
    if (animating || this.needsRender) {
      this.needsRender = false;
      if (this.rig) {
        this.camera.updateMatrixWorld();
        for (const m of this.rig.paint.values()) updateNormalMatrix(m, this.camera.matrixWorldInverse);
      }
      this.renderer.render(this.scene, this.camera);
      this.positionBadges();
    }
  };

  /** Матовая полупрозрачная плоскость даёт зрительную опору, не создавая тяжёлого пола с текстурами. */
  private makeGroundSurface(): Mesh {
    const material = new MeshBasicMaterial({ color: 0x607186, transparent: true, opacity: 0.14, depthWrite: false, toneMapped: false });
    const surface = new Mesh(new PlaneGeometry(160, 160), material);
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = -0.012;
    surface.renderOrder = -2;
    return surface;
  }

  /** Подгоняет пятно контакта под габариты и центр конкретной модели. */
  private fitGroundToRig(rig: ModelRig): void {
    const [x, , z] = rig.bounds.center;
    const scale = Math.max(0.75, rig.bounds.radius / 2.4);
    this.groundSurface.position.set(x, -0.012, z);
    this.groundShadow.position.set(x, -0.008, z);
    this.groundShadow.scale.set(scale, 1, scale);
  }

  private makeGroundShadow(): Mesh {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    const m = new Mesh(new PlaneGeometry(6.4, 3.2), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = -0.008;
    m.renderOrder = -1;
    return m;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.blueprintMaterial?.dispose();
    this.groundSurface.geometry.dispose();
    (this.groundSurface.material as MeshBasicMaterial).dispose();
    this.groundShadow.geometry.dispose();
    const shadowMaterial = this.groundShadow.material as MeshBasicMaterial;
    shadowMaterial.map?.dispose();
    shadowMaterial.dispose();
    this.scene.environment = null;
    this.environmentMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
    this.tooltip.remove();
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000;
