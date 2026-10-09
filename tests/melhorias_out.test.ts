// Contas (excluir, ajustar saldo), zerar conta, metas de planejamento, cupom fiscal e categorias novas.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { guessCategory } from "../supabase/functions/_shared/categorizer.ts";

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
  (await q(`insert into auth.users(email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, `${name}.${crypto.randomUUID()}@x.com`, { name }))[0].id as string;
const saldoConta = async (uid: string, nome: string) => Number((await fe("fe_balances", uid)).contas.find((c: any) => c.nome === nome)?.saldo_cents);

let u = "";
beforeAll(async () => { u = await newUser("Melhorias"); });

describe("categorias novas", () => {
  test("cadastro novo já vem com a lista completa", async () => {
    const cats = (await asUser<any>(u, "app_bootstrap")).categorias;
    const nomes = cats.map((c: any) => c.nome);
    for (const n of ["Moradia e contas da casa", "Filhos e família", "Pets", "Seguros", "Investimentos e reservas", "Outros gastos", "Salário e remuneração", "Renda extra", "Reembolsos", "Outras receitas"]) expect(nomes).toContain(n);
  });
  test("classificador usa os nomes novos e nomes antigos ainda funcionam", async () => {
    expect(guessCategory("paguei a conta de luz")).toMatchObject({ categoria: "Moradia e contas da casa", subcategoria: "Luz" });
    expect(guessCategory("netflix")).toMatchObject({ categoria: "Assinaturas e serviços" });
    expect(guessCategory("ração do cachorro")?.categoria).toBe("Pets");
    const r = await fe("fe_create_transaction", u, { tipo: "despesa", valor: 30, categoria: "Lazer", descricao: "Cinema" });
    expect(r.lancamento.categoria).toBe("Lazer e entretenimento");
  });
});

describe("contas", () => {
  test("ajustar saldo lança a diferença como ajuste", async () => {
    await fe("fe_admin", u, { acao: "salvar_conta", dados: { nome: "Banrisul", tipo: "corrente", saldo_inicial: 1000 } });
    const id = (await fe("fe_balances", u)).contas.find((c: any) => c.nome === "Banrisul").id;
    const r = await fe("fe_adjust_balance", u, { conta_id: id, saldo: 1250.5 });
    expect(r.diferenca_cents).toBe(25050);
    expect(await saldoConta(u, "Banrisul")).toBe(125050);
    await fe("fe_adjust_balance", u, { conta_id: id, saldo: 900 });
    expect(await saldoConta(u, "Banrisul")).toBe(90000);
    const ov = await fe("fe_month_overview", u, {});
    expect(Number(ov.receitas_cents)).toBe(0);   // ajuste não é receita
  });
  test("excluir conta: pede confirmação se tiver lançamentos", async () => {
    await fe("fe_admin", u, { acao: "salvar_conta", dados: { nome: "Velha", tipo: "corrente" } });
    const id = (await fe("fe_balances", u)).contas.find((c: any) => c.nome === "Velha").id;
    await fe("fe_create_transaction", u, { tipo: "despesa", valor: 10, categoria: "Alimentação", conta: "Velha" });
    expect((await asUser<any>(u, "app_delete_account", { id })).status).toBe("has_transactions");
    expect((await asUser<any>(u, "app_delete_account", { id, apagar_lancamentos: true })).status).toBe("ok");
    expect((await fe("fe_balances", u)).contas.map((c: any) => c.nome)).not.toContain("Velha");
  });
});

describe("metas como planejamento", () => {
  test("reserva de emergência e plano mensal", async () => {
    const r = await asUser<any>(u, "app_save_goal", { tipo: "reserva", nome: "Reserva", valor: 6000, meses_reserva: 6, plano_mensal: 500 });
    expect(r.meta.tipo).toBe("reserva");
    expect(r.meta.plano_mensal_cents).toBe(50000);
    expect(r.meta.previsao_plano).toBeTruthy();
    const pl = await asUser<any>(u, "app_planning");
    expect(Number(pl.planejado_mensal_cents)).toBe(50000);
    expect(pl.metas.some((g: any) => g.tipo === "reserva")).toBe(true);
  });
});

describe("cupom fiscal pelo assistente", () => {
  test("foto do cupom vira uma despesa", async () => {
    const extract = async () => ({ tipo: "cupom_fiscal" as const, estabelecimento: "Mercado Central", data: undefined, total: 87.4, forma_pagamento: "debito" as const,
      categoria: "Alimentação", subcategoria: "Supermercado", itens: [{ data: "2026-10-09", descricao: "ARROZ", valor: 30 }, { data: "2026-10-09", descricao: "CARNE", valor: 57.4 }] });
    const r = await handleMessage({ user_id: u, channel: "app", type: "text", content: "📷 Foto", timestamp: "", document: { bytes: new Uint8Array([1]), mime: "image/jpeg" } }, { db, extract });
    expect(r.reply).toContain("Mercado Central");
    expect(r.reply).toContain("R$ 87,40");
    expect(r.reply).toContain("Registrei");
  });
});

describe("zerar a conta", () => {
  test("só com ZERAR; apaga lançamentos e zera saldos", async () => {
    await expect(asUser(u, "app_reset_account", { confirmacao: "sim" })).rejects.toThrow();
    const r = await asUser<any>(u, "app_reset_account", { confirmacao: "ZERAR", fixas: true, orcamentos: true });
    expect(r.lancamentos).toBeGreaterThan(0);
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id = $1 and deleted_at is null`, u);
    expect(n).toBe(0);
    expect(Number((await fe("fe_balances", u)).total_cents)).toBe(0);
  });
});
