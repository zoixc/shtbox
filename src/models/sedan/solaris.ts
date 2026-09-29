import type { CarModelDef, TaskTemplate, ZoneDef } from '../types';
import type { SedanSpec } from './build';

/**
 * Hyundai Solaris (2-е поколение, седан): упрощённая параметрическая модель.
 * Размеры — реальные габариты (4405×1729×1470, база 2600), форма задаётся таблицей сечений.
 * Чтобы добавить другой седан, достаточно скопировать спецификацию и поменять числа.
 */
/** ключевые сечения по X, от носа к корме */
const KX = [2.13, 2.05, 1.87, 1.3, 1.05, 0.3, -0.55, -1.5, -1.98, -2.17, -2.275];
const zip = (v: number[]): [number, number][] => v.map((y, i) => [KX[i], y]);

export const SOLARIS_SPEC: SedanSpec = {
  xFront: 2.13,
  xRear: -2.275,
  frontAxleX: 1.3,
  rearAxleX: -1.3,
  trackHalf: 0.75,
  wheelR: 0.3,
  tireW: 0.195,
  archR: 0.365,
  x: {
    bumperFront: 1.9,
    cowl: 1.05,
    doorFront: 0.85,
    roofFront: 0.3,
    doorSplit: -0.12,
    roofRear: -0.55,
    doorRear: -0.98,
    trunkFront: -1.5,
    bumperRear: -2.02,
  },
  body: {
    glassRise: 0.045,
    profile: {
      yBot: zip([0.34, 0.28, 0.21, 0.17, 0.16, 0.16, 0.16, 0.17, 0.24, 0.3, 0.36]),
      wBot: zip([0.56, 0.6, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.58, 0.54, 0.5]),
      yS: zip([0.42, 0.36, 0.3, 0.27, 0.26, 0.26, 0.26, 0.27, 0.34, 0.4, 0.46]),
      wS: zip([0.68, 0.75, 0.81, 0.82, 0.82, 0.82, 0.82, 0.82, 0.78, 0.72, 0.62]),
      wM: zip([0.73, 0.79, 0.85, 0.865, 0.865, 0.865, 0.865, 0.86, 0.83, 0.76, 0.68]),
      yBelt: zip([0.72, 0.74, 0.76, 0.81, 0.89, 0.93, 0.94, 0.93, 0.91, 0.88, 0.84]),
      // линия крыши по центру: капот → лобовое (прямой наклон) → крыша → заднее стекло → багажник
      yC: [
        [2.13, 0.78], [2.05, 0.82], [1.87, 0.87], [1.3, 0.93], [1.05, 0.98],
        [0.85, 1.1], [0.6, 1.27], [0.3, 1.43], [0.1, 1.465], [-0.3, 1.47], [-0.55, 1.44],
        [-0.85, 1.32], [-1.15, 1.13], [-1.45, 1.0], [-1.98, 1.0], [-2.17, 0.97], [-2.275, 0.92],
      ],
      wG: zip([0.5, 0.58, 0.68, 0.72, 0.74, 0.78, 0.76, 0.69, 0.66, 0.6, 0.54]),
      wR: zip([0.4, 0.46, 0.52, 0.56, 0.58, 0.63, 0.6, 0.55, 0.52, 0.48, 0.44]),
      crown: zip([0.02, 0.02, 0.02, 0.025, 0.03, 0.05, 0.05, 0.03, 0.02, 0.02, 0.02]),
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
  name: 'Hyundai Solaris (седан)',
  description: 'Седан B-класса, 2-е поколение. Параметрическая модель без внешних файлов.',
  defaultColor: '#b9bec6',
  zones: SEDAN_ZONES,
  defaultMaintenance: SOLARIS_MAINTENANCE,
  create: async (color) => (await import('./build')).buildSedan(SOLARIS_SPEC, color),
};
