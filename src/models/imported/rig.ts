/**
 * Сборка ModelRig из «пакета модели» (GLB с деталями + Profile).
 *  1. детали переводятся в систему автомобиля (`profile.frame`);
 *  2. каждая деталь (или её часть) относится к узлу по правилам `makeZoner` и правкам пользователя;
 *  3. по узлам строятся меши: окрашиваемые детали узла склеиваются в один меш с краской;
 *  4. открывающиеся узлы получают шарнир (по габаритам узла, с возможностью подправить);
 *  5. чего нет в модели (агрегаты, салон, моторный отсек) — берётся из процедурного шаблона,
 *     подогнанного по размерам (см. `fit.ts`).
 */
import { Box3, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh, Object3D, Vector3 } from 'three';
import type { Material, MeshStandardMaterial } from 'three';
import { histogram, makeZoner, remapZone, splitInto, SPLIT_BUDGET } from '../../import/partition';
import type { Soup } from '../../import/partition';
import { xform } from '../../import/frame';
import { facingOf, zonesFor } from '../../import/zoneset';
import type { Profile, Vec3 } from '../../import/types';
import { createPaintMaterial, enhanceMaterial } from '../../view3d/paintMaterial';
import type { ModelRig, OpenableRig, ZoneDef } from '../types';

interface Acc {
  /** zone → (материал или 'paint') → треугольники */
  zones: Map<string, Map<Material | 'paint', Soup>>;
}

function soupOf(mesh: Mesh, f: ReturnType<typeof xform>): { pos: Float32Array; nor: Float32Array } | null {
  const g = mesh.geometry;
  const pa = g.getAttribute('position');
  const na = g.getAttribute('normal');
  if (!pa || !na) return null;
  const idx = g.getIndex();
  const count = idx ? idx.count : pa.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const fn = f;
  const o = fn(0, 0, 0);
  for (let i = 0; i < count; i++) {
    const v = idx ? idx.getX(i) : i;
    const p = fn(pa.getX(v), pa.getY(v), pa.getZ(v));
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
    // нормали: только поворот (масштаб одинаковый по осям)
    const q = fn(na.getX(v), na.getY(v), na.getZ(v));
    nor[i * 3] = q[0] - o[0];
    nor[i * 3 + 1] = q[1] - o[1];
    nor[i * 3 + 2] = q[2] - o[2];
  }
  // нормализуем нормали после масштаба
  for (let i = 0; i < nor.length; i += 3) {
    const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]) || 1;
    nor[i] /= l;
    nor[i + 1] /= l;
    nor[i + 2] /= l;
  }
  return { pos, nor };
}

function add(acc: Acc, zone: string, key: Material | 'paint', pos: ArrayLike<number>, nor: ArrayLike<number>): void {
  let zm = acc.zones.get(zone);
  if (!zm) acc.zones.set(zone, (zm = new Map()));
  let s = zm.get(key);
  if (!s) zm.set(key, (s = { pos: [], nor: [] }));
  for (let i = 0; i < pos.length; i++) {
    s.pos.push(pos[i]);
    s.nor.push(nor[i]);
  }
}

function addSoup(acc: Acc, zone: string, key: Material | 'paint', s: Soup): void {
  let zm = acc.zones.get(zone);
  if (!zm) acc.zones.set(zone, (zm = new Map()));
  const t = zm.get(key);
  if (!t) zm.set(key, s);
  else {
    for (const v of s.pos) t.pos.push(v);
    for (const v of s.nor) t.nor.push(v);
  }
}

const geomOf = (s: Soup): BufferGeometry => {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(s.pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(s.nor, 3));
  g.computeBoundingSphere();
  return g;
};

export interface ImportedParts {
  rig: ModelRig;
  /** узлы, для которых в модели есть геометрия */
  covered: Set<string>;
  zones: ZoneDef[];
}

/** Разбирает детали по узлам. Без процедурной начинки — её добавляет `createImportedRig`. */
export function buildImportedParts(scene: Object3D, pr: Profile, color: string): ImportedParts {
  const zones = zonesFor(pr.body, pr.layout);
  const zdef = new Map(zones.map((z) => [z.id, z]));
  const zoner = makeZoner(pr);
  const f = xform(pr.frame);
  const acc: Acc = { zones: new Map() };
  const budget = { left: SPLIT_BUDGET };
  // Модельные контуры требуют более мелких треугольников у линии разреза, чем общий plane-cut.
  const cutResolution = pr.panelRegions?.length ? 0.01 : 0.025;
  const valid = (z: string | undefined): z is string => !!z && zdef.has(remapZone(z, pr.body));

  scene.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  scene.traverse((o) => {
    if ((o as Mesh).isMesh) meshes.push(o as Mesh);
  });

  for (const mesh of meshes) {
    const info = pr.parts[mesh.name];
    if (!info || info.k === 'hide') continue;
    const s = soupOf(mesh, f);
    if (!s) continue;
    const mat = mesh.material as Material;
    const isPaint = info.k === 'paint' && pr.paint.includes(info.m);
    const key = isPaint ? 'paint' : mat;
    const put = (zone: string) => remapZone(zone, pr.body);

    if (valid(info.z)) {
      add(acc, put(info.z), zdef.get(put(info.z))?.paintable ? key : mat, s.pos, s.nor);
      continue;
    }
    const tri = (fn: (c: Vec3, n: Vec3) => string, sub: boolean) => {
      const out = new Map<string, Soup>();
      splitInto(s.pos, s.nor, fn, out, budget, sub ? cutResolution : 1e9);
      for (const [z, soup] of out) addSoup(acc, put(z), key, soup);
    };
    switch (info.k) {
      case 'wheel':
        tri((c) => zoner.wheel(c), false);
        break;
      case 'brake':
        tri((c) => zoner.brake(c), false);
        break;
      case 'int':
        tri((c) => zoner.interior(c), false);
        break;
      case 'light':
        add(acc, put(zoner.light([(s.pos[0] + s.pos[3] + s.pos[6]) / 3, 0, 0])), mat, s.pos, s.nor);
        break;
      default: {
        const fn = info.k === 'glass' ? zoner.glass : info.k === 'paint' ? zoner.paint : zoner.trim;
        const hist = histogram(s.pos, s.nor, fn);
        const total = s.pos.length / 9;
        const [topZ, topN] = [...hist.entries()].sort((a, b) => b[1] - a[1])[0];
        // мелкие детали и детали, почти целиком лежащие в одном узле, не режем
        let ext = 0;
        for (let a = 0; a < 3; a++) {
          let lo = Infinity, hi = -Infinity;
          for (let i = a; i < s.pos.length; i += 3) (s.pos[i] < lo && (lo = s.pos[i]), s.pos[i] > hi && (hi = s.pos[i]));
          ext = Math.max(ext, hi - lo);
        }
        if (ext < 0.45 || topN / total >= 0.93) add(acc, put(topZ), key, s.pos, s.nor);
        else tri(fn, true);
      }
    }
  }
  return assemble(acc, pr, zones, color);
}

function assemble(acc: Acc, pr: Profile, zones: ZoneDef[], color: string): ImportedParts {
  const zdef = new Map(zones.map((z) => [z.id, z]));
  const root = new Group();
  const paint = new Map<string, Mesh>();
  const pick = new Map<string, Object3D[]>();
  const openables = new Map<string, OpenableRig>();
  const anchors = new Map<string, Object3D>();
  const facing = new Map<string, Vec3>();
  const shell: Object3D[] = [];
  const paintMats: MeshStandardMaterial[] = [];
  const covered = new Set<string>();
  const matCache = new Map<Material, Material>();

  for (const [zone, byMat] of acc.zones) {
    const def = zdef.get(zone);
    if (!def) continue;
    // габариты узла
    const box = new Box3();
    let edgeMinX: number[] = [];
    let edgeMaxX: number[] = [];
    let n = 0;
    for (const s of byMat.values()) {
      n += s.pos.length / 9;
      for (let i = 0; i < s.pos.length; i += 3) box.expandByPoint(new Vector3(s.pos[i], s.pos[i + 1], s.pos[i + 2]));
    }
    if (n < 2 || box.isEmpty()) continue;
    if (def.openable) {
      for (const s of byMat.values())
        for (let i = 0; i < s.pos.length; i += 3) {
          if (s.pos[i] < box.min.x + 0.1) edgeMinX.push(s.pos[i + 1]);
          if (s.pos[i] > box.max.x - 0.1) edgeMaxX.push(s.pos[i + 1]);
        }
    }
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

    const pivot = new Group();
    pivot.name = zone;
    const content = new Group();
    let hinge: Vector3 | null = null;
    let axis = new Vector3(0, 1, 0);
    let angle = 1;
    const ov = pr.hinges?.[zone];
    if (def.openable) {
      const side = zone.endsWith('l') ? -1 : 1;
      if (zone === 'hood') {
        hinge = new Vector3(box.min.x, avg(edgeMinX), 0);
        axis = new Vector3(0, 0, 1);
        angle = 1.0;
      } else if (zone === 'trunk') {
        hinge = new Vector3(box.max.x, avg(edgeMaxX), 0);
        axis = new Vector3(0, 0, 1);
        angle = pr.body === 'hatch' ? -1.2 : -1.0;
      } else {
        const zOut = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
        hinge = new Vector3(box.max.x, 0, side * (zOut - 0.05));
        axis = new Vector3(0, 1, 0);
        angle = side * (zone.startsWith('door_f') ? 1.15 : 1.05);
      }
      if (ov) {
        if (ov.x !== undefined) hinge.x = ov.x;
        if (ov.y !== undefined) hinge.y = ov.y;
        if (ov.z !== undefined) hinge.z = ov.z;
        if (ov.angle !== undefined) angle = ov.angle;
      }
      pivot.position.copy(hinge);
      content.position.copy(hinge).multiplyScalar(-1);
      openables.set(zone, { pivot, axis, angle, label: def.label });
    }
    pivot.add(content);
    root.add(pivot);

    const meshes: Mesh[] = [];
    for (const [key, s] of byMat) {
      let material: Material;
      if (key === 'paint') {
        const pm = createPaintMaterial(color, 'satin');
        pm.side = DoubleSide;
        paintMats.push(pm);
        material = pm;
      } else {
        let m = matCache.get(key);
        if (!m) {
          m = key.clone();
          (m as MeshStandardMaterial).side = DoubleSide;
          if (m.transparent || m.opacity < 1) m.depthWrite = false;
          enhanceMaterial(m);
          matCache.set(key, m);
        }
        material = m;
      }
      const mesh = new Mesh(geomOf(s), material);
      mesh.name = zone;
      mesh.userData.zone = zone;
      if (def.layer !== 'body') mesh.userData.layerGroup = def.layer;
      if (key === 'paint' && def.paintable) paint.set(zone, mesh);
      content.add(mesh);
      meshes.push(mesh);
      if (def.layer === 'body') shell.push(mesh);
    }
    pick.set(zone, meshes);
    covered.add(zone);

    // якорь бейджа
    const fc = facingOf(zone, pr.body);
    const anchor = new Object3D();
    const c = box.getCenter(new Vector3());
    if (fc && Math.abs(fc[0]) > 0.9) anchor.position.set(fc[0] > 0 ? box.max.x : box.min.x, c.y, c.z);
    else if (fc && Math.abs(fc[2]) > 0.9) anchor.position.set(c.x, c.y, fc[2] > 0 ? box.max.z : box.min.z);
    else anchor.position.set(c.x, def.layer === 'body' ? box.max.y : c.y, c.z);
    content.add(anchor);
    anchors.set(zone, anchor);
    if (fc) facing.set(zone, fc);
  }

  const box = new Box3().setFromObject(root);
  const center = box.getCenter(new Vector3());
  const rig: ModelRig = {
    root,
    paint,
    pick,
    openables,
    anchors,
    facing,
    shell,
    setColor: (hex) => {
      for (const m of paintMats) m.color.set(new Color(hex));
    },
    bounds: { center: [center.x, center.y, center.z], radius: Math.max(2.4, box.getSize(new Vector3()).length() / 2) },
    dispose: () => {
      root.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of paintMats) m.dispose();
      for (const m of matCache.values()) m.dispose();
    },
  };
  return { rig, covered, zones };
}
