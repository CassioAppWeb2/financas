// Compra dividida no cartão (parcelada ou não): a parte de cada um, informada ou perguntada,
// e o acerto que vence junto com cada fatura — "a receber" para o dono do cartão, "a pagar" para o outro.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { interpretRules } from "../supabase/functions/_shared/interpreter_rules.ts";

const db = localEngine();
const q = async (sql: string, ...a: unknown[]) => (await db.sql.unsafe(sql, a)) as any[];
const asUser = <T = any>(uid: string, fn: string, p: object = {}) =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await tx.unsafe(`set local role authenticated`);
    return ((await tx.unsafe(`select to_jsonb(public.${fn}($1::jsonb)) r`, [p])) as any)[0].r as T;
  });
const newUser = async (name: string) =>
  (await q(`insert into auth.users(email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, `${name}.${crypto.randomUUID()}@x.com`, { name }))[0].id as string;
const say = (uid: string, content: string) => handleMessage({ user_id: uid, channel: "app", type: "text", content, timestamp: "" }, { db });
let ca = "", br = "", card = "";
const parts = async (desc: string) => q(`select member_id = $2 as dela, sum(amount_cents)::int tot, count(*)::int n, min(coalesce(invoice_due, date))::text venc
  from transactions where user_id = $1 and description like $3 and deleted_at is null group by 1 order by 1`, ca, br, desc + "%");

beforeAll(async () => {
  ca = await newUser("Cássio"); br = await newUser("Bruna");
  const inv = await asUser(ca, "app_family_invite");
  await asUser(br, "app_family_join", { codigo: inv.codigo });
  card = (await asUser(ca, "app_save_card", { nome: "Nubank Cássio", fechamento: 5, vencimento: 12 })).id;
  await asUser(ca, "app_save_account", { nome: "Banrisul", tipo: "corrente", saldo_inicial: 1000 });
  await asUser(br, "app_save_account", { nome: "Itaú Bruna", tipo: "corrente", saldo_inicial: 1000 });
});

describe("entende a divisão na frase", () => {
  const uc = () => ({ hoje: "2026-10-19", categorias: [], contas: [], cartoes: ["Nubank Cássio"], membros: [{ id: "c", nome: "Cássio", eu: true }, { id: "b", nome: "Bruna", eu: false }] }) as any;
  test("valores de cada um", () => {
    const r = interpretRules("comprei um sofá de 3.000 em 10x no cartão nubank cássio, dividido com a bruna: eu 1.800 e a bruna 1.200", uc());
    expect([r.valor, r.parcelas, r.cartao, r.dividir]).toEqual([3000, 10, "Nubank Cássio", true]);
    expect(r.partes).toEqual([{ membro: "c", valor: 1800 }, { membro: "b", valor: 1200 }]);
  });
  test("só a parte dela", () => {
    const r = interpretRules("geladeira de 4 mil em 4x no nubank cássio dividida, a bruna fica com 1.000", uc());
    expect(r.valor).toBe(4000);
    expect(r.partes).toEqual([{ membro: "b", valor: 1000 }]);
  });
  test("percentual", () => {
    const r = interpretRules("comprei uma tv de 2.000 no cartão nubank cássio dividida 60% meu e 40% da bruna", uc());
    expect(r.partes).toEqual([{ membro: "c", percentual: 60 }, { membro: "b", percentual: 40 }]);
  });
  test("partes iguais", () => {
    const r = interpretRules("comprei uma mesa de 900 no nubank cássio dividido em partes iguais com a bruna", uc());
    expect([r.dividir, r.divisao_igual, r.partes]).toEqual([true, true, undefined]);
  });
  test("áudio real: cartão e percentuais ditos depois de “dividido com a Bruna”", () => {
    const r = interpretRules("Compramos um sofá de 3.500 reais dividido com a Bruna. Comprei com a fatura, comprei com o cartão do Nubank Cássio e a fatura vai ser dividida 60% para mim e 40% para Bruna em 10 vezes.", uc());
    expect([r.valor, r.parcelas, r.cartao, r.dividir, r.descricao, r.familia]).toEqual([3500, 10, "Nubank Cássio", true, "Sofá", undefined]);
    expect(r.partes).toEqual([{ membro: "c", percentual: 60 }, { membro: "b", percentual: 40 }]);
  });
  test("“dividido em 10x” é parcelamento, não divisão", () => {
    const r = interpretRules("comprei uma tv de 2.400 dividido em 10x no nubank cássio", uc());
    expect([r.dividir, r.parcelas, r.valor]).toEqual([undefined, 10, 2400]);
  });
});

describe("sofá em 10x no cartão do Cássio, dividido com a Bruna", () => {
  test("sem dizer os valores: pergunta; com a resposta, lança a parte de cada um", async () => {
    const q1 = await say(ca, "comprei um sofá de 3.000 em 10x no cartão nubank cássio dividido com a bruna");
    expect(q1.reply).toContain("Como fica a divisão de **Sofá** — R$ 3.000,00 em 10x de R$ 300,00?");
    const r = await say(ca, "eu 1.800 e a bruna 1.200");
    expect(r.reply).toContain("R$ 3.000,00 em 10x no cartão Nubank Cássio (parcela de R$ 300,00 na fatura)");
    expect(r.reply).toContain("• Você: R$ 1.800,00 (10x de R$ 180,00)");
    expect(r.reply).toContain("• Bruna: R$ 1.200,00 (10x de R$ 120,00) — a pagar para você");
    expect(r.reply).toContain("A cada vencimento da fatura");
    expect(r.reply).toContain("fica R$ 120,00 a receber de Bruna");
    const p = await parts("Sofá");
    expect(p.map((x) => [x.dela, x.tot, x.n])).toEqual([[false, 180000, 10], [true, 120000, 10]]);
    // a Bruna recebe UM aviso da divisão (não um por parcela)
    await db.rpc("fe_notify_scan", br, {});
    const avisos = await q(`select body from notifications where user_id = $1 and type = 'acerto' and body like '%Sofá%'`, br);
    expect(avisos.length).toBe(1);
    expect(avisos[0].body).toContain("sua parte é R$ 1.200,00 em 10x de R$ 120,00");
  });

  test("a fatura do Cássio tem a parcela inteira; cada parcela da Bruna vence com a fatura", async () => {
    const [{ venc }] = await q(`select min(invoice_due)::text venc from transactions where user_id = $1 and description like 'Sofá%'`, ca);
    const [{ sofa }] = await q(`select sum(amount_cents)::int sofa from transactions where user_id = $1 and card_id = $2 and invoice_due = $3::date and description like 'Sofá%'`, ca, card, venc);
    expect(sofa).toBe(30000);          // a parcela inteira (180 dele + 120 dela) está na fatura do Cássio
    const dues = await q(`select coalesce(invoice_due, date)::text d, amount_cents::int v from transactions
      where user_id = $1 and member_id = $2 and description like 'Sofá%' and settle_status = 'pendente' order by 1`, ca, br);
    expect(dues.length).toBe(10);
    expect(new Set(dues.map((x) => x.d.slice(0, 7))).size).toBe(10);           // uma por mês
    expect(dues.every((x) => x.d.endsWith("-12"))).toBe(true);                // no dia do vencimento da fatura
    const devo = await asUser(br, "app_debts", { mes: venc.slice(0, 7) });
    expect(devo.devo[0].itens.filter((t: any) => /^Sofá/.test(t.descricao)).map((t: any) => t.valor_cents)).toEqual([12000]);
  });

  test("a Bruna paga só a parcela do mês (👍 no lembrete): vira transferência, as outras continuam", async () => {
    const [{ id, venc }] = await q(`select id, coalesce(invoice_due, date)::text venc from transactions
      where user_id = $1 and member_id = $2 and description like 'Sofá%' and settle_status = 'pendente' order by 2 limit 1`, ca, br);
    const r = await asUser(br, "app_settle", { ids: [id], acao: "pago", forma: "pix" });
    expect([r.status, r.valor_cents, r.transferencia, r.credor]).toEqual(["pago", 12000, true, "Cássio"]);
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id = $1 and member_id = $2 and description like 'Sofá%' and settle_status = 'pendente'`, ca, br);
    expect(n).toBe(9);
    const pend = await asUser(br, "app_pending", { dias: 400 });
    expect(pend.proximos.some((t: any) => t.id === id)).toBe(false);
  });

  test("lembrete no dia do vencimento, para os dois", async () => {
    // simula a próxima parcela vencendo hoje
    const [{ id }] = await q(`select id from transactions where user_id = $1 and member_id = $2 and description like 'Sofá%' and settle_status = 'pendente' order by invoice_due limit 1`, ca, br);
    await q(`update transactions set invoice_due = fe_today($2) where id = $1`, id, ca);
    await db.rpc("fe_notify_scan", br, {});
    await db.rpc("fe_notify_scan", ca, {});
    const [b] = await q(`select title, body from notifications where user_id = $1 and type = 'acerto_vence' and data->>'tx_id' = $2`, br, id);
    expect(b.title).toBe("Acerto vence hoje");
    expect(b.body).toContain("R$ 120,00 para Cássio");
    const [c2] = await q(`select title, body from notifications where user_id = $1 and type = 'acerto_vence' and data->>'tx_id' = $2`, ca, id);
    expect(c2.title).toBe("A receber hoje");
    expect(c2.body).toContain("Bruna te paga R$ 120,00");
    const pb = await asUser(br, "app_pending", {});
    expect(pb.proximos.some((t: any) => t.id === id && t.tipo === "despesa" && t.pessoa === "Cássio")).toBe(true);
    const pc = await asUser(ca, "app_pending", {});
    expect(pc.proximos.some((t: any) => t.id === id && t.tipo === "receita" && t.pessoa === "Bruna")).toBe(true);
  });
});

describe("compromissos da Bruna", () => {
  test("no mês do vencimento, a parte dela entra em “Compromissos futuros”", async () => {
    const r = await say(ca, "Compramos uma geladeira de 1.000 reais dividido com a Bruna. Comprei no cartão do Nubank Cássio e vai ser dividida 60% para mim e 40% para Bruna em 2 vezes.");
    expect(r.reply).toContain("• Bruna: R$ 400,00 (2x de R$ 200,00) — a pagar para você");
    const [{ venc }] = await q(`select min(invoice_due)::text venc from transactions where user_id = $1 and description like 'Geladeira%' and member_id = $2 and amount_cents = 20000`, ca, br);
    const mes = venc.slice(0, 7);
    const dash = await asUser(br, "app_dashboard", { mes, membro_id: br });
    expect(Number(dash.acertos_a_pagar_cents)).toBeGreaterThanOrEqual(20000);
    const det = await asUser(br, "app_kpi_detail", { mes, membro_id: br, painel: "compromissos" });
    expect(det.acertos.some((t: any) => /^Geladeira/.test(t.descricao) && t.valor_cents === 20000 && t.data === venc && t.pessoa === "Cássio")).toBe(true);
  });
});

describe("outras formas de dizer", () => {
  test("só a parte dela na frase: lança direto, o resto é meu", async () => {
    const r = await say(ca, "geladeira de 4 mil em 4x no nubank cássio dividida, a bruna fica com 1.000");
    expect(r.reply).toContain("• Você: R$ 3.000,00 (4x de R$ 750,00)");
    expect(r.reply).toContain("• Bruna: R$ 1.000,00 (4x de R$ 250,00)");
  });
  test("percentual", async () => {
    const r = await say(ca, "comprei uma tv de 2.000 no cartão nubank cássio dividida 60% meu e 40% da bruna");
    expect(r.reply).toContain("• Bruna: R$ 800,00 — a pagar para você");
  });
  test("resposta só com o valor dela", async () => {
    await say(ca, "compras de 500 no mercado no nubank cássio dividido com a bruna");
    const r = await say(ca, "200");
    expect(r.reply).toContain("• Você: R$ 300,00");
    expect(r.reply).toContain("• Bruna: R$ 200,00");
  });
  test("partes que não fecham: pergunta de novo, sem lançar", async () => {
    const r = await say(ca, "jantar de 1.000 no restaurante no nubank cássio dividido, eu 700 e a bruna 500");
    expect(r.reply).toContain("As partes somam R$ 1.200,00, mas a compra é de R$ 1.000,00");
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id = $1 and description ilike 'jantar%' and amount_cents = 50000`, ca);
    expect(n).toBe(0);
    const ok = await say(ca, "eu 500 e a bruna 500");
    expect(ok.reply).toContain("• Bruna: R$ 500,00");
  });
  test("sem valor total: pergunta o valor e depois a divisão", async () => {
    const q1 = await say(ca, "comprei comida no mercado no nubank cássio dividido com a bruna");
    expect(q1.reply).toMatch(/valor/i);
    const q2 = await say(ca, "1.500");
    expect(q2.reply).toContain("Como fica a divisão");
    const r = await say(ca, "metade");
    expect(r.reply).toContain("• Bruna: R$ 750,00");
  });
});

describe("cartões com o mesmo nome", () => {
  test("cada um que fala “Nubank” usa o próprio Nubank", async () => {
    await asUser(br, "app_save_card", { nome: "Nubank Cássio", fechamento: 3, vencimento: 10 });   // mesmo nome, da Bruna
    await say(br, "gastei 33 no mercado no nubank cássio");
    await say(ca, "gastei 44 no mercado no nubank cássio");
    const rows = await q(`select (select member_id from credit_cards c where c.id = t.card_id) dono, t.created_by from transactions t
      where t.user_id = $1 and t.amount_cents in (3300, 4400) and t.deleted_at is null`, ca);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.dono === r.created_by)).toBe(true);
  });
});
