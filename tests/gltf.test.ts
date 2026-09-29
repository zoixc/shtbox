import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assertSafeModelUrl, parseOpen, rigFromScene } from '../src/models/gltf';
import type { ZoneDef } from '../src/models/types';

const zones: ZoneDef[] = [
  { id: 'door', label: 'Дверь', group: 'Кузов', layer: 'body', paintable: true, openable: true },
  { id: 'engine', label: 'Двигатель', group: 'Агрегаты', layer: 'mech' },
  { id: 'general', label: 'Общее', group: 'Общее', layer: 'body', virtual: true },
];

const node = (name: string, userData: Record<string, unknown>, at: [number, number, number] = [0, 0, 0]) => {
  const g = new Group();
  g.name = name;
  g.position.set(...at);
  g.userData = userData;
  g.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return g;
};

describe('glTF → ModelRig', () => {
  it('maps zones, pivots and paint materials', () => {
    const scene = new Group();
    scene.add(node('door', { zone: 'door', paint: true, open: { axis: [0, 1, 0], angle: 1.1, label: 'Дверь' } }, [2, 0, 0]));
    scene.add(node('engine', { zone: 'engine' }));
    const rig = rigFromScene(scene, zones, '#336699');
    expect(rig.paint.has('door')).toBe(true);
    expect(rig.pick.get('engine')).toHaveLength(1);
    const open = rig.openables.get('door')!;
    expect(open.pivot.position.x).toBeCloseTo(2); // pivot стоит в точке привязки узла
    expect(open.angle).toBeCloseTo(1.1);
    expect(rig.anchors.has('door') && rig.anchors.has('engine')).toBe(true);
    expect(rig.bounds.radius).toBeGreaterThan(0.5);
    rig.setColor('#ff0000');
    rig.dispose();
  });

  it('rejects unknown/missing zones with a readable error', () => {
    const scene = new Group();
    scene.add(node('x', { zone: 'nope' }));
    expect(() => rigFromScene(scene, zones, '#fff')).toThrow(/неизвестная зона «nope»/);
    const s2 = new Group();
    s2.add(node('door', { zone: 'door', paint: true }));
    expect(() => rigFromScene(s2, zones, '#fff')).toThrow(/нет геометрии для зоны «engine»/);
    const s3 = new Group();
    s3.add(node('door', { zone: 'door' }), node('engine', { zone: 'engine' }));
    expect(() => rigFromScene(s3, zones, '#fff')).toThrow(/extras\.paint/);
  });

  it('validates open extras and model URLs', () => {
    expect(parseOpen({ axis: [0, 1, 0], angle: 1 })).not.toBeNull();
    expect(parseOpen({ axis: [0, 1], angle: 1 })).toBeNull();
    expect(parseOpen({ axis: [0, 1, 0], angle: 99 })).toBeNull();
    expect(() => assertSafeModelUrl('/models/car.glb')).not.toThrow();
    for (const bad of ['https://evil.example/x.glb', '/models/../x.glb', '//evil/x.glb', '/models/x.js', 'models/x.glb']) expect(() => assertSafeModelUrl(bad)).toThrow();
  });

  it('GLTFLoader (GLB) keeps node extras as userData', async () => {
    const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'door', mesh: 0, extras: { zone: 'door', paint: true } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    };
    let json = Buffer.from(JSON.stringify(gltf));
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const total = 12 + 8 + json.length + 8 + bin.length;
    const head = Buffer.alloc(12);
    head.write('glTF', 0, 'ascii');
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(total, 8);
    const chunk = (len: number, type: string) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(len, 0);
      h.write(type, 4, 'ascii');
      return h;
    };
    const glb = Buffer.concat([head, chunk(json.length, 'JSON'), json, chunk(bin.length, 'BIN\0'), bin]);
    const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length) as ArrayBuffer;
    const parsed = await new GLTFLoader().parseAsync(ab, '');
    const door = parsed.scene.getObjectByName('door')!;
    expect(door.userData.zone).toBe('door');
    const rig = rigFromScene(parsed.scene, [zones[0], zones[2]], '#fff');
    expect(rig.paint.has('door')).toBe(true);
  });
});
