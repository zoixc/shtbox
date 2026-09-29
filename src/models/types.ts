import type { Mesh, Object3D, Vector3 } from 'three';

/**
 * Слой модели: что сейчас показываем/можно выбирать.
 *  body     — кузов, стёкла, колёса, а также «внутренности» открытых капота/багажника;
 *  interior — салон (кузов становится прозрачным);
 *  mech     — агрегаты: двигатель, КПП, подвеска, тормоза, выхлоп (кузов прозрачный).
 */
export type Layer = 'body' | 'interior' | 'mech';

export const LAYERS: { id: Layer; label: string }[] = [
  { id: 'body', label: 'Кузов' },
  { id: 'interior', label: 'Салон' },
  { id: 'mech', label: 'Агрегаты' },
];

/** Узел автомобиля — единица, к которой привязываются дефекты, ТО и работы. */
export interface ZoneDef {
  id: string;
  label: string;
  /** группа для списка узлов */
  group: string;
  layer: Layer;
  /** может открываться (дверь, капот, багажник) */
  openable?: boolean;
  /** выбирается в 3D только когда открыт указанный узел (например, моторный отсек — когда открыт капот) */
  requiresOpen?: string;
  /** есть окрашиваемая панель: на ней можно отмечать ржавчину/вмятины/сколы */
  paintable?: boolean;
  /** у узла нет 3D-геометрии (общие работы по авто) */
  virtual?: boolean;
}

export interface TaskTemplate {
  zoneId: string;
  title: string;
  everyKm?: number;
  everyMonths?: number;
  notes?: string;
}

export interface OpenableRig {
  pivot: Object3D;
  axis: Vector3;
  /** угол в открытом состоянии, рад */
  angle: number;
  /** «человеческое» имя для кнопки */
  label: string;
}

/**
 * Готовая 3D-модель, которую ожидает Viewer. Любой источник (процедурный генератор,
 * glTF-загрузчик) должен вернуть такую структуру — остальное приложение от него не зависит.
 */
export interface ModelRig {
  root: Object3D;
  /**
   * Окрашиваемые детали кузова: zoneId → mesh. К ним применяется шейдер краски и на них
   * ставятся ржавчина/вмятины/сколы. Координаты пятен — в локальной системе этого меша.
   */
  paint: Map<string, Mesh>;
  /** Все меши узла, по которым работает выбор мышью (включая paint) */
  pick: Map<string, Object3D[]>;
  /** Открывающиеся узлы */
  openables: Map<string, OpenableRig>;
  /** Точка привязки бейджа узла (дочерний объект панели, поэтому двигается вместе с ней) */
  anchors: Map<string, Object3D>;
  /** Направление наружу для скрытия бейджей на обратной стороне (в системе автомобиля) */
  facing: Map<string, [number, number, number]>;
  /** Меши, которые становятся прозрачными в режимах «Салон/Агрегаты» */
  shell: Object3D[];
  /** Перекрасить кузов */
  setColor(hex: string): void;
  /** Габариты для камеры: центр и радиус */
  bounds: { center: [number, number, number]; radius: number };
  dispose(): void;
}

export interface CarModelDef {
  id: string;
  name: string;
  description: string;
  defaultColor: string;
  zones: ZoneDef[];
  defaultMaintenance: TaskTemplate[];
  /** Создаёт 3D-модель. Загрузка ленивая, чтобы three.js не попадал в стартовый бандл. */
  create(color: string): Promise<ModelRig>;
}

/** Описание модели, геометрия которой лежит в glTF/GLB (см. `src/models/gltf.ts` и `docs/ADDING_MODELS.md`). */
export type GltfModelDef = Omit<CarModelDef, 'create'> & { url: string };
