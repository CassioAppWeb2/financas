// Gastos divididos entre o casal e acertos.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";

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
let ca = "", br = "", cardCa = "", cardBr = "", contaBr = "", hoje = "";

beforeAll(async () => {
  ca = await newUser("Cássio"); br = await newUser("Bruna");
  const inv = await asUser(ca, "app_family_invite");
  await asUser(br, "app_family_join", { codigo: inv.codigo });
  cardCa = (await asUser(ca, "app_save_card", { nome: "Nubank Cássio", fechamento: 5, vencimento: 12 })).id;
  contaBr = (await asUser(br, "app_save_account", { nome: "Itaú Bruna", tipo: "corrente", saldo_inicial: 1000 })).id;
  hoje = (await q(`select fe_today($1)::text t`, ca))[0].t;
});

describe("divisão de compras", () => {
  test("cartão tem dono", async () => {
    const cards = await asUser<any[]>(ca, "app_cards");
    expect(cards[0].membro_id).toBe(ca);
  });

  test("Bruna sem cartão: pede para cadastrar", async () => {
    const r = await asUser(ca, "app_save_split", { tipo: "despesa", valor: 250, categoria: "Alimentação", descricao: "Mercado",
      partes: [{ membro_id: ca, cartao_do_membro: true }, { membro_id: br, cartao_do_membro: true }] });
    expect(r.status).toBe("needs_member_card");
    expect(r.membro).toBe("Bruna");
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id = $1 and deleted_at is null`, ca);
    expect(n).toBe(0);
  });

  test("metade no meu cartão e metade no da Bruna: cada um paga a sua, sem acerto", async () => {
    cardBr = (await asUser(br, "app_save_card", { nome: "Inter Bruna", fechamento: 10, vencimento: 20 })).id;
    const r = await asUser(ca, "app_save_split", { tipo: "despesa", valor: 250, categoria: "Alimentação", descricao: "Mercado",
      partes: [{ membro_id: ca, cartao_do_membro: true }, { membro_id: br, cartao_do_membro: true }] });
    expect(r.status).toBe("created");
    expect(r.partes.map((x: any) => [x.membro, x.valor_cents, x.cartao, x.deve_para])).toEqual([["Cássio", 12500, "Nubank Cássio", null], ["Bruna", 12500, "Inter Bruna", null]]);
    const d = await asUser(br, "app_debts");
    expect(d.devo).toEqual([]);
  });

  test("150 no meu cartão dividido: Bruna fica devendo 75", async () => {
    const r = await asUser(ca, "app_save_split", { tipo: "despesa", valor: 150, categoria: "Lazer", descricao: "Jantar", cartao_id: cardCa, dividir: true });
    expect(r.partes.map((x: any) => [x.membro, x.valor_cents, x.cartao, x.deve_para])).toEqual([["Cássio", 7500, "Nubank Cássio", null], ["Bruna", 7500, "Nubank Cássio", "Cássio"]]);
    const inv = await asUser(ca, "app_card_invoice", { cartao_id: cardCa });
    expect(inv.fatura.total_cents).toBe(12500 + 15000);
    const d = await asUser(br, "app_debts");
    expect(d.devo[0].pessoa).toBe("Cássio");
    expect(d.devo[0].total_cents).toBe(7500);
    const d2 = await asUser(ca, "app_debts");
    expect(d2.recebo[0].total_cents).toBe(7500);
    const al = await asUser<any[]>(br, "app_alerts");
    expect(al.some((a) => a.tipo === "acerto" && /75,00/.test(a.texto))).toBe(true);
  });

  test("painel da Bruna: despesas dela, faturas só dos cartões dela, acerto a pagar", async () => {
    const d = await asUser(ca, "app_dashboard", { membro_id: br });
    expect(Number(d.despesas_cents)).toBe(12500 + 7500);
    expect(Number(d.acertos_a_pagar_cents)).toBe(7500);
    const dc = await asUser(ca, "app_dashboard", { membro_id: ca });
    expect(Number(dc.acertos_a_receber_cents)).toBe(7500);
    const det = await asUser(br, "app_kpi_detail", { painel: "despesas", membro_id: br });
    expect(det.lancamentos.length).toBe(2);
    expect(det.lancamentos.some((t: any) => t.deve_para === "Cássio")).toBe(true);
    const fat = await asUser(ca, "app_kpi_detail", { painel: "faturas", membro_id: ca, mes: "" });
    expect(Array.isArray(fat.faturas)).toBe(true);
    const sal = await asUser(br, "app_kpi_detail", { painel: "saldo", membro_id: br });
    expect(sal.contas.map((c: any) => c.nome)).toContain("Itaú Bruna");
  });

  test("partes que não fecham o total dão erro", async () => {
    await expect(asUser(ca, "app_save_split", { tipo: "despesa", valor: 100, categoria: "Lazer",
      partes: [{ membro_id: ca, valor: 30 }, { membro_id: br, valor: 30 }] })).rejects.toThrow(/somam/);
  });

  test("Bruna paga o acerto por Pix: vira transferência entre as contas, sem despesa nova", async () => {
    const contaCa = (await asUser<any>(ca, "app_bootstrap")).contas.contas.find((c: any) => c.membro_id === ca).id;
    const r = await asUser(br, "app_settle", { pessoa_id: ca, acao: "pago", forma: "pix" });
    expect(r.status).toBe("pago");
    expect(r.valor_cents).toBe(7500);
    expect(r.transferencia).toBe(true);
    expect(r.conta_origem).toBe("Itaú Bruna");
    const bal = await asUser<any>(ca, "app_bootstrap");
    expect(bal.contas.contas.find((c: any) => c.id === contaCa).saldo_cents).toBe(7500);
    expect((await asUser(br, "app_debts")).devo).toEqual([]);
    const d = await asUser(ca, "app_dashboard", { membro_id: br });
    expect(Number(d.despesas_cents)).toBe(20000);
  });

  test("dispensar (ok) zera sem lançamento", async () => {
    await asUser(ca, "app_save_split", { tipo: "despesa", valor: 40, categoria: "Lazer", descricao: "Sorvete", cartao_id: cardCa, dividir: true });
    const r = await asUser(ca, "app_settle", { pessoa_id: br, acao: "dispensar" });
    expect(r.status).toBe("dispensado");
    expect(r.transferencia).toBe(false);
    expect((await asUser(ca, "app_debts")).recebo).toEqual([]);
  });
});

import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
const say = (uid: string, content: string) => handleMessage({ user_id: uid, channel: "telegram", type: "text", content, timestamp: "" }, { db });

describe("divisão pela conversa", () => {
  test("jantar no cartão dividido com a Bruna", async () => {
    const r = await say(ca, "jantar de 150 no cartão nubank cássio dividido com a bruna");
    expect(r.reply).toContain("dividido");
    expect(r.reply).toContain("Bruna: R$ 75,00");
    expect(r.reply).toContain("acertos do mês");
  });
  test("metade no meu cartão e metade no da Bruna", async () => {
    const r = await say(ca, "comprei 250 no mercado, metade no meu cartão e metade no cartão da bruna");
    expect(r.reply).toContain("Você: R$ 125,00 no cartão Nubank Cássio");
    expect(r.reply).toContain("Bruna: R$ 125,00 no cartão Inter Bruna");
    expect(r.reply).not.toContain("acertar");
  });
  test("Bruna consulta e acerta por pix", async () => {
    const q1 = await say(br, "quanto devo pro cássio?");
    expect(q1.reply).toContain("Você deve R$ 75,00");
    const r = await say(br, "fiz pix pro cássio");
    expect(r.reply).toContain("Confirma?");
    const ok = await say(br, "sim");
    expect(ok.reply).toContain("Acerto registrado");
    expect(ok.reply).toContain("transferência");
    expect((await say(br, "acertos")).reply).toContain("Nenhum acerto pendente");
  });
  test("ok dispensa", async () => {
    await say(ca, "pizza de 60 no cartão nubank cássio rachado com a bruna");
    await say(ca, "acertei com a bruna");
    const r = await say(ca, "ok");
    expect(r.reply).toContain("dispensei");
  });
});

describe("áudio incompleto ou duvidoso", () => {
  const audio = (uid: string, content: string) => handleMessage({ user_id: uid, channel: "app", type: "audio", content, timestamp: "" }, { db });
  test("sem valor no áudio: avisa e pergunta o valor (e mantém a divisão)", async () => {
    const r = await audio(ca, "Compra de um computador dividido em dois cartões. A metade pra mim e a metade pra Bruna.");
    expect(r.reply).toContain("Não identifiquei o valor no áudio");
    const r2 = await say(ca, "mil reais");
    expect(r2.reply).toMatch(/R\$ 1\.000,00|dividid|categoria/);
  });
  test("valor por extenso duvidoso: confirma antes de lançar", async () => {
    await say(ca, "cancela");
    const r = await audio(ca, "gastei dois no mercado");
    expect(r.reply).toContain("não tenho certeza");
    const [{ n: antes }] = await q(`select count(*)::int n from transactions where user_id = $1`, ca);
    const r2 = await say(ca, "foi 200");
    expect(r2.reply).toContain("R$ 200,00");
    const [{ n: depois }] = await q(`select count(*)::int n from transactions where user_id = $1`, ca);
    expect(depois).toBe(antes + 1);
  });
  test("valor claro no áudio não pede confirmação", async () => {
    const r = await audio(ca, "gastei 250 reais no mercado");
    expect(r.reply).toContain("Registrei");
  });
});
