import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Document, WebIO } from '@gltf-transform/core';
import type { TypedArray } from '@gltf-transform/core';
import { ImportCancelledError, ImportSession } from '../src/import/client';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { joinGlb, splitGlb } from '../src/import/container';
import { readModel, writePackage } from '../src/import/glb';
import { estimatePreservedTextures } from '../src/import/texture-estimate';
import { DEFAULT_BUDGET, processModel } from '../src/import/pipeline';
import { allocateTriangleTargets, semanticPriority, weld } from '../src/import/simplify';
import type { Profile, RawPart } from '../src/import/types';

const sampleCarProfile = (): Profile => ({
  v: 1,
  title: 'Texture test',
  body: 'hatch',
  layout: 'front',
  driver: 'l',
  frame: { yaw: 0, scale: 1, offset: [0, 0, 0] },
  dims: { L: 4.3, W: 1.8, H: 1.4, xFront: 2.15, xRear: -2.15, axleF: 1.3, axleR: -1.3, track: 0.7, wheelR: 0.3 },
  lines: {
    bumperFront: 1.9, cowl: 0.6, doorFront: 0.5, roofFront: 0, doorSplit: -0.4, roofRear: -1.3,
    doorRear: -1.2, trunkFront: -1.9, bumperRear: -2, sill: 0.25, belt: 0.9,
    bumperTopF: 0.5, bumperTopR: 0.45, hoodHw: 0.7, trunkHw: 0.55,
  },
  paint: ['Paint'],
  parts: { p0: { n: 'Body', k: 'paint', m: 'Paint' } },
});

function rawPart(id: string, name: string, tris: number): RawPart {
  const vertices = tris * 3;
  const pos = new Float32Array(vertices * 3);
  const nor = new Float32Array(vertices * 3);
  const idx = new Uint32Array(vertices);
  for (let i = 0; i < vertices; i++) {
    pos[i * 3] = i % 17;
    pos[i * 3 + 1] = (i * 7) % 23;
    nor[i * 3 + 2] = 1;
    idx[i] = i;
  }
  return { id, name, material: 'generic', alpha: 1, emissive: false, color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.8, pos, nor, idx };
}

const pixelPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=', 'base64'));

function accessor(doc: Document, buffer: ReturnType<Document['createBuffer']>, type: 'VEC2' | 'VEC3' | 'SCALAR', data: Float32Array | Uint32Array) {
  return doc.createAccessor().setType(type).setArray(data as unknown as TypedArray).setBuffer(buffer);
}

async function triangleGlb(withTexture: boolean): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('fixture');
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2]);
  const primitive = doc.createPrimitive()
    .setAttribute('POSITION', accessor(doc, buffer, 'VEC3', positions))
    .setAttribute('NORMAL', accessor(doc, buffer, 'VEC3', normals))
    .setIndices(accessor(doc, buffer, 'SCALAR', indices));
  const material = doc.createMaterial('Paint');
  if (withTexture) {
    const texture = doc.createTexture('one-pixel').setMimeType('image/png').setImage(pixelPng);
    material.setBaseColorTexture(texture);
    primitive.setAttribute('TEXCOORD_0', accessor(doc, buffer, 'VEC2', new Float32Array([0, 0, 1, 0, 0, 1])));
  }
  primitive.setMaterial(material);
  scene.addChild(doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(primitive)));
  return new WebIO().writeBinary(doc);
}

async function manyMaterialGlb(count: number): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('part-limit-fixture');
  const positions = accessor(doc, buffer, 'VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const normals = accessor(doc, buffer, 'VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const indices = accessor(doc, buffer, 'SCALAR', new Uint32Array([0, 1, 2]));
  const mesh = doc.createMesh('many-materials');
  for (let i = 0; i < count; i++) {
    const material = doc.createMaterial(`material-${i}`).setBaseColorFactor([0.5, 0.5, 0.5, 1]);
    mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions).setAttribute('NORMAL', normals).setIndices(indices).setMaterial(material));
  }
  scene.addChild(doc.createNode('many-materials').setMesh(mesh));
  return new WebIO().writeBinary(doc);
}

async function meshoptGlb(): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('meshopt-fixture');
  const columns = 30, rows = 30;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      positions.push(x / (columns - 1), y / (rows - 1), Math.sin(x * 0.2) * Math.cos(y * 0.2) * 0.02);
      normals.push(0, 0, 1);
    }
  }
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < columns - 1; x++) {
      const a = y * columns + x, b = a + 1, c = a + columns, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const primitive = doc.createPrimitive()
    .setAttribute('POSITION', accessor(doc, buffer, 'VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', accessor(doc, buffer, 'VEC3', new Float32Array(normals)))
    .setIndices(accessor(doc, buffer, 'SCALAR', new Uint32Array(indices)));
  scene.addChild(doc.createNode('grid').setMesh(doc.createMesh('grid').addPrimitive(primitive)));
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const io = new WebIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  return io.writeBinary(doc);
}

describe('importer resource safeguards', () => {
  it('welds repeated vertices without merging UV seams or changing triangle winding', async () => {
    const part: RawPart = {
      ...rawPart('p0', 'seamed part', 2),
      pos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
      nor: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array([0, 0, 1, 0, 0, 1, 0.5, 0, 1, 0, 0, 1]),
      idx: new Uint32Array([0, 1, 2, 3, 4, 5]),
    };
    const result = await weld(part);
    expect(result.pos.length / 3).toBe(4);
    expect(result.idx).toEqual(new Uint32Array([0, 1, 2, 3, 1, 2]));
    expect(result.uv?.[6]).toBe(0.5);
  });

  it('allocates one global budget and reserves more triangles for semantically named components', () => {
    const generic = rawPart('p0', 'object_0', 2_000);
    const wheel = rawPart('p1', 'wheel_front_left', 2_000);
    const targets = allocateTriangleTargets([generic, wheel], 500);
    const assigned = Object.fromEntries(targets.map((item) => [item.id, item.target]));
    expect(targets.reduce((sum, item) => sum + item.target, 0)).toBe(500);
    expect(assigned.p1).toBeGreaterThan(assigned.p0);
    expect(semanticPriority(wheel)).toBeGreaterThan(semanticPriority(generic));
    expect(() => allocateTriangleTargets([generic, wheel], 1)).toThrow(/не менее 2/);
  });

  it('imports EXT_meshopt_compression through the registered decoder', async () => {
    const compressed = await meshoptGlb();
    const { json } = splitGlb(compressed);
    expect(json.extensionsRequired).toContain('EXT_meshopt_compression');
    const result = await readModel(compressed);
    expect(result.tris).toBe((30 - 1) * (30 - 1) * 2);
    expect(result.parts).toHaveLength(1);
  });

  it('keeps embedded albedo/UVs only when explicitly requested and round-trips the package', async () => {
    const source = await triangleGlb(true);
    const sourceJson = splitGlb(source).json;
    expect(estimatePreservedTextures(sourceJson)).toEqual({ bytes: pixelPng.byteLength, textures: 1, omitted: 0 });
    expect(estimatePreservedTextures(sourceJson, pixelPng.byteLength - 1)).toEqual({ bytes: 0, textures: 0, omitted: 1 });
    const transformedGlb = splitGlb(source);
    const material = (transformedGlb.json.materials as Array<Record<string, unknown>>)[0];
    const pbr = material.pbrMetallicRoughness as Record<string, unknown>;
    const textureInfo = pbr.baseColorTexture as Record<string, unknown>;
    textureInfo.extensions = { KHR_texture_transform: { offset: [0.25, 0.25] } };
    expect(estimatePreservedTextures(transformedGlb.json)).toEqual({ bytes: 0, textures: 0, omitted: 0 });
    const transformed = await readModel(joinGlb(transformedGlb.json, transformedGlb.bin), undefined, { preserveTextures: true });
    expect(transformed.parts[0].texture).toBeUndefined();
    expect(transformed.warnings.some((warning) => warning.includes('KHR_texture_transform'))).toBe(true);

    const defaultRead = await readModel(source);
    expect(defaultRead.parts[0].texture).toBeUndefined();
    expect(defaultRead.warnings.some((warning) => warning.includes('не включены в пакет'))).toBe(true);

    const progress: number[] = [];
    const preserved = await readModel(source, undefined, { preserveTextures: true, onProgress: (_stage, frac) => progress.push(frac) });
    expect(preserved.parts[0].texture?.mime).toBe('image/png');
    expect(preserved.parts[0].uv).toHaveLength(6);
    expect(progress.at(-1)).toBe(1);

    const output = await writePackage(preserved.parts, sampleCarProfile());
    const roundTrip = await new WebIO().readBinary(output);
    const primitive = roundTrip.getRoot().listMeshes()[0].listPrimitives()[0];
    expect(primitive.getAttribute('TEXCOORD_0')?.getCount()).toBe(3);
    expect(primitive.getMaterial()?.getBaseColorTexture()?.getMimeType()).toBe('image/png');
    expect(primitive.getMaterial()?.getBaseColorTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
  });

  it('warns before skipping non-triangle primitives and rejects unknown required extensions', async () => {
    const source = await triangleGlb(false);
    const { json, bin } = splitGlb(source);
    const meshes = json.meshes as Array<{ primitives: Array<Record<string, unknown>> }>;
    meshes[0].primitives.push({ ...meshes[0].primitives[0], mode: 1 });
    const withLines = await readModel(joinGlb(json, bin));
    expect(withLines.tris).toBe(1);
    expect(withLines.warnings.some((warning) => warning.includes('не в формате треугольников'))).toBe(true);

    const unsupported = splitGlb(source);
    unsupported.json.extensionsRequired = ['KHR_vendor_required'];
    await expect(readModel(joinGlb(unsupported.json, unsupported.bin))).rejects.toThrow(/KHR_vendor_required/);
  });

  it('rejects models that remain over the UI part limit after safe material merges', async () => {
    await expect(readModel(await manyMaterialGlb(401))).rejects.toThrow(/лимит 400/);
  });

  it('terminates a pending import immediately when cancelled', async () => {
    const previousWorker = globalThis.Worker;
    let terminated = false;
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(): void {}
      terminate(): void { terminated = true; }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    try {
      const session = new ImportSession();
      const pending = session.importFile(new ArrayBuffer(8), 'cancelled');
      session.close();
      await expect(pending).rejects.toBeInstanceOf(ImportCancelledError);
      expect(terminated).toBe(true);
      session.close();
    } finally {
      if (previousWorker) Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });

  it('keeps the representative BMW import within the default global triangle target', async () => {
    const data = new Uint8Array(readFileSync('public/models/bmw116i.glb'));
    const result = await processModel(data, { title: 'BMW import regression' });
    expect(result.stats.srcTris).toBeGreaterThan(result.stats.tris);
    expect(result.stats.tris).toBeLessThanOrEqual(DEFAULT_BUDGET);
    expect(result.stats.parts).toBeGreaterThan(0);
    expect(Object.values(result.profile.parts).some((part) => part.confidence === 'low' || part.confidence === 'medium' || part.confidence === 'high')).toBe(true);
  });
});
