/** base64 ⇄ байты без зависимостей (чанками, чтобы не упереться в лимит аргументов). */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function blobToB64(b: Blob): Promise<string> {
  return bytesToB64(new Uint8Array(await b.arrayBuffer()));
}
