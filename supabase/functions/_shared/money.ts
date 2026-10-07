// Extração de valores em reais de frases em português.
// Regra de ouro: "R$ 1.500,00" é mil e quinhentos, nunca R$ 1,50.

import { norm } from "./text.ts";

const WORDS: Record<string, number> = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70,
  oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300,
  quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600,
  setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900,
};
const MULT: Record<string, number> = { mil: 1000, milhao: 1_000_000, milhoes: 1_000_000 };

export interface NumericParse {
  value: number;
  alt?: number; // interpretação alternativa quando o formato é ambíguo
}

/** Converte um número escrito com dígitos no padrão brasileiro. */
export function parseBRNumber(raw: string): NumericParse | null {
  const s = raw.trim();
  if (!/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) {
    // 1.500,00 (padrão BR) ou 1,500.00 (padrão EUA)
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) return { value: Number(s.replace(/\./g, "").replace(",", ".")) };
    return { value: Number(s.replace(/,/g, "")) };
  }
  if (s.includes(",")) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) {
      // "1,500": no Brasil seria 1,5 — mas pode ter sido digitado como mil e quinhentos
      return { value: Number(s.replace(",", ".")), alt: Number(s.replace(/,/g, "")) };
    }
    if (/^\d+,\d+$/.test(s)) return { value: Number(s.replace(",", ".")) };
    return null;
  }
  if (s.includes(".")) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return { value: Number(s.replace(/\./g, "")) }; // 1.500 / 1.500.000
    if (/^\d+\.\d{1,2}$/.test(s)) return { value: Number(s) };                    // 87.50
    return null;
  }
  return { value: Number(s) };
}

export type Tok = { t: string; i: number };

/** Quebra o texto (já normalizado) em tokens, preservando a posição. */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /r\$|\d[\d.,]*\d|\d|[a-z]+|[%/?º°]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ t: m[0], i: m.index });
  return out;
}

export interface AmountCandidate {
  value: number;
  alt?: number;
  start: number; // índice do token inicial
  end: number;   // índice do token final
  strength: number; // 3 = com "R$"/"reais", 2 = dígitos, 1 = por extenso
  role: "valor" | "parcelas" | "dia" | "outro";
}

const isNumWord = (t: string) => t in WORDS || t in MULT;
const isDigit = (t: string) => /^\d/.test(t);

function evalRun(tokens: string[]): NumericParse | null {
  let total = 0, cur = 0, alt: number | undefined, any = false;
  for (const t of tokens) {
    if (t === "e") continue;
    if (t in MULT) {
      total += (cur || 1) * MULT[t];
      cur = 0; any = true;
    } else if (t in WORDS) {
      cur += WORDS[t]; any = true;
    } else if (isDigit(t)) {
      const p = parseBRNumber(t);
      if (!p) return null;
      if (p.alt !== undefined) alt = p.alt;
      cur += p.value; any = true;
    } else return null;
  }
  if (!any) return null;
  const value = Math.round((total + cur) * 100) / 100;
  return { value, alt };
}

/** Encontra todos os números da frase e classifica o papel de cada um. */
export function findAmounts(text: string): AmountCandidate[] {
  const n = norm(text).replace(/(\d)\s*x\b/g, "$1 vezes").replace(/(\d)\s*k\b/g, "$1 mil");
  const toks = tokenize(n);
  const cands: AmountCandidate[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i].t;
    if (!(isDigit(t) || isNumWord(t))) { i++; continue; }
    // data numérica 06/10 ou 6/10/2026
    if (isDigit(t) && toks[i + 1]?.t === "/") { i += 2; while (toks[i] && (isDigit(toks[i].t) || toks[i].t === "/")) i++; continue; }
    let j = i;
    const run: string[] = [t];
    while (j + 1 < toks.length) {
      const nx = toks[j + 1].t;
      if (isNumWord(nx)) { run.push(nx); j++; continue; }            // "3 mil", "dois mil"
      if (nx === "e" && j + 2 < toks.length) {                         // "mil e quinhentos", "3 mil e 500"
        const after = toks[j + 2].t;
        if (isNumWord(after) || (isDigit(after) && run.some((r) => r in MULT))) { run.push("e", after); j += 2; continue; }
      }
      break;
    }
    // "um"/"uma" sozinhos são artigos ("uma TV"), não valores
    if (run.length === 1 && (t === "um" || t === "uma") && !/^(mil|real|reais)$/.test(toks[j + 1]?.t ?? "")) { i = j + 1; continue; }
    const parsed = evalRun(run);
    if (!parsed) { i = j + 1; continue; }
    const prev = toks[i - 1]?.t ?? "";
    const prev2 = toks[i - 2]?.t ?? "";
    const next = toks[j + 1]?.t ?? "";
    const next2 = toks[j + 2]?.t ?? "";
    let role: AmountCandidate["role"] = "valor";
    if (/^(vezes|parcelas|prestacoes|meses)$/.test(next)) role = "parcelas";
    else if (prev === "dia" || prev === "as" || prev === "ate" && prev2 === "dia") role = "dia";
    else if (next === "%" || next === "º" || next === "°" || /^(dia|dias|horas|h|anos|semanas|minutos)$/.test(next)) role = "outro";
    else if (/^(de|do)$/.test(next) && /^(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)$/.test(next2)) role = "dia";
    let strength = run.some(isDigit) ? 2 : 1;
    if (prev === "r$" || /^(reais|real|conto|contos|pila|pilas|mangos)$/.test(next)) strength = 3;
    cands.push({ value: parsed.value, alt: parsed.alt, start: i, end: j, strength, role });
    i = j + 1;
  }
  return cands;
}

export interface AmountResult {
  valor?: number;
  alternativas?: number[];
  parcelas?: number;
}

/** Escolhe o valor principal e o número de parcelas. */
export function extractAmount(text: string): AmountResult {
  const c = findAmounts(text);
  const res: AmountResult = {};
  const parc = c.find((x) => x.role === "parcelas");
  if (parc && Number.isInteger(parc.value) && parc.value >= 2 && parc.value <= 72) res.parcelas = parc.value;
  const vals = c.filter((x) => x.role === "valor" && x.value > 0);
  if (!vals.length) return res;
  const best = Math.max(...vals.map((v) => v.strength));
  const pick = vals.find((v) => v.strength === best)!;
  res.valor = pick.value;
  if (pick.alt !== undefined && pick.alt !== pick.value) res.alternativas = [pick.value, pick.alt];
  // dois valores fortes e diferentes na mesma frase ("150 ou 1500") -> ambíguo
  const strong = vals.filter((v) => v.strength === best && v.value !== pick.value);
  if (strong.length && /\bou\b/.test(norm(text))) res.alternativas = [pick.value, strong[0].value];
  return res;
}
