/**
 * Типы для служебных файлов three.js, которые поставляются без деклараций
 * (`examples/jsm/libs/**`): там лежат emscripten-сборки Draco и Basis Universal.
 */
declare module 'three/examples/jsm/libs/basis/basis_transcoder.js' {
  interface BasisTranscoderModule {
    KTX2File: new (data: Uint8Array) => {
      isValid(): boolean;
      getWidth(): number;
      getHeight(): number;
      getImageTranscodedSizeInBytes(mip: number, layer: number, face: number, format: number): number;
      startTranscoding(): boolean;
      transcodeImage(dst: Uint8Array, mip: number, layer: number, face: number, format: number, unused: number, r: number, g: number): boolean;
      close(): void;
      delete(): void;
    };
    initializeBasis?: () => void;
  }
  const BASIS: (options?: { wasmBinary?: ArrayBuffer; locateFile?: (path: string) => string }) => Promise<BasisTranscoderModule>;
  export default BASIS;
}
