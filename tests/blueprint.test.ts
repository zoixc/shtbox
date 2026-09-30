import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { createBlueprintEdges } from '../src/view3d/blueprint';

describe('blueprint edge extraction', () => {
  it('welds a non-indexed panel and omits its triangulation diagonal', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      0.00002, 0, 0, 1, 1, 0, 0, 1, 0,
    ], 3));

    const edges = createBlueprintEdges(geometry);
    expect(edges).not.toBeNull();
    expect(edges!.getAttribute('position').count).toBe(8); // четыре внешних отрезка × две вершины
    expect((edges as unknown as { parameters?: unknown }).parameters).toBeUndefined();
    edges!.dispose();
    geometry.dispose();
  });

  it('uses the source index for indexed meshes', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const edges = createBlueprintEdges(geometry);
    expect(edges).not.toBeNull();
    expect(edges!.getAttribute('position').count).toBe(8);
    edges!.dispose();
    geometry.dispose();
  });
});
