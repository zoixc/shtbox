export const fmtKm = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n).toLocaleString('ru-RU')} км`);
export const fmtMoney = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);

/** Разбор числа из поля ввода (принимает запятую и пробелы); пусто → undefined. */
export function parseNum(s: string): number | undefined {
  const t = s.replace(/\s/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV без формульных инъекций: ячейки, начинающиеся с = + - @, экранируются апострофом. */
export function csvCell(v: string | number | undefined): string {
  let s = v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
