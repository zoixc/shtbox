import type { ZoneDef } from '../models/types';
import { SEDAN_ZONES } from '../models/sedan/solaris';
import type { BodyType } from './types';

/** Набор узлов для типа кузова и расположения двигателя. */
export function zonesFor(body: BodyType, layout: 'front' | 'rear'): ZoneDef[] {
  let zs = SEDAN_ZONES.map((z) => ({ ...z }));
  if (body === 'hatch') zs = zs.filter((z) => z.id !== 'rear_glass').map((z) => (z.id === 'trunk' ? { ...z, label: 'Задняя дверь (багажник)' } : z));
  if (body === 'coupe') zs = zs.filter((z) => z.id !== 'door_rl' && z.id !== 'door_rr').map((z) => (z.id.startsWith('door_f') ? { ...z, label: z.id === 'door_fl' ? 'Дверь левая' : 'Дверь правая' } : z));
  if (layout === 'rear') {
    return zs.map((z) => {
      if (z.id === 'hood') return { ...z, label: 'Капот (передний багажник)' };
      if (z.id === 'trunk') return { ...z, label: 'Крышка моторного отсека' };
      if (z.id === 'engine_bay') return { ...z, requiresOpen: 'trunk' };
      if (z.id === 'trunk_bay') return { ...z, label: 'Передний багажник', requiresOpen: 'hood' };
      return z;
    });
  }
  return zs;
}

/** Направление «наружу» для бейджей узла (система автомобиля). */
export function facingOf(zone: string, body: BodyType): [number, number, number] | undefined {
  if (zone === 'hood' || zone === 'roof') return [0, 1, 0];
  if (zone === 'trunk') return body === 'hatch' ? [-1, 0.5, 0] : [0, 1, 0];
  if (zone === 'bumper_f' || zone === 'lights_f') return [1, 0, 0];
  if (zone === 'bumper_r' || zone === 'lights_r') return [-1, 0, 0];
  if (zone === 'windshield') return [1, 0.6, 0];
  if (zone === 'rear_glass') return [-1, 0.6, 0];
  if (/_(fl|rl)$|^sill_l$/.test(zone)) return [0, 0, -1];
  if (/_(fr|rr)$|^sill_r$/.test(zone)) return [0, 0, 1];
  return undefined;
}
