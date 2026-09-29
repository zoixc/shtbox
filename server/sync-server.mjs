// Мини-сервер синхронизации ShtBox. Хранит ТОЛЬКО шифртекст (клиент шифрует сам), без зависимостей.
//
//   GET    /sync/v1/:id   → 200 + тело + ETag: "<rev>" | 404
//   PUT    /sync/v1/:id   → If-None-Match: * (создание) или If-Match: "<rev>" (обновление); 200/201/412
//   DELETE /sync/v1/:id   → удалить данные
//   GET    /healthz
//
// Доступ: заголовок Authorization: Bearer <token>. Сервер хранит только SHA-256 токена, выданного
// при создании записи. Никакого CORS: браузер ходит на тот же origin через nginx.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID_RE = /^[a-f0-9]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export function createSyncServer(opts = {}) {
  const dir = opts.dataDir ?? process.env.DATA_DIR ?? '/data';
  const maxBytes = Number(opts.maxBytes ?? process.env.MAX_BYTES ?? 25 * 1024 * 1024);
  const maxEntries = Number(opts.maxEntries ?? process.env.MAX_ENTRIES ?? 200);
  const invite = String(opts.invite ?? process.env.INVITE ?? '');
  const ratePerMin = Number(opts.ratePerMin ?? process.env.RATE_PER_MIN ?? 120);
  const trustProxy = (opts.trustProxy ?? process.env.TRUST_PROXY) === true || process.env.TRUST_PROXY === '1';

  const file = (id) => path.join(dir, `${id}.blob`);
  const sha = (s) => crypto.createHash('sha256').update(s).digest();

  // последовательная обработка запросов к одной записи (read-check-write без гонок)
  const chains = new Map();
  const serial = (id, fn) => {
    const prev = chains.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    chains.set(id, next);
    next.finally(() => chains.get(id) === next && chains.delete(id)).catch(() => {});
    return next;
  };

  // простое ограничение частоты по IP (скользящее окно 60 с)
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60_000) hits.delete(k);
    return arr.length > ratePerMin;
  };

  async function read(id) {
    let raw;
    try {
      raw = await fsp.readFile(file(id));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    const nl = raw.indexOf(10);
    if (nl < 0) return null;
    const meta = JSON.parse(raw.subarray(0, nl).toString('utf8'));
    return { meta, data: raw.subarray(nl + 1) };
  }

  async function write(id, meta, data) {
    const tmp = path.join(dir, `.${id}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.writeFile(tmp, Buffer.concat([Buffer.from(JSON.stringify(meta) + '\n'), data]), { mode: 0o600 });
    await fsp.rename(tmp, file(id));
  }

  const send = (res, status, body = '', headers = {}) => {
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Type': 'text/plain; charset=utf-8',
      ...headers,
    });
    res.end(body);
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > maxBytes) return reject(Object.assign(new Error('too large'), { status: 413 }));
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) {
          req.destroy();
          reject(Object.assign(new Error('too large'), { status: 413 }));
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const etagOf = (rev) => `"${rev}"`;
  const parseRev = (h) => {
    const m = /^"(\d{1,12})"$/.exec(String(h ?? '').trim());
    return m ? Number(m[1]) : null;
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, 'ok\n');
    const ip = trustProxy ? String(req.headers['x-real-ip'] ?? req.socket.remoteAddress) : String(req.socket.remoteAddress);
    if (limited(ip)) return send(res, 429, 'Too Many Requests', { 'Retry-After': '30' });

    const m = /^\/sync\/v1\/([a-f0-9]{32})$/.exec(url.pathname);
    if (!m || !ID_RE.test(m[1])) return send(res, 404, 'Not found');
    const id = m[1];
    if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, 'Method Not Allowed', { Allow: 'GET, PUT, DELETE' });

    const auth = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    const token = auth?.[1];
    if (!token || !TOKEN_RE.test(token)) {
      // без токена не отвечаем даже «есть/нет»
      return send(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
    const tokenHash = sha(token);

    const body = req.method === 'PUT' ? await readBody(req) : null;

    return serial(id, async () => {
      const cur = await read(id);
      const authorized = cur && crypto.timingSafeEqual(Buffer.from(cur.meta.tokenHash, 'hex'), tokenHash);
      if (cur && !authorized) return send(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });

      if (req.method === 'GET') {
        if (!cur) return send(res, 404, 'Not found');
        return send(res, 200, cur.data, { 'Content-Type': 'application/octet-stream', ETag: etagOf(cur.meta.rev), 'Content-Length': cur.data.length });
      }
      if (req.method === 'DELETE') {
        if (!cur) return send(res, 404, 'Not found');
        await fsp.unlink(file(id));
        return send(res, 204);
      }
      // PUT
      if (!body.length) return send(res, 400, 'Empty body');
      const ifMatch = parseRev(req.headers['if-match']);
      const ifNone = String(req.headers['if-none-match'] ?? '').trim() === '*';
      if (!cur) {
        if (!ifNone) return send(res, 412, 'Precondition Failed');
        if (invite && req.headers['x-invite'] !== invite) return send(res, 403, 'Invite required');
        const count = (await fsp.readdir(dir)).filter((f) => f.endsWith('.blob')).length;
        if (count >= maxEntries) return send(res, 507, 'Storage full');
        await write(id, { rev: 1, tokenHash: tokenHash.toString('hex'), updatedAt: Date.now() }, body);
        return send(res, 201, '', { ETag: etagOf(1) });
      }
      if (ifMatch === null || ifMatch !== cur.meta.rev) return send(res, 412, 'Precondition Failed', { ETag: etagOf(cur.meta.rev) });
      const rev = cur.meta.rev + 1;
      await write(id, { rev, tokenHash: cur.meta.tokenHash, updatedAt: Date.now() }, body);
      return send(res, 200, '', { ETag: etagOf(rev) });
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e?.status === 413) return send(res, 413, 'Payload Too Large');
      console.error('sync error:', e?.message ?? e);
      send(res, 500, 'Internal Server Error');
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  server.on('clientError', (_e, socket) => socket.destroy());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.env.DATA_DIR ?? '/data';
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const port = Number(process.env.PORT ?? 8081);
  createSyncServer().listen(port, '0.0.0.0', () => console.log(`shtbox sync listening on :${port}, data=${dir}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
}
