/**
 * Импорт пользовательских моделей: общие типы.
 *
 * Пакет модели = один GLB: каждая деталь исходной модели — отдельный узел `p<N>` (упрощённый меш,
 * только позиции и нормали, материал — цвет/прозрачность), а разметка лежит в `extras.shtbox`
 * корня glTF (это `Profile`). Система координат пакета — исходная; `frame` переводит её
 * в систему автомобиля: +X вперёд, +Y вверх, лево = −Z, метры, колёса на y = 0.
 */
export type Vec3 = [number, number, number];

/** Тип детали — решает, как её разбирать по узлам автомобиля. */
export type Kind = 'paint' | 'glass' | 'light' | 'wheel' | 'brake' | 'trim' | 'int' | 'hide';
export const KINDS: readonly Kind[] = ['paint', 'glass', 'light', 'wheel', 'brake', 'trim', 'int', 'hide'];

export interface PartInfo {
  /** исходное имя (для интерфейса) */
  n: string;
  k: Kind;
  /** имя материала */
  m: string;
  /** уверенность авторазметки; для ручных правок поле не используется */
  confidence?: DataConfidence;
  /** принудительный узел (перекрывает автоматику) */
  z?: string;
  /** правка сделана пользователем — при повторном анализе сохраняется */
  u?: 1;
}

export type BodyType = 'sedan' | 'hatch' | 'coupe';

/** Границы панелей в системе автомобиля (м). Смысл — как у `SedanSpec.x`. */
export interface Lines {
  bumperFront: number;
  cowl: number;
  doorFront: number;
  roofFront: number;
  doorSplit: number;
  roofRear: number;
  doorRear: number;
  trunkFront: number;
  bumperRear: number;
  /** высота порога и линии остекления */
  sill: number;
  belt: number;
  /** верх бамперов */
  bumperTopF: number;
  bumperTopR: number;
  /** половина ширины капота / крышки багажника */
  hoodHw: number;
  trunkHw: number;
}

export interface Frame {
  /** поворот вокруг вертикали, градусы: 0 | 90 | 180 | 270 */
  yaw: number;
  scale: number;
  offset: Vec3;
}

export interface Dims {
  L: number;
  W: number;
  H: number;
  xFront: number;
  xRear: number;
  axleF: number;
  axleR: number;
  /** половина колеи */
  track: number;
  wheelR: number;
}

export interface HingeOverride {
  x?: number;
  y?: number;
  z?: number;
  angle?: number;
}

/**
 * Ручной приблизительный контур панели для импортированной оболочки без отдельного меша двери/крышки.
 * Это проекционная маска, а не подтверждённая заводская/CAD-граница. Точки в координатах авто задают
 * замкнутую область в боковой или верхней проекции и позволяют заменить прямые пороги `Profile.lines` на контур по кузову.
 */
export interface PanelRegion {
  zone: string;
  projection: 'side' | 'top';
  /** side: левая сторона авто = z < 0, правая = z > 0; top: сторона не ограничивается по умолчанию. */
  side?: 'left' | 'right' | 'both';
  /** Минимальный |z| для боковой проекции (метры), чтобы маска не затронула центральные детали. */
  minAbsZ?: number;
  /** Минимальная составляющая нормали Y для верхней проекции (0..1). */
  minNormalY?: number;
  /** Категории поверхностей, к которым применяется контур; по умолчанию paint/glass/trim. */
  kinds?: Array<'paint' | 'glass' | 'trim'>;
  /** Замкнутый контур [x,y] для side или [x,z] для top. */
  points: [number, number][];
}

export type DataProvenance = 'auto' | 'manual' | 'document' | 'oem';
export type DataConfidence = 'low' | 'medium' | 'high';
export interface ProfileProvenance {
  dimensions: DataProvenance;
  dimensionsConfidence: DataConfidence;
  panelBoundaries: DataProvenance;
  panelBoundariesConfidence: DataConfidence;
  reference?: string;
}

export interface Profile {
  v: 1;
  title: string;
  credits?: { author?: string; license?: string; source?: string };
  body: BodyType;
  /** расположение двигателя: спереди или сзади */
  layout: 'front' | 'rear';
  /** сторона водителя */
  driver: 'l' | 'r';
  frame: Frame;
  dims: Dims;
  lines: Lines;
  /** материалы, которые красятся цветом кузова */
  paint: string[];
  parts: Record<string, PartInfo>;
  hinges?: Record<string, HingeOverride>;
  /** Ручные приблизительные проекционные маски панелей (не обязательно совпадают с OEM/CAD-швами). */
  panelRegions?: PanelRegion[];
  /** Происхождение размеров и границ, чтобы не выдавать автоматику за заводские данные. */
  provenance?: ProfileProvenance;
}

/** Встроенная текстура альбедо; изображение разделяется между деталями, чтобы не дублировать память. */
export interface RawTexture {
  id: string;
  mime: string;
  image: Uint8Array;
}

/** Деталь в виде массивов — для анализа, упрощения и сборки (без three.js, работает в Worker и Node). */
export interface RawPart {
  id: string;
  name: string;
  material: string;
  alpha: number;
  emissive: boolean;
  /** базовый цвет (линейный, как baseColorFactor в glTF) */
  color: [number, number, number];
  metallic: number;
  roughness: number;
  pos: Float32Array;
  nor: Float32Array;
  /** UV-канал 0 (VEC2), только для включённого сохранения base-color текстур. */
  uv?: Float32Array;
  texture?: RawTexture;
  idx: Uint32Array;
}

export const MAX_PARTS = 400;
