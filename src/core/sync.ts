import { deriveSync, openSnapshot, sealSnapshot } from './crypto';
import type { SyncSecrets } from './crypto';
import type { Store } from './store';
import type { Backup } from './types';
import { parseBackupText } from './validation';

export type SyncErrorKind = 'unavailable' | 'auth' | 'conflict' | 'too-large' | 'full' | 'invite' | 'rate' | 'network';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const MESSAGES: Record<SyncErrorKind, string> = {
  unavailable: 'Сервер синхронизации не подключён к этому приложению',
  auth: 'Сервер отклонил ключ — проверьте, что ключ введён верно',
  conflict: 'На сервере более новая версия. Сначала получите её (объедините), затем отправьте',
  'too-large': 'Данные не помещаются в лимит сервера — отправьте без фото',
  full: 'На сервере закончилось место',
  invite: 'Создание новых хранилищ на этом сервере закрыто приглашением',
  rate: 'Слишком много запросов, попробуйте через минуту',
  network: 'Нет связи с сервером',
};

export interface SyncConfig {
  key: string;
  /** ревизия, с которой устройство синхронизировалось в последний раз */
  rev: number | null;
  at?: number;
  /** код-приглашение, если сервер синхронизации закрыт для создания новых хранилищ (INVITE) */
  invite?: string;
}

const CFG_KEY = 'shtbox.sync';
export function loadSyncConfig(): SyncConfig | null {
  try {
    const v = JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null');
    if (v && typeof v.key === 'string') return { key: v.key, rev: typeof v.rev === 'number' ? v.rev : null, at: typeof v.at === 'number' ? v.at : undefined, invite: typeof v.invite === 'string' && v.invite ? v.invite.slice(0, 64) : undefined };
  } catch {
    /* ignore */
  }
  return null;
}
export function saveSyncConfig(c: SyncConfig | null): void {
  try {
    if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CFG_KEY);
  } catch {
    /* ignore */
  }
}

export interface SyncOptions {
  base?: string;
  fetch?: typeof fetch;
  invite?: string;
}

const revOf = (r: Response) => {
  const m = /^"(\d+)"$/.exec(r.headers.get('etag') ?? '');
  return m ? Number(m[1]) : null;
};

function fail(status: number): never {
  if (status === 401) throw new SyncError('auth', MESSAGES.auth);
  if (status === 412) throw new SyncError('conflict', MESSAGES.conflict);
  if (status === 413) throw new SyncError('too-large', MESSAGES['too-large']);
  if (status === 507) throw new SyncError('full', MESSAGES.full);
  if (status === 403) throw new SyncError('invite', MESSAGES.invite);
  if (status === 429) throw new SyncError('rate', MESSAGES.rate);
  throw new SyncError('unavailable', MESSAGES.unavailable);
}

export class SyncClient {
  private base: string;
  private f: typeof fetch;
  constructor(
    private s: SyncSecrets,
    private opts: SyncOptions = {},
  ) {
    this.base = opts.base ?? '/sync/v1';
    this.f = opts.fetch ?? ((...a) => fetch(...a));
  }
  static async create(key: string, opts?: SyncOptions): Promise<SyncClient> {
    return new SyncClient(await deriveSync(key), opts);
  }

  private async req(method: string, headers: Record<string, string>, body?: Uint8Array): Promise<Response> {
    try {
      return await this.f(`${this.base}/${this.s.id}`, {
        method,
        headers: { Authorization: `Bearer ${this.s.token}`, ...(this.opts.invite ? { 'X-Invite': this.opts.invite } : {}), ...headers },
        body: body as BodyInit | undefined,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new SyncError('network', MESSAGES.network);
    }
  }

  /** Возвращает расшифрованную копию и её ревизию; null — на сервере ещё пусто. */
  async pull(): Promise<{ backup: Backup; rev: number } | null> {
    const r = await this.req('GET', {});
    if (r.status === 404) {
      // «нет данных» отличаем от «сервер не подключён»: у нашего сервера есть заголовок nosniff и text/plain
      if ((r.headers.get('content-type') ?? '').startsWith('text/plain') && (await r.text()) === 'Not found') return null;
      throw new SyncError('unavailable', MESSAGES.unavailable);
    }
    if (!r.ok) fail(r.status);
    const rev = revOf(r);
    if (rev === null) throw new SyncError('unavailable', MESSAGES.unavailable);
    const data = new Uint8Array(await r.arrayBuffer());
    const text = await openSnapshot(this.s, data);
    return { backup: parseBackupText(text), rev };
  }

  /** Отправляет копию. rev — ревизия, которую устройство видело в последний раз (null — создать). Возвращает новую ревизию. */
  async push(snapshot: Backup, rev: number | null): Promise<number> {
    const sealed = await sealSnapshot(this.s, JSON.stringify(snapshot));
    const r = await this.req('PUT', rev === null ? { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' } : { 'If-Match': `"${rev}"`, 'Content-Type': 'application/octet-stream' }, sealed);
    if (!r.ok) fail(r.status);
    const n = revOf(r);
    if (n === null) throw new SyncError('unavailable', MESSAGES.unavailable);
    return n;
  }

  async remove(): Promise<void> {
    const r = await this.req('DELETE', {});
    if (!r.ok && r.status !== 404) fail(r.status);
  }
}

/** Снимок текущих данных → на сервер. Возвращает обновлённую конфигурацию. */
export async function pushStore(store: Store, cfg: SyncConfig, includePhotos: boolean, opts?: SyncOptions): Promise<SyncConfig> {
  const client = await SyncClient.create(cfg.key, opts);
  const rev = await client.push(await store.exportSnapshot(includePhotos), cfg.rev);
  return { ...cfg, rev, at: Date.now() };
}
