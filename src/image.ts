import { ValidationError } from './core/validation';
import type { ProcessedImage } from './core/store';

const MAX_INPUT = 30 * 1024 * 1024;
const MAX_PIXELS = 100_000_000; // защита от «бомб декомпрессии»
const FULL_SIDE = 1600;
const THUMB_SIDE = 240;

async function render(bmp: ImageBitmap, side: number, quality: number): Promise<{ blob: Blob; w: number; h: number }> {
  const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new ValidationError('Не удалось обработать изображение');
  ctx.fillStyle = '#fff'; // прозрачность PNG → белый фон
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob =
    canvas instanceof HTMLCanvasElement
      ? await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality))
      : await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality });
  if (!blob) throw new ValidationError('Не удалось сжать изображение');
  return { blob, w, h };
}

/**
 * Готовит фото к сохранению: перекодирует в JPEG (это убирает EXIF, в том числе GPS-координаты),
 * уменьшает до 1600 px и делает миниатюру. Исходный файл нигде не сохраняется.
 */
export async function compressImage(file: File): Promise<ProcessedImage> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new ValidationError('Поддерживаются JPEG, PNG и WebP (HEIC сначала переведите в JPEG)');
  if (file.size > MAX_INPUT) throw new ValidationError('Файл больше 30 МБ');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ValidationError('Не удалось открыть изображение');
  }
  try {
    if (bmp.width * bmp.height > MAX_PIXELS) throw new ValidationError('Слишком большое изображение');
    const full = await render(bmp, FULL_SIDE, 0.82);
    const thumb = await render(bmp, THUMB_SIDE, 0.7);
    return { name: file.name.replace(/\.[^.]+$/, '').slice(0, 100) + '.jpg', blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h };
  } finally {
    bmp.close();
  }
}
