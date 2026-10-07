// Testes ponta a ponta: conversa -> interpretação -> Motor Financeiro -> PostgreSQL.
// Requer o banco local (./dev/reset_db.sh). Rodar: bun test
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import type { Channel } from "../supabase/functions/_shared/types.ts";

const db = localEngine();
let user = "";
let other = "";

async function say(text: string, channel: Channel = "app") {
  return handleMessage({ user_id: user, channel, type: "text", content: text, timestamp: new Date().toISOString() }, { db });
}
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];

beforeAll(async () => {
  [{ id: user }] = await q(`insert into auth.users(email) values ('teste' || gen_random_uuid() || '@x.com') returning id`);
  [{ id: other }] = await q(`insert into auth.users(email) values ('outro' || gen_random_uuid() || '@x.com') returning id`);
});

describe("conversa completa", () => {
  test("cadastro cria conta padrão e categorias", async () => {
    const [{ n }] = await q(`select count(*)::int n from categories where user_id = $1`, user);
    expect(n).toBeGreaterThan(15);
    const [{ name }] = await q(`select name from accounts where user_id = $1 and is_default`, user);
    expect(name).toBe("Carteira");
  });

  test("gastei 50 reais na padaria", async () => {
    const r = await say("gastei 50 reais na padaria");
    expect(r.reply).toContain("R$ 50,00");
    expect(r.reply).toContain("Alimentação > Padaria");
  });

  test("duplicidade é detectada e confirmada", async () => {
    const r1 = await say("gastei 50 reais na padaria");
    expect(r1.reply).toContain("há poucos minutos");
    const r2 = await say("não");
    expect(r2.reply).toContain("cancelado");
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id=$1 and deleted_at is null`, user);
    expect(n).toBe(1);
  });

  test("recebi 1000 reais de salário (via WhatsApp) mostra previsão como estimativa", async () => {
    const r = await say("recebi 1000 reais de salário", "whatsapp");
    expect(r.reply).toContain("R$ 1.000,00");
    expect(r.reply).toContain("Salário");
    expect(r.reply).toContain("estimativa");
  });

  test("paguei 200 de gasolina", async () => {
    const r = await say("paguei 200 de gasolina");
    expect(r.reply).toContain("Transporte > Combustível");
  });

  test("comprei uma TV de 2400 em 10 vezes cria 10 parcelas", async () => {
    const r = await say("comprei uma TV de 2400 em 10 vezes");
    expect(r.reply).toContain("10x de R$ 240,00");
    const [{ n, s }] = await q(`select count(*)::int n, sum(amount_cents)::int s from transactions where user_id=$1 and installment_total=10`, user);
    expect(n).toBe(10);
    expect(s).toBe(240000);
  });

  test("gastei 80 no restaurante ontem", async () => {
    const r = await say("gastei 80 no restaurante ontem");
    expect(r.reply).toContain("ontem");
    expect(r.reply).toContain("Restaurante");
  });

  test("lançamento do WhatsApp aparece na consulta pelo app (mesmo motor, mesmo banco)", async () => {
    const r = await say("quanto recebi este mês?", "app");
    expect(r.reply).toContain("R$ 1.000,00");
  });

  test("quanto gastei esse mês?", async () => {
    const r = await say("quanto gastei esse mês?");
    // 50 + 200 + 240 (1ª parcela) + 80 = 570
    expect(r.reply).toContain("R$ 570,00");
  });

  test("quanto gastei com alimentação?", async () => {
    const r = await say("quanto gastei com alimentação?");
    expect(r.reply).toContain("R$ 130,00");
  });

  test("qual minha maior despesa?", async () => {
    const r = await say("qual minha maior despesa?");
    expect(r.reply).toContain("TV");
  });

  test("quanto tenho disponível? (estimativa)", async () => {
    const r = await say("quanto tenho disponível?");
    expect(r.reply).toContain("Estimativa");
    expect(r.reply).toContain("R$ 430,00"); // saldo 1000 - 570
  });

  test("quanto posso gastar até o final do mês?", async () => {
    const r = await say("quanto posso gastar até o final do mês?");
    expect(r.reply).toMatch(/por dia/);
  });

  test("quanto vou gastar com parcelas no próximo mês?", async () => {
    const r = await say("Quanto vou gastar com parcelas no próximo mês?");
    expect(r.reply).toContain("R$ 240,00");
  });

  test("corrija minha última despesa -> pergunta -> corrige categoria", async () => {
    const r1 = await say("corrija minha última despesa");
    expect(r1.reply).toContain("O que devo corrigir");
    const r2 = await say("a categoria é lazer");
    expect(r2.reply).toContain("Lazer");
    const [{ name }] = await q(`select c.name from transactions t join categories c on c.id=t.category_id
      where t.user_id=$1 and t.deleted_at is null order by t.created_at desc limit 1`, user);
    expect(name).toBe("Lazer");
  });

  test("apague o último lançamento (com confirmação)", async () => {
    const r1 = await say("apague o último lançamento");
    expect(r1.reply).toContain("Confirma");
    const r2 = await say("sim");
    expect(r2.reply).toContain("Apaguei");
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id=$1 and deleted_at is not null`, user);
    expect(n).toBeGreaterThan(0);
  });

  test("falta valor -> pergunta -> registra", async () => {
    const r1 = await say("paguei minha conta de luz");
    expect(r1.reply).toContain("Qual foi o valor");
    const r2 = await say("187,40");
    expect(r2.reply).toContain("R$ 187,40");
    expect(r2.reply).toContain("Energia");
  });

  test("falta categoria -> pergunta -> registra", async () => {
    const r1 = await say("gastei 500 reais");
    expect(r1.reply).toContain("Em qual categoria");
    const r2 = await say("saúde");
    expect(r2.reply).toContain("Saúde");
  });

  test("valor ambíguo -> pergunta", async () => {
    const r1 = await say("gastei 1,500 no mercado");
    expect(r1.reply).toContain("Você quis dizer");
    const r2 = await say("1500");
    expect(r2.reply).toContain("R$ 1.500,00");
  });

  test("aprendizado por estabelecimento", async () => {
    await say("gastei 30 no Bar do Zé");
    await say("lazer");
    const r = await say("gastei 45 no Bar do Zé");
    expect(r.reply).toContain("Lazer");
  });

  test("histórico unificado guarda app e WhatsApp", async () => {
    const rows = await q(`select distinct channel from chat_messages where user_id=$1`, user);
    expect(rows.map((r) => r.channel).sort()).toEqual(["app", "whatsapp"]);
  });

  test("auditoria e interpretação registradas", async () => {
    const [{ a }] = await q(`select count(*)::int a from audit_logs where user_id=$1`, user);
    const [{ i }] = await q(`select count(*)::int i from ai_interpretations where user_id=$1`, user);
    expect(a).toBeGreaterThan(5);
    expect(i).toBeGreaterThan(5);
  });

  test("como estão minhas finanças / compare / gastando demais / posso comprar", async () => {
    expect((await say("Como estão minhas finanças?")).reply).toContain("Neste mês você recebeu");
    expect((await say("Compare este mês com o mês passado.")).reply).toContain("mês passado");
    expect((await say("Estou gastando demais?")).reply).toContain("projeção");
    expect((await say("Posso comprar um celular de R$ 1.800?")).reply).toMatch(/cabe|não cabe/);
  });
});

describe("isolamento entre usuários", () => {
  test("outro usuário não vê os dados", async () => {
    const r = await handleMessage({ user_id: other, channel: "app", type: "text", content: "quanto gastei esse mês?", timestamp: "" }, { db });
    expect(r.reply).toContain("Não encontrei");
  });

  test("RLS: usuário logado só lê as próprias linhas e não chama o motor", async () => {
    const res = await db.sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [other]);
      const rows = await tx.unsafe(`select count(*)::int n from transactions`);
      let blocked = false;
      try { await tx.unsafe(`savepoint s`); await tx.unsafe(`select fe_balances($1::uuid)`, [user]); } catch { blocked = true; await tx.unsafe(`rollback to savepoint s`); }
      let insertBlocked = false;
      try { await tx.unsafe(`savepoint s2`); await tx.unsafe(`insert into transactions(user_id,type,amount_cents,date,description) values ($1,'despesa',1,current_date,'x')`, [other]); } catch { insertBlocked = true; await tx.unsafe(`rollback to savepoint s2`); }
      return { n: rows[0].n, blocked, insertBlocked };
    });
    expect(res).toEqual({ n: 0, blocked: true, insertBlocked: true });
  });
});

describe("WhatsApp: vínculo por código", () => {
  test("código vincula número ao usuário", async () => {
    const code = await db.sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      return (await tx.unsafe(`select app_link_code() r`))[0].r.codigo;
    });
    expect(await db.rpc("fe_whatsapp_link", null, { phone: "+55 11 99999-0000", code: "000000x" })).toMatchObject({ status: "invalid_code" });
    expect(await db.rpc("fe_whatsapp_link", null, { phone: "+55 11 99999-0000", code })).toMatchObject({ status: "linked", user_id: user });
    expect(await db.rpc("fe_whatsapp_lookup", null, { phone: "5511999990000" })).toEqual({ user_id: user });
  });
});
