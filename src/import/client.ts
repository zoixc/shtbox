import type { AnalyzeHint } from './analyze';
import type { Profile } from './types';
import type { WorkerReq, WorkerRes } from './worker';

export interface ImportOutcome {
  glb: Uint8Array;
  profile: Profile;
  stats: { srcTris: number; tris: number; parts: number; bytes: number };
  warnings: string[];
}

/** Обёртка над Web Worker импорта (создаётся лениво, закрывается по `close()`). */
export class ImportSession {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<number, { res: (r: WorkerRes & { type: 'done' }) => void; rej: (e: Error) => void; progress?: (stage: string, frac: number) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerRes>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') p.progress?.(m.stage, m.frac);
      else {
        this.pending.delete(m.id);
        if (m.type === 'error') p.rej(new Error(m.message));
        else p.res(m);
      }
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.rej(new Error(e.message || 'Сбой обработчика импорта'));
      this.pending.clear();
    };
  }

  private call(req: Omit<WorkerReq, 'id'>, transfer: Transferable[] = [], progress?: (stage: string, frac: number) => void) {
    const id = ++this.seq;
    return new Promise<WorkerRes & { type: 'done' }>((res, rej) => {
      this.pending.set(id, { res, rej, progress });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  async importFile(data: ArrayBuffer, title: string, hint?: AnalyzeHint, progress?: (stage: string, frac: number) => void): Promise<ImportOutcome> {
    const r = await this.call({ type: 'import', data, title, hint } as never, [data], progress);
    return { glb: r.glb!, profile: r.profile!, stats: r.stats!, warnings: r.warnings ?? [] };
  }

  /** Загружает готовый пакет (для повторной разметки). */
  async loadPackage(data: ArrayBuffer): Promise<void> {
    await this.call({ type: 'load', data: data.slice(0) } as never);
  }

  async analyze(title: string, hint: AnalyzeHint): Promise<Profile> {
    return (await this.call({ type: 'analyze', title, hint } as never) as { profile: Profile }).profile;
  }

  close(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.rej(new Error('Отменено'));
    this.pending.clear();
  }
}
