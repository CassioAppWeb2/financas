// Indicadores do mercado: busca no Banco Central (SGS, gratuito e sem cadastro) e grava no banco.
// Atualiza "sob demanda": quando alguém abre a tela Mercado ou pergunta ao assistente e os dados
// têm mais de 6 horas. Assim fica sempre atualizado sem precisar de agendador.

import type { EngineDb } from "./types.ts";

export const SERIES: { code: string; sgs: number; dias: number }[] = [
  { code: "selic", sgs: 432, dias: 400 },      // Meta Selic definida pelo Copom (% a.a.)
  { code: "cdi", sgs: 4389, dias: 400 },       // CDI anualizado base 252 (% a.a.)
  { code: "ipca_12m", sgs: 13522, dias: 420 }, // IPCA acumulado em 12 meses (%)
  { code: "ipca_mes", sgs: 433, dias: 420 },   // IPCA variação mensal (%)
  { code: "igpm_mes", sgs: 189, dias: 420 },   // IGP-M variação mensal (%)
  { code: "poupanca", sgs: 195, dias: 400 },   // Poupança: rentabilidade no período (% a.m.)
  { code: "tr", sgs: 226, dias: 400 },         // TR (% a.m.)
  { code: "dolar", sgs: 1, dias: 120 },        // Dólar comercial venda (R$)
  { code: "euro", sgs: 21619, dias: 120 },     // Euro venda (R$)
];

export interface Indicador { nome: string; unidade: string; valor: number; data: string; data_fim?: string | null; anterior?: number | null; historico: { data: string; valor: number }[] }
export interface Mercado { fonte: string; atualizado_em: string | null; desatualizado: boolean; indicadores: Record<string, Indicador> }

const br = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const iso = (dmy: string) => { const [d, m, y] = dmy.split("/"); return `${y}-${m}-${d}`; };

/** Lê uma série do SGS: [{data, valor, data_fim?}] em formato ISO. */
export async function fetchSeries(sgs: number, dias: number, f: typeof fetch = fetch, hoje = new Date()): Promise<{ data: string; valor: string; data_fim?: string }[]> {
  const ini = new Date(hoje.getTime() - dias * 86400_000);
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${sgs}/dados?formato=json&dataInicial=${br(ini)}&dataFinal=${br(new Date(hoje.getTime() + 60 * 86400_000))}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await f(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`SGS ${sgs}: ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error(`SGS ${sgs}: resposta inesperada`);
    return arr.filter((x: any) => x?.data && x?.valor !== undefined && x.valor !== "")
      .map((x: any) => ({ data: iso(x.data), valor: String(x.valor).trim(), ...(x.dataFim ? { data_fim: iso(x.dataFim) } : {}) }));
  } finally { clearTimeout(t); }
}

/** Busca todas as séries (em paralelo) e grava. Séries que falharem ficam com o último valor salvo. */
export async function refreshMarket(db: EngineDb, user: string, f: typeof fetch = fetch): Promise<number> {
  const res = await Promise.allSettled(SERIES.map(async (s) => ({ code: s.code, pontos: await fetchSeries(s.sgs, s.dias, f) })));
  const series = res.filter((r): r is PromiseFulfilledResult<{ code: string; pontos: any[] }> => r.status === "fulfilled" && r.value.pontos.length > 0).map((r) => r.value);
  res.filter((r) => r.status === "rejected").forEach((r) => console.warn("mercado:", (r as PromiseRejectedResult).reason?.message));
  if (series.length) await db.rpc("fe_market_save", user, { series });
  return series.length;
}

/** Dados do mercado, atualizando antes se estiverem velhos. */
export async function ensureMarket(db: EngineDb, user: string, f: typeof fetch = fetch, force = false): Promise<Mercado> {
  let m = await db.rpc<Mercado>("fe_market", user, {});
  if (force || m.desatualizado || !Object.keys(m.indicadores ?? {}).length) {
    try { if (await refreshMarket(db, user, f)) m = await db.rpc<Mercado>("fe_market", user, {}); }
    catch (e) { console.warn("mercado: não atualizou:", (e as Error).message); }
  }
  for (const k of Object.keys(m.indicadores ?? {})) {
    const x = m.indicadores[k];
    x.valor = Number(x.valor);
    if (x.anterior !== null && x.anterior !== undefined) x.anterior = Number(x.anterior);
    x.historico = (x.historico ?? []).map((h) => ({ data: h.data, valor: Number(h.valor) }));
  }
  return m;
}

/** Valores que o simulador usa. */
export function simInputs(m: Mercado) {
  const v = (k: string) => (m.indicadores?.[k]?.valor ?? null) as number | null;
  return { selic: v("selic"), cdi: v("cdi"), ipca12: v("ipca_12m"), poupanca_mes: v("poupanca"), tr_mes: v("tr") };
}
