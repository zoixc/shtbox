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
import type { SedanSpec } from '../sedan/build';
import { loadGltfScene, rigFromScene } from '../gltf';
import type { PaintFinish } from '../../data/paintFinish';
import type { ModelRig } from '../types';
import { BMW116I_SPEC, HATCH_ZONES } from './bmw116i';

declare const __BMW116I_MODEL_URL__: string;

/** Query hash derives from the GLB bytes at build time, so Nginx may safely use immutable caching. */
export const BMW116I_GLB_URL = __BMW116I_MODEL_URL__;

/** Узлы, которые остаются процедурными. */
export const PROCEDURAL_ZONES: ReadonlySet<string> = new Set([
  'engine_bay', 'trunk_bay', 'headliner', 'engine', 'gearbox', 'cooling', 'battery', 'electrics', 'susp_f', 'susp_r', 'exhaust', 'fuel_tank',
]);

// The source BMW has its exhaust on the left (−Z); keep the simplified procedural-only model unchanged.
const BMW116I_GLB_SPEC: SedanSpec = { ...BMW116I_SPEC, exhaustSide: -1 };
// These generic template bulkheads do not match the BMW shell closely enough and can poke through its sides.
const OMITTED_BMW_BAY_OBJECTS = new Set(['engine_bay:bulkhead', 'trunk_bay:bulkhead']);

const disposeObj = (o: Object3D): void => {
  const m = o as Mesh;
  m.geometry?.dispose();
  const mat = m.material as Material | Material[] | undefined;
  if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
};

/** Объединяет GLB-модель и процедурную «начинку». Чистая функция — тестируется без сети. */
export function mergeRigs(
  glb: ModelRig,
  proc: ModelRig,
  procZones: ReadonlySet<string> = PROCEDURAL_ZONES,
  omittedProcObjects: ReadonlySet<string> = new Set(),
): ModelRig {
  const keep = new Set<Object3D>();
  for (const z of procZones) for (const o of proc.pick.get(z) ?? []) o.traverse((c) => keep.add(c));
  const drop: Object3D[] = [];
  proc.root.traverse((o) => {
    const m = o as Mesh & LineSegments;
    if ((m.isMesh || m.isLineSegments) && (!keep.has(o) || omittedProcObjects.has(o.name))) drop.push(o);
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
  const paint = new Map(glb.paint);
  const openables = new Map(glb.openables);
  const windows = new Map([...(glb.windows ?? []), ...(proc.windows ?? [])]);
  for (const z of procZones) {
    const pm = proc.paint.get(z);
    if (pm) paint.set(z, pm);
    const op = proc.openables.get(z);
    if (op) openables.set(z, op);
    const p = proc.pick.get(z);
    if (p) pick.set(z, p.filter((o) => !dropped.has(o)));
    const a = proc.anchors.get(z);
    if (a) anchors.set(z, a);
    const f = proc.facing.get(z);
    if (f) facing.set(z, f);
  }
  const box = new Box3().setFromObject(glb.root);
  const center = box.getCenter(new Vector3());
  return {
    root,
    paint,
    pick,
    openables,
    windows,
    anchors,
    facing,
    shell: [...glb.shell, ...proc.shell.filter((o) => !dropped.has(o))],
    setColor: (hex) => {
      glb.setColor(hex);
      proc.setColor(hex);
    },
    setFinish: (finish) => {
      glb.setFinish?.(finish);
      proc.setFinish?.(finish);
    },
    bounds: { center: [center.x, center.y, center.z], radius: Math.max(2.4, box.getSize(new Vector3()).length() / 2) },
    dispose: () => {
      glb.dispose();
      proc.dispose();
    },
  };
}

/** `load` подменяется в тестах (в Node нет fetch по относительному URL). */
export async function createBmw116i(
  color: string,
  load: (url: string) => Promise<Object3D> = loadGltfScene,
  finish?: PaintFinish,
): Promise<ModelRig> {
  const [scene, proc] = await Promise.all([load(BMW116I_GLB_URL), Promise.resolve(buildSedan(BMW116I_GLB_SPEC, color, finish))]);
  const glb = rigFromScene(
    scene,
    HATCH_ZONES.filter((z) => !PROCEDURAL_ZONES.has(z.id)),
    color,
    finish ?? 'matte',
  );
  return mergeRigs(glb, proc, PROCEDURAL_ZONES, OMITTED_BMW_BAY_OBJECTS);
}
