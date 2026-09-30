import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { MeshPhysicalMaterial } from 'three';
import { FINISH_HINT, FINISH_LABEL, PAINT_FINISHES, DEFAULT_FINISH, isPaintFinish } from '../src/data/paintFinish';
import { PAINT_COLORS, PAINT_GROUPS } from '../src/data/paintColors';
import { addCustomColor, hexToHsl, loadCustomColors, parseColorInput, saveCustomColors, searchColors } from '../src/data/paintSearch';
import { createPaintMaterial, getFx, setPaintFinish } from '../src/view3d/paintMaterial';
import { sanitizeCar } from '../src/core/validation';
import { analyze } from '../src/import/analyze';
import { readModel, writePackage } from '../src/import/glb';
import { createImportedRig, parsePackage } from '../src/models/imported';
import { BMW116I_SPEC } from '../src/models/hatch/bmw116i';
import { buildSedan } from '../src/models/sedan/build';
import type { Car } from '../src/core/types';

/** GLTFLoader в Node требует заглушки декодера картинок. */
function stubs() {
  (globalThis as Record<string, unknown>).self ??= globalThis;
  (globalThis as Record<string, unknown>).createImageBitmap ??= async () => ({ width: 2, height: 2, close() {} });
}

const carInput = (patch: Record<string, unknown>): Car =>
  sanitizeCar({ id: 'car1', name: 'Тест', modelId: 'sedan-solaris', createdAt: 1, updatedAt: 2, ...patch });

describe('покрытия кузова', () => {
  it('набор покрытий покрывает матовый, глянцевый, полуглянцевый и металлик', () => {
    for (const f of ['matte', 'semi-gloss', 'gloss', 'metallic'] as const) expect(PAINT_FINISHES).toContain(f);
    expect(PAINT_FINISHES.length).toBe(7);
    for (const f of PAINT_FINISHES) {
      expect(FINISH_LABEL[f]).toBeTruthy();
      expect(FINISH_HINT[f]).toBeTruthy();
      expect(isPaintFinish(f)).toBe(true);
    }
    expect(isPaintFinish('мокрый')).toBe(false);
    expect(isPaintFinish(undefined)).toBe(false);
    expect(isPaintFinish(DEFAULT_FINISH)).toBe(true);
  });

  it('покрытие меняет параметры материала и «хлопья» металлика без пересоздания геометрии', () => {
    const m = createPaintMaterial('#1f4e8c', 'gloss');
    const gloss = { roughness: m.roughness, metalness: m.metalness, clearcoat: m.clearcoat };
    setPaintFinish(m, 'matte');
    expect(m.roughness).toBeGreaterThan(gloss.roughness);
    expect(m.clearcoat).toBeLessThan(gloss.clearcoat);
    expect(getFx(m)?.flake.value).toBe(0);

    setPaintFinish(m, 'metallic');
    expect(m.metalness).toBeGreaterThan(0.5);
    expect(getFx(m)?.flake.value).toBeGreaterThan(0);

    setPaintFinish(m, 'pearl');
    expect(m.iridescence).toBeGreaterThan(0.5);

    // цвет при смене покрытия не трогаем
    expect(`#${m.color.getHexString()}`).toBe('#1f4e8c');
  });

  it('покрытие и код переживают санитайзер автомобиля, мусор отбрасывается', () => {
    expect(carInput({ finish: 'matte', colorCode: ' BMW 475 ' }).finish).toBe('matte');
    expect(carInput({ finish: 'matte', colorCode: ' BMW 475 ' }).colorCode).toBe('BMW 475');
    expect(carInput({ finish: 'liquid-glass' }).finish).toBeUndefined();
    expect(carInput({ colorCode: 'x'.repeat(40) }).colorCode).toBeUndefined();
    expect(carInput({}).finish).toBeUndefined();
  });

  it('процедурная модель принимает покрытие', () => {
    const matte = createPaintMaterial('#a3161f', 'matte');
    const m = new MeshPhysicalMaterial();
    matte.copy(m);
    const rig = buildSedan(BMW116I_SPEC, '#a3161f', 'metallic');
    expect(rig.setFinish).toBeTypeOf('function');
    rig.setFinish?.('matte');
    const pm = [...rig.paint.values()][0]?.material as MeshPhysicalMaterial;
    expect(pm.roughness).toBeGreaterThan(0.7);
    expect(getFx(pm)?.flake.value).toBe(0);
    expect(rig.windows?.size).toBe(4);
  });
});

describe('поиск цвета по коду', () => {
  it('справочник содержит RAL и автомобильные названия с указанием источника', () => {
    expect(PAINT_COLORS.length).toBeGreaterThan(300);
    expect(PAINT_GROUPS).toContain('RAL Classic');
    const ral = PAINT_COLORS.find((c) => c.code === 'RAL 9005');
    expect(ral?.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('код находится в любом написании, а ввод HEX/rgb распознаётся как цвет', () => {
    for (const q of ['RAL 9005', 'ral9005', '9005']) {
      const hit = searchColors(q)[0];
      expect(hit?.item.code).toBe('RAL 9005');
    }
    expect(parseColorInput('#1F4E8C')).toBe('#1f4e8c');
    expect(parseColorInput('1f4e8c')).toBe('#1f4e8c');
    expect(parseColorInput('#abc')).toBe('#aabbcc');
    expect(parseColorInput('rgb(31, 78, 140)')).toBe('#1f4e8c');
    expect(parseColorInput('не цвет')).toBeNull();
    expect(searchColors('#1f4e8c')[0].item.hex).toBe('#1f4e8c');
  });

  it('по слову находит светлые цвета, по «металлик» — металлики', () => {
    const white = searchColors('белый');
    expect(white.length).toBeGreaterThan(5);
    for (const r of white.slice(0, 10)) expect(hexToHsl(r.item.hex).l).toBeGreaterThan(0.8);
    const metallic = searchColors('металлик');
    expect(metallic.length).toBeGreaterThan(5);
    for (const r of metallic) expect(r.item.finish).toBe('metallic');
  });

  it('свои коды производителя хранятся отдельно, ищутся и чистятся при загрузке', () => {
    const own = addCustomColor([], { code: 'BMW 475', name: 'Black Sapphire', hex: '#101418' });
    expect(own[0].code).toBe('BMW 475');
    const found = searchColors('bmw475', own);
    expect(found[0].item.name).toBe('Black Sapphire');
    expect(found[0].custom).toBe(true);

    const round = loadCustomColors(saveCustomColors(own));
    expect(round).toEqual([{ code: 'BMW 475', name: 'Black Sapphire', hex: '#101418', group: 'Свои коды', custom: true }]);
    // мусор не проходит: битый HEX, пустые имя и код, дубликаты
    expect(loadCustomColors(JSON.stringify([{ code: '', name: '', hex: 'нет' }, { code: 'x', name: 'y', hex: '#12345' }]))).toEqual([]);
    expect(loadCustomColors('не json')).toEqual([]);
    const dup = addCustomColor(own, { code: 'bmw 475', name: 'Другое', hex: '#222222' });
    expect(dup.length).toBe(1);
    expect(dup[0].hex).toBe('#222222');
  });
});

describe('опускание стёкол в импортированной модели', () => {
  it('стёкла дверей опускаются и возвращаются, задняя дверь хэтча не трогается', async () => {
    stubs();
    const buf = await readFile(new URL('../public/models/bmw116i.glb', import.meta.url));
    const data = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const { parts } = await readModel(data);
    const profile = analyze(parts, 'BMW 116i');
    const glb = await writePackage(parts, profile);
    const arr = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
    const { scene, profile: pr } = await parsePackage(arr);
    const rig = createImportedRig(scene, pr, '#e6e9ec');

    const zones = [...(rig.windows ?? [])].map(([z]) => z).sort();
    expect(zones).toEqual(['door_fl', 'door_fr', 'door_rl', 'door_rr']);
    expect(rig.windows?.has('trunk')).toBe(false);

    const zone = 'door_fl';
    const win = rig.windows!.get(zone)!;
    const glass = win.meshes[0];
    expect(glass).toBeTruthy();
    const fx = getFx(glass.material as never)!;
    const baseY = glass.position.y;
    expect(fx.win.z).toBe(0); // закрытое стекло выглядит как исходная модель

    win.set(1);
    expect(glass.position.y).toBeLessThan(baseY - 0.1);
    expect(fx.win.z).toBe(1);
    expect(fx.win.x).toBeCloseTo(win.top, 5);

    win.set(0.5);
    expect(glass.position.y).toBeGreaterThan(baseY - 0.5);
    expect(fx.win.z).toBe(1);

    win.set(0);
    expect(glass.position.y).toBeCloseTo(baseY, 6);
    expect(fx.win.z).toBe(0);
  }, 60_000);
});
