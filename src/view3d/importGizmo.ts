/**
 * Гизмо для правки разметки прямо в 3D (P1, п. 7).
 *
 * Тянем одну координату: точку петли (X/Y/Z) или плоскость реза (X/Y, для полуширины — сразу две
 * симметричные плоскости). Логика значений живёт в `src/import/gizmo.ts` и покрыта тестами; здесь —
 * только three.js: TransformControls, ручка и полупрозрачные подсказки-плоскости.
 *
 * Во время перетаскивания гизмо вызывает `onPreview` (живое значение, можно вернуть число для подтягивания
 * к пределам), а по окончании — `onCommit` (одна запись в историю правок). Камера на время перетаскивания
 * не вращается: OrbitControls выключается на `dragging-changed`.
 */
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, OctahedronGeometry, Scene, Vector3 } from 'three';
import type { Camera } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LINE_KIND, lineDragAxis, lineGuideBoxes } from '../import/gizmo';
import type { Dims, Lines } from '../import/types';

export type GizmoTarget =
  | { kind: 'hinge'; zone: string; axis: 'x' | 'y' | 'z'; position: [number, number, number] }
  | { kind: 'line'; key: keyof Lines; value: number };

export interface GizmoCallbacks {
  /** Живое значение при перетаскивании; верните число, чтобы притянуть ручку (например, к габаритам). */
  onPreview(value: number): number | void;
  /** Перетаскивание закончено: сюда приходит итоговое значение. */
  onCommit(value: number): void;
  onDragging(dragging: boolean): void;
}

export class ImportGizmo {
  private controls: TransformControls;
  private helper: Object3D;
  private handle: Mesh;
  private guides = new Group();
  private target: GizmoTarget | null = null;
  private dragging = false;

  constructor(
    private scene: Scene,
    camera: Camera,
    dom: HTMLElement,
    private orbit: OrbitControls,
    private callbacks: GizmoCallbacks,
  ) {
    this.controls = new TransformControls(camera, dom);
    this.controls.setMode('translate');
    this.controls.setSpace('world');
    this.controls.setTranslationSnap(0.01);
    this.helper = this.controls.getHelper();
    this.handle = new Mesh(
      new OctahedronGeometry(0.07, 0),
      new MeshBasicMaterial({ color: 0xffb400, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.handle.name = 'gizmo-handle';
    this.handle.renderOrder = 40;
    this.guides.name = 'gizmo-guides';
    scene.add(this.helper, this.handle, this.guides);
    this.controls.addEventListener('dragging-changed', (event) => {
      this.dragging = Boolean((event as unknown as { value: boolean }).value);
      this.orbit.enabled = !this.dragging;
      if (!this.dragging) this.callbacks.onCommit(this.value());
      this.callbacks.onDragging(this.dragging);
    });
    this.controls.addEventListener('objectChange', () => {
      if (!this.dragging) return;
      const snapped = this.callbacks.onPreview(this.value());
      if (typeof snapped === 'number') this.setAxisValue(snapped);
    });
    this.setVisible(false);
  }

  /** Включено ли перетаскивание прямо сейчас (чтобы не мешать кликам-указаниям). */
  get isDragging(): boolean {
    return this.dragging;
  }

  get isAttached(): boolean {
    return this.target !== null;
  }

  /** Показывает гизмо для петли или плоскости реза. */
  attach(target: GizmoTarget, dims: Dims): void {
    this.target = target;
    const axis = target.kind === 'hinge' ? target.axis : lineDragAxis(target.key);
    this.controls.showX = axis === 'x';
    this.controls.showY = axis === 'y';
    this.controls.showZ = axis === 'z';
    this.controls.showXY = false;
    this.controls.showXZ = false;
    this.controls.showYZ = false;
    this.setAxisValue(target.kind === 'hinge' ? target.position[AXIS_INDEX[axis]] : target.value);
    if (target.kind === 'line') this.handle.position.set(...lineHandlePosition(target.key, target.value, dims));
    else this.handle.position.set(target.position[0], target.position[1], target.position[2]);
    this.drawGuides(target, dims);
    this.controls.attach(this.handle);
    this.setVisible(true);
  }

  /** Синхронизация с ползунком в панели: ручка и плоскости переезжают на новое значение. */
  syncLine(key: keyof Lines, value: number, dims: Dims): void {
    if (this.target?.kind !== 'line' || this.target.key !== key) return;
    this.target = { kind: 'line', key, value };
    this.setAxisValue(value);
    this.handle.position.set(...lineHandlePosition(key, value, dims));
    this.drawGuides(this.target, dims);
  }

  /** Синхронизация с полем угла/положения петли из панели. */
  syncHinge(zone: string, axis: 'x' | 'y' | 'z', position: [number, number, number]): void {
    if (this.target?.kind !== 'hinge' || this.target.zone !== zone || this.target.axis !== axis) return;
    this.target = { kind: 'hinge', zone, axis, position };
    this.handle.position.set(position[0], position[1], position[2]);
  }

  detach(): void {
    if (this.target) this.controls.detach();
    this.target = null;
    this.clearGuides();
    this.setVisible(false);
    this.orbit.enabled = true;
  }

  dispose(): void {
    this.detach();
    this.scene.remove(this.helper, this.handle, this.guides);
    this.controls.dispose();
    this.handle.geometry.dispose();
    (this.handle.material as MeshBasicMaterial).dispose();
  }

  private setVisible(visible: boolean): void {
    this.helper.visible = visible;
    this.handle.visible = visible;
    this.guides.visible = visible;
  }

  private value(): number {
    const target = this.target;
    if (!target) return 0;
    if (target.kind === 'hinge') return readAxis(this.handle.position, target.axis);
    return LINE_KIND[target.key] === 'w' ? Math.abs(this.handle.position.z) : this.handle.position[lineDragAxis(target.key)];
  }

  private setAxisValue(value: number): void {
    const target = this.target;
    if (!target) return;
    if (target.kind === 'hinge') {
      writeAxis(this.handle.position, target.axis, value);
      return;
    }
    if (LINE_KIND[target.key] === 'w') {
      this.handle.position.z = (this.handle.position.z < 0 ? -1 : 1) * Math.abs(value);
      return;
    }
    writeAxis(this.handle.position, lineDragAxis(target.key), value);
  }

  private drawGuides(target: GizmoTarget, dims: Dims): void {
    this.clearGuides();
    if (target.kind !== 'line') return;
    const material = new MeshBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.16, depthWrite: false, side: 2 });
    for (const box of lineGuideBoxes(target.key, target.value, dims)) {
      const mesh = new Mesh(new BoxGeometry(...box.size), material);
      mesh.position.set(...box.pos);
      mesh.renderOrder = 20;
      mesh.raycast = () => {};
      this.guides.add(mesh);
    }
  }

  private clearGuides(): void {
    for (const child of [...this.guides.children]) {
      this.guides.remove(child);
      if (child instanceof Mesh) {
        child.geometry.dispose();
        (child.material as MeshBasicMaterial).dispose();
      }
    }
  }
}

/** Ручка для линии стоит в плоскости реза: по центру кузова (X/Y) или на полуширине (W). */
function lineHandlePosition(key: keyof Lines, value: number, dims: Dims): [number, number, number] {
  const kind = LINE_KIND[key];
  if (kind === 'x') return [value, dims.H * 0.55, 0];
  if (kind === 'y') return [(dims.xRear + dims.xFront) / 2, value, 0];
  return [(dims.xRear + dims.xFront) / 2, dims.H * 0.55, value];
}

const AXIS_INDEX: Record<'x' | 'y' | 'z', 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

const readAxis = (v: Vector3, axis: 'x' | 'y' | 'z'): number => (axis === 'x' ? v.x : axis === 'y' ? v.y : v.z);

const writeAxis = (v: Vector3, axis: 'x' | 'y' | 'z', value: number): void => {
  if (axis === 'x') v.x = value;
  else if (axis === 'y') v.y = value;
  else v.z = value;
};

/** Точка, к которой привязана ручка петли (для подсветки активной панели). */
export const hingeHandlePosition = (position: [number, number, number]): Vector3 => new Vector3(...position);
