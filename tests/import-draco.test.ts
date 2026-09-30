import { describe, expect, it } from 'vitest';
import { Document, WebIO } from '@gltf-transform/core';
import type { TypedArray } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { hasDraco, decodeDracoGlb } from '../src/import/draco';
import { readModel } from '../src/import/glb';

/** Кодировщик Draco (из того же пакета, что и декодер) — нужен только для тестового файла. */
async function dracoEncoder(): Promise<unknown> {
  const mod = (await import('draco3dgltf/draco_encoder_gltf_nodejs.js')) as unknown as { default?: unknown };
  const create = (mod.default ?? mod) as (options?: { wasmBinary?: ArrayBuffer }) => Promise<unknown>;
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const wasm = readFileSync(createRequire(import.meta.url).resolve('draco3dgltf/draco_encoder.wasm'));
  return create({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
}

function triangleDoc(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('draco-fixture');
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]) as unknown as TypedArray)
    .setBuffer(buffer);
  const normals = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) as unknown as TypedArray)
    .setBuffer(buffer);
  const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2, 1, 3, 2]) as unknown as TypedArray).setBuffer(buffer);
  const material = doc.createMaterial('Body').setBaseColorFactor([0.4, 0.5, 0.6, 1]).setMetallicFactor(0.2).setRoughnessFactor(0.7);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', positions)
    .setAttribute('NORMAL', normals)
    .setIndices(indices)
    .setMaterial(material);
  scene.addChild(doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(primitive)));
  return doc;
}

/** Собирает GLB с KHR_draco_mesh_compression — так выглядят модели со Sketchfab. */
async function dracoGlb(): Promise<Uint8Array> {
  const encoder = await dracoEncoder();
  const io = new WebIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({ 'draco3d.encoder': encoder });
  const doc = triangleDoc();
  doc.createExtension(KHRDracoMeshCompression).setRequired(true);
  return io.writeBinary(doc);
}

describe('импорт моделей со сжатием Draco', () => {
  it('видит Draco по JSON-блоку GLB', async () => {
    const glb = await dracoGlb();
    const { splitGlb } = await import('../src/import/container');
    const { json } = splitGlb(glb);
    expect(hasDraco(json)).toBe(true);
  });

  it('распаковывает Draco-геометрию и читает модель как обычную', async () => {
    const glb = await dracoGlb();
    const plain = await decodeDracoGlb(glb);
    const { splitGlb } = await import('../src/import/container');
    expect(hasDraco(splitGlb(plain).json)).toBe(false);
    expect(plain.byteLength).toBeGreaterThan(0);

    const model = await readModel(glb);
    expect(model.tris).toBe(2);
    expect(model.parts).toHaveLength(1);
    expect(model.warnings.some((warning) => warning.includes('Draco'))).toBe(true);
  });

  it('повреждённый Draco не роняет импорт, а объясняет проблему', async () => {
    const glb = await dracoGlb();
    const broken = Uint8Array.from(glb);
    broken[broken.length - 10] = 0; // портим полезную нагрузку буфера
    broken[broken.length - 11] = 0;
    await expect(decodeDracoGlb(broken)).rejects.toThrow(/Не удалось распаковать Draco-геометрию/);
  });
});
