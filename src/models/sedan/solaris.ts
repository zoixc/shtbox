import type { CarModelDef, TaskTemplate, ZoneDef } from '../types';
import type { SedanSpec } from './build';

/** Каталожные размеры Solaris I Sedan (2011–2014), Auto-Data: */
export const SOLARIS_I_DIMENSIONS = {
  length: 4.37,
  width: 1.7,
  height: 1.47,
  wheelbase: 2.57,
  frontTrack: 1.495,
  rearTrack: 1.502,
  frontOverhang: 0.82,
  rearOverhang: 0.98,
  groundClearance: 0.16,
} as const;

/**
 * Hyundai Solaris I Sedan (RB, 2011–2014): параметрическая внешняя форма, а не OEM/CAD-поверхность.
 * Контрольные точки и характерные элементы кузова приближены по фотографиям. Общие габариты и база
 * сверены со страницей поколения; колея, свесы, клиренс и шины — с карточкой Solaris 1.6 MPI:
 * https://www.auto-data.net/en/hyundai-solaris-i-sedan-generation-5739
 * https://www.auto-data.net/en/hyundai-solaris-i-sedan-1.6-mpi-123hp-33028
 */
const WB_HALF = SOLARIS_I_DIMENSIONS.wheelbase / 2;
const X_FRONT = WB_HALF + SOLARIS_I_DIMENSIONS.frontOverhang;
const X_REAR = -WB_HALF - SOLARIS_I_DIMENSIONS.rearOverhang;
/**
 * Loft cross-sections use Catmull–Rom interpolation, which slightly overshoots the control points.
 * These factors calibrate the sampled exterior envelope (including that overshoot) to the catalog height,
 * ground clearance, and width instead of merely matching the control values.
 */
const BODY_Y_SCALE = 0.9842447577284821;
const BODY_Y_OFFSET = 0.00981153398032339;
const BODY_WIDTH_SCALE = 0.9863152146886657;
/** ключевые сечения кузова по X, от носа к корме */
const KX = [X_FRONT, 2.025, 1.83, WB_HALF, 0.62, 0.18, -0.35, -1.12, -1.52, -2.02, X_REAR];
const yZip = (v: number[]): [number, number][] => v.map((y, i) => [KX[i], y * BODY_Y_SCALE + BODY_Y_OFFSET]);
const riseZip = (v: number[]): [number, number][] => v.map((y, i) => [KX[i], y * BODY_Y_SCALE]);
const widthZip = (v: number[]): [number, number][] => v.map((y, i) => [KX[i], y * BODY_WIDTH_SCALE]);
const yCurve = (points: [number, number][]): [number, number][] => points.map(([x, y]) => [x, y * BODY_Y_SCALE + BODY_Y_OFFSET]);

export const SOLARIS_SPEC: SedanSpec = {
  style: 'solaris-i-2011',
  tail: 'notchback',
  drive: 'fwd',
  grille: 'wide',
  xFront: X_FRONT,
  xRear: X_REAR,
  frontAxleX: WB_HALF,
  rearAxleX: -WB_HALF,
  // Auto-Data gives 1495 mm front and 1502 mm rear; retain both rather than forcing one shared track.
  trackHalf: (SOLARIS_I_DIMENSIONS.frontTrack + SOLARIS_I_DIMENSIONS.rearTrack) / 4,
  frontTrackHalf: SOLARIS_I_DIMENSIONS.frontTrack / 2,
  rearTrackHalf: SOLARIS_I_DIMENSIONS.rearTrack / 2,
  // Nominal 185/65 R15 diameter: 381 + 2×120.25 = 621.5 mm.
  wheelR: 0.31075,
  tireW: 0.185,
  archR: 0.367,
  x: {
    bumperFront: 1.91,
    cowl: 0.62,
    doorFront: 0.58,
    roofFront: 0.18,
    doorSplit: -0.35,
    roofRear: -1.0,
    doorRear: -1.12,
    trunkFront: -1.52,
    bumperRear: -2.02,
  },
  body: {
    glassRise: 0.045 * BODY_Y_SCALE,
    profile: {
      yBot: yZip([0.34, 0.28, 0.21, 0.17, 0.16, 0.16, 0.16, 0.17, 0.24, 0.3, 0.36]),
      wBot: widthZip([0.55, 0.6, 0.62, 0.61, 0.62, 0.63, 0.63, 0.62, 0.58, 0.53, 0.49]),
      yS: yZip([0.42, 0.36, 0.3, 0.27, 0.26, 0.26, 0.26, 0.27, 0.34, 0.4, 0.46]),
      wS: widthZip([0.67, 0.74, 0.8, 0.81, 0.81, 0.81, 0.81, 0.8, 0.77, 0.71, 0.62]),
      // Width samples are calibrated after Catmull–Rom interpolation; catalog body width is 1700 mm (mirrors excluded).
      wM: widthZip([0.73, 0.78, 0.83, 0.845, 0.85, 0.85, 0.85, 0.84, 0.81, 0.75, 0.66]),
      yBelt: yZip([0.72, 0.74, 0.77, 0.81, 0.86, 0.9, 0.93, 0.92, 0.9, 0.87, 0.84]),
      // Длинный наклонный капот, узкая дуга крыши, крутое заднее стекло и короткая горизонтальная полка багажника.
      yC: yCurve([
        [X_FRONT, 0.78], [2.025, 0.82], [1.83, 0.88], [WB_HALF, 0.93], [0.92, 0.96], [0.62, 1.0],
        [0.42, 1.15], [0.18, 1.32], [-0.02, 1.44], [-0.32, 1.465], [-0.58, SOLARIS_I_DIMENSIONS.height],
        [-0.8, 1.43], [-1.0, 1.34], [-1.21, 1.18], [-1.52, 1.02], [-1.95, 1.0], [-2.12, 0.96], [X_REAR, 0.9],
      ]),
      wG: widthZip([0.5, 0.57, 0.66, 0.71, 0.73, 0.75, 0.74, 0.7, 0.65, 0.59, 0.53]),
      wR: widthZip([0.39, 0.45, 0.52, 0.56, 0.58, 0.6, 0.59, 0.55, 0.51, 0.46, 0.42]),
      crown: riseZip([0.015, 0.018, 0.02, 0.022, 0.025, 0.03, 0.035, 0.03, 0.02, 0.018, 0.015]),
    },
  },
};

const B = 'Кузов';
const W = 'Колёса и тормоза';
const I = 'Салон';
const M = 'Агрегаты';

export const SEDAN_ZONES: ZoneDef[] = [
  { id: 'hood', label: 'Капот', group: B, layer: 'body', paintable: true, openable: true },
  { id: 'engine_bay', label: 'Моторный отсек', group: B, layer: 'body', requiresOpen: 'hood' },
  { id: 'trunk', label: 'Крышка багажника', group: B, layer: 'body', paintable: true, openable: true },
  { id: 'trunk_bay', label: 'Багажное отделение', group: B, layer: 'body', requiresOpen: 'trunk' },
  { id: 'door_fl', label: 'Дверь передняя левая', group: B, layer: 'body', paintable: true, openable: true },
  { id: 'door_fr', label: 'Дверь передняя правая', group: B, layer: 'body', paintable: true, openable: true },
  { id: 'door_rl', label: 'Дверь задняя левая', group: B, layer: 'body', paintable: true, openable: true },
  { id: 'door_rr', label: 'Дверь задняя правая', group: B, layer: 'body', paintable: true, openable: true },
  { id: 'fender_fl', label: 'Крыло переднее левое', group: B, layer: 'body', paintable: true },
  { id: 'fender_fr', label: 'Крыло переднее правое', group: B, layer: 'body', paintable: true },
  { id: 'quarter_rl', label: 'Крыло заднее левое', group: B, layer: 'body', paintable: true },
  { id: 'quarter_rr', label: 'Крыло заднее правое', group: B, layer: 'body', paintable: true },
  { id: 'sill_l', label: 'Порог левый', group: B, layer: 'body', paintable: true },
  { id: 'sill_r', label: 'Порог правый', group: B, layer: 'body', paintable: true },
  { id: 'roof', label: 'Крыша и стойки', group: B, layer: 'body', paintable: true },
  { id: 'bumper_f', label: 'Бампер передний', group: B, layer: 'body', paintable: true },
  { id: 'bumper_r', label: 'Бампер задний', group: B, layer: 'body', paintable: true },
  { id: 'windshield', label: 'Лобовое стекло', group: B, layer: 'body' },
  { id: 'rear_glass', label: 'Заднее стекло', group: B, layer: 'body' },
  { id: 'lights_f', label: 'Фары', group: B, layer: 'body' },
  { id: 'lights_r', label: 'Задние фонари', group: B, layer: 'body' },

  { id: 'wheel_fl', label: 'Колесо переднее левое', group: W, layer: 'body' },
  { id: 'wheel_fr', label: 'Колесо переднее правое', group: W, layer: 'body' },
  { id: 'wheel_rl', label: 'Колесо заднее левое', group: W, layer: 'body' },
  { id: 'wheel_rr', label: 'Колесо заднее правое', group: W, layer: 'body' },
  { id: 'brakes_f', label: 'Тормоза передние', group: W, layer: 'mech' },
  { id: 'brakes_r', label: 'Тормоза задние', group: W, layer: 'mech' },

  { id: 'dashboard', label: 'Торпедо и приборная панель', group: I, layer: 'interior' },
  { id: 'steering', label: 'Рулевое колесо и колонка', group: I, layer: 'interior' },
  { id: 'console', label: 'Консоль, магнитола, КПП-селектор', group: I, layer: 'interior' },
  { id: 'seat_fl', label: 'Сиденье водителя', group: I, layer: 'interior' },
  { id: 'seat_fr', label: 'Сиденье пассажира', group: I, layer: 'interior' },
  { id: 'seat_r', label: 'Задний диван', group: I, layer: 'interior' },
  { id: 'floor', label: 'Пол и коврики', group: I, layer: 'interior' },
  { id: 'headliner', label: 'Потолок', group: I, layer: 'interior' },

  { id: 'engine', label: 'Двигатель', group: M, layer: 'mech' },
  { id: 'gearbox', label: 'КПП / трансмиссия', group: M, layer: 'mech' },
  { id: 'cooling', label: 'Система охлаждения', group: M, layer: 'mech' },
  { id: 'battery', label: 'Аккумулятор', group: M, layer: 'mech' },
  { id: 'electrics', label: 'Электрика, предохранители', group: M, layer: 'mech' },
  { id: 'susp_f', label: 'Подвеска передняя', group: M, layer: 'mech' },
  { id: 'susp_r', label: 'Подвеска задняя', group: M, layer: 'mech' },
  { id: 'exhaust', label: 'Выхлопная система', group: M, layer: 'mech' },
  { id: 'fuel_tank', label: 'Топливный бак и система', group: M, layer: 'mech' },

  { id: 'general', label: 'Автомобиль в целом', group: 'Общее', layer: 'body', virtual: true },
];

/** Типовой регламент (ориентир для Solaris 1.6 MPI; уточняйте по сервисной книжке). */
export const SOLARIS_MAINTENANCE: TaskTemplate[] = [
  { zoneId: 'engine', title: 'Замена моторного масла и масляного фильтра', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'engine', title: 'Воздушный фильтр двигателя', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'engine', title: 'Свечи зажигания', everyKm: 30000, everyMonths: 36 },
  { zoneId: 'engine', title: 'Ремень приводных агрегатов: осмотр/замена', everyKm: 60000 },
  { zoneId: 'cooling', title: 'Замена охлаждающей жидкости', everyKm: 90000, everyMonths: 48 },
  { zoneId: 'gearbox', title: 'Замена масла в КПП', everyKm: 60000, everyMonths: 60 },
  { zoneId: 'fuel_tank', title: 'Топливный фильтр', everyKm: 60000 },
  { zoneId: 'brakes_f', title: 'Передние колодки и диски: осмотр', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'brakes_r', title: 'Задние колодки/барабаны: осмотр', everyKm: 30000, everyMonths: 24 },
  { zoneId: 'general', title: 'Замена тормозной жидкости', everyMonths: 24 },
  { zoneId: 'susp_f', title: 'Диагностика подвески и рулевого', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'battery', title: 'Проверка аккумулятора и клемм', everyMonths: 12 },
  { zoneId: 'wheel_fl', title: 'Ротация колёс / шиномонтаж (сезонная смена)', everyMonths: 6 },
  { zoneId: 'floor', title: 'Салонный фильтр', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'general', title: 'Антикор / обработка кузова', everyMonths: 24 },
];

export const solaris: CarModelDef = {
  id: 'sedan-solaris',
  name: 'Hyundai Solaris I (2011–2014, седан)',
  description: 'Первое поколение RB. Габариты сверены с Auto-Data; внешний кузов — процедурное приближение по фото, не OEM/CAD.',
  defaultColor: '#b9bec6',
  zones: SEDAN_ZONES,
  defaultMaintenance: SOLARIS_MAINTENANCE,
  create: async (color) => (await import('./build')).buildSedan(SOLARIS_SPEC, color),
};
