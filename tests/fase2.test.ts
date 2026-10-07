// Fase 2: cartões e faturas, recorrências, metas, orçamentos, alertas, relatórios e importação.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";

const db = localEngine();
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];
const fe = <T = any>(fn: string, uid: string, p: object = {}) => db.rpc<T>(fn, uid, p as Record<string, unknown>);
const asUser = <T = any>(uid: string, fn: string, p: object = {}) =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await tx.unsafe(`set local role authenticated`);
    return ((await tx.unsafe(`select to_jsonb(public.${fn}($1::jsonb)) r`, [p])) as any)[0].r as T;
  });
const newUser = async (name: string) =>
  (await q(`insert into auth.users(email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
    `${name}.${crypto.randomUUID()}@x.com`, { name }))[0].id as string;
const d = (s: string) => s; // datas ISO
let u = "", hoje = "";
const addDays = (iso: string, n: number) => { const x = new Date(iso + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

beforeAll(async () => {
  u = await newUser("Cartões");
  hoje = (await q(`select fe_today($1)::text t`, u))[0].t;
});

describe("cálculo de fatura", () => {
  test("vencimento depois do fechamento (fecha 5, vence 12)", async () => {
    const { id } = await fe("fe_save_card", u, { nome: "Nubank", fechamento: 5, vencimento: 12, limite: 5000 });
    const due = async (dt: string) => (await q(`select fe_invoice_due($1, $2::date)::text v`, id, dt))[0].v;
    expect(await due("2026-10-03")).toBe("2026-10-12");
    expect(await due("2026-10-04")).toBe("2026-10-12");
    expect(await due("2026-10-05")).toBe("2026-11-12");   // no dia do fechamento já vai para a próxima
    expect(await due("2026-12-20")).toBe("2027-01-12");
  });
  test("vencimento antes do fechamento (fecha 28, vence 5 do mês seguinte)", async () => {
    const { id } = await fe("fe_save_card", u, { nome: "Itaú Visa", banco: "Itaú", fechamento: 28, vencimento: 5 });
    const due = async (dt: string) => (await q(`select fe_invoice_due($1, $2::date)::text v`, id, dt))[0].v;
    expect(await due("2026-10-10")).toBe("2026-11-05");
    expect(await due("2026-10-28")).toBe("2026-12-05");
    expect(await due("2027-02-27")).toBe("2027-03-05");   // fevereiro: fecha no dia 28
  });
});

describe("compras no cartão", () => {
  test("compra no cartão não mexe no saldo da conta e entra na fatura", async () => {
    const antes = (await fe("fe_balances", u)).total_cents;
    const r = await fe("fe_create_transaction", u, { tipo: "despesa", valor: 300, categoria: "Lazer", cartao: "nubank", descricao: "Show" });
    expect(r.status).toBe("created");
    expect(r.cartao).toBe("Nubank");
    expect(r.lancamento.cartao).toBe("Nubank");
    expect(r.lancamento.fatura_vencimento).toBeTruthy();
    expect((await fe("fe_balances", u)).total_cents).toBe(antes);
    expect(r.limite_disponivel_cents).toBe(500000 - 30000);
  });

  test("TV de 3.000 em 10 vezes: 10 parcelas em 10 faturas seguidas", async () => {
    const r = await fe("fe_create_transaction", u, { tipo: "despesa", valor: 3000, parcelas: 10, categoria: "Outros", cartao: "Nubank", descricao: "TV" });
    expect(r.parcelas).toBe(10);
    const rows = await q(`select invoice_due::text due, amount_cents::int v from transactions where installment_group = (select installment_group from transactions where id = $1) order by installment_number`, r.ids[0]);
    expect(rows.length).toBe(10);
    expect(rows.every((x) => x.v === 30000)).toBe(true);
    const meses = rows.map((x) => x.due.slice(0, 7));
    expect(new Set(meses).size).toBe(10);
  });

  test("com mais de um cartão, \"no cartão\" pergunta qual", async () => {
    const r = await fe("fe_create_transaction", u, { tipo: "despesa", valor: 40, categoria: "Lazer", forma_pagamento: "credito" });
    expect(r.status).toBe("needs_card");
    expect(r.cartoes).toContain("Nubank");
  });

  test("lista de cartões mostra fatura atual, limite usado e próximas faturas", async () => {
    const cards = await fe("fe_cards", u);
    const nu = cards.find((c: any) => c.nome === "Nubank");
    expect(nu.usado_cents).toBe(30000 + 300000);
    expect(nu.disponivel_cents).toBe(500000 - 330000);
    expect(nu.proximas.length).toBeGreaterThan(5);
  });

  test("pagar fatura: sai da conta, não conta como despesa e a fatura fica paga", async () => {
    const nu = (await fe("fe_cards", u)).find((c: any) => c.nome === "Nubank");
    const due = nu.fatura_atual.vencimento;
    const total = nu.fatura_atual.total_cents;
    const saldoAntes = (await fe("fe_balances", u)).total_cents;
    const despAntes = (await fe("fe_period_totals", u, { tipo: "despesa", inicio: "2000-01-01", fim: "2100-01-01" })).total_cents;
    const r = await fe("fe_pay_invoice", u, { cartao: "nubank", vencimento: due });
    expect(r.status).toBe("paid");
    expect(r.valor_cents).toBe(total);
    expect(r.fatura.situacao).toBe("paga");
    expect((await fe("fe_balances", u)).total_cents).toBe(saldoAntes - total);
    expect((await fe("fe_period_totals", u, { tipo: "despesa", inicio: "2000-01-01", fim: "2100-01-01" })).total_cents).toBe(despAntes);
  });

  test("quanto posso gastar considera faturas a vencer no mês", async () => {
    const a = await fe("fe_available", u);
    expect(a).toHaveProperty("faturas_cents");
  });
});

describe("recorrências", () => {
  test("internet R$ 120 todo dia 10: gera os lançamentos até o fim do próximo mês", async () => {
    const r = await fe("fe_save_recurring", u, { tipo: "despesa", valor: 120, descricao: "Internet", categoria: "Moradia", subcategoria: "Internet", dia: 10 });
    expect(r.status).toBe("saved");
    expect(r.recorrencia.quando).toBe("todo dia 10");
    const rows = await q(`select date::text d, origin from transactions where recurring_id = $1 and deleted_at is null order by date`, r.recorrencia.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((x) => x.d.endsWith("-10") && x.origin === "recorrencia")).toBe(true);
    // rodar de novo não duplica
    await q(`select fe_run_recurring(fe_owner($1))`, u);
    const again = await q(`select count(*)::int n from transactions where recurring_id = $1 and deleted_at is null`, r.recorrencia.id);
    expect(again[0].n).toBe(rows.length);
  });

  test("salário no 5º dia útil", async () => {
    const r = await fe("fe_save_recurring", u, { tipo: "receita", valor: 7000, descricao: "Salário", categoria: "Salário", dia_util: 5 });
    expect(r.recorrencia.quando).toBe("todo 5º dia útil");
    expect((await q(`select fe_business_day('2026-11-01', 5)::text v`))[0].v).toBe("2026-11-06");
    expect((await q(`select fe_business_day('2026-10-01', 5)::text v`))[0].v).toBe("2026-10-07");
  });

  test("alterar valor refaz só o futuro; encerrar remove só o futuro", async () => {
    const { recorrencias } = { recorrencias: (await fe("fe_recurrings", u)).itens };
    const net = recorrencias.find((x: any) => x.descricao === "Internet");
    await fe("fe_save_recurring", u, { id: net.id, tipo: "despesa", valor: 130, descricao: "Internet", categoria: "Moradia", dia: 10 });
    const fut = await q(`select amount_cents::int v from transactions where recurring_id = $1 and deleted_at is null and date > $2::date`, net.id, hoje);
    expect(fut.every((x) => x.v === 13000)).toBe(true);
    const c = await fe("fe_cancel_recurring", u, { id: net.id });
    expect(c.status).toBe("cancelled");
    const after = await q(`select count(*)::int n from transactions where recurring_id = $1 and deleted_at is null and date > $2::date`, net.id, hoje);
    expect(after[0].n).toBe(0);
  });

  test("recorrência no cartão vai para a fatura", async () => {
    const r = await fe("fe_save_recurring", u, { tipo: "despesa", valor: 55.9, descricao: "Netflix", categoria: "Lazer", cartao: "Nubank", dia: 15 });
    const rows = await q(`select card_id, invoice_due from transactions where recurring_id = $1`, r.recorrencia.id);
    expect(rows.every((x) => x.card_id && x.invoice_due)).toBe(true);
  });
});

describe("metas", () => {
  test("quero juntar 20 mil em 10 meses: calcula por mês, por semana e progresso", async () => {
    const prazo = addDays(hoje, 304);
    const r = await fe("fe_save_goal", u, { nome: "Reserva", valor: 20000, prazo });
    expect(r.meta.falta_cents).toBe(2000000);
    expect(r.meta.por_mes_cents).toBeGreaterThan(195000);
    expect(r.meta.por_mes_cents).toBeLessThan(205000);
    expect(r.meta.por_semana_cents).toBeGreaterThan(40000);
    const c = await fe("fe_goal_contribute", u, { meta: "reserva", valor: 5000 });
    expect(c.meta.atual_cents).toBe(500000);
    expect(c.meta.progresso).toBe(25);
    expect(c.meta.previsao).toBeTruthy();
  });
  test("aporte sem dizer a meta usa a única meta ativa", async () => {
    const c = await fe("fe_goal_contribute", u, { valor: 1000 });
    expect(c.status).toBe("ok");
    expect(c.meta.atual_cents).toBe(600000);
  });
});

describe("orçamentos e alertas", () => {
  test("Alimentação R$ 1.000: acompanha o gasto e alerta aos 80%", async () => {
    const s = await fe("fe_set_budget", u, { categoria: "Alimentação", valor: 1000 });
    expect(s.status).toBe("saved");
    const r = await fe("fe_create_transaction", u, { tipo: "despesa", valor: 850, categoria: "Alimentação", subcategoria: "Supermercado" });
    expect(r.orcamento.percentual).toBe(85);
    const b = await fe("fe_budgets", u);
    const ali = b.itens.find((x: any) => x.categoria === "Alimentação");
    expect(ali.situacao).toBe("atencao");
    const alerts = await fe("fe_alerts", u);
    expect(alerts.some((a: any) => a.tipo === "orcamento" && a.texto.includes("Alimentação"))).toBe(true);
  });
  test("orçamento vale para os meses seguintes até ser alterado", async () => {
    const prox = addDays(hoje.slice(0, 8) + "01", 40).slice(0, 7);
    const b = await fe("fe_budgets", u, { mes: prox });
    expect(b.itens.find((x: any) => x.categoria === "Alimentação").limite_cents).toBe(100000);
    await fe("fe_set_budget", u, { categoria: "Alimentação", valor: 0, mes: prox });
    const b2 = await fe("fe_budgets", u, { mes: prox });
    expect(b2.itens.find((x: any) => x.categoria === "Alimentação")).toBeUndefined();
    const b3 = await fe("fe_budgets", u);
    expect(b3.itens.find((x: any) => x.categoria === "Alimentação").limite_cents).toBe(100000);
  });
});

describe("relatórios e dashboard", () => {
  test("relatório do mês traz resumo, categorias, cartões, evolução e metas", async () => {
    const r = await fe("fe_report", u, {});
    expect(r.resumo.despesas_cents).toBeGreaterThan(0);
    expect(r.por_categoria.length).toBeGreaterThan(0);
    expect(r.por_cartao.some((x: any) => x.cartao === "Nubank")).toBe(true);
    expect(r.evolucao.length).toBe(1);
    expect(r.metas.length).toBe(1);
    const ano = await fe("fe_report", u, { inicio: hoje.slice(0, 4) + "-01-01", fim: hoje.slice(0, 4) + "-12-31" });
    expect(ano.evolucao.length).toBe(12);
  });
  test("dashboard: alertas, gastos por cartão e compromissos com faturas", async () => {
    const o = await fe("fe_month_overview", u);
    expect(Array.isArray(o.alertas)).toBe(true);
    expect(o).toHaveProperty("por_cartao");
    expect(o).toHaveProperty("faturas_mes_cents");
  });
});

describe("importação de extrato", () => {
  test("prévia marca duplicadas e importa só as novas", async () => {
    const conta = (await fe("fe_balances", u)).contas[0].id;
    await fe("fe_create_transaction", u, { tipo: "despesa", valor: 42.5, data: hoje, descricao: "Padaria Pão Quente", categoria: "Alimentação", conta_id: conta });
    const itens = [
      { data: hoje, valor: -42.5, descricao: "PADARIA PAO QUENTE LTDA", id_externo: "A1" },
      { data: hoje, valor: -19.9, descricao: "Spotify", id_externo: "A2" },
      { data: hoje, valor: 1500, descricao: "Pix recebido", id_externo: "A3" },
    ];
    const prev = await asUser(u, "app_import", { conta_id: conta, itens });
    expect(prev.status).toBe("preview");
    expect(prev.itens.map((x: any) => x.situacao)).toEqual(["duplicada", "nova", "nova"]);
    expect(prev.itens[1].categoria).toBeTruthy(); // aprendido ou "Outros"
    const ok = await asUser(u, "app_import", { conta_id: conta, itens, confirmar: true });
    expect(ok.importados).toBe(2);
    const again = await asUser(u, "app_import", { conta_id: conta, itens });
    expect(again.itens.every((x: any) => x.situacao === "duplicada")).toBe(true);
  });
});

describe("API do app (usuário logado)", () => {
  test("app_* funcionam com login e não com anon", async () => {
    const cards = await asUser(u, "app_cards");
    expect(cards.length).toBe(2);
    const boot = await asUser(u, "app_bootstrap");
    expect(boot.cartoes.length).toBe(2);
    expect(boot.metas.length).toBe(1);
    const ch = await asUser(u, "app_changes");
    expect(ch.cadastros).toBeTruthy();
    await expect(db.sql.begin(async (tx) => { await tx.unsafe("set local role anon"); await tx.unsafe("select app_cards('{}')"); })).rejects.toThrow();
  });
});
