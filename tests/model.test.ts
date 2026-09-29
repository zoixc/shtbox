import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';
import { listModels } from '../src/models/registry';
import { BodyLoft, buildGrid, buildStations, pchip } from '../src/models/sedan/loft';
import { SOLARIS_SPEC } from '../src/models/sedan/solaris';

describe('pchip', () => {
  it('is monotone and hits keys (descending x)', () => {
    const f = pchip([3, 2, 1, 0], [10, 10, 4, 0]);
    expect(f(3)).toBeCloseTo(10);
    expect(f(0)).toBeCloseTo(0);
    let prev = f(0);
    for (let x = 0.1; x <= 3; x += 0.1) {
      expect(f(x)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f(x);
    }
  });
});

describe('sedan loft', () => {
  it('has finite geometry and outward normals on top', () => {
    const loft = new BodyLoft(SOLARIS_SPEC.body);
    const g = buildGrid(loft, buildStations(2.2, -2.2, [1.98, 0.72, -0.32]));
    expect(g.pos.every(Number.isFinite)).toBe(true);
    expect(g.nrm.every(Number.isFinite)).toBe(true);
    // вершина на крыше — нормаль смотрит вверх
    const i = g.idx(-0.2);
    const top = (i * 49 + 24) * 3;
    expect(g.nrm[top + 1]).toBeGreaterThan(0.8);
  });
});

describe('model registry contract', () => {
  for (const def of listModels()) {
    it(`${def.id}: every zone has 3D geometry, paintable zones have paint meshes`, async () => {
      const rig = await def.create(def.defaultColor);
      const ids = new Set(def.zones.map((z) => z.id));
      expect(ids.size).toBe(def.zones.length); // уникальные id
      for (const z of def.zones) {
        if (z.virtual) continue;
        expect(rig.pick.has(z.id), `pick:${z.id}`).toBe(true);
        expect(rig.anchors.has(z.id), `anchor:${z.id}`).toBe(true);
        if (z.paintable) expect(rig.paint.has(z.id), `paint:${z.id}`).toBe(true);
        if (z.openable) expect(rig.openables.has(z.id), `open:${z.id}`).toBe(true);
        if (z.requiresOpen) expect(def.zones.find((x) => x.id === z.requiresOpen)?.openable).toBe(true);
      }
      for (const m of rig.paint.values()) expect((m as Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0);
      for (const t of def.defaultMaintenance) expect(ids.has(t.zoneId), `task zone ${t.zoneId}`).toBe(true);
      rig.dispose();
    });
  }
});
