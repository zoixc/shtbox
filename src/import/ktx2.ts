/**
 * KTX2 / Basis Universal: распаковка base-color текстуры в PNG прямо на импорте.
 *
 * Модели из Sketchfab и оптимизированных пайплайнов часто хранят текстуры в KTX2
 * (`KHR_texture_basisu`). Просмотрщику такие текстуры без GPU-транскодера не подходят, а держать
 * в пакете сжатие «ради сжатия» бессмысленно: после импорта модель должна открываться обычным
 * GLTFLoader. Поэтому текстурa пересобирается в PNG здесь — тем же декодером Basis, что использует
 * three.js (`examples/jsm/libs/basis`), но без воркера и без canvas: PNG пишется на месте (fflate),
 * так что код работает и в Web Worker, и в Node (CLI, тесты).
 *
 * Декодер грузится лениво, только при первой KTX2-текстуре: 527 КБ wasm не попадают в стартовый
 * бандл. Размер ограничен `KTX2_MAX_EDGE`, чтобы распаковка не съела память устройства.
 *
 * Лицензии: Basis Universal — Apache-2.0 (Binomial LLC, https://github.com/BinomialLLC/basis_universal,
 * файлы поставляются в составе three.js), three.js — MIT, fflate — MIT.
 */
import BASIS from 'three/examples/jsm/libs/basis/basis_transcoder.js';
import basisWasmUrl from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url';
import { zlibSync } from 'fflate';
import { loadWasm } from './wasm';

/**
 * Идентификатор контейнера KTX2 (`«KTX 20» 0xBB \r\n \x1A \n`): Basis `KTX2File.isValid()` не
 * ловит произвольный мусор, поэтому проверяем сигнатуру сами и раньше.
 */
const KTX2_MAGIC = Uint8Array.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function looksLikeKtx2(image: Uint8Array): boolean {
  if (image.length < KTX2_MAGIC.length) return false;
  for (let i = 0; i < KTX2_MAGIC.length; i++) if (image[i] !== KTX2_MAGIC[i]) return false;
  return true;
}

/** TranscoderFormat.RGBA32 из Basis: несжатые 8-битные RGBA — работает на любом GPU и в Node. */
const RGBA32 = 13;
export const KTX2_MAX_EDGE = 4096;

interface Ktx2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getImageTranscodedSizeInBytes(mip: number, layer: number, face: number, format: number): number;
  startTranscoding(): boolean;
  transcodeImage(dst: Uint8Array, mip: number, layer: number, face: number, format: number, unused: number, r: number, g: number): boolean;
  close(): void;
  delete(): void;
}

interface BasisModule {
  KTX2File: new (data: Uint8Array) => Ktx2File;
  initializeBasis?: () => void;
}

type BasisFactory = (options?: { wasmBinary?: ArrayBuffer; locateFile?: (path: string) => string }) => Promise<BasisModule>;

let modulePromise: Promise<BasisModule> | null = null;

/** Ленивая загрузка транскодера: в браузере wasm берётся с того же origin, в Node — из node_modules. */
async function basisModule(): Promise<BasisModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const create = BASIS as unknown as BasisFactory;
      const wasmBinary = await loadWasm(basisWasmUrl, 'three/examples/jsm/libs/basis/basis_transcoder.wasm');
      const mod = await create({ wasmBinary });
      mod.initializeBasis?.();
      return mod;
    })().catch((error) => {
      modulePromise = null; // неудачную загрузку не кэшируем: следующая попытка может пройти
      throw error;
    });
  }
  return modulePromise;
}

// --- PNG без canvas ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** Кодирует RGBA-пиксели в PNG (8 бит на канал, без интерлейса). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!width || !height || rgba.length < width * height * 4) throw new Error('Некорректный размер изображения для PNG');
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // фильтр строки: None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlibSync(raw, { level: 6 });
  const chunks = [signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// --- KTX2 → PNG -------------------------------------------------------------

export interface DecodedTexture {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * Распаковывает KTX2-изображение в PNG. Возвращает `null`, если картинка больше допустимого
 * размера (импорт продолжается с цветом материала). Ошибки декодера бросаются наружу.
 */
export async function ktx2ToPng(image: Uint8Array, maxEdge = KTX2_MAX_EDGE): Promise<DecodedTexture | null> {
  const mod = await basisModule();
  const file = new mod.KTX2File(image);
  try {
    if (!looksLikeKtx2(image) || !file.isValid()) throw new Error('файл повреждён или не содержит Basis-данных');
    const width = file.getWidth();
    const height = file.getHeight();
    if (!width || !height) throw new Error('не удалось определить размер изображения');
    if (width > maxEdge || height > maxEdge) return null;
    if (!file.startTranscoding()) throw new Error('транскодер не смог начать работу');
    const size = file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32);
    if (!size) throw new Error('неизвестный размер несжатого изображения');
    const rgba = new Uint8Array(size);
    if (!file.transcodeImage(rgba, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error('transcodeImage вернул ошибку');
    return { png: encodePng(rgba, width, height), width, height };
  } finally {
    file.close();
    file.delete();
  }
}
