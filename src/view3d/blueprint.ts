import { BufferGeometry, EdgesGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Builds a compact edge overlay from a mesh geometry. Vertices are welded by position before
 * extracting creases/boundaries, so non-indexed panel soups don't draw every triangle edge.
 */
export function createBlueprintEdges(geometry: BufferGeometry, thresholdAngle = 22): EdgesGeometry | null {
  const source = geometry.getAttribute('position');
  if (!source || source.count < 3) return null;

  const positions = new Float32Array(source.count * 3);
  for (let i = 0; i < source.count; i++) {
    positions[i * 3] = source.getX(i);
    positions[i * 3 + 1] = source.getY(i);
    positions[i * 3 + 2] = source.getZ(i);
  }

  // Preserve indexed geometry topology and discard bad/degenerate triangles before edge extraction.
  const sourceIndex = geometry.getIndex();
  const count = sourceIndex?.count ?? source.count;
  const indices = new Uint32Array(count);
  let indexCount = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < count; i += 3) {
    const ia = sourceIndex ? sourceIndex.getX(i) : i;
    const ib = sourceIndex ? sourceIndex.getX(i + 1) : i + 1;
    const ic = sourceIndex ? sourceIndex.getX(i + 2) : i + 2;
    if (ia >= source.count || ib >= source.count || ic >= source.count) continue;
    const ax = source.getX(ia), ay = source.getY(ia), az = source.getZ(ia);
    const bx = source.getX(ib), by = source.getY(ib), bz = source.getZ(ib);
    const cx = source.getX(ic), cy = source.getY(ic), cz = source.getZ(ic);
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    ) continue;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const area2 = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    if (!Number.isFinite(area2) || area2 < 1e-10) continue;
    indices[indexCount++] = ia;
    indices[indexCount++] = ib;
    indices[indexCount++] = ic;
    minX = Math.min(minX, ax, bx, cx); minY = Math.min(minY, ay, by, cy); minZ = Math.min(minZ, az, bz, cz);
    maxX = Math.max(maxX, ax, bx, cx); maxY = Math.max(maxY, ay, by, cy); maxZ = Math.max(maxZ, az, bz, cz);
  }
  if (!indexCount) return null;

  const input = new BufferGeometry();
  input.setAttribute('position', new Float32BufferAttribute(positions, 3));
  input.setIndex(new Uint32BufferAttribute(indices.subarray(0, indexCount), 1));
  let welded: BufferGeometry | null = null;
  try {
    welded = mergeVertices(input, 1e-4);
    const edges = new EdgesGeometry(welded, thresholdAngle);
    const p = edges.getAttribute('position');
    if (!p || p.count < 2) {
      edges.dispose();
      return null;
    }

    // Lift the overlay a fraction of a millimetre to avoid z-fighting with the translucent shell.
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const len = Math.hypot(dx, dy, dz) || 1;
      const offset = 0.0008 / len;
      p.setXYZ(i, x + dx * offset, y + dy * offset, z + dz * offset);
    }
    p.needsUpdate = true;
    edges.computeBoundingSphere();
    // EdgesGeometry keeps its input in .parameters; do not retain the much larger welded source mesh.
    delete (edges as unknown as { parameters?: unknown }).parameters;
    return edges;
  } finally {
    input.dispose();
    welded?.dispose();
  }
}
