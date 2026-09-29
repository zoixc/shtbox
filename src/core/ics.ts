import { dueInfo } from './maintenance';
import type { Car, DateStr, MaintenanceTask } from './types';

/** Экранирование TEXT по RFC 5545 (в т.ч. защита от инъекции строк календаря через \r\n). */
export function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Складывает строки длиннее 75 октетов (RFC 5545 §3.1), не разрывая UTF-8 символы. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // продолжение начинается с пробела
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const compact = (d: DateStr) => d.replace(/-/g, '');
const nextDay = (d: DateStr): DateStr => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/**
 * Календарь (.ics) с ближайшими датами регламентных работ: по одному событию на работу
 * (для тех, у кого есть срок по времени), напоминание за 7 дней. Работы, ограниченные
 * только пробегом, не выгружаются — у них нет даты; для остальных пробег указан в описании.
 */
export function buildIcs(car: Pick<Car, 'name' | 'mileage'>, tasks: MaintenanceTask[], today: DateStr, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const L: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ShtBox//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(`ТО: ${car.name}`)}`];
  let count = 0;
  for (const t of tasks) {
    const d = dueInfo(t, car.mileage, today);
    if (!d.nextDate) continue;
    count++;
    const desc = [
      d.nextKm !== undefined ? `Следующее ТО по пробегу: ${d.nextKm} км (сейчас ${car.mileage} км)` : '',
      t.notes,
    ].filter(Boolean).join('\n');
    L.push(
      'BEGIN:VEVENT',
      `UID:${t.id.replace(/[^\w-]/g, '')}@shtbox`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(d.nextDate)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(d.nextDate))}`,
      `SUMMARY:${icsText(`${car.name}: ${t.title}`)}`,
      ...(desc ? [`DESCRIPTION:${icsText(desc)}`] : []),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(t.title)}`,
      'TRIGGER:-P7D',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  L.push('END:VCALENDAR');
  return count ? L.map(foldLine).join('\r\n') + '\r\n' : '';
}
