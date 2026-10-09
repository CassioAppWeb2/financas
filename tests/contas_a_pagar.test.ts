// Contas a pagar/receber pendentes, 👍 pago, pendências do início e sugestões de histórico.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";

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
const addDays = (iso: string, n: number) => { const x = new Date(iso + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const saldo = async (uid: string) => Number((await fe("fe_balances", uid)).total_cents);

let u = "", hoje = "";
beforeAll(async () => {
  u = await newUser("Pagar");
  hoje = (await q(`select fe_today($1)::text t`, u))[0].t;
  await fe("fe_create_transaction", u, { tipo: "receita", valor: 1000, categoria: "Salário", data: addDays(hoje, -3) });
});

describe("a pagar", () => {
  test("despesa a pagar atrasada não mexe no saldo até o 👍", async () => {
    const antes = await saldo(u);
    const r = await asUser<any>(u, "app_save_transaction", { tipo: "despesa", valor: 150, descricao: "Conta de luz", categoria_id: null, pendente: true, data: addDays(hoje, -2),
      ...{ categoria_id: (await q(`select id from categories where user_id = $1 and name = 'Moradia'`, u))[0].id } });
    expect(r.status).toBe("created");
    expect(r.lancamento.pendente).toBe(true);
    expect(await saldo(u)).toBe(antes);
    const p = await fe("fe_pending", u);
    expect(p.atrasados.map((x: any) => x.descricao)).toContain("Conta de luz");
    const al = await fe("fe_alerts", u);
    expect(al.some((a: any) => a.tipo === "pendente" && a.texto.includes("150,00"))).toBe(true);
    const ok = await asUser<any>(u, "app_set_paid", { id: r.lancamento.id, pago: true });
    expect(ok.lancamento.pendente).toBe(false);
    expect(await saldo(u)).toBe(antes - 15000);
    expect((await fe("fe_pending", u)).atrasados.length).toBe(0);
    // desfazer
    await asUser(u, "app_set_paid", { id: r.lancamento.id, pago: false });
    expect(await saldo(u)).toBe(antes);
    await asUser(u, "app_set_paid", { id: r.lancamento.id, pago: true });
  });

  test("despesa futura entra em compromissos e nos próximos dias", async () => {
    await fe("fe_create_transaction", u, { tipo: "despesa", valor: 89.9, descricao: "Internet", categoria: "Internet", data: addDays(hoje, 3) });
    const p = await fe("fe_pending", u);
    expect(p.proximos.map((x: any) => x.descricao)).toContain("Internet");
  });

  test("conta fixa em conta gera ocorrência pendente; no cartão não", async () => {
    const dia = Number(hoje.slice(8, 10));
    await fe("fe_save_recurring", u, { tipo: "despesa", valor: 1200, descricao: "Aluguel", categoria: "Aluguel", frequencia: "mensal", inicio: hoje, dia });
    const [t] = await q(`select status from transactions where user_id = $1 and description = 'Aluguel' and date = $2::date and deleted_at is null`, u, hoje);
    expect(t.status).toBe("previsto");
    const p = await fe("fe_pending", u);
    expect(p.proximos.some((x: any) => x.descricao === "Aluguel")).toBe(true);
  });

  test("receita a receber atrasada", async () => {
    await asUser(u, "app_save_transaction", { tipo: "receita", valor: 300, descricao: "Freela", pendente: true, data: addDays(hoje, -5),
      categoria_id: (await q(`select id from categories where user_id = $1 and kind = 'receita' order by name limit 1`, u))[0].id });
    const p = await fe("fe_pending", u);
    expect(p.atrasados.some((x: any) => x.tipo === "receita" && x.descricao === "Freela")).toBe(true);
  });
});

describe("sugestões ao digitar", () => {
  test("últimos lançamentos parecidos, sem repetir", async () => {
    await fe("fe_create_transaction", u, { tipo: "despesa", valor: 210, descricao: "Mercado", categoria: "Supermercado", forma_pagamento: "pix", data: addDays(hoje, -6) });
    await fe("fe_create_transaction", u, { tipo: "despesa", valor: 180, descricao: "Mercado", categoria: "Supermercado", forma_pagamento: "pix", data: addDays(hoje, -1) });
    const s = await asUser<any[]>(u, "app_suggest", { q: "merc", tipo: "despesa" });
    expect(s.length).toBe(1);
    expect(s[0].valor_cents).toBe(18000);
    expect(s[0].forma_pagamento).toBe("pix");
    expect((await asUser<any[]>(u, "app_suggest", { q: "supermerc" })).length).toBeGreaterThan(0);
    expect((await asUser<any[]>(u, "app_suggest", { q: "m" })).length).toBe(0);
  });
});

describe("assistente confirma conta a pagar", () => {
  test("\"paguei a internet\" marca a pendente como paga, sem duplicar", async () => {
    const antes = await saldo(u);
    const r = await handleMessage({ user_id: u, channel: "app", type: "text", content: "paguei 89,90 da internet", timestamp: new Date().toISOString() }, { db });
    expect(r.reply).toContain("paga");
    expect(r.reply).toContain("Internet");
    expect(await saldo(u)).toBe(antes - 8990);
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id = $1 and description ilike '%internet%' and deleted_at is null`, u);
    expect(n).toBe(1);
  });
});
