import type { DiagnosticCode } from './types';

const DTC = /\b[PBCU][0-3][0-9A-F]{3}\b/i;
const CODE_HEADER = /^(code|dtc|dtccode|codedtc|troublecode|faultcode|enginecode|код|ошибка|коды)$/i;
const DESCRIPTION_HEADER = /^(description|text|message|описание|текст)$/i;
const MODULE_HEADER = /^(module|ecu|controlunit|модуль|блок)$/i;
const STATUS_HEADER = /^(status|state|статус|состояние)$/i;

function scalar(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}
function text(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
}
function normalize(item: unknown): DiagnosticCode | undefined {
  if (typeof item === 'string' || typeof item === 'number') {
    const raw = String(item);
    const code = raw.toUpperCase().match(DTC)?.[0];
    return code ? { code, description: '' } : undefined;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const o = item as Record<string, unknown>;
  const rawCode = scalar(o.code ?? o.dtc ?? o.troubleCode ?? o.faultCode ?? o.id);
  const code = rawCode.toUpperCase().match(DTC)?.[0];
  if (!code) return undefined;
  return {
    code,
    description: text(scalar(o.description ?? o.text ?? o.message ?? o.title), 500),
    module: text(scalar(o.module ?? o.ecu ?? o.controlUnit), 100) || undefined,
    status: text(scalar(o.status ?? o.state), 60) || undefined,
  };
}
function jsonRecords(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  for (const key of ['codes', 'dtcs', 'DTCs', 'troubleCodes', 'faultCodes', 'errors']) {
    if (Array.isArray(o[key])) return o[key] as unknown[];
  }
  if (o.results && Array.isArray(o.results)) return o.results;
  if (o.report && typeof o.report === 'object') return jsonRecords(o.report);
  if (o.code || o.dtc || o.troubleCode) return [o];
  return [];
}
function csvRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(value.trim()); value = '';
    } else value += ch;
  }
  out.push(value.trim());
  return out;
}
function csvRecords(raw: string): unknown[] {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 1001);
  if (!lines.length) return [];
  const first = lines[0];
  const delimiter = [';', ',', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const header = csvRow(first, delimiter).map((x) => x.toLowerCase().replace(/[\s_-]/g, ''));
  const codeIndex = header.findIndex((x) => CODE_HEADER.test(x));
  if (codeIndex >= 0) {
    const descriptionIndex = header.findIndex((x) => DESCRIPTION_HEADER.test(x));
    const moduleIndex = header.findIndex((x) => MODULE_HEADER.test(x));
    const statusIndex = header.findIndex((x) => STATUS_HEADER.test(x));
    return lines.slice(1).map((line) => {
      const cells = csvRow(line, delimiter);
      return {
        code: cells[codeIndex],
        description: descriptionIndex < 0 ? '' : cells[descriptionIndex],
        module: moduleIndex < 0 ? '' : cells[moduleIndex],
        status: statusIndex < 0 ? '' : cells[statusIndex],
      };
    });
  }
  return lines.map((line) => {
    const code = line.toUpperCase().match(DTC)?.[0];
    if (!code) return undefined;
    const cells = csvRow(line, delimiter);
    const codeCell = cells.findIndex((x) => DTC.test(x.toUpperCase()));
    return { code, description: cells.filter((_, i) => i !== codeCell).join(' · ') };
  }).filter(Boolean);
}

/**
 * Parses a small, common subset of JSON/CSV OBD exports. The result contains only
 * report codes and source-provided labels; it deliberately does not infer diagnoses.
 */
export function parseObdReport(raw: string, fileName = 'OBD report'): DiagnosticCode[] {
  if (raw.length > 5 * 1024 * 1024) throw new Error('OBD-файл слишком большой (максимум 5 МБ).');
  let records: unknown[] = [];
  const source = raw.trim();
  if (!source) throw new Error('Файл OBD-отчёта пуст.');
  if (source.startsWith('{') || source.startsWith('[')) {
    try { records = jsonRecords(JSON.parse(source)); }
    catch { throw new Error('Некорректный JSON в OBD-отчёте.'); }
  } else records = csvRecords(source);

  const unique = new Map<string, DiagnosticCode>();
  for (const record of records) {
    const code = normalize(record);
    if (!code) continue;
    const key = `${code.code}|${code.module ?? ''}|${code.status ?? ''}`;
    if (!unique.has(key)) unique.set(key, code);
    if (unique.size >= 100) break;
  }
  if (!unique.size) throw new Error(`В «${text(fileName, 120)}» не найдено кодов OBD-II (например, P0420). Поддерживаются JSON и CSV с полем code/DTC.`);
  return [...unique.values()];
}
