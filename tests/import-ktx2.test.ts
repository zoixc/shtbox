import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unzlibSync } from 'fflate';
import { Document, WebIO } from '@gltf-transform/core';
import type { TypedArray } from '@gltf-transform/core';
import { encodePng, ktx2ToPng, KTX2_MAX_EDGE } from '../src/import/ktx2';
import { readModel } from '../src/import/glb';

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Настоящая KTX2-текстура (8×8, четыре однотонных квадрата), сжатая ETC1S.
 * Сгенерирована один раз офлайн через `ktx2-encoder` (MIT) и лежит рядом, чтобы тесты
 * не тянули в зависимости ещё один wasm-кодировщик:
 *   encodeToKTX2(png, { isUASTC: false, generateMipmap: false, imageDecoder })
 */
const KTX2_FIXTURE = Uint8Array.from(readFileSync(fileURLToPath(new URL('./fixtures/ktx2-8x8.ktx2', import.meta.url))));

/** Цвета квадратов 8×8 (левый верх / правый верх / левый низ / правый низ). */
const QUADRANTS = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
];

function pixel(png: PngInfo, x: number, y: number): number[] {
  const offset = y * (png.width * 4 + 1) + 1 + x * 4;
  return [...png.raw.subarray(offset, offset + 4)];
}

/** ETC1S сжимает с потерями, поэтому сравниваем квадраты с ожидаемым цветом «на глаз». */
function nearestQuadrant(rgba: number[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  QUADRANTS.forEach((quad, index) => {
    const distance = quad.slice(0, 3).reduce((sum, channel, i) => sum + (channel - rgba[i]) ** 2, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

interface PngInfo {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  raw: Uint8Array;
}

/** Минимальный разбор PNG для проверки собственного кодера (без canvas и внешних библиотек). */
function readPng(bytes: Uint8Array): PngInfo {
  expect([...bytes.subarray(0, 8)]).toEqual(signature);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let info: Omit<PngInfo, 'raw'> | null = null;
  const idat: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      info = { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12), bitDepth: data[8], colorType: data[9] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!info) throw new Error('PNG без IHDR');
  const merged = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of idat) { merged.set(chunk, at); at += chunk.length; }
  return { ...info, raw: unzlibSync(merged, { out: new Uint8Array(info.height * (info.width * 4 + 1)) }) as Uint8Array };
}

describe('KTX2 и PNG для импорта текстур', () => {
  it('кодирует RGBA в PNG без canvas и восстанавливает пиксели', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 40]);
    const png = encodePng(rgba, 2, 2);
    const parsed = readPng(png);
    expect([parsed.width, parsed.height, parsed.bitDepth, parsed.colorType]).toEqual([2, 2, 8, 6]);
    // Каждая строка предваряется байтом фильтра (0 = None).
    const stride = 2 * 4;
    for (let y = 0; y < 2; y++) {
      expect(parsed.raw[y * (stride + 1)]).toBe(0);
      expect([...parsed.raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))]).toEqual([...rgba.subarray(y * stride, (y + 1) * stride)]);
    }
  });

  it('отвергает слишком маленький буфер', () => {
    expect(() => encodePng(new Uint8Array(3), 2, 2)).toThrow(/размер/);
  });

  it('сообщает об ошибке вместо падения, если KTX2 повреждён', async () => {
    // Ошибка именно от транскодера Basis (а не от загрузки модуля): файл прочитан, но невалиден.
    await expect(ktx2ToPng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow(/повреждён или не содержит Basis/);
    expect(KTX2_MAX_EDGE).toBeGreaterThanOrEqual(2048);
  });

  it('распаковывает настоящую KTX2-текстуру (ETC1S) в PNG', async () => {
    const decoded = await ktx2ToPng(KTX2_FIXTURE);
    expect(decoded).not.toBeNull();
    expect([decoded!.width, decoded!.height]).toEqual([8, 8]);
    const png = readPng(decoded!.png);
    expect([png.width, png.height, png.colorType]).toEqual([8, 8, 6]);
    // По центру каждого квадрата цвет должен остаться «своим».
    expect(nearestQuadrant(pixel(png, 1, 1))).toBe(0);
    expect(nearestQuadrant(pixel(png, 6, 1))).toBe(1);
    expect(nearestQuadrant(pixel(png, 1, 6))).toBe(2);
    expect(nearestQuadrant(pixel(png, 6, 6))).toBe(3);
  });

  it('переносит KTX2 из GLB в PNG-текстуру пакета', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene('ktx2-real');
    const positions = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) as unknown as TypedArray).setBuffer(buffer);
    const normals = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) as unknown as TypedArray).setBuffer(buffer);
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]) as unknown as TypedArray).setBuffer(buffer);
    const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2]) as unknown as TypedArray).setBuffer(buffer);
    const texture = doc.createTexture('paint').setMimeType('image/ktx2').setImage(KTX2_FIXTURE);
    const material = doc.createMaterial('Paint').setBaseColorTexture(texture).setBaseColorFactor([1, 1, 1, 1]);
    const primitive = doc.createPrimitive()
      .setAttribute('POSITION', positions)
      .setAttribute('NORMAL', normals)
      .setAttribute('TEXCOORD_0', uv)
      .setIndices(indices)
      .setMaterial(material);
    scene.addChild(doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(primitive)));
    const glb = await new WebIO().registerExtensions([]).writeBinary(doc);

    const plain = await readModel(glb, undefined, { preserveTextures: true });
    expect(plain.tris).toBe(1);
    expect(plain.parts[0].texture?.mime).toBe('image/png');
    const png = readPng(plain.parts[0].texture!.image);
    expect([png.width, png.height]).toEqual([8, 8]);
    expect(plain.warnings.some((warning) => warning.includes('распакована в PNG'))).toBe(true);
  });

  it('принимает KHR_texture_basisu и сводит повреждённую KTX2-текстуру к цвету материала', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene('ktx2-fixture');
    const positions = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) as unknown as TypedArray).setBuffer(buffer);
    const normals = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) as unknown as TypedArray).setBuffer(buffer);
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]) as unknown as TypedArray).setBuffer(buffer);
    const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2]) as unknown as TypedArray).setBuffer(buffer);
    const texture = doc.createTexture('base').setMimeType('image/ktx2').setImage(Uint8Array.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]));
    const material = doc.createMaterial('Paint').setBaseColorTexture(texture).setBaseColorFactor([0.4, 0.5, 0.6, 1]);
    const primitive = doc.createPrimitive()
      .setAttribute('POSITION', positions)
      .setAttribute('NORMAL', normals)
      .setAttribute('TEXCOORD_0', uv)
      .setIndices(indices)
      .setMaterial(material);
    scene.addChild(doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(primitive)));
    const glb = await new WebIO().registerExtensions([]).writeBinary(doc);

    const plain = await readModel(glb, undefined, { preserveTextures: true });
    expect(plain.tris).toBe(1);
    expect(plain.parts[0].texture).toBeUndefined();
    expect(plain.warnings.some((warning) => warning.includes('KTX2'))).toBe(true);
  });
});
