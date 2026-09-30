import { describe, expect, it } from 'vitest';
import { MIN_TEXTURE_BYTES, optimizeTextures } from '../src/import/texture-optimize';
import type { RawPart, RawTexture } from '../src/import/types';

const texture = (id: string, bytes: number): RawTexture => ({ id, mime: 'image/png', image: new Uint8Array(bytes) });

const part = (patch: Partial<RawPart> & { texture?: RawTexture }): RawPart => ({
  id: 'p0',
  material: 'Body',
  color: [1, 1, 1],
  alpha: 1,
  metallic: 0,
  roughness: 0.5,
  emissive: false,
  pos: new Float32Array(9),
  nor: new Float32Array(9),
  idx: new Uint32Array([0, 1, 2]),
  uv: new Float32Array(6),
  ...patch,
} as RawPart);

const big = MIN_TEXTURE_BYTES * 4;

describe('оптимизация текстур', () => {
  it('перекодирует большую текстуру и переносит результат в деталь', async () => {
    const source = texture('t0', big);
    const parts = [part({ texture: source })];
    let calls = 0;
    const stats = await optimizeTextures(parts, {
      encoder: async (t) => {
        calls++;
        return { id: t.id, mime: 'image/jpeg', image: new Uint8Array(Math.floor(t.image.byteLength / 4)) };
      },
    });
    expect(calls).toBe(1);
    expect(stats).toEqual({ before: big, after: big / 4, converted: 1, kept: 0 });
    expect(parts[0].texture?.mime).toBe('image/jpeg');
    expect(parts[0].texture?.image.byteLength).toBe(big / 4);
  });

  it('кодирует общую текстуру один раз, даже если она у нескольких деталей', async () => {
    const shared = texture('t1', big);
    const parts = [part({ id: 'p0', texture: shared }), part({ id: 'p1', texture: shared }), part({ id: 'p2', texture: shared })];
    let calls = 0;
    const stats = await optimizeTextures(parts, {
      encoder: async (t) => {
        calls++;
        return { id: t.id, mime: 'image/jpeg', image: new Uint8Array(t.image.byteLength - 10) };
      },
    });
    expect(calls).toBe(1);
    expect(stats.converted).toBe(1);
    expect(parts.every((p) => p.texture?.mime === 'image/jpeg')).toBe(true);
    expect(parts[0].texture).toBe(parts[2].texture);
  });

  it('оставляет исходные байты, если выигрыша нет или кодировщик упал', async () => {
    const source = texture('t2', big);
    const parts = [part({ texture: source })];
    const noGain = await optimizeTextures(parts, { encoder: async () => null });
    expect(noGain).toEqual({ before: big, after: big, converted: 0, kept: 1 });
    expect(parts[0].texture).toBe(source);

    const broken = await optimizeTextures([part({ texture: source })], {
      encoder: async () => {
        throw new Error('нет памяти');
      },
    });
    expect(broken.converted).toBe(0);
    expect(broken.kept).toBe(1);
  });

  it('пропускает мелкие текстуры, полупрозрачные материалы и детали без UV', async () => {
    const small = texture('t3', 1024);
    const transparent = texture('t4', big);
    const noUv = texture('t5', big);
    const parts = [
      part({ id: 'p0', texture: small }),
      part({ id: 'p1', texture: transparent, alpha: 0.5 }),
      part({ id: 'p2', texture: noUv, uv: undefined }),
      part({ id: 'p3' }),
    ];
    let calls = 0;
    const stats = await optimizeTextures(parts, {
      encoder: async (t) => {
        calls++;
        return { id: t.id, mime: 'image/jpeg', image: new Uint8Array(1) };
      },
    });
    expect(calls).toBe(0);
    expect(stats.converted).toBe(0);
    expect(parts[0].texture).toBe(small);
    expect(parts[1].texture).toBe(transparent);
  });

  it('без кодировщика ничего не делает (Node, CLI)', async () => {
    const parts = [part({ texture: texture('t6', big) })];
    const stats = await optimizeTextures(parts, { encoder: null });
    expect(stats).toEqual({ before: 0, after: 0, converted: 0, kept: 0 });
  });
});
