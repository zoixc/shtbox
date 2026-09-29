/**
 * BMW 116i: гибридная модель.
 *  — кузов, стёкла, свет, колёса, тормозные диски и салон — из GLB (`public/models/bmw116i.glb`,
 *    подготовлен `scripts/prepare-bmw116i.mjs` из исходной модели Peter Stephan, CC-BY-4.0);
 *  — моторный отсек, багажное отделение, потолок и агрегаты (двигатель, КПП, подвеска, выхлоп,
 *    бак и т. д.) — процедурные: в исходной модели их нет.
 * Оба источника лежат в одной системе координат (+X вперёд, метры, колёса на y = 0).
 */
import { Box3, Group, Vector3 } from 'three';
import type { LineSegments, Material, Mesh, Object3D } from 'three';
import { buildSedan } from '../sedan/build';
import { loadGltfScene, rigFromScene } from '../gltf';
import type { ModelRig } from '../types';
import { BMW116I_SPEC, HATCH_ZONES } from './bmw116i';

export const BMW116I_GLB_URL = '/models/bmw116i.glb';

/** Узлы, которые остаются процедурными. */
export const PROCEDURAL_ZONES: ReadonlySet<string> = new Set([
  'engine_bay', 'trunk_bay', 'headliner', 'engine', 'gearbox', 'cooling', 'battery', 'electrics', 'susp_f', 'susp_r', 'exhaust', 'fuel_tank',
]);

const disposeObj = (o: Object3D): void => {
  const m = o as Mesh;
  m.geometry?.dispose();
  const mat = m.material as Material | Material[] | undefined;
  if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
};

/** Объединяет GLB-модель и процедурную «начинку». Чистая функция — тестируется без сети. */
export function mergeRigs(glb: ModelRig, proc: ModelRig): ModelRig {
  const keep = new Set<Object3D>();
  for (const z of PROCEDURAL_ZONES) for (const o of proc.pick.get(z) ?? []) o.traverse((c) => keep.add(c));
  const drop: Object3D[] = [];
  proc.root.traverse((o) => {
    const m = o as Mesh & LineSegments;
    if ((m.isMesh || m.isLineSegments) && !keep.has(o) && !o.userData.bay) drop.push(o);
  });
  const dropped = new Set(drop);
  for (const o of drop) {
    o.removeFromParent();
    disposeObj(o);
  }

  const root = new Group();
  root.add(proc.root, glb.root);
  const pick = new Map(glb.pick);
  const anchors = new Map(glb.anchors);
  const facing = new Map(glb.facing);
  for (const z of PROCEDURAL_ZONES) {
    const p = proc.pick.get(z);
    if (p) pick.set(z, p);
    const a = proc.anchors.get(z);
    if (a) anchors.set(z, a);
    const f = proc.facing.get(z);
    if (f) facing.set(z, f);
  }
  const box = new Box3().setFromObject(glb.root);
  const center = box.getCenter(new Vector3());
  return {
    root,
    paint: glb.paint,
    pick,
    openables: glb.openables,
    anchors,
    facing,
    shell: [...glb.shell, ...proc.shell.filter((o) => !dropped.has(o))],
    setColor: (hex) => {
      glb.setColor(hex);
      proc.setColor(hex);
    },
    bounds: { center: [center.x, center.y, center.z], radius: Math.max(2.4, box.getSize(new Vector3()).length() / 2) },
    dispose: () => {
      glb.dispose();
      proc.dispose();
    },
  };
}

/** `load` подменяется в тестах (в Node нет fetch по относительному URL). */
export async function createBmw116i(color: string, load: (url: string) => Promise<Object3D> = loadGltfScene): Promise<ModelRig> {
  const [scene, proc] = await Promise.all([load(BMW116I_GLB_URL), Promise.resolve(buildSedan(BMW116I_SPEC, color))]);
  const glb = rigFromScene(
    scene,
    HATCH_ZONES.filter((z) => !PROCEDURAL_ZONES.has(z.id)),
    color,
  );
  return mergeRigs(glb, proc);
}
