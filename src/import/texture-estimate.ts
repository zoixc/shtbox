import type { Json } from './container';

export const PRESERVED_TEXTURE_LIMIT = 32 * 1024 * 1024;
const supportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function dataUriSize(uri: string): { mime: string; bytes: number } | null {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const metadata = uri.slice(5, comma).split(';');
  const mime = metadata[0].toLowerCase();
  const payload = uri.slice(comma + 1);
  if (metadata.includes('base64')) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return { mime, bytes: Math.max(0, Math.floor(payload.length * 3 / 4) - padding) };
  }
  // Percent-encoded data contributes one byte per %XX escape. This avoids decoding/copying a
  // potentially large image just to estimate it; unescaped characters are counted conservatively.
  let bytes = 0;
  for (let i = 0; i < payload.length; i++, bytes++) {
    if (payload[i] === '%' && /^[\da-f]{2}$/i.test(payload.slice(i + 1, i + 3))) i += 2;
  }
  return { mime, bytes };
}

/** Approximate encoded bytes retained by the optional base-color texture path. No image data is copied. */
export function estimatePreservedTextures(json: Json, limit = PRESERVED_TEXTURE_LIMIT): { bytes: number; textures: number; omitted: number } {
  const materials = array(json.materials);
  const textures = array(json.textures);
  const images = array(json.images);
  const bufferViews = array(json.bufferViews);
  const referenced = new Set<number>();
  let hasTextureTransform = materials.some((value) => {
    const pbr = object(object(value)?.pbrMetallicRoughness);
    const textureInfo = object(pbr?.baseColorTexture);
    return !!object(textureInfo?.extensions)?.KHR_texture_transform;
  });

  for (const meshValue of array(json.meshes)) {
    const mesh = object(meshValue);
    for (const primitiveValue of array(mesh?.primitives)) {
      const primitive = object(primitiveValue);
      const attributes = object(primitive?.attributes);
      const materialIndex = primitive?.material;
      if (typeof materialIndex !== 'number') continue;
      const material = object(materials[materialIndex]);
      const pbr = object(material?.pbrMetallicRoughness);
      const textureInfo = object(pbr?.baseColorTexture);
      if (object(textureInfo?.extensions)?.KHR_texture_transform) continue;
      const textureIndex = textureInfo?.index;
      const texCoord = typeof textureInfo?.texCoord === 'number' ? textureInfo.texCoord : 0;
      if (
        typeof textureIndex === 'number' &&
        attributes?.[`TEXCOORD_${texCoord}`] !== undefined &&
        object(textures[textureIndex])
      ) referenced.add(textureIndex);
    }
  }

  let bytes = 0, retained = 0, omitted = 0;
  for (const textureIndex of referenced) {
    const texture = object(textures[textureIndex]);
    const sourceIndex = texture?.source;
    const image = typeof sourceIndex === 'number' ? object(images[sourceIndex]) : null;
    if (!image) continue;
    let mime = typeof image.mimeType === 'string' ? image.mimeType.toLowerCase() : '';
    let imageBytes = 0;
    if (typeof image.uri === 'string' && image.uri.startsWith('data:')) {
      const data = dataUriSize(image.uri);
      if (data) {
        mime ||= data.mime;
        imageBytes = data.bytes;
      }
    } else {
      const viewIndex = image.bufferView;
      const view = typeof viewIndex === 'number' ? object(bufferViews[viewIndex]) : null;
      imageBytes = typeof view?.byteLength === 'number' && Number.isFinite(view.byteLength) ? Math.max(0, view.byteLength) : 0;
    }
    if (!supportedMimeTypes.has(mime) || imageBytes <= 0) continue;
    if (bytes + imageBytes > limit) omitted++;
    else {
      bytes += imageBytes;
      retained++;
    }
  }
  return hasTextureTransform ? { bytes: 0, textures: 0, omitted: 0 } : { bytes, textures: retained, omitted };
}
