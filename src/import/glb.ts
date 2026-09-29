/**
 * Чтение произвольного GLB в набор `RawPart` и запись «пакета модели» (GLB + профиль).
 * Без DOM: работает в Web Worker, в Node (CLI, тесты).
 */
import { Document, WebIO } from '@gltf-transform/core';
import type { Mesh as GMesh, Node as GNode } from '@gltf-transform/core';
import { joinGlb, splitGlb } from './container';
import type { Json } from './container';
import { MAX_PARTS } from './types';
import type { Profile, RawPart } from './types';

export const LIMITS = {
  fileBytes: 60 * 1024 * 1024,
  tris: 3_000_000,
};

/** Расшифровка текстуры в средний цвет (sRGB 0..1). В браузере — canvas, в Node — библиотеки. */
export type AvgColor = (image: Uint8Array, mime: string) => Promise<[number, number, number] | null>;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Приводит материалы к metal-rough и убирает расширения, которые three.js/упаковщик не используют. */
function sanitize(json: Json): void {
  const used = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  if (used.has('KHR_draco_mesh_compression') || used.has('EXT_meshopt_compression')) {
    throw new Error('Модель сжата Draco/meshopt — пересохраните GLB без сжатия (Blender: «Сжатие» выключено).');
  }
  for (const b of json.buffers ?? []) if (b.uri && !b.uri.startsWith('data:')) throw new Error('Внешние файлы не поддерживаются — нужен самодостаточный GLB');
  for (const i of json.images ?? []) if (i.uri && !i.uri.startsWith('data:')) throw new Error('Внешние текстуры не поддерживаются — нужен самодостаточный GLB');
  for (const m of json.materials ?? []) {
    const ext = (m.extensions ?? {}) as Record<string, Record<string, unknown>>;
    const sg = ext.KHR_materials_pbrSpecularGlossiness;
    if (sg) {
      m.pbrMetallicRoughness = {
        baseColorFactor: sg.diffuseFactor ?? [1, 1, 1, 1],
        baseColorTexture: sg.diffuseTexture,
        metallicFactor: 0,
        roughnessFactor: 1 - (typeof sg.glossinessFactor === 'number' ? sg.glossinessFactor : 1) * 0.85,
      };
    }
    const tr = ext.KHR_materials_transmission;
    if (tr) {
      const f = typeof tr.transmissionFactor === 'number' ? tr.transmissionFactor : 0;
      if (f > 0.05) {
        m.alphaMode = 'BLEND';
        const pbr = (m.pbrMetallicRoughness ?? (m.pbrMetallicRoughness = {})) as { baseColorFactor?: number[] };
        const c = pbr.baseColorFactor ?? [1, 1, 1, 1];
        pbr.baseColorFactor = [c[0], c[1], c[2], Math.max(0.2, (c[3] ?? 1) * (1 - 0.75 * f))];
      }
    }
    delete m.extensions;
  }
  delete json.extensionsUsed;
  delete json.extensionsRequired;
}

type M4 = ArrayLike<number>;
function normalMatrix(m: M4): number[] {
  // обратная транспонированная верхняя 3×3 (column-major → row-major результата не важен: применяем симметрично)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, Bv = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * Bv + c * C || 1;
  const r = 1 / det;
  // cofactor / det = inverse transpose (для column-major входа хранится так же)
  return [
    A * r, Bv * r, C * r,
    (c * h - b * i) * r, (a * i - c * g) * r, (b * g - a * h) * r,
    (b * f - c * e) * r, (c * d - a * f) * r, (a * e - b * d) * r,
  ];
}

function computeNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const nor = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      nor[v] += x;
      nor[v + 1] += y;
      nor[v + 2] += z;
    }
  }
  for (let v = 0; v < nor.length; v += 3) {
    const l = Math.hypot(nor[v], nor[v + 1], nor[v + 2]) || 1;
    nor[v] /= l;
    nor[v + 1] /= l;
    nor[v + 2] /= l;
  }
  return nor;
}

export interface ReadResult {
  parts: RawPart[];
  tris: number;
  warnings: string[];
}

export async function readModel(data: Uint8Array, avgColor?: AvgColor): Promise<ReadResult> {
  if (data.byteLength > LIMITS.fileBytes) throw new Error(`Файл больше ${LIMITS.fileBytes >> 20} МБ`);
  const { json, bin } = splitGlb(data);
  sanitize(json);
  const doc = await new WebIO().readBinary(joinGlb(json, bin));
  const warnings: string[] = [];

  const colorCache = new Map<unknown, [number, number, number] | null>();
  const parts: RawPart[] = [];
  let tris = 0;
  const visit = async (node: GNode) => {
    const mesh: GMesh | null = node.getMesh();
    if (mesh) {
      const wm = node.getWorldMatrix();
      const nm = normalMatrix(wm);
      let k = 0;
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue;
        const pa = prim.getAttribute('POSITION');
        if (!pa) continue;
        const src = pa.getArray();
        if (!src) continue;
        const n = pa.getCount();
        const ia = prim.getIndices();
        const idx = ia ? Uint32Array.from(ia.getArray() as ArrayLike<number>) : Uint32Array.from({ length: n }, (_, i) => i);
        if (idx.length < 3) continue;
        tris += idx.length / 3;
        if (tris > LIMITS.tris) throw new Error('Слишком детальная модель (больше 3 млн треугольников)');
        const pos = new Float32Array(n * 3);
        const tmp = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          pa.getElement(i, tmp);
          const [x, y, z] = tmp;
          pos[i * 3] = wm[0] * x + wm[4] * y + wm[8] * z + wm[12];
          pos[i * 3 + 1] = wm[1] * x + wm[5] * y + wm[9] * z + wm[13];
          pos[i * 3 + 2] = wm[2] * x + wm[6] * y + wm[10] * z + wm[14];
        }
        const na = prim.getAttribute('NORMAL');
        let nor: Float32Array;
        if (na) {
          nor = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            na.getElement(i, tmp);
            const [x, y, z] = tmp;
            const nx = nm[0] * x + nm[3] * y + nm[6] * z, ny = nm[1] * x + nm[4] * y + nm[7] * z, nz = nm[2] * x + nm[5] * y + nm[8] * z;
            const l = Math.hypot(nx, ny, nz) || 1;
            nor[i * 3] = nx / l;
            nor[i * 3 + 1] = ny / l;
            nor[i * 3 + 2] = nz / l;
          }
        } else nor = computeNormals(pos, idx);
        // зеркальная матрица переворачивает обход треугольников
        if (wm[0] * (wm[5] * wm[10] - wm[6] * wm[9]) - wm[4] * (wm[1] * wm[10] - wm[2] * wm[9]) + wm[8] * (wm[1] * wm[6] - wm[2] * wm[5]) < 0) {
          for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
        }

        const mat = prim.getMaterial();
        const bc = mat?.getBaseColorFactor() ?? [0.8, 0.8, 0.8, 1];
        let color: [number, number, number] = [bc[0], bc[1], bc[2]];
        const tex = mat?.getBaseColorTexture();
        if (tex && avgColor) {
          let avg = colorCache.get(tex);
          if (avg === undefined) {
            const img = tex.getImage();
            avg = img ? await avgColor(img, tex.getMimeType()).catch(() => null) : null;
            colorCache.set(tex, avg);
          }
          if (avg) color = [color[0] * srgbToLinear(avg[0]), color[1] * srgbToLinear(avg[1]), color[2] * srgbToLinear(avg[2])];
        }
        const em = mat?.getEmissiveFactor() ?? [0, 0, 0];
        parts.push({
          id: '',
          name: (node.getName() || mesh.getName() || 'part') + (k++ ? `.${k}` : ''),
          material: mat?.getName() || 'material',
          alpha: mat && mat.getAlphaMode() === 'BLEND' ? bc[3] : 1,
          emissive: Math.max(em[0], em[1], em[2]) > 0.05 || !!mat?.getEmissiveTexture(),
          color,
          metallic: mat?.getMetallicFactor() ?? 0,
          roughness: mat?.getRoughnessFactor() ?? 0.8,
          pos,
          nor,
          idx,
        });
      }
    }
    for (const c of node.listChildren()) await visit(c);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) await visit(n);
  if (!parts.length) throw new Error('В файле нет треугольных мешей');

  // слишком много деталей — склеиваем по материалу
  let out = parts;
  if (parts.length > MAX_PARTS) {
    warnings.push(`Деталей ${parts.length} > ${MAX_PARTS}: склеены по материалам`);
    out = mergeByMaterial(parts);
  }
  out.forEach((p, i) => (p.id = `p${i}`));
  return { parts: out, tris, warnings };
}

export function mergeByMaterial(parts: RawPart[]): RawPart[] {
  const groups = new Map<string, RawPart[]>();
  for (const p of parts) {
    const key = `${p.material}|${p.alpha}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  const res: RawPart[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      res.push(g[0]);
      continue;
    }
    const nv = g.reduce((s, p) => s + p.pos.length / 3, 0);
    const ni = g.reduce((s, p) => s + p.idx.length, 0);
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of g) {
      pos.set(p.pos, vo * 3);
      nor.set(p.nor, vo * 3);
      for (let i = 0; i < p.idx.length; i++) idx[io + i] = p.idx[i] + vo;
      vo += p.pos.length / 3;
      io += p.idx.length;
    }
    res.push({ ...g[0], name: g[0].material, pos, nor, idx });
  }
  return res;
}

// ------------------------------------------------------------------ запись пакета
const round = (v: number) => Math.round(v * 1e4) / 1e4;

export async function writePackage(parts: RawPart[], profile: Profile): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('car');
  const mats = new Map<string, ReturnType<Document['createMaterial']>>();
  for (const p of parts) {
    const key = `${p.material}|${p.color.map(round)}|${p.alpha}|${p.metallic}|${p.roughness}|${p.emissive}`;
    let m = mats.get(key);
    if (!m) {
      m = doc
        .createMaterial(p.material)
        .setBaseColorFactor([p.color[0], p.color[1], p.color[2], p.alpha])
        .setMetallicFactor(p.metallic)
        .setRoughnessFactor(p.roughness)
        .setDoubleSided(true);
      if (p.alpha < 0.98) m.setAlphaMode('BLEND');
      if (p.emissive) m.setEmissiveFactor([0.3, 0.3, 0.3]);
      mats.set(key, m);
    }
    const acc = (type: 'VEC3' | 'SCALAR', arr: Float32Array | Uint32Array | Uint16Array) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
    const idx = p.pos.length / 3 < 65535 ? Uint16Array.from(p.idx) : p.idx;
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', p.pos))
      .setAttribute('NORMAL', acc('VEC3', p.nor))
      .setIndices(acc('SCALAR', idx))
      .setMaterial(m);
    const node = doc.createNode(p.id).setMesh(doc.createMesh(p.id).addPrimitive(prim));
    scene.addChild(node);
  }
  const root = doc.getRoot();
  root.setExtras({ shtbox: profile as unknown as Record<string, unknown> });
  const c = profile.credits;
  root.getAsset().generator = 'shtbox importer';
  if (c?.author || c?.license) root.getAsset().copyright = [c.author, c.license].filter(Boolean).join(' — ');
  return new WebIO().writeBinary(doc);
}
