// Mercado: indicadores do Banco Central, simulações e a trava de NÃO recomendar investimentos.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { fakeMarketFetch } from "../dev/fake_market.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { ensureMarket, fetchSeries } from "../supabase/functions/_shared/mercado.ts";
import { classifyInvest, parseSimulation, looksLikeAdvice } from "../supabase/functions/_shared/invest.ts";
// @ts-ignore
import { simular, irAliquota, PRODUTOS } from "../web/js/simulador.js";

const db = localEngine();
let user = "";
const calls: string[] = [];
const mf = fakeMarketFetch({ calls });
const say = (text: string) => handleMessage({ user_id: user, channel: "app", type: "text", content: text, timestamp: new Date().toISOString() }, { db, marketFetch: mf });
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];

beforeAll(async () => {
  [{ id: user }] = await q(`insert into auth.users(email) values ('mercado' || gen_random_uuid() || '@x.com') returning id`);
  await q(`update market_meta set updated_at = now() - interval '1 day'`);
});

describe("indicadores", () => {
  test("lê o formato do SGS", async () => {
    const r = await fetchSeries(195, 30, mf);
    expect(r[0].data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r[0].data_fim).toBeDefined();
  });
  test("busca quando está velho e guarda; depois usa o que está salvo", async () => {
    calls.length = 0;
    const m = await ensureMarket(db, user, mf);
    expect(calls.length).toBe(9);
    expect(m.indicadores.selic.valor).toBe(15);
    expect(m.indicadores.dolar.historico.length).toBeGreaterThan(10);
    expect(m.desatualizado).toBe(false);
    calls.length = 0;
    await ensureMarket(db, user, mf);
    expect(calls.length).toBe(0);
  });
  test("se o Banco Central falhar, mantém os últimos valores", async () => {
    await q(`update market_meta set updated_at = now() - interval '1 day'`);
    const m = await ensureMarket(db, user, fakeMarketFetch({ fail: [432, 4389, 13522, 433, 189, 195, 226, 1, 21619] }));
    expect(m.indicadores.cdi.valor).toBe(14.9);
  });
});

describe("simulador", () => {
  const ind = { selic: 15, cdi: 14.9, ipca12: 5, poupanca_mes: 0.62, tr_mes: 0.17 };
  test("IR regressivo", () => {
    expect(irAliquota(100)).toBe(0.225); expect(irAliquota(360)).toBe(0.2); expect(irAliquota(700)).toBe(0.175); expect(irAliquota(800)).toBe(0.15);
  });
  test("CDB 100% do CDI, 10 mil por 12 meses", () => {
    const r = simular({ inicial: 10000, meses: 12, produto: { ...PRODUTOS.cdb, pct: 100 }, ind });
    expect(r.bruto_cents).toBe(1149000);                 // 14,9% a.a.
    expect(r.ir_cents).toBe(Math.round(149000 * 0.2));   // 360 dias: 20%
    expect(r.liquido_cents).toBe(1149000 - 29800);
  });
  test("LCI é isenta; poupança usa a taxa do mês", () => {
    expect(simular({ inicial: 1000, meses: 12, produto: PRODUTOS.lci, ind }).ir_cents).toBe(0);
    const p = simular({ inicial: 1000, meses: 1, produto: PRODUTOS.poupanca, ind });
    expect(p.liquido_cents).toBe(100620);
  });
  test("aportes mensais contam IR por aporte", () => {
    const r = simular({ inicial: 0, mensal: 100, meses: 24, produto: PRODUTOS.cdb, ind });
    expect(r.investido_cents).toBe(240000);
    expect(r.ir_cents).toBeGreaterThan(0);
  });
});

describe("entende o pedido", () => {
  test("simulação com percentual, prazo e aporte", () => {
    const p = parseSimulation("quanto rende 10 mil no CDB 110% do CDI em 2 anos com 500 por mês?");
    expect(p.inicial).toBe(10000); expect(p.aporte).toBe(500); expect(p.meses).toBe(24);
    expect(p.produtos[0].pct).toBe(110);
  });
  test("compara vários produtos", () => {
    const p = parseSimulation("simule 5 mil por 18 meses na poupança, LCI 95% do CDI e tesouro selic");
    expect(p.produtos.map((x: any) => x.tipo)).toEqual(["poupanca", "cdi", "selic"]);
    expect(p.produtos[1].pct).toBe(95); expect(p.meses).toBe(18);
  });
  const casos: [string, string | null][] = [
    ["qual a selic hoje?", "indicators"], ["quanto está o dólar?", "indicators"], ["indicadores", "indicators"],
    ["onde devo investir meu dinheiro?", "advice"], ["qual o melhor investimento?", "advice"], ["vale a pena comprar dólar?", "advice"],
    ["devo vender minhas ações?", "advice"], ["o dólar vai subir?", "advice"], ["me recomenda um CDB", "advice"],
    ["o que é LCI?", "explain"], ["qual a diferença entre CDB e LCI?", "explain"],
    ["quanto rende 1000 na poupança?", "simulate"],
    ["quanto tenho na poupança?", null], ["quanto gastei este mês?", null], ["gastei 50 no mercado", null],
  ];
  for (const [t, k] of casos) test(t, () => expect(classifyInvest(t)).toBe(k));
});

describe("NUNCA recomenda", () => {
  test("pedido de recomendação recebe informação, não escolha", async () => {
    for (const t of ["onde devo investir 10 mil?", "qual o melhor investimento para mim?", "vale a pena colocar dinheiro no tesouro?"]) {
      const r = await say(t);
      expect(r.reply).toContain("não recomendo");
      expect(r.reply).toContain("decisão é sempre sua");
      expect(looksLikeAdvice(r.reply)).toBe(false);
    }
  });
  test("simulação mostra números e o aviso, sem eleger vencedor", async () => {
    const r = await say("simule 10 mil por 1 ano na poupança e no CDB 100% do CDI");
    expect(r.reply).toContain("Poupança");
    expect(r.reply).toContain("CDB 100% do CDI");
    expect(r.reply).toContain("não é recomendação");
    expect(r.reply).not.toMatch(/melhor|vale mais a pena|recomendo/i);
  });
  test("indicadores com fonte", async () => {
    const r = await say("qual a selic e o dólar hoje?");
    expect(r.reply).toContain("Selic");
    expect(r.reply).toContain("Banco Central");
  });
  test("trava detecta recomendação na resposta da IA", () => {
    expect(looksLikeAdvice("Eu recomendo o CDB do banco X.")).toBe(true);
    expect(looksLikeAdvice("A melhor opção para você é a LCI.")).toBe(true);
    expect(looksLikeAdvice("Você deveria investir no Tesouro.")).toBe(true);
    expect(looksLikeAdvice("O CDB rende 14,9% ao ano e tem garantia do FGC.")).toBe(false);
  });
  test("lançamentos de investimento continuam funcionando", async () => {
    const r = await say("investi 1000 no cdb");
    expect(r.reply).not.toContain("não recomendo");
  });
});
