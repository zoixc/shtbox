import type { AnalyzeHint } from './analyze';
import type { Profile } from './types';
import type { WorkerReq, WorkerRes } from './worker';

export interface ImportOutcome {
  glb: Uint8Array;
  profile: Profile;
  stats: { srcTris: number; tris: number; parts: number; bytes: number };
  warnings: string[];
}

export interface ImportFileOptions {
  preserveTextures?: boolean;
}

type WorkerReqWithoutId = WorkerReq extends infer Request ? (Request extends { id: number } ? Omit<Request, 'id'> : never) : never;
type DoneResponse = WorkerRes & { type: 'done' };

export class ImportCancelledError extends Error {
  constructor() {
    super('Импорт отменён');
    this.name = 'AbortError';
  }
}

/** Обёртка над Web Worker импорта (создаётся лениво, закрывается по `close()`). */
export class ImportSession {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private closed = false;
  private pending = new Map<number, { res: (r: DoneResponse) => void; rej: (e: Error) => void; progress?: (stage: string, frac: number) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerRes>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === 'progress') pending.progress?.(message.stage, message.frac);
      else {
        this.pending.delete(message.id);
        if (message.type === 'error') pending.rej(new Error(message.message));
        else pending.res(message);
      }
    };
    this.worker.onerror = (event) => {
      for (const pending of this.pending.values()) pending.rej(new Error(event.message || 'Сбой обработчика импорта'));
      this.pending.clear();
    };
  }

  private call(req: WorkerReqWithoutId, transfer: Transferable[] = [], progress?: (stage: string, frac: number) => void): Promise<DoneResponse> {
    if (this.closed) return Promise.reject(new ImportCancelledError());
    const id = ++this.seq;
    return new Promise<DoneResponse>((resolve, reject) => {
      this.pending.set(id, { res: resolve, rej: reject, progress });
      try {
        this.worker.postMessage({ ...req, id }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async importFile(
    data: ArrayBuffer,
    title: string,
    hint?: AnalyzeHint,
    progress?: (stage: string, frac: number) => void,
    options: ImportFileOptions = {},
  ): Promise<ImportOutcome> {
    const result = await this.call({ type: 'import', data, title, hint, preserveTextures: options.preserveTextures }, [data], progress);
    return { glb: result.glb!, profile: result.profile!, stats: result.stats!, warnings: result.warnings ?? [] };
  }

  /** Загружает готовый пакет (для повторной разметки). */
  async loadPackage(data: ArrayBuffer): Promise<void> {
    await this.call({ type: 'load', data: data.slice(0) });
  }

  async analyze(title: string, hint: AnalyzeHint): Promise<Profile> {
    const result = await this.call({ type: 'analyze', title, hint });
    return result.profile!;
  }

  /** Немедленно завершает Worker; браузер прекращает текущий sync/wasm-шаг без потери исходного файла. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.rej(new ImportCancelledError());
    this.pending.clear();
  }
}
