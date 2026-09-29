import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createPaintMaterial, enhanceMaterial, setArch } from '../../view3d/paintMaterial';
import type { ModelRig, OpenableRig } from '../types';
import { BodyLoft, K_IDX, LOOP_N, Ownership, buildGrid, buildStations, extractPanel } from './loft';
import type { BodySpec } from './loft';

export interface SedanSpec {
  body: BodySpec;
  /** форма задней части: седан (крышка багажника + неподвижное заднее стекло) или хэтчбек (5-я дверь со стеклом) */
  tail?: 'notchback' | 'hatch';
  /** привод: FWD — поперечный двигатель, RWD — продольный двигатель, карданный вал и редуктор */
  drive?: 'fwd' | 'rwd';
  /** решётка радиатора: широкая или «ноздри» */
  grille?: 'wide' | 'kidney';
  xFront: number;
  xRear: number;
  frontAxleX: number;
  rearAxleX: number;
  trackHalf: number;
  wheelR: number;
  tireW: number;
  archR: number;
  /** границы панелей по X (от носа к корме) */
  x: {
    bumperFront: number;
    cowl: number;
    doorFront: number;
    roofFront: number;
    doorSplit: number;
    roofRear: number;
    doorRear: number;
    trunkFront: number;
    bumperRear: number;
  };
}

type Vec3 = [number, number, number];

// ---------- материалы ----------
const std = (color: number, o: { rough?: number; metal?: number; side?: 0 | 1 | 2 } = {}) =>
  enhanceMaterial(new MeshStandardMaterial({ color, roughness: o.rough ?? 0.7, metalness: o.metal ?? 0, side: o.side ?? 0 }));

const mats = {
  inner: () => enhanceMaterial(new MeshStandardMaterial({ color: 0x33373d, roughness: 0.92, side: BackSide }), undefined),
  shell: () => std(0x1a1d21, { rough: 0.85, side: DoubleSide }),
  glass: () =>
    enhanceMaterial(
      new MeshPhysicalMaterial({ color: 0x070b10, metalness: 0.8, roughness: 0.05, transparent: true, opacity: 0.78, depthWrite: false, envMapIntensity: 1.4 }),
    ),
  lightF: () => enhanceMaterial(new MeshPhysicalMaterial({ color: 0x9aa7b5, roughness: 0.06, metalness: 0.5, clearcoat: 1, emissive: 0x0d1116 })),
  lightR: () => enhanceMaterial(new MeshPhysicalMaterial({ color: 0x7d0c12, roughness: 0.12, metalness: 0.2, clearcoat: 1, emissive: 0x2a0305 })),
  trim: () => std(0x0e1013, { rough: 0.55 }),
  chrome: () => std(0xc7ccd2, { rough: 0.2, metal: 1 }),
  plate: () => std(0xe9ecef, { rough: 0.5 }),
  tire: () => std(0x111213, { rough: 0.92, side: DoubleSide }),
  rim: () => std(0xb4bcc6, { rough: 0.22, metal: 0.95, side: DoubleSide }),
  rimDark: () => std(0x262a2f, { rough: 0.5, metal: 0.6, side: DoubleSide }),
  brake: () => std(0x8b9097, { rough: 0.45, metal: 0.9 }),
  caliper: () => std(0xb3221b, { rough: 0.5, metal: 0.3 }),
  seat: () => std(0x4a505a, { rough: 0.9 }),
  seatDark: () => std(0x2a2e34, { rough: 0.9 }),
  dash: () => std(0x1f2226, { rough: 0.75 }),
  carpet: () => std(0x24272b, { rough: 1, side: DoubleSide }),
  headliner: () => enhanceMaterial(new MeshStandardMaterial({ color: 0xb8bcc2, roughness: 1, side: DoubleSide, transparent: true, opacity: 0.22, depthWrite: false })),
  engine: () => std(0x6d7379, { rough: 0.55, metal: 0.7 }),
  engineDark: () => std(0x2c3035, { rough: 0.6, metal: 0.5 }),
  gearbox: () => std(0x8a8f96, { rough: 0.5, metal: 0.75 }),
  battery: () => std(0x1a3a66, { rough: 0.6 }),
  radiator: () => std(0x101315, { rough: 0.8 }),
  fuse: () => std(0x2a2d31, { rough: 0.7 }),
  metal: () => std(0x596068, { rough: 0.45, metal: 0.85 }),
  spring: () => std(0xc98a1c, { rough: 0.5, metal: 0.6 }),
  exhaust: () => std(0x7a716a, { rough: 0.5, metal: 0.8 }),
  tank: () => std(0x34383e, { rough: 0.7, metal: 0.4 }),
  bay: () => std(0x2b2e33, { rough: 0.9, side: DoubleSide }),
  spare: () => std(0x1b1c1e, { rough: 0.9, side: DoubleSide }),
};

class Builder {
  root = new Group();
  paint = new Map<string, Mesh>();
  pick = new Map<string, Object3D[]>();
  openables = new Map<string, OpenableRig>();
  anchors = new Map<string, Object3D>();
  facing = new Map<string, Vec3>();
  shell: Object3D[] = [];
  tint: MeshStandardMaterial[] = [];
  private lineMat = new LineBasicMaterial({ color: 0x090b0d, transparent: true, opacity: 0.6 });

  registerPick(zone: string, obj: Object3D): void {
    obj.traverse((o) => {
      if ((o as Mesh).isMesh) o.userData.zone = zone;
    });
    const arr = this.pick.get(zone) ?? [];
    arr.push(obj);
    this.pick.set(zone, arr);
  }

  /** Панель: pivot (в мировых координатах шарнира) + content (со смещением −hinge, поэтому внутри — координаты автомобиля). */
  panel(zone: string, hinge?: Vector3, axis?: Vector3, angle = 0, label = ''): Group {
    const pivot = new Group();
    pivot.name = zone;
    const content = new Group();
    if (hinge) {
      pivot.position.copy(hinge);
      content.position.copy(hinge).multiplyScalar(-1);
      this.openables.set(zone, { pivot, axis: axis!, angle, label });
    }
    pivot.add(content);
    this.root.add(pivot);
    return content;
  }

  anchor(zone: string, parent: Object3D, p: Vec3, facing?: Vec3): void {
    const a = new Object3D();
    a.position.set(...p);
    parent.add(a);
    this.anchors.set(zone, a);
    if (facing) this.facing.set(zone, facing);
  }

  lines(edges: Float32Array, parent: Object3D): void {
    if (!edges.length) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(edges, 3));
    const l = new LineSegments(g, this.lineMat);
    l.userData.line = true;
    parent.add(l);
    this.shell.push(l);
  }

  mesh(geo: BufferGeometry, mat: Material, parent: Object3D, zone?: string, at?: Vec3, rot?: Vec3): Mesh {
    const m = new Mesh(geo, mat);
    if (at) m.position.set(...at);
    if (rot) m.rotation.set(...rot);
    parent.add(m);
    if (zone) this.registerPick(zone, m);
    return m;
  }
}

const box = (w: number, h: number, d: number, r = 0.012) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));

// ---------- колесо ----------
function buildWheel(b: Builder, spec: SedanSpec, zone: string, x: number, side: 1 | -1): void {
  const R = spec.wheelR;
  const W = spec.tireW;
  const g = b.panel(zone);
  const wheel = new Group();
  wheel.position.set(x, R, side * spec.trackHalf);
  g.add(wheel);
  // шина
  const hw = W / 2;
  const rIn = R * 0.62;
  const prof: Vector2[] = [];
  const add = (r: number, y: number) => prof.push(new Vector2(r, y));
  add(rIn, -hw * 0.9);
  add(R * 0.8, -hw);
  add(R * 0.95, -hw * 0.92);
  add(R * 0.995, -hw * 0.62);
  add(R, -hw * 0.3);
  add(R, hw * 0.3);
  add(R * 0.995, hw * 0.62);
  add(R * 0.95, hw * 0.92);
  add(R * 0.8, hw);
  add(rIn, hw * 0.9);
  const tireGeo = new LatheGeometry(prof, 48);
  tireGeo.rotateX(Math.PI / 2);
  const tire = b.mesh(tireGeo, mats.tire(), wheel, zone);
  b.shell.push(tire);
  // диск: тёмное дно, обод и 5 спиц
  const rimR = rIn * 0.98;
  const dish = b.mesh(new CylinderGeometry(rimR * 0.94, rimR * 0.94, 0.03, 40), mats.rimDark(), wheel, zone, [0, 0, side * (hw - 0.03)], [Math.PI / 2, 0, 0]);
  b.shell.push(dish);
  const lip = b.mesh(new TorusGeometry(rimR, 0.012, 8, 48), mats.rim(), wheel, zone, [0, 0, side * (hw - 0.012)]);
  b.shell.push(lip);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const spoke = b.mesh(box(rimR * 0.92, 0.05, 0.026, 0.008), mats.rim(), wheel, zone, [Math.cos(a) * rimR * 0.5, Math.sin(a) * rimR * 0.5, side * (hw - 0.02)]);
    spoke.rotation.z = a;
    b.shell.push(spoke);
  }
  const hub = b.mesh(new CylinderGeometry(0.05, 0.05, 0.035, 20), mats.rim(), wheel, zone, [0, 0, side * (hw - 0.012)], [Math.PI / 2, 0, 0]);
  b.shell.push(hub);
  b.anchor(zone, wheel, [0, R * 0.9, side * (hw + 0.02)], [0, 0, side]);
  // арочный подкрылок
  const liner = new Mesh(
    new CylinderGeometry(spec.archR - 0.006, spec.archR - 0.006, 0.3, 32, 1, true, Math.PI / 2, Math.PI),
    mats.bay(),
  );
  liner.rotation.x = Math.PI / 2;
  liner.position.set(x, R, side * (spec.trackHalf - 0.05));
  b.root.add(liner);
}

function buildBrake(b: Builder, spec: SedanSpec, zone: string, x: number, side: 1 | -1, drum: boolean): void {
  const grp = new Group();
  grp.position.set(x, spec.wheelR, side * (spec.trackHalf - spec.tireW / 2 + 0.06));
  b.root.add(grp);
  if (drum) {
    b.mesh(new CylinderGeometry(0.115, 0.115, 0.06, 28), mats.brake(), grp, zone, [0, 0, 0], [Math.PI / 2, 0, 0]);
  } else {
    b.mesh(new CylinderGeometry(0.15, 0.15, 0.024, 36), mats.brake(), grp, zone, [0, 0, 0], [Math.PI / 2, 0, 0]);
    b.mesh(box(0.1, 0.11, 0.07, 0.015), mats.caliper(), grp, zone, [-0.11, 0.02, -side * 0.02]);
  }
}

// ---------- основной билдер ----------
export function buildSedan(spec: SedanSpec, paintColor: string): ModelRig {
  const b = new Builder();
  const loft = new BodyLoft(spec.body);
  const X = spec.x;
  const stations = buildStations(spec.xFront, spec.xRear, [
    X.bumperFront, X.cowl, X.doorFront, X.roofFront, X.doorSplit, X.roofRear, X.doorRear, X.trunkFront, X.bumperRear,
  ]);
  const grid = buildGrid(loft, stations);
  const own = new Ownership(grid);
  const [, , K2, , , K5, K6] = K_IDX;
  const J_TOP0 = K5;
  const J_TOP1 = LOOP_N - K5;

  own.rect('shell', 0, grid.rows - 1, 0, LOOP_N);
  // greenhouse + крыша, затем перекрываем деталями
  const hatch = spec.tail === 'hatch';
  own.center('roof', X.cowl, hatch ? X.roofRear : X.trunkFront, J_TOP0, J_TOP1);
  own.center('hood', X.bumperFront, X.cowl, J_TOP0, J_TOP1);
  own.center('trunk', hatch ? X.roofRear : X.trunkFront, X.bumperRear, J_TOP0, J_TOP1);
  own.center('windshield', X.cowl, X.roofFront, K6, LOOP_N - K6);
  // у хэтчбека заднее стекло — часть 5-й двери и поднимается вместе с ней
  own.center(hatch ? 'trunk:glass' : 'rear_glass', X.roofRear, X.trunkFront, K6, LOOP_N - K6);
  own.side('fender_fr', 'fender_fl', X.bumperFront, X.doorFront, K_IDX[1], K5);
  own.side('quarter_rr', 'quarter_rl', X.doorRear, X.bumperRear, K_IDX[1], K5);
  own.side('sill_r', 'sill_l', X.doorFront, X.doorRear, K_IDX[1], K2 + 1);
  own.side('door_fr', 'door_fl', X.doorFront, X.doorSplit, K2 + 1, K6);
  own.side('door_rr', 'door_rl', X.doorSplit, X.doorRear, K2 + 1, K6);
  // стёкла дверей (с рамкой)
  const gi = (x: number, d: number) => grid.idx(x) + d;
  own.rect('door_fr:glass', gi(X.doorFront, 1), gi(X.doorSplit, -1), K5, K6 - 1);
  own.rect('door_fl:glass', gi(X.doorFront, 1), gi(X.doorSplit, -1), LOOP_N - (K6 - 1), LOOP_N - K5);
  own.rect('door_rr:glass', gi(X.doorSplit, 1), gi(X.doorRear, -1), K5, K6 - 1);
  own.rect('door_rl:glass', gi(X.doorSplit, 1), gi(X.doorRear, -1), LOOP_N - (K6 - 1), LOOP_N - K5);
  // бамперы поверх всего
  own.rect('bumper_f', 0, grid.idx(X.bumperFront), 0, LOOP_N);
  own.rect('bumper_r', grid.idx(X.bumperRear), grid.rows - 1, 0, LOOP_N);
  // оптика: обёртка на угол бампера (кольца торца + первые станции борта)
  const lf0 = 2;
  const lf1 = grid.idx(X.bumperFront) - 2;
  own.rect('lights_f', lf0, lf1, K_IDX[3] + 1, K5 + 2);
  own.rect('lights_f', lf0, lf1, LOOP_N - (K5 + 2), LOOP_N - (K_IDX[3] + 1));
  const lr0 = grid.idx(X.bumperRear) + 2;
  const lr1 = grid.rows - 3;
  own.rect('lights_r', lr0, lr1, K_IDX[3] + 1, K5 + 2);
  own.rect('lights_r', lr0, lr1, LOOP_N - (K5 + 2), LOOP_N - (K_IDX[3] + 1));

  const paintMats: MeshPhysicalMaterial[] = [];
  const bodyTint: Material[] = [];

  // ---- окрашиваемые панели
  type PanelDef = { zone: string; hinge?: Vec3; axis?: Vec3; angle?: number; label?: string; arch?: [number, number, number]; anchor: Vec3; facing: Vec3 };
  const sideZ = (x: number, y: number) => loft.sideZ(x, y);
  const hingeZ = (x: number) => sideZ(x, 0.7) - 0.02;
  const cowlY = loft.topY(X.cowl) - 0.02;
  const trunkY = loft.topY(X.trunkFront) - 0.02;
  const R = spec.archR;
  const midDoorF = (X.doorFront + X.doorSplit) / 2;
  const midDoorR = (X.doorSplit + X.doorRear) / 2;
  const defs: PanelDef[] = [
    { zone: 'hood', hinge: [X.cowl, cowlY, 0], axis: [0, 0, 1], angle: 1.0, label: 'Капот', anchor: [1.25, loft.topY(1.25) + 0.01, 0], facing: [0, 1, 0] },
    hatch
      ? { zone: 'trunk', hinge: [X.roofRear, loft.topY(X.roofRear) - 0.02, 0], axis: [0, 0, 1], angle: -1.2, label: 'Задняя дверь', anchor: [X.trunkFront - 0.1, loft.topY(X.trunkFront - 0.1) + 0.01, 0], facing: [-1, 0.5, 0] }
      : { zone: 'trunk', hinge: [X.trunkFront, trunkY, 0], axis: [0, 0, 1], angle: -1.0, label: 'Багажник', anchor: [-1.65, loft.topY(-1.65) + 0.01, 0], facing: [0, 1, 0] },
    { zone: 'roof', anchor: [-0.35, loft.topY(-0.35) + 0.01, 0], facing: [0, 1, 0] },
    { zone: 'bumper_f', anchor: [spec.xFront + 0.01, 0.5, 0], facing: [1, 0, 0] },
    { zone: 'bumper_r', anchor: [spec.xRear - 0.01, 0.5, 0], facing: [-1, 0, 0] },
  ];
  for (const [sd, sn, sg] of [[1, 'r', 1], [-1, 'l', -1]] as const) {
    defs.push(
      { zone: `fender_f${sn}`, arch: [spec.frontAxleX, spec.wheelR, R], anchor: [1.0, 0.72, sd * (sideZ(1.0, 0.72) + 0.01)], facing: [0, 0, sg] },
      { zone: `quarter_r${sn}`, arch: [spec.rearAxleX, spec.wheelR, R], anchor: [-1.55, 0.74, sd * (sideZ(-1.55, 0.74) + 0.01)], facing: [0, 0, sg] },
      { zone: `sill_${sn}`, anchor: [midDoorF - 0.2, 0.32, sd * (sideZ(midDoorF, 0.32) + 0.01)], facing: [0, 0, sg] },
      {
        zone: `door_f${sn}`, hinge: [X.doorFront, 0, sd * hingeZ(X.doorFront)], axis: [0, 1, 0], angle: sd * 1.15, label: sd > 0 ? 'Дверь пер. правая' : 'Дверь пер. левая',
        anchor: [midDoorF, 0.72, sd * (sideZ(midDoorF, 0.72) + 0.01)], facing: [0, 0, sg],
      },
      {
        zone: `door_r${sn}`, hinge: [X.doorSplit, 0, sd * hingeZ(X.doorSplit)], axis: [0, 1, 0], angle: sd * 1.05, label: sd > 0 ? 'Дверь зад. правая' : 'Дверь зад. левая',
        anchor: [midDoorR, 0.72, sd * (sideZ(midDoorR, 0.72) + 0.01)], facing: [0, 0, sg],
      },
    );
  }

  const contentOf = new Map<string, Group>();
  for (const d of defs) {
    const content = b.panel(d.zone, d.hinge ? new Vector3(...d.hinge) : undefined, d.axis ? new Vector3(...d.axis) : undefined, d.angle, d.label);
    contentOf.set(d.zone, content);
    const glassOwner = `${d.zone}:glass`;
    const p = extractPanel(grid, own, d.zone, (o) => o === d.zone || o === glassOwner);
    if (p) {
      const pm = createPaintMaterial(paintColor);
      paintMats.push(pm);
      const mesh = b.mesh(p.geometry, pm, content, d.zone);
      mesh.name = d.zone;
      b.paint.set(d.zone, mesh);
      b.shell.push(mesh);
      const im = mats.inner();
      const inner = new Mesh(p.geometry, im);
      inner.userData.inner = true;
      content.add(inner);
      if (d.arch) {
        setArch(pm, d.arch);
        setArch(im, d.arch);
      }
      b.lines(p.edges, content);
    }
    const g = extractPanel(grid, own, glassOwner);
    if (g) {
      const gm = b.mesh(g.geometry, mats.glass(), content, d.zone);
      b.shell.push(gm);
    }
    b.anchor(d.zone, content, d.anchor, d.facing);
  }

  // ---- стёкла кузова
  for (const [zone, anchor, facing] of [
    ['windshield', [0.38, loft.topY(0.38) + 0.02, 0], [1, 0.6, 0]],
    ...(hatch ? [] : [['rear_glass', [-1.1, loft.topY(-1.1) + 0.02, 0], [-1, 0.6, 0]]]),
  ] as [string, Vec3, Vec3][]) {
    const content = b.panel(zone);
    const g = extractPanel(grid, own, zone, (o) => o === zone);
    if (g) {
      const m = b.mesh(g.geometry, mats.glass(), content, zone);
      b.shell.push(m);
      b.lines(g.edges, content);
    }
    b.anchor(zone, content, anchor, facing);
  }

  // ---- оптика
  for (const [zone, mk, at, facing] of [
    ['lights_f', mats.lightF, [spec.xFront - 0.02, 0.64, 0.5], [1, 0, 0]],
    ['lights_r', mats.lightR, [spec.xRear + 0.02, 0.72, 0.5], [-1, 0, 0]],
  ] as [string, () => Material, Vec3, Vec3][]) {
    const content = b.panel(zone);
    const g = extractPanel(grid, own, zone, (o) => o === zone);
    if (g) {
      const m = b.mesh(g.geometry, mk(), content, zone);
      b.shell.push(m);
      b.lines(g.edges, content);
    }
    b.anchor(zone, content, at, facing);
  }

  // ---- underbody + прочее
  {
    const g = extractPanel(grid, own, 'shell', () => false);
    if (g) {
      const m = new Mesh(g.geometry, mats.shell());
      m.userData.shellPlain = true;
      b.root.add(m);
      b.shell.push(m);
    }
  }

  // ---- детали на панелях: ручки, зеркала, решётка, номера
  const bodyMat = () => {
    const m = enhanceMaterial(new MeshPhysicalMaterial({ color: new Color(paintColor), metalness: 0.35, roughness: 0.34, clearcoat: 0.9, clearcoatRoughness: 0.08 }));
    bodyTint.push(m);
    return m;
  };
  for (const sd of [1, -1] as const) {
    const sn = sd > 0 ? 'r' : 'l';
    for (const [zone, xc] of [
      [`door_f${sn}`, midDoorF - 0.22],
      [`door_r${sn}`, midDoorR - 0.2],
    ] as [string, number][]) {
      const c = contentOf.get(zone)!;
      const hy = 0.86;
      const hm = new Mesh(box(0.15, 0.028, 0.03, 0.01), bodyMat());
      hm.position.set(xc, hy, sd * (sideZ(xc, hy) + 0.006));
      hm.userData.zone = zone;
      c.add(hm);
      b.shell.push(hm);
    }
    // зеркало
    const c = contentOf.get(`door_f${sn}`)!;
    const mx = X.doorFront - 0.14;
    const my = 0.98;
    const mz = sideZ(mx, 0.9);
    const mirror = new Group();
    const mBody = new Mesh(box(0.13, 0.1, 0.19, 0.035), bodyMat());
    mBody.position.set(mx - 0.02, my + 0.05, sd * (mz + 0.13));
    const mGlass = new Mesh(box(0.008, 0.08, 0.15, 0.003), mats.chrome());
    mGlass.position.set(mx - 0.09, my + 0.05, sd * (mz + 0.13));
    const stalk = new Mesh(box(0.05, 0.035, 0.12, 0.01), mats.trim());
    stalk.position.set(mx, my - 0.005, sd * (mz + 0.05));
    mirror.add(mBody, mGlass, stalk);
    mirror.traverse((o) => {
      if ((o as Mesh).isMesh) o.userData.zone = `door_f${sn}`;
    });
    c.add(mirror);
    b.shell.push(mBody, mGlass, stalk);
  }
  // окантовка колёсных арок (чёрный пластик) — кромка вдоль выреза
  for (const sd of [1, -1] as const) {
    for (const [zone, ax] of [[`fender_f${sd > 0 ? 'r' : 'l'}`, spec.frontAxleX], [`quarter_r${sd > 0 ? 'r' : 'l'}`, spec.rearAxleX]] as [string, number][]) {
      // арка заходит на заднюю дверь (BMW) — кромка на стыке панелей выглядит рваной, пропускаем
      if (zone.startsWith('quarter') && ax + spec.archR > X.doorRear + 0.15) continue;
      const R2 = spec.archR + 0.004;
      const pts: Vector3[] = [];
      for (let k = 0; k <= 24; k++) {
        const t = (k / 24) * Math.PI;
        const px = ax + Math.cos(t) * R2;
        const py = spec.wheelR + Math.sin(t) * R2;
        pts.push(new Vector3(px, py, sd * (sideZ(px, py) + 0.003)));
      }
      const flare = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 40, 0.011, 6, false), mats.trim());
      flare.userData.zone = zone;
      contentOf.get(zone)!.add(flare);
      b.shell.push(flare);
    }
  }
  {
    // решётка и воздухозаборники, номерной знак
    const c = contentOf.get('bumper_f')!;
    const xf = spec.xFront;
    if (spec.grille === 'kidney') {
      for (const [w, h, y, z] of [[0.21, 0.15, 0.6, 0.125], [0.21, 0.15, 0.6, -0.125], [0.9, 0.08, 0.4, 0]] as const) {
        const m = new Mesh(box(0.03, h, w, 0.012), mats.trim());
        m.position.set(xf + 0.004 - 0.005, y, z);
        m.userData.zone = 'bumper_f';
        c.add(m);
        b.shell.push(m);
      }
    } else {
      // широкий шестиугольный «рот» с хромированным кантом + нижний воздухозаборник + ПТФ
      const trap = (wTop: number, wBot: number, h: number, depth: number, mat: Material, y: number, dx: number) => {
        const sh = new Shape([new Vector2(-wTop / 2, h / 2), new Vector2(wTop / 2, h / 2), new Vector2(wBot / 2, -h / 2), new Vector2(-wBot / 2, -h / 2)]);
        const g = new ExtrudeGeometry(sh, { depth, bevelEnabled: false });
        g.rotateY(Math.PI / 2);
        const m = new Mesh(g, mat);
        m.position.set(xf + dx, y, 0);
        m.userData.zone = 'bumper_f';
        c.add(m);
        b.shell.push(m);
      };
      trap(0.9, 0.7, 0.135, 0.03, mats.chrome(), 0.615, -0.022);
      trap(0.86, 0.67, 0.108, 0.036, mats.trim(), 0.615, -0.02);
      trap(0.84, 0.7, 0.078, 0.034, mats.trim(), 0.335, -0.02);
      for (const z of [-0.52, 0.52]) {
        const rim = new Mesh(new CylinderGeometry(0.048, 0.048, 0.03, 20), mats.chrome());
        rim.rotation.z = Math.PI / 2;
        rim.position.set(xf - 0.006, 0.335, z);
        const lens = new Mesh(new CylinderGeometry(0.036, 0.036, 0.034, 20), mats.lightF());
        lens.rotation.z = Math.PI / 2;
        lens.position.set(xf - 0.004, 0.335, z);
        for (const m of [rim, lens]) {
          m.userData.zone = 'bumper_f';
          c.add(m);
          b.shell.push(m);
        }
      }
    }
    const plate = new Mesh(box(0.012, 0.115, 0.52, 0.004), mats.plate());
    plate.position.set(xf + 0.012, 0.47, 0);
    plate.userData.zone = 'bumper_f';
    c.add(plate);
    b.shell.push(plate);
    const cr = contentOf.get('bumper_r')!;
    const plateR = new Mesh(box(0.012, 0.115, 0.52, 0.004), mats.plate());
    plateR.position.set(spec.xRear - 0.012, 0.66, 0);
    plateR.userData.zone = 'bumper_r';
    cr.add(plateR);
    b.shell.push(plateR);
  }

  // ---- колёса и тормоза
  buildWheel(b, spec, 'wheel_fl', spec.frontAxleX, -1);
  buildWheel(b, spec, 'wheel_fr', spec.frontAxleX, 1);
  buildWheel(b, spec, 'wheel_rl', spec.rearAxleX, -1);
  buildWheel(b, spec, 'wheel_rr', spec.rearAxleX, 1);
  for (const sd of [-1, 1] as const) {
    buildBrake(b, spec, 'brakes_f', spec.frontAxleX, sd, false);
    buildBrake(b, spec, 'brakes_r', spec.rearAxleX, sd, true);
  }
  b.anchor('brakes_f', b.root, [spec.frontAxleX, 0.3, -(spec.trackHalf - 0.1)]);
  b.anchor('brakes_r', b.root, [spec.rearAxleX, 0.3, -(spec.trackHalf - 0.1)]);

  buildInterior(b, loft);
  buildMech(b, spec);
  buildBays(b, loft, spec);

  const setColor = (hex: string) => {
    for (const m of paintMats) m.color.set(hex);
    for (const m of bodyTint) (m as MeshStandardMaterial).color.set(hex);
  };

  return {
    root: b.root,
    paint: b.paint,
    pick: b.pick,
    openables: b.openables,
    anchors: b.anchors,
    facing: b.facing,
    shell: b.shell,
    setColor,
    bounds: { center: [0, 0.7, 0], radius: 3.2 },
    dispose() {
      b.root.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh || (o as LineSegments).isLineSegments) {
          m.geometry?.dispose();
          const mm = m.material as Material | Material[];
          (Array.isArray(mm) ? mm : [mm]).forEach((x) => x.dispose());
        }
      });
    },
  };
}

// ---------- перегородки и «внутренности» открываемых отсеков ----------
function bulkhead(loft: BodyLoft, x: number, yClip: number, mat: Material): Mesh {
  const pts = loft.loop(x, yClip);
  const shape = new Shape(pts.map(([z, y]) => new Vector2(z, y)));
  const g = new ShapeGeometry(shape);
  g.rotateY(-Math.PI / 2); // плоскость XY → YZ (нормаль вдоль X)
  g.translate(x, 0, 0);
  return new Mesh(g, mat);
}

function buildBays(b: Builder, loft: BodyLoft, spec: SedanSpec): void {
  const X = spec.x;
  // моторный отсек: щит + пол; выбирается, когда открыт капот
  const bay = b.root;
  const fire = bulkhead(loft, X.cowl + 0.02, 1.0, mats.bay());
  bay.add(fire);
  b.registerPick('engine_bay', fire);
  b.shell.push(fire);
  const bayFloor = new Mesh(new BoxGeometry(X.cowl - spec.xFront + 0.3, 0.02, 1.2), mats.bay());
  bayFloor.position.set((X.cowl + spec.xFront - 0.3) / 2 + 0.05, 0.3, 0);
  bay.add(bayFloor);
  b.registerPick('engine_bay', bayFloor);
  b.shell.push(bayFloor);
  b.anchor('engine_bay', b.root, [1.7, 0.6, 0.35]);

  // багажник
  const rearWall = bulkhead(loft, -1.3, 0.95, mats.bay());
  rearWall.userData.bay = true; // остаётся при подмене кузова (см. hatch/hybrid.ts)
  b.root.add(rearWall);
  b.shell.push(rearWall);
  const shelf = new Mesh(new BoxGeometry(0.3, 0.02, 1.3), mats.carpet());
  shelf.position.set(-1.42, 0.95, 0);
  shelf.userData.bay = true;
  b.root.add(shelf);
  b.shell.push(shelf);
  const tfloor = new Mesh(new BoxGeometry(0.66, 0.02, 1.2), mats.carpet());
  tfloor.position.set(-1.63, 0.34, 0);
  b.root.add(tfloor);
  b.registerPick('trunk_bay', tfloor);
  b.shell.push(tfloor);
  const spare = new Mesh(new CylinderGeometry(0.3, 0.3, 0.1, 32), mats.spare());
  spare.position.set(-1.65, 0.4, 0);
  b.root.add(spare);
  b.registerPick('trunk_bay', spare);
  b.shell.push(spare);
  b.anchor('trunk_bay', b.root, [-1.65, 0.55, 0.0]);
}

// ---------- салон ----------
function buildInterior(b: Builder, loft: BodyLoft): void {
  const g = new Group();
  g.userData.layerGroup = 'interior';
  b.root.add(g);
  const add = (zone: string, geo: BufferGeometry, mat: Material, at: Vec3, rot?: Vec3) => b.mesh(geo, mat, g, zone, at, rot);

  // пол и потолок
  add('floor', new BoxGeometry(1.9, 0.02, 1.36), mats.carpet(), [-0.3, 0.19, 0]);
  add('headliner', new BoxGeometry(0.6, 0.015, 1.0), mats.headliner(), [-0.4, loft.topY(-0.4) - 0.09, 0]);

  // сиденья
  for (const [zone, z] of [['seat_fl', -0.36], ['seat_fr', 0.36]] as const) {
    add(zone, box(0.46, 0.13, 0.5, 0.04), mats.seat(), [-0.02, 0.44, z]);
    add(zone, box(0.12, 0.62, 0.5, 0.04), mats.seat(), [-0.3, 0.75, z], [0, 0, 0.2]);
    add(zone, box(0.08, 0.16, 0.22, 0.03), mats.seatDark(), [-0.38, 1.13, z], [0, 0, 0.2]);
    add(zone, box(0.4, 0.28, 0.44, 0.03), mats.seatDark(), [-0.02, 0.28, z]);
    b.anchor(zone, g, [-0.15, 0.85, z]);
  }
  // задний диван
  add('seat_r', box(0.48, 0.13, 1.3, 0.04), mats.seat(), [-0.93, 0.44, 0]);
  add('seat_r', box(0.12, 0.5, 1.3, 0.04), mats.seat(), [-1.15, 0.68, 0], [0, 0, 0.18]);
  add('seat_r', box(0.4, 0.28, 1.2, 0.03), mats.seatDark(), [-0.93, 0.28, 0]);
  for (const z of [-0.36, 0, 0.36]) add('seat_r', box(0.07, 0.13, 0.2, 0.03), mats.seatDark(), [-1.2, 0.98, z], [0, 0, 0.18]);
  b.anchor('seat_r', g, [-1.05, 0.8, 0]);

  // торпедо
  const sh = new Shape();
  sh.moveTo(0.72, 0.95).lineTo(0.5, 0.93).lineTo(0.4, 0.86).lineTo(0.34, 0.66).lineTo(0.4, 0.5).lineTo(0.72, 0.5).closePath();
  const dg = new ExtrudeGeometry(sh, { depth: 1.5, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
  dg.translate(0, 0, -0.75);
  add('dashboard', dg, mats.dash(), [0, 0, 0]);
  add('dashboard', box(0.06, 0.14, 0.34, 0.02), mats.trim(), [0.42, 0.86, -0.36]); // приборка
  add('console', box(0.12, 0.18, 0.4, 0.02), mats.trim(), [0.42, 0.8, 0.05]); // магнитола
  add('console', box(0.75, 0.22, 0.2, 0.03), mats.dash(), [0.02, 0.32, 0]);
  add('console', new CylinderGeometry(0.014, 0.016, 0.16, 10), mats.trim(), [0.16, 0.5, 0]);
  add('console', new SphereGeometry(0.03, 12, 10), mats.trim(), [0.16, 0.6, 0]);
  b.anchor('dashboard', g, [0.5, 0.92, 0.3]);
  b.anchor('console', g, [0.3, 0.62, 0.08]);

  // руль
  const wheel = new Group();
  wheel.position.set(0.36, 0.85, -0.36);
  wheel.rotation.z = -0.35;
  g.add(wheel);
  b.mesh(new TorusGeometry(0.18, 0.017, 10, 36), mats.trim(), wheel, 'steering', [0, 0, 0], [0, Math.PI / 2, 0]);
  b.mesh(new CylinderGeometry(0.05, 0.05, 0.04, 16), mats.trim(), wheel, 'steering', [0, 0, 0], [0, 0, Math.PI / 2]);
  for (const a of [0, 2.1, 4.2]) {
    const s = b.mesh(box(0.014, 0.17, 0.03, 0.005), mats.trim(), wheel, 'steering');
    s.rotation.x = a;
    s.position.set(0, Math.cos(a) * 0.0, 0);
    s.geometry.translate(0, 0.085, 0);
    s.rotation.x = a + Math.PI / 2;
  }
  b.mesh(new CylinderGeometry(0.022, 0.022, 0.3, 10), mats.trim(), g, 'steering', [0.5, 0.74, -0.36], [0, 0, 1.15]);
  b.anchor('steering', wheel, [0.05, 0.22, 0]);

  b.anchor('floor', g, [-0.35, 0.22, 0.25]);
  b.anchor('headliner', g, [-0.4, loft.topY(-0.4) - 0.11, 0]);
}

// ---------- агрегаты ----------
function buildMech(b: Builder, spec: SedanSpec): void {
  const g = new Group();
  g.userData.layerGroup = 'mech';
  b.root.add(g);
  const add = (zone: string, geo: BufferGeometry, mat: Material, at: Vec3, rot?: Vec3) => b.mesh(geo, mat, g, zone, at, rot);

  if (spec.drive === 'rwd') {
    // продольный двигатель, КПП под тоннелем, карданный вал и задний редуктор
    add('engine', box(0.66, 0.46, 0.56, 0.05), mats.engine(), [1.3, 0.5, 0]);
    add('engine', box(0.5, 0.09, 0.44, 0.03), mats.engineDark(), [1.32, 0.78, 0]);
    add('engine', new CylinderGeometry(0.07, 0.07, 0.1, 16), mats.engineDark(), [1.66, 0.5, 0], [0, 0, Math.PI / 2]);
    b.anchor('engine', g, [1.3, 0.85, 0]);
    add('gearbox', new CylinderGeometry(0.15, 0.13, 0.62, 20), mats.gearbox(), [0.68, 0.42, 0], [0, 0, Math.PI / 2]);
    add('gearbox', new CylinderGeometry(0.03, 0.03, 0.36 + Math.abs(spec.rearAxleX), 12), mats.metal(), [(0.36 + spec.rearAxleX) / 2, 0.36, 0], [0, 0, Math.PI / 2]);
    add('gearbox', box(0.3, 0.24, 0.28, 0.06), mats.gearbox(), [spec.rearAxleX, 0.34, 0]);
    for (const s of [-1, 1] as const) add('gearbox', new CylinderGeometry(0.022, 0.022, spec.trackHalf - 0.15, 10), mats.metal(), [spec.rearAxleX, 0.34, s * (spec.trackHalf / 2 + 0.05)], [Math.PI / 2, 0, 0]);
    b.anchor('gearbox', g, [0.68, 0.62, 0]);
  } else {
    // двигатель (поперечный) и КПП
    add('engine', box(0.62, 0.5, 0.62, 0.05), mats.engine(), [1.3, 0.5, 0.12]);
    add('engine', box(0.3, 0.09, 0.5, 0.03), mats.engineDark(), [1.42, 0.8, 0.12]);
    add('engine', new CylinderGeometry(0.06, 0.06, 0.16, 16), mats.engineDark(), [1.3, 0.5, 0.46], [Math.PI / 2, 0, 0]);
    add('engine', box(0.5, 0.36, 0.06, 0.02), mats.engineDark(), [1.3, 0.55, 0.45]);
    b.anchor('engine', g, [1.3, 0.85, 0.12]);
    add('gearbox', box(0.46, 0.42, 0.36, 0.06), mats.gearbox(), [1.25, 0.44, -0.5]);
    add('gearbox', new CylinderGeometry(0.11, 0.11, 0.2, 20), mats.gearbox(), [1.25, 0.44, -0.72], [Math.PI / 2, 0, 0]);
    b.anchor('gearbox', g, [1.25, 0.68, -0.5]);
  }
  // АКБ и электрика
  add('battery', box(0.24, 0.17, 0.17, 0.01), mats.battery(), [1.62, 0.7, -0.5]);
  add('battery', box(0.03, 0.03, 0.03, 0.005), mats.chrome(), [1.56, 0.8, -0.46]);
  b.anchor('battery', g, [1.62, 0.85, -0.5]);
  add('electrics', box(0.2, 0.09, 0.16, 0.01), mats.fuse(), [1.58, 0.72, 0.5]);
  b.anchor('electrics', g, [1.58, 0.82, 0.5]);
  // радиатор
  add('cooling', box(0.07, 0.4, 0.78, 0.01), mats.radiator(), [1.92, 0.52, 0]);
  add('cooling', new CylinderGeometry(0.15, 0.15, 0.05, 20), mats.engineDark(), [1.82, 0.55, 0.2], [0, 0, Math.PI / 2]);
  b.anchor('cooling', g, [1.92, 0.78, 0]);
  // подвеска
  for (const s of [-1, 1] as const) {
    add('susp_f', new CylinderGeometry(0.032, 0.032, 0.5, 12), mats.metal(), [spec.frontAxleX, 0.6, s * 0.6]);
    add('susp_f', new CylinderGeometry(0.065, 0.065, 0.26, 16), mats.spring(), [spec.frontAxleX, 0.55, s * 0.6]);
    add('susp_f', box(0.08, 0.03, 0.45, 0.01), mats.metal(), [spec.frontAxleX - 0.1, 0.22, s * 0.5]);
    add('susp_r', new CylinderGeometry(0.03, 0.03, 0.4, 12), mats.metal(), [spec.rearAxleX + 0.02, 0.5, s * 0.6]);
    add('susp_r', new CylinderGeometry(0.06, 0.06, 0.2, 16), mats.spring(), [spec.rearAxleX + 0.02, 0.48, s * 0.6]);
  }
  add('susp_f', box(0.14, 0.05, 1.0, 0.01), mats.metal(), [spec.frontAxleX - 0.15, 0.22, 0]);
  add('susp_r', box(0.09, 0.07, 1.2, 0.01), mats.metal(), [spec.rearAxleX - 0.03, 0.24, 0]);
  b.anchor('susp_f', g, [spec.frontAxleX, 0.85, -0.6]);
  b.anchor('susp_r', g, [spec.rearAxleX, 0.72, -0.6]);
  // выхлоп
  const curve = new CatmullRomCurve3([
    new Vector3(1.05, 0.3, 0.32),
    new Vector3(0.6, 0.14, 0.3),
    new Vector3(-0.6, 0.11, 0.12),
    new Vector3(-1.5, 0.13, 0.15),
    new Vector3(-1.85, 0.2, 0.3),
    new Vector3(-2.18, 0.28, 0.36),
  ]);
  add('exhaust', new TubeGeometry(curve, 40, 0.032, 10, false), mats.exhaust(), [0, 0, 0]);
  add('exhaust', new CylinderGeometry(0.1, 0.1, 0.75, 20), mats.exhaust(), [-1.75, 0.2, 0.3], [0, 0, Math.PI / 2]);
  b.anchor('exhaust', g, [-1.0, 0.1, 0.12]);
  // бак
  add('fuel_tank', box(0.9, 0.17, 0.62, 0.05), mats.tank(), [-0.62, 0.12, 0]);
  b.anchor('fuel_tank', g, [-0.62, 0.05, 0]);
}
