/**
 * Шифрование на клиенте (WebCrypto). Сервер и любой, кто получит файл, видят только шифртекст.
 *  - файл копии: пароль → PBKDF2-SHA256 (600 000 итераций) → AES-256-GCM;
 *  - синхронизация: случайный ключ 160 бит → HKDF-SHA256 → (id, токен доступа, ключ AES-GCM);
 *    из токена, который видит сервер, ключ шифрования вычислить нельзя.
 */
import { b64ToBytes, bytesToB64 } from './b64';

export class CryptoError extends Error {}

const te = new TextEncoder();
const td = new TextDecoder();
const AAD_FILE = te.encode('shtbox-file-v1');
const AAD_SYNC = te.encode('shtbox-sync-v1');
export const PBKDF2_ITER = 600_000;
const MAX_PLAIN = 200 * 1024 * 1024;

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit = MAX_PLAIN): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  let total = 0;
  const writer = stream.writable.getWriter();
  const reading = (async () => {
    const r = stream.readable.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new CryptoError('Данные слишком большие');
      out.push(value);
    }
  })();
  const writing = writer.write(new Uint8Array(data)).then(() => writer.close());
  await Promise.all([reading, writing]);
  const res = new Uint8Array(total);
  let o = 0;
  for (const c of out) (res.set(c, o), (o += c.length));
  return res;
}
export const gzip = (d: Uint8Array) => pipe(d, new CompressionStream('gzip'));
export const gunzip = (d: Uint8Array) => pipe(d, new DecompressionStream('gzip'));

async function aesEncrypt(key: CryptoKey, plain: Uint8Array, aad: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(plain)));
  return { iv, ct };
}
async function aesDecrypt(key: CryptoKey, iv: Uint8Array, ct: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(ct)));
  } catch {
    throw new CryptoError('Неверный пароль/ключ или данные повреждены');
  }
}

// ---------- файл, защищённый паролем ----------
async function passKey(pass: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(te.encode(pass.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedFile {
  app: 'shtbox';
  enc: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  z: 'gzip';
  salt: string;
  iv: string;
  ct: string;
}

export async function encryptFile(plain: string, pass: string, iter = PBKDF2_ITER): Promise<string> {
  if (pass.length < 8) throw new CryptoError('Пароль — не короче 8 символов');
  const salt = rand(16);
  const { iv, ct } = await aesEncrypt(await passKey(pass, salt, iter), await gzip(te.encode(plain)), AAD_FILE);
  const f: EncryptedFile = { app: 'shtbox', enc: 1, kdf: 'PBKDF2-SHA256', iter, z: 'gzip', salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(ct) };
  return JSON.stringify(f);
}

/** true, если текст похож на зашифрованный файл ShtBox (без расшифровки). */
export function isEncryptedFile(text: string): boolean {
  return text.length < 400 * 1024 * 1024 && /^\s*\{/.test(text) && /"enc"\s*:\s*1/.test(text.slice(0, 400));
}

export async function decryptFile(text: string, pass: string): Promise<string> {
  let f: Partial<EncryptedFile>;
  try {
    f = JSON.parse(text);
  } catch {
    throw new CryptoError('Файл повреждён');
  }
  if (f.app !== 'shtbox' || f.enc !== 1 || f.kdf !== 'PBKDF2-SHA256' || f.z !== 'gzip' || typeof f.salt !== 'string' || typeof f.iv !== 'string' || typeof f.ct !== 'string')
    throw new CryptoError('Неподдерживаемый формат файла');
  // параметры из файла ограничиваем, чтобы подсунутый файл не «повесил» браузер
  if (typeof f.iter !== 'number' || f.iter < 100_000 || f.iter > 3_000_000) throw new CryptoError('Некорректные параметры шифрования');
  const salt = b64ToBytes(f.salt);
  const iv = b64ToBytes(f.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new CryptoError('Некорректные параметры шифрования');
  const plain = await aesDecrypt(await passKey(pass, salt, f.iter), iv, b64ToBytes(f.ct), AAD_FILE);
  return td.decode(await gunzip(plain));
}

// ---------- ключ синхронизации ----------
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 символа, без 0/O/1/I
/** Ключ синхронизации: 160 бит случайности, вид XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-. */
export function generateSyncKey(): string {
  const bytes = rand(20);
  let bits = 0;
  let acc = 0;
  let s = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      s += ALPHA[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return s.match(/.{4}/g)!.join('-');
}

export function parseSyncKey(input: string): Uint8Array {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 32 || [...s].some((c) => !ALPHA.includes(c))) throw new CryptoError('Некорректный ключ синхронизации');
  const out = new Uint8Array(20);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const c of s) {
    acc = (acc << 5) | ALPHA.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out[o++] = (acc >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

export interface SyncSecrets {
  id: string;
  token: string;
  key: CryptoKey;
}

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (u: Uint8Array) => bytesToB64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function deriveSync(syncKey: string): Promise<SyncSecrets> {
  const raw = parseSyncKey(syncKey);
  const base = await crypto.subtle.importKey('raw', buf(raw), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = buf(te.encode('shtbox-sync-v1'));
  const bits = async (info: string, n: number) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: buf(te.encode(info)) }, base, n * 8));
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: buf(te.encode('enc')) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { id: hex(await bits('id', 16)), token: b64url(await bits('auth', 32)), key };
}

/** Снимок → gzip → AES-GCM. Результат: iv(12) ‖ шифртекст. */
export async function sealSnapshot(s: SyncSecrets, plain: string): Promise<Uint8Array> {
  const { iv, ct } = await aesEncrypt(s.key, await gzip(te.encode(plain)), AAD_SYNC);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

export async function openSnapshot(s: SyncSecrets, data: Uint8Array): Promise<string> {
  if (data.length < 12 + 16) throw new CryptoError('Данные повреждены');
  const plain = await aesDecrypt(s.key, data.subarray(0, 12), data.subarray(12), AAD_SYNC);
  return td.decode(await gunzip(plain));
}
