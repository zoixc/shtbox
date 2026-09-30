/**
 * Источники импорта: `.glb`, `.gltf` (+ `.bin` и картинки) и `.zip` → один самодостаточный GLB.
 *
 * Модели с Sketchfab и других сайтов часто отдают `.gltf` с внешними `.bin`/текстурами или zip-архив.
 * Пользователь выбирает все файлы сразу (или архив), а сюда попадают уже прочитанные байты: сервис
 * собирает из них GLB — тот же формат, что и раньше, дальше путь импорта не меняется.
 *
 * Лицензии: fflate — MIT (https://github.com/101arrowz/fflate).
 */
import { unzipSync } from 'fflate';
import { joinGlb } from './container';
import type { Json } from './container';

export interface SourceFile {
  name: string;
  bytes: Uint8Array;
}

export interface ConvertedSource {
  glb: Uint8Array;
  /** Имя модели без расширения (для заголовка мастера). */
  name: string;
  warnings: string[];
}

/** Сколько файлов готовы принять за раз (защита от выбора огромной папки). */
export const MAX_SOURCE_FILES = 256;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  ktx2: 'image/ktx2',
  gif: 'image/gif',
};

const basename = (path: string): string => path.replace(/\\/g, '/').split('/').pop() ?? path;

const extension = (name: string): string => {
  const match = /\.([a-z0-9]+)$/i.exec(basename(name));
  return match ? match[1].toLowerCase() : '';
};

const withoutExtension = (name: string): string => basename(name).replace(/\.[a-z0-9]+$/i, '');

/** data:-ссылка в байты; поддерживаются base64 и процентное кодирование. */
function dataUri(uri: string, what: string): { bytes: Uint8Array; mime: string } {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(uri);
  if (!match) throw new Error(`Не удалось разобрать data:-ссылку (${what})`);
  const meta = match[1];
  const mime = (meta.split(';')[0] || 'application/octet-stream').toLowerCase();
  if (/;base64/i.test(meta)) {
    let binary: string;
    try {
      binary = atob(match[2].replace(/\s+/g, ''));
    } catch {
      throw new Error(`Повреждённая base64-ссылка (${what})`);
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(match[2])), mime };
}

interface BufferView {
  buffer?: number;
  byteOffset?: number;
  byteLength?: number;
  [key: string]: unknown;
}

/**
 * Собирает `.gltf` и его ресурсы в GLB: буферы и изображения становятся частью одного BIN-блока.
 * Внешние ссылки ищутся по имени файла (регистр не важен), поэтому выбор всех файлов из папки
 * работает независимо от того, как они назывались в архиве.
 */
export function filesToGlb(input: readonly SourceFile[]): ConvertedSource {
  const files = input.filter((file) => file.bytes.byteLength > 0);
  if (!files.length) throw new Error('Не выбрано ни одного файла');
  if (files.length > MAX_SOURCE_FILES) throw new Error(`Слишком много файлов (больше ${MAX_SOURCE_FILES}) — упакуйте модель в zip`);

  const warnings: string[] = [];
  let pool = files;

  const zip = files.find((file) => extension(file.name) === 'zip');
  if (zip) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(zip.bytes);
    } catch (error) {
      throw new Error(`Не удалось прочитать zip-архив: ${error instanceof Error ? error.message : String(error)}`);
    }
    pool = Object.entries(entries)
      .filter(([name, bytes]) => !name.endsWith('/') && bytes.byteLength > 0)
      .map(([name, bytes]) => ({ name, bytes }));
    if (!pool.length) throw new Error('Zip-архив пуст');
    warnings.push(`Zip-архив распакован: файлов ${pool.length}.`);
  }

  const glbFile = pool.find((file) => extension(file.name) === 'glb');
  if (glbFile) {
    if (pool.length > 1) warnings.push(`Лишних файлов проигнорировано: ${pool.length - 1}.`);
    return { glb: glbFile.bytes, name: withoutExtension(glbFile.name) || 'model', warnings };
  }

  const gltfFile = pool.find((file) => extension(file.name) === 'gltf');
  if (!gltfFile) throw new Error('В выбранных файлах нет ни .glb, ни .gltf');

  let json: Json & { bufferViews?: BufferView[]; images?: { uri?: string; mimeType?: string; bufferView?: number; name?: string }[] };
  try {
    json = JSON.parse(new TextDecoder().decode(gltfFile.bytes)) as typeof json;
  } catch (error) {
    throw new Error(`Не удалось прочитать .gltf: ${error instanceof Error ? error.message : String(error)}`);
  }

  const byName = new Map<string, SourceFile>();
  for (const file of pool) {
    byName.set(basename(file.name).toLowerCase(), file);
    byName.set(file.name.replace(/\\/g, '/').toLowerCase(), file);
  }
  const used = new Set<SourceFile>();
  const find = (uri: string): SourceFile | undefined => {
    const clean = decodeURIComponent(uri).replace(/\\/g, '/');
    const file = byName.get(clean.toLowerCase()) ?? byName.get(basename(clean).toLowerCase());
    if (file) used.add(file);
    return file;
  };
  function missing(what: string, uri: string): never {
    throw new Error(
      `Не найден ${what} «${uri || '(без имени)'}» — выберите его вместе с .gltf или соберите zip-архив.`,
    );
  }

  // Единый BIN-блок: каждая часть кладётся с выравниванием по 4 байта (требование GLB).
  const parts: { offset: number; bytes: Uint8Array }[] = [];
  let binLength = 0;
  const push = (bytes: Uint8Array): number => {
    while (binLength % 4) binLength++;
    const offset = binLength;
    parts.push({ offset, bytes });
    binLength += bytes.byteLength;
    return offset;
  };

  const bufferViews: BufferView[] = [...(json.bufferViews ?? [])];
  const buffers = (json.buffers ?? []) as { uri?: string; byteLength?: number }[];
  const offsets: number[] = [];
  for (const buffer of buffers) {
    let bytes: Uint8Array | null = null;
    if (typeof buffer.uri === 'string') {
      bytes = /^data:/i.test(buffer.uri) ? dataUri(buffer.uri, 'буфер').bytes : find(buffer.uri)?.bytes ?? null;
      if (!bytes) missing('файл буфера', buffer.uri);
    } else if ((buffer.byteLength ?? 0) === 0) {
      bytes = new Uint8Array(0);
    } else {
      missing('файл буфера', '');
    }
    offsets.push(push(bytes));
  }
  for (const view of bufferViews) {
    const index = view.buffer ?? 0;
    view.buffer = 0;
    view.byteOffset = (view.byteOffset ?? 0) + (offsets[index] ?? 0);
  }

  // Изображения: внешние файлы и data:-ссылки переносим в тот же BIN, uri убираем.
  const images = json.images ?? [];
  let embeddedImages = 0;
  for (const image of images) {
    if (typeof image.uri !== 'string') continue;
    let bytes: Uint8Array;
    let mime: string;
    if (/^data:/i.test(image.uri)) {
      const decoded = dataUri(image.uri, 'изображение');
      bytes = decoded.bytes;
      mime = decoded.mime;
    } else {
      const file = find(image.uri) ?? missing('файл изображения', image.uri);
      bytes = file.bytes;
      mime = EXT_MIME[extension(file.name)] ?? (image.mimeType ?? '').toLowerCase();
    }
    if (!mime || mime === 'application/octet-stream') {
      throw new Error(`Формат изображения «${image.uri}» не поддерживается (${mime || 'неизвестен'}).`);
    }
    const bufferView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: push(bytes), byteLength: bytes.byteLength });
    delete image.uri;
    image.bufferView = bufferView;
    image.mimeType = mime;
    embeddedImages++;
  }

  const bin = new Uint8Array(binLength);
  for (const part of parts) bin.set(part.bytes, part.offset);

  const unused = pool.filter((file) => file !== gltfFile && !used.has(file)).length;
  if (unused > 0) warnings.push(`Неиспользованных файлов: ${unused}.`);
  warnings.push('Внешние ресурсы .gltf встроены в GLB.');

  json.bufferViews = bufferViews;
  if (binLength) json.buffers = [{ byteLength: binLength }];
  else delete (json as Record<string, unknown>).buffers;
  if (images.length) json.images = images;
  else delete (json as Record<string, unknown>).images;

  return { glb: joinGlb(json, binLength ? bin : null), name: withoutExtension(gltfFile.name) || 'model', warnings };
}
