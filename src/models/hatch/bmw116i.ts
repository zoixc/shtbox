import type { CarModelDef, TaskTemplate, ZoneDef } from '../types';
import type { SedanSpec } from '../sedan/build';
import { SEDAN_ZONES } from '../sedan/solaris';

/**
 * BMW 116i (F20, 5-дверный хэтчбек, задний привод): упрощённая параметрическая модель.
 * Габариты — 4324×1765×1421, база 2690. Использует тот же генератор, что и седан
 * (`tail: 'hatch'` — пятая дверь со стеклом, `drive: 'rwd'` — продольный двигатель и кардан).
 */
const KX = [2.16, 2.08, 1.88, 1.345, 0.62, -0.05, -0.9, -1.75, -1.95, -2.08, -2.16];
const zip = (v: number[]): [number, number][] => v.map((y, i) => [KX[i], y]);

export const BMW116I_SPEC: SedanSpec = {
  tail: 'hatch',
  drive: 'rwd',
  grille: 'kidney',
  xFront: 2.16,
  xRear: -2.16,
  frontAxleX: 1.345,
  rearAxleX: -1.345,
  trackHalf: 0.76,
  wheelR: 0.32,
  tireW: 0.205,
  archR: 0.385,
  x: {
    bumperFront: 1.94,
    cowl: 0.62,
    doorFront: 0.56,
    roofFront: -0.05,
    doorSplit: -0.42,
    roofRear: -1.32,
    doorRear: -1.26,
    trunkFront: -1.95,
    bumperRear: -1.99,
  },
  body: {
    glassRise: 0.045,
    profile: {
      yBot: zip([0.34, 0.28, 0.21, 0.17, 0.16, 0.16, 0.16, 0.18, 0.26, 0.31, 0.34]),
      wBot: zip([0.5, 0.55, 0.62, 0.64, 0.64, 0.64, 0.64, 0.64, 0.6, 0.55, 0.5]),
      yS: zip([0.44, 0.38, 0.31, 0.27, 0.26, 0.26, 0.26, 0.28, 0.36, 0.42, 0.46]),
      wS: zip([0.6, 0.7, 0.82, 0.85, 0.85, 0.85, 0.85, 0.84, 0.8, 0.74, 0.64]),
      wM: zip([0.66, 0.76, 0.86, 0.885, 0.885, 0.885, 0.885, 0.87, 0.84, 0.78, 0.7]),
      yBelt: zip([0.66, 0.69, 0.73, 0.8, 0.9, 0.95, 0.96, 0.95, 0.93, 0.9, 0.86]),
      // капот (длинный) → лобовое → крыша → сильно наклонное заднее стекло → короткий хвост
      yC: [
        [2.16, 0.74], [2.08, 0.8], [1.88, 0.86], [1.345, 0.93], [0.62, 0.99],
        [0.4, 1.14], [0.2, 1.3], [-0.05, 1.415], [-0.4, 1.43], [-0.9, 1.42], [-1.2, 1.37],
        [-1.5, 1.24], [-1.75, 1.09], [-1.95, 0.99], [-2.08, 0.95], [-2.16, 0.9],
      ],
      wG: zip([0.46, 0.56, 0.68, 0.72, 0.74, 0.8, 0.8, 0.76, 0.68, 0.6, 0.54]),
      wR: zip([0.4, 0.46, 0.54, 0.58, 0.6, 0.64, 0.64, 0.58, 0.52, 0.48, 0.44]),
      crown: zip([0.02, 0.02, 0.02, 0.025, 0.03, 0.05, 0.05, 0.03, 0.02, 0.02, 0.02]),
    },
  },
};

const tailgate = (z: ZoneDef): ZoneDef => (z.id === 'trunk' ? { ...z, label: 'Задняя дверь (багажник)' } : z);
export const HATCH_ZONES: ZoneDef[] = SEDAN_ZONES.filter((z) => z.id !== 'rear_glass').map(tailgate);

const N = 'Ориентир для 116i (N13, 1.6T); уточняйте по индикатору CBS и сервисной книжке.';

/** Типовой регламент для BMW 116i F20. */
export const BMW116I_MAINTENANCE: TaskTemplate[] = [
  { zoneId: 'engine', title: 'Замена моторного масла и масляного фильтра', everyKm: 15000, everyMonths: 12, notes: N },
  { zoneId: 'engine', title: 'Воздушный фильтр двигателя', everyKm: 30000, everyMonths: 36 },
  { zoneId: 'engine', title: 'Свечи зажигания', everyKm: 60000, everyMonths: 48 },
  { zoneId: 'engine', title: 'Ремень приводных агрегатов: осмотр/замена', everyKm: 60000 },
  { zoneId: 'cooling', title: 'Замена охлаждающей жидкости', everyKm: 90000, everyMonths: 48 },
  { zoneId: 'gearbox', title: 'Замена масла в КПП', everyKm: 80000, everyMonths: 72, notes: 'Для автомата ZF 8HP; для механики — каждые 60 000 км.' },
  { zoneId: 'gearbox', title: 'Масло в заднем редукторе', everyKm: 100000, everyMonths: 96 },
  { zoneId: 'brakes_f', title: 'Передние колодки и диски: осмотр', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'brakes_r', title: 'Задние колодки и диски: осмотр', everyKm: 30000, everyMonths: 24 },
  { zoneId: 'general', title: 'Замена тормозной жидкости', everyMonths: 24 },
  { zoneId: 'susp_f', title: 'Диагностика подвески и рулевого', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'battery', title: 'Проверка аккумулятора (после замены — регистрация в блоке)', everyMonths: 12 },
  { zoneId: 'wheel_fl', title: 'Ротация колёс / шиномонтаж (сезонная смена)', everyMonths: 6 },
  { zoneId: 'floor', title: 'Салонный фильтр (микрофильтр)', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'general', title: 'Антикор / обработка кузова', everyMonths: 24 },
];

export const bmw116i: CarModelDef = {
  id: 'hatch-bmw116i',
  name: 'BMW 116i (F20, хэтчбек)',
  description: '5-дверный хэтчбек, задний привод. Параметрическая модель без внешних файлов.',
  defaultColor: '#e6e9ec',
  zones: HATCH_ZONES,
  defaultMaintenance: BMW116I_MAINTENANCE,
  create: async (color) => (await import('../sedan/build')).buildSedan(BMW116I_SPEC, color),
};
