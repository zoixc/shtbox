/**
 * Опускание стёкол дверей у модели, которая пришла из файла.
 *
 * В импортированной модели нет подвижных створок: стекло — просто меш внутри двери. Сделать его
 * «живым» можно двумя способами:
 *  1) честно вырезать геометрию створки и двигать её — точно, но требует резать меши по поясной
 *     линии, а у сканов линии пояса нет и рез получается рваным;
 *  2) оставить геометрию как есть, а видимую часть ограничить маской в шейдере и сдвинуть створку
 *     вниз — стекло «уезжает» в дверь, край остаётся настоящим (со своей формой), ничего не рвётся
 *     и не торчит снизу.
 *
 * Здесь реализован второй путь: он не зависит от топологии файла, работает и для цельных, и для
 * разбитых на детали моделей, стоит один uniform на материал и обратим (закрытое стекло выглядит
 * ровно как в исходной модели).
 */
import { Box3, Mesh } from 'three';
import type { Object3D } from 'three';
import { setWindowMask } from './paintMaterial';

export interface WindowControl {
  /** узел-дверь, которой принадлежит створка */
  zone: string;
  label: string;
  /** верх проёма в локальных координатах створки (м) */
  top: number;
  /** текущее положение створки: 0 — закрыто, 1 — опущено */
  value: number;
  /** меши створки (у составной створки их несколько) */
  meshes: Mesh[];
  set(fraction: number): void;
}

export interface WindowOptions {
  zone: string;
  label: string;
  /** пояс кузова (линия окон) в тех же координатах, что и геометрия створки */
  belt: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Делает из меша стекла опускаемую створку. Геометрия не меняется: меш сдвигается вниз,
 * а шейдер прячет всё выше проёма и ниже пояса.
 */
export function makeWindow(mesh: Mesh, opts: WindowOptions): WindowControl {
  const geom = mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const box = geom.boundingBox ?? new Box3();
  const top = box.max.y;
  // низ створки не может быть выше пояса: иначе при опускании останется «полоска» стекла
  const bottom = Math.min(box.min.y, opts.belt);
  const drop = Math.max(0.06, top - bottom + 0.02);
  const baseY = mesh.position.y;
  const material = mesh.material as Parameters<typeof setWindowMask>[0];
  const control: WindowControl = {
    zone: opts.zone,
    label: opts.label,
    top,
    value: 0,
    meshes: [mesh],
    set(fraction: number) {
      const k = clamp01(fraction);
      control.value = k;
      mesh.position.y = baseY - drop * k;
      // при закрытом стекле маска выключена — модель выглядит как исходная
      setWindowMask(material, k > 0.002 ? { top, bottom } : null);
    },
  };
  control.set(0);
  return control;
}

/** Ищет в узле меши, которые стоит сделать опускаемыми (стекло двери). */
export function collectWindows(
  objects: Object3D[],
  isGlass: (mesh: Mesh) => boolean,
  belt: number,
  zone: string,
  label: string,
): WindowControl[] {
  const out: WindowControl[] = [];
  for (const root of objects) {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !isGlass(mesh)) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      // стекло должно быть выше пояса: детали внутри двери (ручки, направляющие) не трогаем
      if ((mesh.geometry.boundingBox?.max.y ?? 0) < belt) return;
      out.push(makeWindow(mesh, { zone, label, belt }));
    });
  }
  return out;
}

/** Объединяет несколько створок одного узла (например, передняя и задняя секции) в одну ручку. */
export function mergeWindows(zone: string, label: string, list: WindowControl[]): WindowControl {
  if (list.length === 1) return list[0];
  const merged: WindowControl = {
    zone,
    label,
    top: Math.max(...list.map((c) => c.top)),
    value: 0,
    meshes: list.flatMap((c) => c.meshes),
    set(fraction: number) {
      for (const c of list) c.set(fraction);
      merged.value = clamp01(fraction);
    },
  };
  return merged;
}
