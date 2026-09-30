/**
 * Типы для модулей `draco3dgltf`: пакет поставляет CommonJS-обёртки emscripten без деклараций.
 * Декодер используется в `draco.ts`, кодировщик — только в тестах (собирают Draco-файл).
 */
declare module 'draco3dgltf/draco_decoder_gltf_nodejs.js' {
  const createDecoderModule: (options?: { wasmBinary?: ArrayBuffer; locateFile?: (path: string) => string }) => Promise<unknown>;
  export default createDecoderModule;
}
declare module 'draco3dgltf/draco_encoder_gltf_nodejs.js' {
  const createEncoderModule: (options?: { wasmBinary?: ArrayBuffer; locateFile?: (path: string) => string }) => Promise<unknown>;
  export default createEncoderModule;
}
