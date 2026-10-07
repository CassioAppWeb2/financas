// Fase 2 pela conversa: cartões, faturas, contas fixas, metas, orçamentos e alertas.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";

const db = localEngine();
let user = "";
const say = async (text: string) =>
  handleMessage({ user_id: user, channel: "telegram", type: "text", content: text, timestamp: new Date().toISOString() }, { db });
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];

beforeAll(async () => {
  [{ id: user }] = await q(`insert into auth.users(email) values ('chat2' || gen_random_uuid() || '@x.com') returning id`);
  await say("oi");
});

describe("cartões pela conversa", () => {
  test("sem cartão cadastrado, registra na conta e sugere cadastrar", async () => {
    const r = await say("gastei 100 no cartão de crédito no mercado");
    expect(r.reply).toContain("R$ 100,00");
    expect(r.reply).toContain("cadastre seus cartões");
  });

  test("compra parcelada no cartão mostra a fatura e o limite", async () => {
    await db.rpc("fe_save_card", user, { nome: "Nubank", fechamento: 5, vencimento: 12, limite: 5000 });
    await db.rpc("fe_save_card", user, { nome: "Inter", fechamento: 20, vencimento: 28 });
    const r = await say("comprei uma TV de 3000 em 10x no cartão Nubank");
    expect(r.reply).toContain("Nubank");
    expect(r.reply).toContain("fatura que vence");
    expect(r.reply).toContain("Limite disponível: R$ 2.000,00");
  });

  test("crédito sem dizer qual cartão: pergunta e registra", async () => {
    const r = await say("gastei 60 no crédito na farmácia");
    expect(r.reply).toContain("Em qual cartão");
    const r2 = await say("inter");
    expect(r2.reply).toContain("cartão **Inter**");
  });

  test("consulta fatura e limite", async () => {
    const f = await say("quanto está a fatura do nubank?");
    expect(f.reply).toContain("Nubank");
    expect(f.reply).toContain("fatura atual");
    const l = await say("qual o limite disponível do nubank?");
    expect(l.reply).toContain("disponível R$ 2.000,00");
  });

  test("pagar fatura", async () => {
    const [{ due }] = await q(`select min(invoice_due)::text due from transactions where user_id = $1 and card_id is not null and deleted_at is null and invoice_due >= current_date`, user);
    await q(`update transactions set date = date - 40, invoice_due = $2::date - 30 where user_id = $1 and description ilike 'TV%' and installment_number = 1`, user, due);
    const r = await say("paguei a fatura do nubank");
    expect(r.reply).toMatch(/Registrei o pagamento de \*\*R\$ 300,00\*\*/);
    expect(r.reply).toContain("não conta como despesa");
  });
});

describe("contas fixas", () => {
  test("cria, lista e encerra", async () => {
    const r = await say("minha internet custa 120 todo dia 28");
    expect(r.reply).toContain("Conta fixa criada");
    expect(r.reply).toContain("todo dia 28");
    const l = await say("quais são minhas contas fixas?");
    expect(l.reply).toContain("R$ 120,00");
    const c = await say("não pago mais a internet");
    expect(c.reply).toContain("Confirma?");
    const ok = await say("sim");
    expect(ok.reply).toContain("encerrei");
    const [{ n }] = await q(`select count(*)::int n from recurring_transactions where user_id = $1 and active`, user);
    expect(n).toBe(0);
  });
});

describe("metas e orçamentos", () => {
  test("meta: criar, guardar e consultar", async () => {
    const r = await say("quero juntar 12 mil até dezembro de 2027 para a viagem");
    expect(r.reply).toContain("Meta criada");
    expect(r.reply).toContain("por mês");
    const a = await say("guardei 500 na meta viagem");
    expect(a.reply).toContain("Guardei R$ 500,00");
    const g = await say("como estão minhas metas?");
    expect(g.reply).toContain("R$ 500,00 de R$ 12.000,00");
  });

  test("orçamento: definir, alerta e consulta", async () => {
    const r = await say("orçamento de 200 para alimentação");
    expect(r.reply).toContain("Orçamento de **Alimentação**");
    const g = await say("gastei 150 no restaurante");
    expect(g.reply).toMatch(/Alimentação (já usou|passou)/);
    const b = await say("como está meu orçamento?");
    expect(b.reply).toContain("Alimentação");
    const al = await say("tenho algum alerta?");
    expect(al.reply).toContain("Alimentação");
  });
});
