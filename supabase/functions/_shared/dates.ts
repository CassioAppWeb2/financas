// Datas relativas em português, sempre no fuso America/Sao_Paulo.
import { norm } from "./text.ts";

export const TZ = "America/Sao_Paulo";

export function todayISO(now = new Date(), tz = TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Manipulação de datas "puras" (sem hora) usando UTC para não sofrer com fuso.
export function toDate(iso: string): Date { return new Date(iso.slice(0, 10) + "T12:00:00Z"); }
export function iso(d: Date): string { return d.toISOString().slice(0, 10); }
export function addDays(isoDate: string, n: number): string { const d = toDate(isoDate); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
export function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function addMonths(isoDate: string, n: number): string {
  const d = toDate(isoDate);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m, 1, 12));
  const dim = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
  target.setUTCDate(Math.min(day, dim));
  return iso(target);
}
export function startOfMonth(isoDate: string): string { return isoDate.slice(0, 8) + "01"; }
export function endOfMonth(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4)), m = Number(isoDate.slice(5, 7));
  return `${isoDate.slice(0, 8)}${String(daysInMonth(y, m)).padStart(2, "0")}`;
}
export function weekday(isoDate: string): number { return toDate(isoDate).getUTCDay(); } // 0 = domingo

/** n-ésimo dia útil (seg-sex) do mês da data informada. Feriados não são considerados. */
export function nthBusinessDay(isoDate: string, n: number): string {
  let d = startOfMonth(isoDate), count = 0;
  for (let i = 0; i < 31; i++) {
    const wd = weekday(d);
    if (wd !== 0 && wd !== 6) { count++; if (count === n) return d; }
    d = addDays(d, 1);
  }
  return d;
}

const WEEKDAYS: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const ORD: Record<string, number> = { primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6, setimo: 7, oitavo: 8, nono: 9, decimo: 10 };

export interface DateResult { data: string; explicita: boolean; }

/**
 * Data de um lançamento. Sem menção de data, usa hoje.
 * passado=true: "dia 10" quando hoje é dia 6 significa dia 10 do mês passado.
 */
export function resolveDate(text: string, today: string, passado = true): DateResult {
  const n = norm(text);
  if (/\banteontem\b/.test(n)) return { data: addDays(today, -2), explicita: true };
  if (/\bontem\b/.test(n)) return { data: addDays(today, -1), explicita: true };
  if (/\bamanha\b/.test(n)) return { data: addDays(today, 1), explicita: true };
  if (/\bhoje\b/.test(n)) return { data: today, explicita: true };

  let m = n.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : Number(today.slice(0, 4));
    if (!m[3] && passado && `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` > today) y -= 1;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
      return { data: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, explicita: true };
    }
  }

  m = n.match(/\bdia (\d{1,2})(?: de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro))?\b/);
  if (m) {
    const d = Number(m[1]);
    let y = Number(today.slice(0, 4)), mo = m[2] ? MONTHS[m[2]] : Number(today.slice(5, 7));
    let cand = `${y}-${String(mo).padStart(2, "0")}-${String(Math.min(d, daysInMonth(y, mo))).padStart(2, "0")}`;
    if (passado && cand > today) {
      if (m[2]) y -= 1; else { const prev = addMonths(startOfMonth(today), -1); y = Number(prev.slice(0, 4)); mo = Number(prev.slice(5, 7)); }
      cand = `${y}-${String(mo).padStart(2, "0")}-${String(Math.min(d, daysInMonth(y, mo))).padStart(2, "0")}`;
    }
    if (d >= 1 && d <= 31) return { data: cand, explicita: true };
  }

  m = n.match(/\b(proxim[oa]|ultim[oa]|nest[ea]|ness[ea]|n?[oa])?\s*(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira| feira)?\s*(passad[oa]|que vem)?\b/);
  if (m && !/\bquint[oa] dia util\b/.test(n)) {
    const target = WEEKDAYS[m[2]];
    const wd = weekday(today);
    const futuro = /proxim/.test(m[1] ?? "") || m[3] === "que vem" || !passado;
    let diff: number;
    if (futuro) { diff = (target - wd + 7) % 7; if (diff === 0) diff = 7; }
    else { diff = -((wd - target + 7) % 7); if (diff === 0 && (/passad|ultim/.test(m[3] ?? m[1] ?? ""))) diff = -7; }
    return { data: addDays(today, diff), explicita: true };
  }

  if (/\bsemana passada\b/.test(n)) return { data: addDays(today, -7), explicita: true };
  if (/\bmes passado\b/.test(n)) return { data: addMonths(today, -1), explicita: true };
  if (/\bproximo mes\b|\bmes que vem\b/.test(n)) return { data: addMonths(today, 1), explicita: true };

  m = n.match(/\b(primeiro|segundo|terceiro|quarto|quinto|sexto|setimo|oitavo|nono|decimo|\d{1,2}[oº]?) dia util\b/);
  if (m) {
    const k = ORD[m[1]] ?? parseInt(m[1]);
    let d = nthBusinessDay(today, k);
    if (!passado && d < today) d = nthBusinessDay(addMonths(startOfMonth(today), 1), k);
    return { data: d, explicita: true };
  }
  return { data: today, explicita: false };
}

export interface Period { inicio: string; fim: string; label: string; }

/** Período de uma consulta. Padrão: mês atual. */
export function resolvePeriod(text: string, today: string): Period {
  const n = norm(text);
  if (/\banteontem\b/.test(n)) { const d = addDays(today, -2); return { inicio: d, fim: d, label: "anteontem" }; }
  if (/\bontem\b/.test(n)) { const d = addDays(today, -1); return { inicio: d, fim: d, label: "ontem" }; }
  if (/\bhoje\b/.test(n) && !/\bate hoje\b/.test(n)) return { inicio: today, fim: today, label: "hoje" };
  const wd = weekday(today);
  const monday = addDays(today, -((wd + 6) % 7));
  if (/\bsemana passada\b/.test(n)) return { inicio: addDays(monday, -7), fim: addDays(monday, -1), label: "na semana passada" };
  if (/\b(nesta|nessa|esta|essa|da) semana\b/.test(n)) return { inicio: monday, fim: today, label: "nesta semana" };
  if (/\bultimos? (\d+) dias\b/.test(n)) {
    const k = Number(n.match(/\bultimos? (\d+) dias\b/)![1]);
    return { inicio: addDays(today, -(k - 1)), fim: today, label: `nos últimos ${k} dias` };
  }
  if (/\bmes passado\b|\bmes anterior\b|\bultimo mes\b/.test(n)) {
    const s = addMonths(startOfMonth(today), -1);
    return { inicio: s, fim: endOfMonth(s), label: "no mês passado" };
  }
  if (/\bproximo mes\b|\bmes que vem\b/.test(n)) {
    const s = addMonths(startOfMonth(today), 1);
    return { inicio: s, fim: endOfMonth(s), label: "no próximo mês" };
  }
  if (/\bano passado\b/.test(n)) {
    const y = Number(today.slice(0, 4)) - 1;
    return { inicio: `${y}-01-01`, fim: `${y}-12-31`, label: `em ${y}` };
  }
  if (/\b(neste|nesse|este|esse|no) ano\b/.test(n)) {
    const y = today.slice(0, 4);
    return { inicio: `${y}-01-01`, fim: `${y}-12-31`, label: "neste ano" };
  }
  const mm = n.match(/\b(?:em|de|no mes de)\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?: de (\d{4}))?\b/);
  if (mm) {
    const mo = MONTHS[mm[1]];
    let y = mm[2] ? Number(mm[2]) : Number(today.slice(0, 4));
    if (!mm[2] && mo > Number(today.slice(5, 7))) y -= 1;
    const s = `${y}-${String(mo).padStart(2, "0")}-01`;
    return { inicio: s, fim: endOfMonth(s), label: `em ${mm[1] === "marco" ? "março" : mm[1]}` };
  }
  const s = startOfMonth(today);
  return { inicio: s, fim: endOfMonth(s), label: "neste mês" };
}
