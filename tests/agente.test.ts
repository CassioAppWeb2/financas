// Agente: cadastros por conversa (IA simulada — as respostas do Gemini são roteirizadas aqui).
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";

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

// Gemini de mentira: devolve as respostas da fila, na ordem
let queue: any[] = [];
const sent: any[] = [];
const fakeFetch = (async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  if (!body.tools) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"intent":"OTHER","confidence":0.3}' }] } }] }), { status: 200 });
  sent.push(body);
  const next = queue.shift();
  if (!next) return new Response("{}", { status: 500 });
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: next } }] }), { status: 200 });
}) as unknown as typeof fetch;
const ai = { geminiKey: "teste", geminiModel: "fake", fetch: fakeFetch };
let ca = "", br = "";
const say = (uid: string, content: string) => handleMessage({ user_id: uid, channel: "app", type: "text", content, timestamp: "" }, { db, ai });
const call = (name: string, args: object) => [{ functionCall: { name, args }, thoughtSignature: "x" }];
const text = (t: string) => [{ text: t }];

beforeAll(async () => {
  ca = await newUser("Cássio"); br = await newUser("Bruna");
  const inv = await asUser(ca, "app_family_invite");
  await asUser(br, "app_family_join", { codigo: inv.codigo });
});

describe("cadastros conversando", () => {
  test("cartão para a Bruna: pergunta o fechamento e depois cadastra", async () => {
    queue = [text("Certo! Qual é o dia de fechamento da fatura do Nubank? (costuma ser uns 7 dias antes, dia 3)")];
    const r1 = await say(ca, "cadastre para a bruna o cartão de crédito nubank, com a fatura para o vencimento dia 10");
    expect(r1.reply).toContain("fechamento");
    queue = [call("cadastrar_cartao", { nome: "Nubank", dia_fechamento: 3, dia_vencimento: 10, dono: "Bruna" }), text("✅ Cartão Nubank da Bruna cadastrado: fecha dia 3, vence dia 10.")];
    const r2 = await say(ca, "dia 3");
    expect(r2.reply).toContain("cadastrado");
    // a IA recebeu a conversa anterior e o resultado da ferramenta
    const last = sent[sent.length - 1];
    expect(JSON.stringify(last.contents)).toContain("vencimento dia 10");
    expect(JSON.stringify(last.contents)).toContain("functionResponse");
    expect(JSON.stringify(last.contents)).toContain("thoughtSignature");
    const [k] = await q(`select name, closing_day, due_day, member_id from credit_cards where user_id = $1`, ca);
    expect([k.name, k.closing_day, k.due_day, k.member_id]).toEqual(["Nubank", 3, 10, br]);
  });

  test("editar limite", async () => {
    queue = [call("editar_cartao", { cartao: "nubank", limite: 8000 }), text("Pronto, limite do Nubank agora é R$ 8.000,00.")];
    const r = await say(ca, "mude o limite do nubank para 8 mil");
    expect(r.reply).toContain("8.000");
    const [k] = await q(`select limit_cents::int l, due_day, member_id from credit_cards where user_id = $1`, ca);
    expect(k.l).toBe(800000); expect(k.due_day).toBe(10); expect(k.member_id).toBe(br);
  });

  test("conta da Bruna com saldo", async () => {
    queue = [call("cadastrar_conta", { nome: "Itaú", saldo_inicial: 2300, dono: "bruna", tipo: "corrente" }), text("Conta Itaú da Bruna criada com R$ 2.300,00.")];
    await say(ca, "crie a conta Itaú da bruna com saldo de 2.300");
    const [a] = await q(`select initial_balance_cents::int s, member_id from accounts where user_id = $1 and name = 'Itaú'`, ca);
    expect(a.s).toBe(230000); expect(a.member_id).toBe(br);
  });

  test("erro da ferramenta volta para a IA explicar", async () => {
    queue = [call("editar_cartao", { cartao: "Santander", limite: 100 }), text("Não encontrei o cartão Santander. Você tem: Nubank.")];
    const r = await say(ca, "mude o limite do santander para 100");
    expect(r.reply).toContain("Não encontrei");
    expect(JSON.stringify(sent[sent.length - 1].contents)).toContain("Não encontrei o cartão");
  });

  test("subcategoria e meta de economia", async () => {
    queue = [call("criar_subcategoria", { categoria: "Lazer", nome: "Parque" }), text("Subcategoria Parque criada em Lazer.")];
    await say(ca, "crie a subcategoria parque em lazer");
    const [{ n }] = await q(`select count(*)::int n from subcategories s join categories c on c.id = s.category_id where c.user_id = $1 and s.name = 'Parque'`, ca);
    expect(n).toBe(1);
    queue = [call("definir_meta_economia_mensal", { valor: 1500 }), text("Meta de economia: R$ 1.500,00 por mês.")];
    await say(ca, "define a meta de economia em 1500");
    const [{ m }] = await q(`select monthly_savings_goal_cents::int m from profiles where id = $1`, ca);
    expect(m).toBe(150000);
  });

  test("arquivar pede confirmação", async () => {
    queue = [call("arquivar_cartao", { cartao: "Nubank" })];
    const r = await say(ca, "arquiva o cartão nubank");
    expect(r.reply).toContain("Confirma arquivar o cartão");
    let [k] = await q(`select status from credit_cards where user_id = $1`, ca);
    expect(k.status).toBe("ativo");
    const ok = await say(ca, "sim");
    expect(ok.reply).toContain("arquivado");
    [k] = await q(`select status from credit_cards where user_id = $1`, ca);
    expect(k.status).toBe("arquivado");
  });

  test("pergunta livre vai para a IA; lançamentos continuam sem IA", async () => {
    queue = [text("CDI é a taxa que os bancos usam entre si; muitos investimentos rendem um % dele.")];
    const r = await say(ca, "o que é CDI?");
    expect(r.reply).toContain("CDI");
    const before = sent.length;
    const g = await say(ca, "gastei 40 na padaria");
    expect(g.reply).toContain("R$ 40,00");
    expect(sent.length).toBe(before);
  });

  test("IA fora do ar: resposta amigável", async () => {
    queue = [];
    const r = await say(ca, "cadastre o cartão inter");
    expect(r.reply).toContain("Não consegui falar com a IA");
  });
});
