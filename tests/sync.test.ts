import 'fake-indexeddb/auto';
import fsp from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSyncServer } from '../server/sync-server.mjs';
import { CryptoError, decryptFile, deriveSync, encryptFile, generateSyncKey, isEncryptedFile, openSnapshot, parseSyncKey, sealSnapshot } from '../src/core/crypto';
import { MemoryStorage } from '../src/core/db';
import { Store } from '../src/core/store';
import { SyncClient, SyncError, pushStore } from '../src/core/sync';

describe('crypto: password-protected file', () => {
  it('round-trips (Cyrillic, big payload) and hides plaintext', async () => {
    const plain = JSON.stringify({ app: 'shtbox', note: 'Секретный пробег 123456', pad: 'x'.repeat(50_000) });
    const enc = await encryptFile(plain, 'correct horse battery', 100_000);
    expect(enc).not.toContain('Секретный');
    expect(isEncryptedFile(enc)).toBe(true);
    expect(isEncryptedFile(plain)).toBe(false);
    expect(await decryptFile(enc, 'correct horse battery')).toBe(plain);
  });
  it('wrong password / tampering fail with CryptoError', async () => {
    const enc = await encryptFile('{"a":1}', 'password-1234', 100_000);
    await expect(decryptFile(enc, 'password-4321')).rejects.toThrow(CryptoError);
    const o = JSON.parse(enc);
    o.ct = o.ct.slice(0, -4) + (o.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(decryptFile(JSON.stringify(o), 'password-1234')).rejects.toThrow(CryptoError);
  });
  it('rejects weak passwords and hostile KDF params', async () => {
    await expect(encryptFile('x', 'short')).rejects.toThrow(CryptoError);
    const o = JSON.parse(await encryptFile('x', 'password-1234', 100_000));
    await expect(decryptFile(JSON.stringify({ ...o, iter: 2_000_000_000 }), 'password-1234')).rejects.toThrow(CryptoError);
    await expect(decryptFile(JSON.stringify({ ...o, salt: 'AAAA' }), 'password-1234')).rejects.toThrow(CryptoError);
  });
});

describe('crypto: sync key', () => {
  it('generates 160-bit key that parses back and derives stable, independent secrets', async () => {
    const k = generateSyncKey();
    expect(k).toMatch(/^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/);
    expect(parseSyncKey(k.toLowerCase().replace(/-/g, ' ')).length).toBe(20);
    const a = await deriveSync(k);
    const b = await deriveSync(k);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[a-f0-9]{32}$/);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toContain(a.id);
    expect((await deriveSync(generateSyncKey())).id).not.toBe(a.id);
    expect(() => parseSyncKey('bad')).toThrow(CryptoError);
  });
  it('seal/open round-trip; other key cannot open', async () => {
    const a = await deriveSync(generateSyncKey());
    const sealed = await sealSnapshot(a, 'привет');
    expect(await openSnapshot(a, sealed)).toBe('привет');
    await expect(openSnapshot(await deriveSync(generateSyncKey()), sealed)).rejects.toThrow(CryptoError);
  });
});

describe('sync server + client', () => {
  let dir: string;
  let base: string;
  let close: () => Promise<void>;
  const start = async (o = {}) => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shtbox-sync-'));
    const server = createSyncServer({ dataDir: dir, maxBytes: 200_000, maxEntries: 3, ratePerMin: 10_000, ...o });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sync/v1`;
    close = () => new Promise((r) => (server.closeAllConnections(), server.close(() => r())));
  };
  beforeAll(() => start());
  afterAll(async () => {
    await close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const mkStore = async (name: string) => {
    const s = new Store(new MemoryStorage());
    await s.init();
    await s.addCar({ name, modelId: 'sedan-solaris', mileage: 100 });
    return s;
  };

  it('two devices: A pushes, B pulls; stored data is ciphertext', async () => {
    const key = generateSyncKey();
    const a = await mkStore('Solaris-А');
    await a.addIssue({ zoneId: 'hood', kind: 'rust', title: 'Секретная ржавчина' });
    const cfg = await pushStore(a, { key, rev: null }, false, { base });
    expect(cfg.rev).toBe(1);

    const files = await fsp.readdir(dir);
    const raw = await fsp.readFile(path.join(dir, files.find((f) => f.endsWith('.blob'))!));
    expect(raw.toString('latin1')).not.toContain('ржавчина');
    expect(raw.toString('utf8')).not.toContain('Solaris');

    const client = await SyncClient.create(key, { base });
    const got = await client.pull();
    expect(got?.rev).toBe(1);
    expect(got?.backup.issues[0].title).toBe('Секретная ржавчина');
    const b = await mkStore('other');
    await b.importBackup(got!.backup, 'replace');
    expect(b.issues.value).toHaveLength(1);
  });

  it('optimistic concurrency: stale push → conflict; after pull it works', async () => {
    const key = generateSyncKey();
    const a = await mkStore('A');
    let cfg = await pushStore(a, { key, rev: null }, false, { base });
    cfg = await pushStore(a, cfg, false, { base });
    expect(cfg.rev).toBe(2);
    await expect(pushStore(a, { key, rev: 1 }, false, { base })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(pushStore(a, { key, rev: null }, false, { base })).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('wrong token is rejected; empty vault → null; delete works', async () => {
    const key = generateSyncKey();
    const c = await SyncClient.create(key, { base });
    expect(await c.pull()).toBeNull();
    const a = await mkStore('A');
    await pushStore(a, { key, rev: null }, false, { base });
    // тот же id, другой токен
    const s = await deriveSync(key);
    const r = await fetch(`${base}/${s.id}`, { headers: { Authorization: 'Bearer ' + 'A'.repeat(43) } });
    expect(r.status).toBe(401);
    expect((await fetch(`${base}/${s.id}`)).status).toBe(401);
    await c.remove();
    expect(await c.pull()).toBeNull();
  });

  it('limits: body size, entries count, bad ids, methods', async () => {
    const key = generateSyncKey();
    const s = await deriveSync(key);
    const put = (body: Uint8Array | string, id = s.id) =>
      fetch(`${base}/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'If-None-Match': '*' }, body: body as BodyInit });
    expect((await put(new Uint8Array(300_000))).status).toBe(413);
    expect((await put('')).status).toBe(400);
    expect((await fetch(`${base}/../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/ZZZ`, { headers: { Authorization: `Bearer ${s.token}` } })).status).toBe(404);
    expect((await fetch(`${base}/${s.id}`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } })).status).toBe(405);
    // maxEntries = 3: уже создано ≥1 в тестах выше, добиваем до лимита
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await deriveSync(generateSyncKey());
      const r = await fetch(`${base}/${d.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${d.token}`, 'If-None-Match': '*' }, body: new Uint8Array([1, 2, 3]) });
      codes.push(r.status);
    }
    expect(codes).toContain(507);
  });

  it('invite-only mode and rate limiting', async () => {
    const saved = { dir, base, close };
    await start({ invite: 'sekret', ratePerMin: 5 });
    const d = await deriveSync(generateSyncKey());
    const p = (h: Record<string, string>) => fetch(`${base}/${d.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${d.token}`, 'If-None-Match': '*', ...h }, body: new Uint8Array([1]) });
    expect((await p({})).status).toBe(403);
    expect((await p({ 'X-Invite': 'sekret' })).status).toBe(201);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(`${base}/${d.id}`, { headers: { Authorization: `Bearer ${d.token}` } })).status);
    expect(codes).toContain(429);
    await close();
    await fsp.rm(dir, { recursive: true, force: true });
    ({ dir, base, close } = saved);
  });

  it('client maps network/unavailable errors', async () => {
    const c = await SyncClient.create(generateSyncKey(), { base: 'http://127.0.0.1:1/sync/v1' });
    await expect(c.pull()).rejects.toBeInstanceOf(SyncError);
    const nginx404 = await SyncClient.create(generateSyncKey(), { fetch: async () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }) });
    await expect(nginx404.pull()).rejects.toMatchObject({ kind: 'unavailable' });
    const bad = await SyncClient.create(generateSyncKey(), { fetch: async () => new Response('', { status: 502 }) });
    await expect(bad.pull()).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
