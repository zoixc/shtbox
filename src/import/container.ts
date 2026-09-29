/** Контейнер GLB: разбор и сборка без зависимостей (используется и для правки разметки в готовом пакете). */
import type { Profile } from './types';

export const MAGIC = 0x46546c67;

export interface Json {
  materials?: Record<string, unknown>[];
  buffers?: { uri?: string; byteLength: number }[];
  images?: { uri?: string }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
}

export function splitGlb(data: Uint8Array): { json: Json; bin: Uint8Array | null } {
  if (data.byteLength < 20) throw new Error('Файл слишком мал для GLB');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Это не GLB (ожидается бинарный glTF)');
  if (dv.getUint32(4, true) !== 2) throw new Error('Поддерживается только glTF 2.0');
  let off = 12;
  let json: Json | null = null;
  let bin: Uint8Array | null = null;
  while (off + 8 <= data.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (off + 8 + len > data.byteLength) throw new Error('Повреждённый GLB: неверная длина блока');
    const chunk = data.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Json;
    else if (type === 0x004e4942 && !bin) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error('Повреждённый GLB: нет JSON-блока');
  return { json, bin };
}

export function joinGlb(json: Json, bin: Uint8Array | null): Uint8Array {
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jl = Math.ceil(enc.length / 4) * 4;
  const bl = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 12 + 8 + jl + (bin ? 8 + bl : 0);
  const out = new Uint8Array(total).fill(0x20);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(enc, 20);
  if (bin) {
    const o = 20 + jl;
    out.fill(0, o, o + 8 + bl);
    dv.setUint32(o, bl, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    out.set(bin, o + 8);
  }
  return out;
}


/** Подменяет разметку `extras.shtbox` в готовом пакете (геометрия не трогается). */
export function patchProfile(glb: Uint8Array, profile: Profile): Uint8Array {
  const { json, bin } = splitGlb(glb);
  json.extras = { ...((json.extras as object | undefined) ?? {}), shtbox: profile };
  const a = (json.asset ?? { version: '2.0' }) as Record<string, unknown>;
  const c = profile.credits;
  if (c?.author || c?.license) a.copyright = [c.author, c.license].filter(Boolean).join(' — ');
  json.asset = a;
  return joinGlb(json, bin);
}
