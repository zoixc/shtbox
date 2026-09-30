/**
 * Загрузка 3D-модели из glTF/GLB. Приложение не привязано к процедурному генератору:
 * достаточно экспортировать модель из Blender/другого редактора по соглашению ниже.
 *
 * Соглашение (custom properties узла → glTF `extras`):
 *   zone   — id узла из `CarModelDef.zones` (обязательно у корня группы узла)
 *   paint  — true: меши узла окрашиваются кузовной краской, на них можно ставить дефекты
 *   open   — { axis: [x,y,z], angle: рад, label?: string } — узел открывается; ТОЧКА ПРИВЯЗКИ (origin)
 *            узла в редакторе = ось шарнира
 *   anchor — [x,y,z] в локальных координатах узла: где рисовать бейдж (по умолчанию — верх габаритов)
 *   facing — [x,y,z] в координатах авто: бейдж скрывается, если смотрим с обратной стороны
 * Оси авто: +X — вперёд, +Y — вверх, лево = −Z (в glTF/Blender при экспорте включите «+Y Up»).
 */
import { Box3, Color, Group, Mesh, Object3D, Vector3 } from 'three';
import type { Material } from 'three';
import { createPaintMaterial } from '../view3d/paintMaterial';
import type { PaintFinish } from '../view3d/paintMaterial';
import type { ModelRig, OpenableRig, ZoneDef } from './types';

type Vec3 = [number, number, number];

interface OpenExtras {
  axis: Vec3;
  angle: number;
  label?: string;
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

export function parseOpen(v: unknown): OpenExtras | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isVec3(o.axis) || typeof o.angle !== 'number' || !Number.isFinite(o.angle)) return null;
  if (Math.abs(o.angle) > Math.PI) return null;
  return { axis: o.axis, angle: o.angle, label: typeof o.label === 'string' ? o.label.slice(0, 40) : undefined };
}

function hasPaintFlag(m: Object3D, stop: Object3D): boolean {
  for (let o: Object3D | null = m; o && o !== stop; o = o.parent) if (o.userData.paint === true) return true;
  return false;
}

/** Собирает ModelRig из готовой сцены glTF (чистая функция — удобно тестировать без сети). */
export function rigFromScene(scene: Object3D, zones: readonly ZoneDef[], paintColor: string, paintFinish: PaintFinish = 'satin'): ModelRig {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const root = new Group();
  root.add(scene);

  const paint = new Map<string, Mesh>();
  const pick = new Map<string, Object3D[]>();
  const openables = new Map<string, OpenableRig>();
  const anchors = new Map<string, Object3D>();
  const facing = new Map<string, Vec3>();
  const shell: Object3D[] = [];
  const paintMats: { color: Color }[] = [];

  // узлы с extras.zone (собираем заранее — дальше меняем иерархию)
  const zoneNodes: Object3D[] = [];
  scene.traverse((o) => {
    if (typeof o.userData?.zone === 'string') zoneNodes.push(o);
  });

  const errors: string[] = [];
  for (const node of zoneNodes) {
    const id = node.userData.zone as string;
    const def = byId.get(id);
    if (!def) {
      errors.push(`узел «${node.name}»: неизвестная зона «${id}»`);
      continue;
    }
    const meshes: Mesh[] = [];
    node.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    if (!meshes.length) {
      errors.push(`зона «${id}»: у узла нет мешей`);
      continue;
    }

    // открываемый узел: оборачиваем в pivot, стоящий в точке привязки узла
    const open = parseOpen(node.userData.open);
    if (open && node.parent) {
      const pivot = new Group();
      pivot.name = `${id}:pivot`;
      pivot.position.copy(node.position);
      pivot.quaternion.copy(node.quaternion);
      pivot.scale.copy(node.scale);
      const parent = node.parent;
      parent.add(pivot);
      node.position.set(0, 0, 0);
      node.quaternion.identity();
      node.scale.set(1, 1, 1);
      pivot.add(node);
      openables.set(id, { pivot, axis: new Vector3(...open.axis).normalize(), angle: open.angle, label: open.label ?? def.label });
    }

    // paint: у меша (или его родителя внутри узла) extras.paint = true — красим только такие меши;
    // если помеченных нет, а у узла paint = true — красим все меши узла (простой формат)
    const flagged = meshes.filter((m) => hasPaintFlag(m, node));
    const paintSet = new Set(flagged.length ? flagged : node.userData.paint === true ? meshes : []);
    for (const m of meshes) {
      m.userData.zone = id;
      if (paintSet.has(m) && def.paintable) {
        const pm = createPaintMaterial(paintColor, paintFinish);
        // сохраняем прозрачность/двусторонность исходного материала
        const src = m.material as Material;
        if (src && !Array.isArray(src)) pm.side = src.side;
        m.material = pm;
        paint.set(id, m);
        paintMats.push(pm);
      }
      if (def.layer === 'body') shell.push(m);
    }
    if (def.layer !== 'body') node.userData.layerGroup = def.layer;
    pick.set(id, [...(pick.get(id) ?? []), ...meshes]);

    // бейдж
    const anchor = new Object3D();
    if (isVec3(node.userData.anchor)) anchor.position.set(...node.userData.anchor);
    else {
      const box = new Box3().setFromObject(node);
      const c = box.getCenter(new Vector3());
      node.worldToLocal(c.set(c.x, box.max.y, c.z));
      anchor.position.copy(c);
    }
    node.add(anchor);
    anchors.set(id, anchor);
    if (isVec3(node.userData.facing)) facing.set(id, node.userData.facing);
  }

  // модель обязана покрывать все узлы (кроме виртуальных) — иначе в интерфейсе будут «мёртвые» узлы
  for (const z of zones) if (!z.virtual && !pick.has(z.id)) errors.push(`нет геометрии для зоны «${z.id}»`);
  for (const z of zones) if (z.paintable && !paint.has(z.id) && pick.has(z.id)) errors.push(`зона «${z.id}» paintable, но в glTF у узла нет extras.paint = true`);
  if (errors.length) throw new Error(`Некорректная glTF-модель:\n- ${errors.join('\n- ')}`);

  const box = new Box3().setFromObject(root);
  const center = box.getCenter(new Vector3());
  const radius = Math.max(0.5, box.getSize(new Vector3()).length() / 2);

  return {
    root,
    paint,
    pick,
    openables,
    anchors,
    facing,
    shell,
    setColor: (hex) => {
      for (const m of paintMats) m.color.set(hex);
    },
    bounds: { center: [center.x, center.y, center.z], radius },
    dispose: () => {
      root.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
      });
    },
  };
}

/** Допускаем только файлы с того же origin из /models/ (совпадает с CSP `connect-src 'self'`). */
export function assertSafeModelUrl(url: string): void {
  const [path, query, ...extra] = url.split('?');
  const safePath = /^\/models\/[\w./-]+\.(glb|gltf)$/.test(path) && !path.includes('..');
  const safeVersion = query === undefined || /^v=[a-f0-9]{64}$/.test(query);
  if (!safePath || !safeVersion || extra.length) throw new Error(`Недопустимый путь модели: ${url}`);
}

export async function loadGltfScene(url: string): Promise<Object3D> {
  assertSafeModelUrl(url);
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(url);
  return gltf.scene;
}

export async function loadGltfRig(url: string, zones: readonly ZoneDef[], color: string): Promise<ModelRig> {
  return rigFromScene(await loadGltfScene(url), zones, color);
}
