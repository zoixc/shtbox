/**
 * Чтение произвольного GLB в набор `RawPart` и запись «пакета модели» (GLB + профиль).
 * Без DOM: работает в Web Worker, в Node (CLI, тесты).
 */
import { Document, WebIO } from '@gltf-transform/core';
import type { Mesh as GMesh, Node as GNode, Texture as GTexture, TypedArray } from '@gltf-transform/core';
import {
  EXTMeshoptCompression,
  KHRDracoMeshCompression,
  KHRMeshQuantization,
  KHRTextureBasisu,
  KHRTextureTransform,
} from '@gltf-transform/extensions';
import type { Transform } from '@gltf-transform/extensions';
import { decodeDracoGlb, hasDraco } from './draco';
import { KTX2_MAX_EDGE, ktx2ToPng } from './ktx2';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { joinGlb, splitGlb } from './container';
import type { Json } from './container';
import { MAX_PARTS } from './types';
import { PRESERVED_TEXTURE_LIMIT } from './texture-estimate';
import type { Profile, RawPart, RawTexture } from './types';

export const LIMITS = {
  fileBytes: 60 * 1024 * 1024,
  tris: 3_000_000,
  preservedTextureBytes: PRESERVED_TEXTURE_LIMIT,
};

/** Расшифровка текстуры в средний цвет (sRGB 0..1). В браузере — canvas, в Node — библиотеки. */
export type AvgColor = (image: Uint8Array, mime: string) => Promise<[number, number, number] | null>;
export type ReadProgress = (stage: string, frac: number) => void;

export interface ReadOptions {
  /** Сохранять поддерживаемые embedded base-color текстуры вместо усреднённого цвета. */
  preserveTextures?: boolean;
  onProgress?: ReadProgress;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const YIELD_EVERY = 16_384;
const INDEX_YIELD_EVERY = Math.floor(YIELD_EVERY / 3) * 3;
const YIELD = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const HANDLED_MATERIAL_EXTENSIONS = new Set(['KHR_materials_pbrSpecularGlossiness', 'KHR_materials_transmission']);
const KNOWN_REQUIRED_EXTENSIONS = new Set([
  'EXT_meshopt_compression',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_texture_transform',
  ...HANDLED_MATERIAL_EXTENSIONS,
]);
const SUPPORTED_TEXTURE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** KTX2 распаковывается в PNG: в пакете и в просмотрщике остаются обычные текстуры. */
const KTX2_MIME = 'image/ktx2';

/** Приводит поддержанные legacy-материалы к metal-rough, не копируя BIN-блок GLB без необходимости. */
function sanitize(json: Json, warnings: Set<string>): boolean {
  const used = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  if (used.has('KHR_draco_mesh_compression')) {
    // Сюда попасть нельзя: `readModel` распаковывает Draco до `sanitize`. Сообщение — на случай прямых вызовов.
    throw new Error('Draco-геометрия не была распакована перед разбором (внутренняя ошибка импорта).');
  }
  const unsupportedRequired = (json.extensionsRequired ?? []).filter((extension) => !KNOWN_REQUIRED_EXTENSIONS.has(extension));
  if (unsupportedRequired.length) {
    throw new Error(`Модель требует неподдерживаемые расширения glTF: ${unsupportedRequired.join(', ')}`);
  }
  const unsupportedOptional = [...used].filter((extension) => !KNOWN_REQUIRED_EXTENSIONS.has(extension));
  if (unsupportedOptional.length) {
    warnings.add(`Не все данные расширений glTF сохраняются в импортированном пакете: ${unsupportedOptional.join(', ')}.`);
  }

  for (const buffer of json.buffers ?? []) {
    if (buffer.uri && !buffer.uri.startsWith('data:')) throw new Error('Внешние файлы не поддерживаются — нужен самодостаточный GLB');
  }
  for (const image of json.images ?? []) {
    if (image.uri && !image.uri.startsWith('data:')) throw new Error('Внешние текстуры не поддерживаются — нужен самодостаточный GLB');
  }

  let changed = false;
  // Часть экспортёров забывает перечислить расширения в extensionsUsed. Без записи в списке
  // glTF Transform не увидит трансформ UV и не прочитает Basis-текстуру, поэтому чиним список здесь.
  const usedList = new Set(json.extensionsUsed ?? []);
  const markUsed = (name: string) => {
    if (usedList.has(name)) return;
    usedList.add(name);
    json.extensionsUsed = [...usedList];
    changed = true;
  };
  const hasTransform = (json.materials ?? []).some((material) => {
    const pbr = material.pbrMetallicRoughness as { baseColorTexture?: { extensions?: Record<string, unknown> } } | undefined;
    if (pbr?.baseColorTexture?.extensions?.KHR_texture_transform) return true;
    const ext = (material.extensions ?? {}) as Record<string, { diffuseTexture?: { extensions?: Record<string, unknown> } } | undefined>;
    return !!ext.KHR_materials_pbrSpecularGlossiness?.diffuseTexture?.extensions?.KHR_texture_transform;
  });
  if (hasTransform) markUsed('KHR_texture_transform');
  const hasBasisu = (json.images ?? []).some((image) => {
    const mime = (image as { mimeType?: string }).mimeType;
    return typeof mime === 'string' && mime.toLowerCase() === 'image/ktx2';
  });
  if (hasBasisu) markUsed('KHR_texture_basisu');

  for (const material of json.materials ?? []) {
    const ext = (material.extensions ?? {}) as Record<string, Record<string, unknown>>;
    const unhandled = Object.keys(ext).filter((name) => !HANDLED_MATERIAL_EXTENSIONS.has(name));
    if (unhandled.length) warnings.add(`Не поддержанные расширения материалов (${unhandled.join(', ')}) заменены базовыми параметрами.`);
    const specGloss = ext.KHR_materials_pbrSpecularGlossiness;
    if (specGloss) {
      material.pbrMetallicRoughness = {
        baseColorFactor: specGloss.diffuseFactor ?? [1, 1, 1, 1],
        baseColorTexture: specGloss.diffuseTexture,
        metallicFactor: 0,
        roughnessFactor: 1 - (typeof specGloss.glossinessFactor === 'number' ? specGloss.glossinessFactor : 1) * 0.85,
      };
      changed = true;
    }
    const transmission = ext.KHR_materials_transmission;
    if (transmission) {
      const factor = typeof transmission.transmissionFactor === 'number' ? transmission.transmissionFactor : 0;
      if (factor > 0.05) {
        material.alphaMode = 'BLEND';
        const pbr = (material.pbrMetallicRoughness ?? (material.pbrMetallicRoughness = {})) as { baseColorFactor?: number[] };
        const color = pbr.baseColorFactor ?? [1, 1, 1, 1];
        pbr.baseColorFactor = [color[0], color[1], color[2], Math.max(0.2, (color[3] ?? 1) * (1 - 0.75 * factor))];
      }
      changed = true;
    }
    if (material.extensions) {
      delete material.extensions;
      changed = true;
    }
  }

  for (const field of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json[field];
    if (!list) continue;
    const filtered = list.filter((extension) => !HANDLED_MATERIAL_EXTENSIONS.has(extension));
    if (filtered.length !== list.length) changed = true;
    if (filtered.length) json[field] = filtered;
    else {
      delete json[field];
      changed = true;
    }
  }
  return changed;
}

type M4 = ArrayLike<number>;
function normalMatrix(m: M4): number[] {
  // Обратная транспонированная верхняя 3×3 (column-major → row-major результата не важен: применяем симметрично).
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, Bv = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * Bv + c * C || 1;
  const r = 1 / det;
  return [
    A * r, Bv * r, C * r,
    (c * h - b * i) * r, (a * i - c * g) * r, (b * g - a * h) * r,
    (b * f - c * e) * r, (c * d - a * f) * r, (a * e - b * d) * r,
  ];
}

function determinant3(m: M4): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/**
 * `KHR_texture_transform`: сдвиг, поворот и масштаб набора UV. При импорте трансформ «запекается»
 * в координаты (значения остаются теми же, что видит GPU), поэтому текстура совпадает с исходником.
 */
function applyTextureTransform(uv: Float32Array, t: Transform): void {
  const [sx, sy] = t.getScale();
  const [ox, oy] = t.getOffset();
  const r = t.getRotation();
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // Матрица «сдвиг × поворот × масштаб» из спецификации KHR_texture_transform.
  const m00 = sx * cos, m01 = -sy * sin;
  const m10 = sx * sin, m11 = sy * cos;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i];
    const v = uv[i + 1];
    uv[i] = m00 * u + m01 * v + ox;
    uv[i + 1] = m10 * u + m11 * v + oy;
  }
}

export interface ReadResult {
  parts: RawPart[];
  tris: number;
  warnings: string[];
  credits?: Profile['credits'];
}

function creditsFromJson(json: Json): Profile['credits'] | undefined {
  const asset = (json.asset ?? {}) as { copyright?: string; extras?: Record<string, unknown> };
  const extras = asset.extras ?? {};
  const str = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 300) : undefined);
  const credits = { author: str(extras.author) ?? str(asset.copyright), license: str(extras.license), source: str(extras.source) };
  return credits.author || credits.license || credits.source ? credits : undefined;
}

function inspectJson(json: Json, warnings: Set<string>): void {
  const animations = json.animations as unknown[] | undefined;
  const skins = json.skins as unknown[] | undefined;
  const cameras = json.cameras as unknown[] | undefined;
  const meshes = json.meshes as Array<{ primitives?: Array<{ targets?: unknown[] }> }> | undefined;
  if (animations?.length) warnings.add('Анимации не импортируются: пакет содержит только статическую геометрию.');
  if (skins?.length) warnings.add('Скелеты и skinning не импортируются: деформируемая геометрия будет статической.');
  if (cameras?.length) warnings.add('Камеры исходного GLB не переносятся в пакет модели.');
  if (meshes?.some((mesh) => mesh.primitives?.some((primitive) => (primitive.targets?.length ?? 0) > 0))) {
    warnings.add('Morph targets не импортируются: используется базовая форма меша.');
  }
  // KHR_texture_transform не предупреждение: сдвиг/поворот/масштаб UV применяются к координатам
  // при чтении (см. `textureTransformOf`), поэтому текстура совпадает с исходником.
}

async function computeNormals(
  pos: Float32Array,
  idx: Uint32Array,
  advance: (units: number) => Promise<void>,
): Promise<Float32Array> {
  const nor = new Float32Array(pos.length);
  const trisPerBatch = Math.max(1, Math.floor(YIELD_EVERY / 3));
  for (let start = 0; start < idx.length; start += trisPerBatch * 3) {
    const end = Math.min(idx.length, start + trisPerBatch * 3);
    for (let t = start; t < end; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
      nor[a] += x; nor[a + 1] += y; nor[a + 2] += z;
      nor[b] += x; nor[b + 1] += y; nor[b + 2] += z;
      nor[c] += x; nor[c + 1] += y; nor[c + 2] += z;
    }
    await advance((end - start) / 3);
  }
  for (let start = 0; start < nor.length / 3; start += YIELD_EVERY) {
    const end = Math.min(nor.length / 3, start + YIELD_EVERY);
    for (let v = start * 3; v < end * 3; v += 3) {
      const length = Math.hypot(nor[v], nor[v + 1], nor[v + 2]) || 1;
      nor[v] /= length;
      nor[v + 1] /= length;
      nor[v + 2] /= length;
    }
    await advance(end - start);
  }
  return nor;
}

export async function readModel(data: Uint8Array, avgColor?: AvgColor, options: ReadOptions = {}): Promise<ReadResult> {
  if (data.byteLength > LIMITS.fileBytes) throw new Error(`Файл больше ${LIMITS.fileBytes >> 20} МБ`);
  const warnings = new Set<string>();
  let { json, bin } = splitGlb(data);
  if (hasDraco(json)) {
    // Draco расширяется до обычного GLB, дальше путь чтения общий (в том числе для CLI и тестов).
    options.onProgress?.('Распаковка Draco', 0);
    const plain = await decodeDracoGlb(data);
    ({ json, bin } = splitGlb(plain));
    data = plain;
    warnings.add('Геометрия была сжата Draco и распакована при импорте.');
  }
  inspectJson(json, warnings);
  const preservedCredits = creditsFromJson(json);
  const changedJson = sanitize(json, warnings);
  const hasMeshopt = json.extensionsUsed?.includes('EXT_meshopt_compression') || json.extensionsRequired?.includes('EXT_meshopt_compression');
  const io = new WebIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, KHRTextureTransform, KHRTextureBasisu, KHRDracoMeshCompression])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  if (hasMeshopt) await MeshoptDecoder.ready;
  // Most GLBs need no metadata rewrite. Read the original Uint8Array to avoid a second full-size BIN copy.
  const doc = await io.readBinary(changedJson ? joinGlb(json, bin) : data);
  const scenes = doc.getRoot().listScenes();
  const preserveTextures = options.preserveTextures === true;

  let totalWork = 0;
  const countWork = (node: GNode) => {
    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        if (primitive.getMode() !== 4) continue;
        const position = primitive.getAttribute('POSITION');
        if (!position) continue;
        const vertexCount = position.getCount();
        const indexCount = primitive.getIndices()?.getCount() ?? vertexCount;
        const normalCount = primitive.getAttribute('NORMAL') ? vertexCount : vertexCount + indexCount / 3;
        const texture = primitive.getMaterial()?.getBaseColorTexture();
        const textureInfo = primitive.getMaterial()?.getBaseColorTextureInfo();
        const uvCount = preserveTextures && texture && textureInfo && primitive.getAttribute(`TEXCOORD_${textureInfo.getTexCoord()}`) ? vertexCount : 0;
        totalWork += indexCount + vertexCount + normalCount + uvCount;
      }
    }
    for (const child of node.listChildren()) countWork(child);
  };
  for (const scene of scenes) for (const node of scene.listChildren()) countWork(node);

  let workDone = 0;
  const report = () => options.onProgress?.('Чтение геометрии', totalWork ? Math.min(1, workDone / totalWork) : 1);
  const advance = async (units: number) => {
    let remaining = units;
    while (remaining > 0) {
      const boundary = Math.floor(workDone / YIELD_EVERY + 1) * YIELD_EVERY;
      const step = Math.min(remaining, boundary - workDone);
      workDone += step;
      remaining -= step;
      if (workDone === boundary) {
        report();
        if (workDone < totalWork) await YIELD();
      }
    }
  };
  options.onProgress?.('Чтение геометрии', 0);

  const colorCache = new Map<GTexture, [number, number, number] | null>();
  const textureCache = new Map<GTexture, RawTexture | null>();
  let preservedTextureBytes = 0;
  let textureId = 0;
  let droppedTexture = false;
  let droppedMaterialMaps = false;
  const unsupportedAttributes = new Set<string>();
  const skippedPrimitiveModes = new Map<number, number>();
  const parts: RawPart[] = [];
  let tris = 0;
  const failTexture = (texture: GTexture, reason: string): undefined => {
    warnings.add(`Текстура «${texture.getName() || 'без имени'}»: ${reason}. Она сведена к цвету материала.`);
    textureCache.set(texture, null);
    return undefined;
  };
  const getTextureSource = async (texture: GTexture): Promise<RawTexture | undefined> => {
    if (textureCache.has(texture)) return textureCache.get(texture) ?? undefined;
    const image = texture.getImage();
    const mime = texture.getMimeType().toLowerCase();
    if (!image) return failTexture(texture, 'нет данных изображения');
    let bytes: Uint8Array = image;
    let outMime = mime;
    if (mime === KTX2_MIME) {
      // KTX2/BasisU хранит текстуру в сжатом виде: распаковываем её в PNG на импорте.
      try {
        const decoded = await ktx2ToPng(image);
        if (!decoded) return failTexture(texture, `KTX2 больше ${KTX2_MAX_EDGE}×${KTX2_MAX_EDGE} пикселей — распаковка пропущена`);
        bytes = decoded.png;
        outMime = 'image/png';
        warnings.add(`KTX2-текстура «${texture.getName() || 'без имени'}» распакована в PNG (${decoded.width}×${decoded.height}).`);
      } catch (error) {
        return failTexture(texture, `не удалось распаковать KTX2 (${error instanceof Error ? error.message : String(error)})`);
      }
    } else if (!SUPPORTED_TEXTURE_MIME.has(mime)) {
      return failTexture(texture, `неподдерживаемый формат ${mime || '(MIME не указан)'}`);
    }
    if (preservedTextureBytes + bytes.byteLength > LIMITS.preservedTextureBytes) {
      warnings.add(`Суммарный размер сохраняемых текстур превышает ${LIMITS.preservedTextureBytes >> 20} МиБ; лишние текстуры сведены к цвету материала.`);
      textureCache.set(texture, null);
      return undefined;
    }
    const source: RawTexture = { id: `texture-${textureId++}`, mime: outMime, image: bytes };
    textureCache.set(texture, source);
    preservedTextureBytes += bytes.byteLength;
    return source;
  };

  const visit = async (node: GNode): Promise<void> => {
    const mesh: GMesh | null = node.getMesh();
    if (mesh) {
      const wm = node.getWorldMatrix();
      const nm = normalMatrix(wm);
      const mirrored = determinant3(wm) < 0;
      let partIndex = 0;
      for (const primitive of mesh.listPrimitives()) {
        if (primitive.getMode() !== 4) {
          const mode = primitive.getMode();
          skippedPrimitiveModes.set(mode, (skippedPrimitiveModes.get(mode) ?? 0) + 1);
          continue;
        }
        const positionAccessor = primitive.getAttribute('POSITION');
        if (!positionAccessor) {
          warnings.add('Некоторые треугольные примитивы без POSITION пропущены.');
          continue;
        }
        const vertexCount = positionAccessor.getCount();
        const sourceIndexAccessor = primitive.getIndices();
        const sourceIndices = sourceIndexAccessor?.getArray() as ArrayLike<number> | null;
        const indexCount = sourceIndexAccessor?.getCount() ?? vertexCount;
        if (indexCount % 3 !== 0) throw new Error(`Треугольный меш «${node.getName() || mesh.getName()}» имеет неверное число индексов`);
        let idx: Uint32Array;
        if (sourceIndices instanceof Uint32Array && !mirrored) {
          idx = sourceIndices;
          await advance(idx.length);
        } else {
          idx = new Uint32Array(indexCount);
          for (let start = 0; start < indexCount; start += INDEX_YIELD_EVERY) {
            const end = Math.min(indexCount, start + INDEX_YIELD_EVERY);
            if (mirrored) {
              for (let i = start; i < end; i += 3) {
                const a = sourceIndices ? sourceIndices[i] : i;
                const b = sourceIndices ? sourceIndices[i + 1] : i + 1;
                const c = sourceIndices ? sourceIndices[i + 2] : i + 2;
                idx[i] = a;
                idx[i + 1] = c;
                idx[i + 2] = b;
              }
            } else {
              for (let i = start; i < end; i++) idx[i] = sourceIndices ? sourceIndices[i] : i;
            }
            await advance(end - start);
          }
        }
        const triCount = idx.length / 3;
        tris += triCount;
        if (tris > LIMITS.tris) throw new Error('Слишком детальная модель (больше 3 млн треугольников)');

        const pos = new Float32Array(vertexCount * 3);
        const tmp = [0, 0, 0];
        for (let start = 0; start < vertexCount; start += YIELD_EVERY) {
          const end = Math.min(vertexCount, start + YIELD_EVERY);
          for (let i = start; i < end; i++) {
            positionAccessor.getElement(i, tmp);
            const x = tmp[0], y = tmp[1], z = tmp[2];
            const j = i * 3;
            pos[j] = wm[0] * x + wm[4] * y + wm[8] * z + wm[12];
            pos[j + 1] = wm[1] * x + wm[5] * y + wm[9] * z + wm[13];
            pos[j + 2] = wm[2] * x + wm[6] * y + wm[10] * z + wm[14];
          }
          await advance(end - start);
        }

        const normalAccessor = primitive.getAttribute('NORMAL');
        let nor: Float32Array;
        if (normalAccessor) {
          nor = new Float32Array(vertexCount * 3);
          for (let start = 0; start < vertexCount; start += YIELD_EVERY) {
            const end = Math.min(vertexCount, start + YIELD_EVERY);
            for (let i = start; i < end; i++) {
              normalAccessor.getElement(i, tmp);
              const x = tmp[0], y = tmp[1], z = tmp[2];
              const nx = nm[0] * x + nm[3] * y + nm[6] * z;
              const ny = nm[1] * x + nm[4] * y + nm[7] * z;
              const nz = nm[2] * x + nm[5] * y + nm[8] * z;
              const length = Math.hypot(nx, ny, nz) || 1;
              const j = i * 3;
              nor[j] = nx / length;
              nor[j + 1] = ny / length;
              nor[j + 2] = nz / length;
            }
            await advance(end - start);
          }
        } else {
          warnings.add('У части мешей не было нормалей; для них нормали рассчитаны автоматически.');
          nor = await computeNormals(pos, idx, advance);
        }

        const semantics = primitive.listSemantics();
        const material = primitive.getMaterial();
        const texture = material?.getBaseColorTexture() ?? null;
        const textureInfo = material?.getBaseColorTextureInfo() ?? null;
        const texCoordIndex = textureInfo?.getTexCoord() ?? 0;
        // KHR_texture_transform может и переопределить набор UV, и задать матрицу к нему
        const transform = textureInfo?.getExtension<Transform>('KHR_texture_transform') ?? null;
        const uvSet = transform?.getTexCoord() ?? texCoordIndex;
        const uvAccessor = primitive.getAttribute(`TEXCOORD_${uvSet}`);
        if (texture && !preserveTextures) droppedTexture = true;
        let textureSource: RawTexture | undefined;
        if (preserveTextures && texture) {
          if (!uvAccessor) warnings.add(`Для текстуры «${texture.getName() || 'без имени'}» не найден UV-канал ${uvSet}; текстура не перенесена.`);
          else textureSource = await getTextureSource(texture);
        }
        for (const semantic of semantics) {
          if (semantic !== 'POSITION' && semantic !== 'NORMAL' && !(textureSource && semantic === `TEXCOORD_${uvSet}`)) {
            unsupportedAttributes.add(semantic);
          }
        }

        let uv: Float32Array | undefined;
        if (textureSource && uvAccessor) {
          uv = new Float32Array(vertexCount * 2);
          const uvElement = [0, 0];
          for (let start = 0; start < vertexCount; start += YIELD_EVERY) {
            const end = Math.min(vertexCount, start + YIELD_EVERY);
            for (let i = start; i < end; i++) {
              uvAccessor.getElement(i, uvElement);
              uv[i * 2] = uvElement[0];
              uv[i * 2 + 1] = uvElement[1];
            }
            await advance(end - start);
          }
          if (transform) applyTextureTransform(uv, transform);
        }
        if (
          material?.getEmissiveTexture() || material?.getNormalTexture() || material?.getMetallicRoughnessTexture() || material?.getOcclusionTexture()
        ) droppedMaterialMaps = true;

        const baseColor = material?.getBaseColorFactor() ?? [0.8, 0.8, 0.8, 1];
        let color: [number, number, number] = [baseColor[0], baseColor[1], baseColor[2]];
        if (texture && !textureSource && avgColor) {
          let average = colorCache.get(texture);
          if (average === undefined) {
            const image = texture.getImage();
            average = image ? await avgColor(image, texture.getMimeType()).catch(() => null) : null;
            colorCache.set(texture, average);
          }
          if (average) color = [color[0] * srgbToLinear(average[0]), color[1] * srgbToLinear(average[1]), color[2] * srgbToLinear(average[2])];
        }
        const emissive = material?.getEmissiveFactor() ?? [0, 0, 0];
        parts.push({
          id: '',
          name: (node.getName() || mesh.getName() || 'part') + (partIndex++ ? `.${partIndex}` : ''),
          material: material?.getName() || 'material',
          alpha: material && material.getAlphaMode() === 'BLEND' ? baseColor[3] : 1,
          emissive: Math.max(emissive[0], emissive[1], emissive[2]) > 0.05 || !!material?.getEmissiveTexture(),
          color,
          metallic: material?.getMetallicFactor() ?? 0,
          roughness: material?.getRoughnessFactor() ?? 0.8,
          pos,
          nor,
          uv: textureSource ? uv : undefined,
          texture: textureSource,
          idx,
        });
      }
    }
    for (const child of node.listChildren()) await visit(child);
  };
  for (const scene of scenes) for (const node of scene.listChildren()) await visit(node);
  workDone = totalWork;
  report();
  if (!parts.length) throw new Error('В файле нет треугольных мешей');

  if (skippedPrimitiveModes.size) {
    const skipped = [...skippedPrimitiveModes.entries()].map(([mode, count]) => `mode ${mode}: ${count}`).join(', ');
    warnings.add(`Пропущены примитивы не в формате треугольников (${skipped}).`);
  }
  if (unsupportedAttributes.size) {
    warnings.add(`Не сохраняются дополнительные атрибуты вершин: ${[...unsupportedAttributes].sort().join(', ')}.`);
  }
  if (droppedTexture) {
    warnings.add('Base-color текстуры не включены в пакет: где возможно используется усреднённый цвет, иначе — цвет материала. Для поддерживаемых изображений включите «Сохранять текстуры».');
  }
  if (droppedMaterialMaps) {
    warnings.add('Карты normal, metallic-roughness, occlusion и emissive не переносятся; используется упрощённый материал.');
  }

  // Слишком много деталей — склеиваем только действительно одинаковые материалы/текстуры.
  let out = parts;
  if (parts.length > MAX_PARTS) {
    warnings.add(`Деталей ${parts.length} > ${MAX_PARTS}: совместимые детали склеены по материалам.`);
    out = mergeByMaterial(parts);
    if (out.length > MAX_PARTS) {
      throw new Error(`После безопасного объединения осталось ${out.length} деталей (лимит ${MAX_PARTS}). Объедините мелкие меши/варианты материалов в исходной модели и повторите импорт.`);
    }
  }
  out.forEach((part, index) => (part.id = `p${index}`));
  return { parts: out, tris, warnings: [...warnings], credits: preservedCredits };
}

export function mergeByMaterial(parts: RawPart[]): RawPart[] {
  const groups = new Map<string, RawPart[]>();
  for (const part of parts) {
    const key = `${part.material}|${part.alpha}|${part.color.map((value) => Math.round(value * 1e4))}|${part.metallic}|${part.roughness}|${part.emissive}|${part.texture?.id ?? ''}|${part.uv ? 'uv' : 'no-uv'}`;
    const group = groups.get(key);
    if (group) group.push(part);
    else groups.set(key, [part]);
  }
  const merged: RawPart[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const vertexCount = group.reduce((sum, part) => sum + part.pos.length / 3, 0);
    const indexCount = group.reduce((sum, part) => sum + part.idx.length, 0);
    const pos = new Float32Array(vertexCount * 3);
    const nor = new Float32Array(vertexCount * 3);
    const uv = group.every((part) => part.uv) ? new Float32Array(vertexCount * 2) : undefined;
    const idx = new Uint32Array(indexCount);
    let vertexOffset = 0, indexOffset = 0;
    for (const part of group) {
      pos.set(part.pos, vertexOffset * 3);
      nor.set(part.nor, vertexOffset * 3);
      if (uv && part.uv) uv.set(part.uv, vertexOffset * 2);
      for (let i = 0; i < part.idx.length; i++) idx[indexOffset + i] = part.idx[i] + vertexOffset;
      vertexOffset += part.pos.length / 3;
      indexOffset += part.idx.length;
    }
    merged.push({ ...group[0], name: group[0].material, pos, nor, uv, idx });
  }
  return merged;
}

// ------------------------------------------------------------------ запись пакета
const round = (value: number) => Math.round(value * 1e4) / 1e4;

export async function writePackage(parts: RawPart[], profile: Profile): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('car');
  const materials = new Map<string, ReturnType<Document['createMaterial']>>();
  const textures = new Map<string, ReturnType<Document['createTexture']>>();
  for (const part of parts) {
    const materialKey = `${part.material}|${part.color.map(round)}|${part.alpha}|${part.metallic}|${part.roughness}|${part.emissive}|${part.texture?.id ?? ''}`;
    let material = materials.get(materialKey);
    if (!material) {
      material = doc
        .createMaterial(part.material)
        .setBaseColorFactor([part.color[0], part.color[1], part.color[2], part.alpha])
        .setMetallicFactor(part.metallic)
        .setRoughnessFactor(part.roughness)
        .setDoubleSided(true);
      if (part.alpha < 0.98) material.setAlphaMode('BLEND');
      if (part.emissive) material.setEmissiveFactor([0.3, 0.3, 0.3]);
      if (part.texture && part.uv) {
        let texture = textures.get(part.texture.id);
        if (!texture) {
          texture = doc
            .createTexture(part.texture.id)
            .setMimeType(part.texture.mime)
            .setImage(Uint8Array.from(part.texture.image));
          textures.set(part.texture.id, texture);
        }
        material.setBaseColorTexture(texture);
      }
      materials.set(materialKey, material);
    }
    const accessor = (type: 'VEC2' | 'VEC3' | 'SCALAR', array: Float32Array | Uint32Array | Uint16Array) =>
      doc.createAccessor().setType(type).setArray(array as unknown as TypedArray).setBuffer(buffer);
    const compactIndices = part.pos.length / 3 < 65_535 ? Uint16Array.from(part.idx) : part.idx;
    const primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', part.pos))
      .setAttribute('NORMAL', accessor('VEC3', part.nor))
      .setIndices(accessor('SCALAR', compactIndices))
      .setMaterial(material);
    if (part.uv && part.texture) primitive.setAttribute('TEXCOORD_0', accessor('VEC2', part.uv));
    const node = doc.createNode(part.id).setMesh(doc.createMesh(part.id).addPrimitive(primitive));
    scene.addChild(node);
  }
  const root = doc.getRoot();
  root.setExtras({ shtbox: profile as unknown as Record<string, unknown> });
  const credits = profile.credits;
  root.getAsset().generator = 'shtbox importer';
  if (credits?.author || credits?.license) root.getAsset().copyright = [credits.author, credits.license].filter(Boolean).join(' — ');
  return new WebIO().writeBinary(doc);
}
