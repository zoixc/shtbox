import { describe, expect, it } from 'vitest';
import { Document, WebIO } from '@gltf-transform/core';
import type { TypedArray } from '@gltf-transform/core';
import { zipSync } from 'fflate';
import { splitGlb } from '../src/import/container';
import { readModel } from '../src/import/glb';
import { filesToGlb, MAX_SOURCE_FILES, type SourceFile } from '../src/import/sources';

const pixelPng = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=', 'base64'),
);

function accessor(doc: Document, buffer: ReturnType<Document['createBuffer']>, type: 'VEC2' | 'VEC3' | 'SCALAR', data: Float32Array | Uint16Array) {
  return doc.createAccessor().setType(type).setArray(data as unknown as TypedArray).setBuffer(buffer);
}

/** Мини-модель: один окрашиваемый треугольник, при желании — с base-color текстурой. */
async function triangleGlb(withTexture: boolean): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('fixture');
  const primitive = doc.createPrimitive()
    .setAttribute('POSITION', accessor(doc, buffer, 'VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute('NORMAL', accessor(doc, buffer, 'VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setIndices(accessor(doc, buffer, 'SCALAR', new Uint16Array([0, 1, 2])));
  const material = doc.createMaterial('Paint').setBaseColorFactor([0.5, 0.5, 0.5, 1]);
  if (withTexture) {
    material.setBaseColorTexture(doc.createTexture('paint').setMimeType('image/png').setImage(pixelPng));
    primitive.setAttribute('TEXCOORD_0', accessor(doc, buffer, 'VEC2', new Float32Array([0, 0, 1, 0, 0, 1])));
  }
  primitive.setMaterial(material);
  scene.addChild(doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(primitive)));
  return new WebIO().writeBinary(doc);
}

interface View { byteOffset?: number; byteLength: number }
interface Image { bufferView?: number; uri?: string; mimeType?: string }

/** Разбирает GLB на «как если бы это скачали»: .gltf + .bin + картинки отдельными файлами. */
function externalFiles(glb: Uint8Array, textureName = 'paint.png'): { files: SourceFile[]; json: Record<string, unknown> } {
  const { json, bin } = splitGlb(glb);
  const views = (json.bufferViews ?? []) as View[];
  const images = (json.images ?? []) as Image[];
  const files: SourceFile[] = [];
  for (const [index, image] of images.entries()) {
    if (image.bufferView === undefined) continue;
    const view = views[image.bufferView];
    const start = view.byteOffset ?? 0;
    files.push({ name: textureName, bytes: new Uint8Array(bin!.subarray(start, start + view.byteLength)) });
    delete image.bufferView;
    image.uri = textureName;
    void index;
  }
  json.buffers = [{ uri: 'scene.bin', byteLength: bin!.byteLength }];
  json.bufferViews = views.map((view) => ({ ...view, buffer: 0 }));
  files.unshift({ name: 'scene.gltf', bytes: new TextEncoder().encode(JSON.stringify(json)) });
  files.push({ name: 'scene.bin', bytes: bin! });
  return { files, json: json as Record<string, unknown> };
}

describe('source files → GLB', () => {
  it('пропускает готовый .glb без пересборки', async () => {
    const glb = await triangleGlb(false);
    const result = filesToGlb([{ name: 'Model.GLB', bytes: glb }]);
    expect(result.glb).toBe(glb);
    expect(result.name).toBe('Model');
    expect(result.warnings).toEqual([]);
  });

  it('собирает .gltf + .bin в самодостаточный GLB', async () => {
    const { files, json } = externalFiles(await triangleGlb(false));
    expect((json.buffers as { uri: string }[])[0].uri).toBe('scene.bin');
    const result = filesToGlb(files);
    expect(result.name).toBe('scene');
    expect(result.warnings.join(' ')).toMatch(/встроены в GLB/);
    const read = await readModel(result.glb);
    expect(read.parts.length).toBe(1);
    expect(read.parts[0].pos.length).toBe(9);
    const { json: back, bin } = splitGlb(result.glb);
    expect((back.buffers as unknown[]).length).toBe(1);
    expect((back.buffers as { uri?: string }[])[0].uri).toBeUndefined();
    expect(bin!.byteLength % 4).toBe(0);
  });

  it('переносит внешние текстуры в GLB и они доходят до разбора', async () => {
    const { files, json } = externalFiles(await triangleGlb(true));
    expect((json.images as Image[])[0].uri).toBe('paint.png');
    const result = filesToGlb(files);
    const { json: back } = splitGlb(result.glb);
    const image = (back.images as Image[])[0];
    expect(image.uri).toBeUndefined();
    expect(image.mimeType).toBe('image/png');
    expect(typeof image.bufferView).toBe('number');
    const read = await readModel(result.glb, undefined, { preserveTextures: true });
    expect(read.parts[0].texture?.mime).toBe('image/png');
    expect(read.parts[0].uv?.length).toBe(6);
  });

  it('распаковывает zip-архив с вложенной папкой', async () => {
    const { files } = externalFiles(await triangleGlb(true), 'textures/paint.png');
    const zip = zipSync(Object.fromEntries(files.map((file) => [`car/${file.name}`, file.bytes])));
    const result = filesToGlb([{ name: 'car.zip', bytes: zip }]);
    expect(result.warnings.join(' ')).toMatch(/Zip-архив распакован: файлов 3/);
    const read = await readModel(result.glb, undefined, { preserveTextures: true });
    expect(read.parts.length).toBe(1);
    expect(read.parts[0].texture?.mime).toBe('image/png');
  });

  it('объясняет, какого ресурса не хватает', async () => {
    const { files } = externalFiles(await triangleGlb(false));
    expect(() => filesToGlb(files.filter((file) => !file.name.endsWith('.bin')))).toThrow(/Не найден файл буфера «scene\.bin»/);
    expect(() => filesToGlb([{ name: 'notes.txt', bytes: new Uint8Array([1, 2, 3]) }])).toThrow(/нет ни \.glb, ни \.gltf/);
    expect(() => filesToGlb([])).toThrow(/Не выбрано ни одного файла/);
    const many = Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, i) => ({ name: `f${i}.bin`, bytes: new Uint8Array([1]) }));
    expect(() => filesToGlb(many)).toThrow(/Слишком много файлов/);
  });

  it('понимает data:-URI буфера и не требует внешних файлов', async () => {
    const glb = await triangleGlb(false);
    const { json, bin } = splitGlb(glb);
    const base64 = Buffer.from(bin!).toString('base64');
    json.buffers = [{ uri: `data:application/octet-stream;base64,${base64}`, byteLength: bin!.byteLength }];
    const gltf: SourceFile = { name: 'inline.gltf', bytes: new TextEncoder().encode(JSON.stringify(json)) };
    const result = filesToGlb([gltf]);
    const read = await readModel(result.glb);
    expect(read.parts.length).toBe(1);
    expect(result.warnings.join(' ')).not.toMatch(/Неиспользованных/);
  });
});
