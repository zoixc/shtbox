/**
 * Загрузка wasm-файлов, которые сборщик отдаёт как ассет (`?url`).
 *
 * Vite в браузере возвращает (хешированный) URL на файл — его нужно скачать с того же origin.
 * В Node (CLI-сборка esbuild, тесты) URL может быть `file://`-ссылкой от плагина сборки или
 * корневым путём проекта; последний запасной вариант — найти файл в node_modules через require.
 * Так один и тот же код работает и в Worker, и в CLI, и не тянет Node-модули в браузер.
 */
const isNode = (): boolean =>
  typeof process !== 'undefined' && typeof process.versions?.node === 'string' && typeof window === 'undefined';

export async function loadWasm(assetUrl: string, packagePath: string): Promise<ArrayBuffer> {
  if (!isNode()) return (await fetch(assetUrl)).arrayBuffer();
  const { readFileSync } = await import('node:fs');
  const candidates: string[] = [];
  if (assetUrl.startsWith('file:')) {
    const { fileURLToPath } = await import('node:url');
    candidates.push(fileURLToPath(assetUrl));
  } else if (assetUrl.startsWith('/')) {
    candidates.push(new URL(`.${assetUrl}`, `file://${process.cwd()}/`).pathname);
  }
  try {
    const { createRequire } = await import('node:module');
    candidates.push(createRequire(import.meta.url).resolve(packagePath));
  } catch {
    // Пакет может быть не виден из места сборки — тогда пробуем остальные пути.
  }
  for (const candidate of candidates) {
    try {
      const bytes = readFileSync(candidate);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch {
      // Пробуем следующий путь.
    }
  }
  throw new Error(`не удалось найти файл ${packagePath}`);
}
