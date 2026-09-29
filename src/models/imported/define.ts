/** Описание моделей, собранных из пакета (лёгкий модуль: тяжёлая сборка подгружается при создании). */
import { zonesFor } from '../../import/zoneset';
import type { Profile } from '../../import/types';
import type { CarModelDef, TaskTemplate } from '../types';

export const GENERIC_MAINTENANCE: TaskTemplate[] = [
  { zoneId: 'engine', title: 'Замена моторного масла и масляного фильтра', everyKm: 10000, everyMonths: 12, notes: 'Ориентир — уточняйте по сервисной книжке вашего автомобиля.' },
  { zoneId: 'engine', title: 'Воздушный фильтр двигателя', everyKm: 20000, everyMonths: 24 },
  { zoneId: 'engine', title: 'Свечи зажигания', everyKm: 40000, everyMonths: 48 },
  { zoneId: 'cooling', title: 'Замена охлаждающей жидкости', everyKm: 90000, everyMonths: 48 },
  { zoneId: 'gearbox', title: 'Замена масла в КПП', everyKm: 60000, everyMonths: 60 },
  { zoneId: 'brakes_f', title: 'Передние колодки и диски: осмотр', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'brakes_r', title: 'Задние колодки и диски: осмотр', everyKm: 30000, everyMonths: 24 },
  { zoneId: 'general', title: 'Замена тормозной жидкости', everyMonths: 24 },
  { zoneId: 'susp_f', title: 'Диагностика подвески и рулевого', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'battery', title: 'Проверка аккумулятора и клемм', everyMonths: 12 },
  { zoneId: 'wheel_fl', title: 'Ротация колёс / шиномонтаж (сезонная смена)', everyMonths: 6 },
  { zoneId: 'floor', title: 'Салонный фильтр', everyKm: 15000, everyMonths: 12 },
  { zoneId: 'general', title: 'Антикор / обработка кузова', everyMonths: 24 },
];

/** Описание модели в реестре. `load` отдаёт байты пакета (из /models/ или из IndexedDB). */
export function defineImportedModel(d: {
  id: string;
  name: string;
  description: string;
  shape: Pick<Profile, 'body' | 'layout'>;
  /** если задан — используется вместо разметки из файла (правки пользователя) */
  profile?: Profile;
  defaultColor?: string;
  maintenance?: TaskTemplate[];
  load: () => Promise<ArrayBuffer>;
}): CarModelDef {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    defaultColor: d.defaultColor ?? '#b9bec6',
    zones: zonesFor(d.shape.body, d.shape.layout),
    defaultMaintenance: d.maintenance ?? GENERIC_MAINTENANCE,
    create: async (color) => {
      const { parsePackage, createImportedRig } = await import('./index');
      const pkg = await parsePackage(await d.load());
      return createImportedRig(pkg.scene, d.profile ?? pkg.profile, color);
    },
  };
}
