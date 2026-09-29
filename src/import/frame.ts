import type { Frame, Vec3 } from './types';

const rad = (d: number) => (d * Math.PI) / 180;

/** p' = scale · Ry(yaw) · p + offset (Ry — как в three.js: x' = x cos + z sin, z' = −x sin + z cos). */
export function xform(f: Frame): (x: number, y: number, z: number) => Vec3 {
  const c = Math.round(Math.cos(rad(f.yaw)));
  const s = Math.round(Math.sin(rad(f.yaw)));
  const k = f.scale;
  const [ox, oy, oz] = f.offset;
  return (x, y, z) => [(x * c + z * s) * k + ox, y * k + oy, (-x * s + z * c) * k + oz];
}

export function transformed(pos: Float32Array, f: Frame): Float32Array {
  const t = xform(f);
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const p = t(pos[i], pos[i + 1], pos[i + 2]);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
  }
  return out;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export function bboxOf(pos: ArrayLike<number>): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

export const sizeOf = (b: Box): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const centerOf = (b: Box): Vec3 => [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2];

export function unionBox(boxes: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < min[a]) min[a] = b.min[a];
      if (b.max[a] > max[a]) max[a] = b.max[a];
    }
  }
  return { min, max };
}

/** Габариты детали после поворота на кратный 90° yaw (точно, по углам коробки). */
export function yawBox(b: Box, yaw: number): Box {
  const t = xform({ yaw, scale: 1, offset: [0, 0, 0] });
  const xs: number[] = [];
  const zs: number[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const z of [b.min[2], b.max[2]]) {
      const p = t(x, 0, z);
      xs.push(p[0]);
      zs.push(p[2]);
    }
  return { min: [Math.min(...xs), b.min[1], Math.min(...zs)], max: [Math.max(...xs), b.max[1], Math.max(...zs)] };
}
