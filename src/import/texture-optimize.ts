/**
 * Оптимизация сохранённых текстур (P1, п. 9).
 *
 * Что и почему так:
 *  - KTX2/BasisU мы **читаем** (транскодер уже есть в three.js), но энкодера KTX2 в браузере нет:
 *    он тянет отдельный wasm на ~1.5 МБ, а выигрыш для одной-двух текстур цвета несопоставим. Поэтому
 *    PNG-текстуры цвета перекодируются встроенными средствами браузера (`OffscreenCanvas`):
 *    непрозрачные — в JPEG, с прозрачностью — остаются PNG (JPEG альфу не хранит).
 *  - Никаких новых зависимостей и лицензий: только API браузера. В Node (CLI, тесты) кодировщика нет,
 *    функция ничего не делает (текстуры можно потом сжать `npx @gltf-transform/cli optimize`).
 *  - Если перекодирование не дало выигрыша в байтах, исходные данные сохраняются.
 */
import type { RawPart, RawTexture } from './types';

export interface TextureStats {
  /** Суммарный размер исходных текстур цвета, которые рассматривались. */
  before: number;
  /** Размер после перекодирования (для оставленных без изменений — исходный). */
  after: number;
  converted: number;
  kept: number;
}

export type TextureEncoder = (texture: RawTexture, quality: number) => Promise<RawTexture | null>;

/** Качество JPEG по умолчанию: визуально почти без потерь для цвета кузова, экономия в разы. */
export const JPEG_QUALITY = 0.82;
/** Текстуры меньше этого размера не трогаем: экономия не окупает повторное сжатие. */
export const MIN_TEXTURE_BYTES = 24 * 1024;

const hasTransparency = (ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): boolean => {
  const size = 32;
  const probe = new OffscreenCanvas(size, size);
  const pctx = probe.getContext('2d');
  if (!pctx) return true; // не уверены — считаем, что альфа есть: PNG безопаснее
  pctx.drawImage(ctx.canvas as unknown as CanvasImageSource, 0, 0, size, size);
  const data = pctx.getImageData(0, 0, size, size).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  void width;
  void height;
  return false;
};

/** Кодировщик на API браузера; возвращает null, если перекодировать нельзя или выигрыша нет. */
export const canvasEncoder: TextureEncoder = async (texture, quality) => {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  if (!/png|webp/i.test(texture.mime)) return null; // JPEG уже сжат
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([texture.image as unknown as BlobPart], { type: texture.mime }));
  } catch {
    return null;
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const transparent = hasTransparency(ctx, bitmap.width, bitmap.height);
    const type = transparent ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob(transparent ? { type } : { type, quality });
    const image = new Uint8Array(await blob.arrayBuffer());
    if (image.byteLength >= texture.image.byteLength) return null;
    return { id: texture.id, mime: type, image };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
};

/**
 * Перекодирует текстуры цвета у деталей (общие текстуры кодируются один раз) и обновляет `part.texture`.
 * Полупрозрачные материалы пропускаются: у них альфа важнее экономии.
 */
export async function optimizeTextures(
  parts: RawPart[],
  options: { quality?: number; encoder?: TextureEncoder | null; minBytes?: number } = {},
): Promise<TextureStats> {
  const stats: TextureStats = { before: 0, after: 0, converted: 0, kept: 0 };
  const encoder = options.encoder === undefined ? canvasEncoder : options.encoder;
  if (!encoder) return stats;
  const quality = options.quality ?? JPEG_QUALITY;
  const minBytes = options.minBytes ?? MIN_TEXTURE_BYTES;
  const cache = new Map<string, RawTexture | null>();

  for (const part of parts) {
    const texture = part.texture;
    if (!texture || !part.uv || part.alpha < 0.98) continue;
    if (cache.has(texture.id)) {
      const cached = cache.get(texture.id);
      if (cached && cached !== texture) part.texture = cached;
      continue;
    }
    let result: RawTexture | null = null;
    if (texture.image.byteLength >= minBytes) {
      try {
        result = await encoder(texture, quality);
      } catch {
        result = null;
      }
    }
    stats.before += texture.image.byteLength;
    if (result) {
      stats.after += result.image.byteLength;
      stats.converted++;
      part.texture = result;
      cache.set(texture.id, result);
    } else {
      stats.after += texture.image.byteLength;
      stats.kept++;
      cache.set(texture.id, texture);
    }
  }
  return stats;
}
