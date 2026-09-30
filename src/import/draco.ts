/**
 * Декодирование Draco (`KHR_draco_mesh_compression`).
 *
 * Модели, скачанные с Sketchfab и подобных сервисов, часто приходят с Draco-сжатием геометрии.
 * Читать такие меши штатным путём нельзя, поэтому до разбора GLB пересобирается в обычный:
 * glTF Transform читает документ с расширением Draco (для этого ему нужен декодер `draco3dgltf`),
 * а на выходе получается тот же GLB, но без сжатия. Дальше работает обычный `readModel`.
 *
 * Декодер грузится лениво и только при первом файле с Draco: 190 КБ wasm не попадают ни в
 * стартовый бандл, ни в память устройств, которые таких моделей не встречают.
 *
 * Лицензии: `draco3dgltf` — Apache-2.0 (Google, https://github.com/google/draco),
 * `@gltf-transform/*` — MIT (https://github.com/donmccurdy/glTF-Transform).
 */
import { WebIO } from '@gltf-transform/core';
import {
  EXTMeshoptCompression,
  KHRDracoMeshCompression,
  KHRMeshQuantization,
  KHRTextureBasisu,
  KHRTextureTransform,
} from '@gltf-transform/extensions';
import dracoWasmUrl from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { loadWasm } from './wasm';

/** Модуль Декодера Draco: обёртка emscripten над `draco_decoder_gltf.wasm`. */
type DracoCreateModule = (options?: { wasmBinary?: ArrayBuffer; locateFile?: (path: string) => string }) => Promise<unknown>;

let decoder: Promise<unknown> | null = null;

/** Загружает декодер один раз на процесс (glue-код — динамическим импортом, wasm — ассетом сборки). */
async function decoderModule(): Promise<unknown> {
  if (!decoder) {
    decoder = (async () => {
      const mod = (await import('draco3dgltf/draco_decoder_gltf_nodejs.js')) as unknown as {
        default?: DracoCreateModule;
      };
      const create = (mod.default ?? (mod as unknown as DracoCreateModule)) as DracoCreateModule;
      const wasmBinary = await loadWasm(dracoWasmUrl, 'draco3dgltf/draco_decoder_gltf.wasm');
      return create({ wasmBinary });
    })().catch((error) => {
      decoder = null; // неудачную загрузку не кэшируем: следующая попытка может пройти
      throw error;
    });
  }
  return decoder;
}

/** Быстрая проверка по JSON-блоку: нужен ли транскод. Ошибки разбора здесь не бросаем. */
export function hasDraco(json: { extensionsUsed?: string[]; extensionsRequired?: string[] }): boolean {
  return (
    json.extensionsUsed?.includes('KHR_draco_mesh_compression') === true ||
    json.extensionsRequired?.includes('KHR_draco_mesh_compression') === true
  );
}

/**
 * Пересобирает GLB со сжатием Draco в обычный GLB (геометрия разворачивается в буферы).
 * Материалы, текстуры, extras и иерархия узлов сохраняются.
 */
export async function decodeDracoGlb(data: Uint8Array): Promise<Uint8Array> {
  let mod: unknown;
  try {
    mod = await decoderModule();
  } catch (error) {
    throw new Error(
      `Не удалось загрузить декодер Draco: ${error instanceof Error ? error.message : String(error)}. ` +
        'Пересохраните модель без сжатия или проверьте соединение (декодер — 190 КБ с этого же сайта).',
    );
  }
  // Документ с уже развёрнутой геометрией пишется без Draco: расширение не попадает в результат.
  const io = new WebIO()
    .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform])
    .registerDependencies({ 'draco3d.decoder': mod, 'meshopt.decoder': MeshoptDecoder });
  if (data.byteLength > 0) await MeshoptDecoder.ready;
  try {
    const doc = await io.readBinary(data);
    // Геометрия уже развёрнута в обычные accessor'ы (`preread`), поэтому расширение перед
    // записью убираем — иначе writer попытается сжать геометрию обратно и потребует энкодер.
    doc.disposeExtension(KHRDracoMeshCompression.EXTENSION_NAME);
    return await io.writeBinary(doc);
  } catch (error) {
    throw new Error(
      `Не удалось распаковать Draco-геометрию: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
