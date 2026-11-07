// A IA lê primeiro: entende frases livres, correções no meio da conversa e perguntas sobre o que está em andamento.
// (Gemini de mentira: responde conforme o texto da última mensagem.)
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { sanitize, interpretWithAI } from "../supabase/functions/_shared/ai.ts";
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

// respostas da IA conforme a última mensagem
const respostas: [RegExp, object][] = [];
const prompts: string[] = [];
let geminiFora = false;
const fakeFetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  const groq = String(url).includes("groq");
  const ultima = groq ? body.messages.at(-1).content : body.contents.at(-1).parts[0].text;
  prompts.push(groq ? body.messages[0].content : body.systemInstruction.parts[0].text);
  if (geminiFora && !groq) return new Response("{}", { status: 503 });
  const hit = respostas.find(([rx]) => rx.test(ultima));
  const json = JSON.stringify(hit ? hit[1] : { intent: "OTHER", confidence: 0.2 });
  if (groq) return new Response(JSON.stringify({ choices: [{ message: { content: json } }] }), { status: 200 });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: json }] } }] }), { status: 200 });
}) as unknown as typeof fetch;
const ai = { geminiKey: "teste", groqKey: "teste", fetch: fakeFetch };
let ca = "", br = "";
const say = (uid: string, content: string, type: "text" | "audio" = "text") => handleMessage({ user_id: uid, channel: "app", type, content, timestamp: "" }, { db, ai });

beforeAll(async () => {
  ca = await newUser("Cássio"); br = await newUser("Bruna");
  const inv = await asUser(ca, "app_family_invite");
  await asUser(br, "app_family_join", { codigo: inv.codigo });
  await asUser(ca, "app_save_card", { nome: "Nubank", fechamento: 5, vencimento: 12 });
});

describe("a IA entende frases livres", () => {
  test("“dividido em quatro parcelas” é parcelamento: lança direto, sem perguntar divisão", async () => {
    respostas.push([/Minimal Club/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 507, parcelas: 4, cartao: "Nubank",
      estabelecimento: "Minimal Club", descricao: "Camisetas", categoria: "Vestuário", subcategoria: "Roupas", de_quem: "eu", dividir: false, confidence: 0.95 }]);
    const r = await say(ca, "Jarbas, fiz uma compra de R$ 507,00 na Minimal Club, com o cartão da Nubank dividido em quatro parcelas.");
    expect(r.reply).toContain("Registrei **R$ 507,00** em **Vestuário > Roupas** em 4x");
    expect(r.reply).not.toContain("divisão");
    const [t] = await q(`select member_id, card_id is not null cartao from transactions where user_id = $1 and amount_cents = 12675 limit 1`, ca);
    expect([t.member_id, t.cartao]).toEqual([ca, true]);
    expect(prompts.at(-1)).toContain("Quem está falando: Cássio");
    expect(prompts.at(-1)).toContain("Bruna");
  });

  test("sem IA, as regras também não confundem “dividido em quatro parcelas” com divisão", () => {
    const uc = { hoje: "2026-11-05", categorias: [], contas: [], cartoes: ["Nubank"], membros: [{ id: "c", nome: "Cássio", eu: true }, { id: "b", nome: "Bruna", eu: false }] } as any;
    const r = interpretRules("fiz uma compra de R$ 507,00 na Minimal Club, com o cartão da Nubank dividido em quatro parcelas", uc);
    expect([r.dividir, r.parcelas, r.valor]).toEqual([undefined, 4, 507]);
  });

  test("valor que não está na mensagem é ignorado (a IA não inventa números)", () => {
    const uc = { hoje: "2026-11-05", categorias: [], contas: [], cartoes: [], membros: [] } as any;
    const r = sanitize({ intent: "CREATE_EXPENSE", tipo: "despesa", valor: 999 }, "gastei no mercado", uc);
    expect(r?.valor).toBeUndefined();
  });

  test("Gemini fora do ar: usa a Groq", async () => {
    geminiFora = true;
    respostas.push([/padaria do bairro/, { intent: "CREATE_EXPENSE", tipo: "despesa", valor: 18, categoria: "Alimentação", confidence: 0.9 }]);
    const uc = { hoje: "2026-11-05", categorias: [{ tipo: "despesa", nome: "Alimentação", subcategorias: [] }], contas: [], cartoes: [], membros: [] } as any;
    const r = await interpretWithAI("paguei 18 na padaria do bairro", uc, ai);
    expect([r?.provider, r?.valor, r?.categoria]).toEqual(["groq", 18, "Alimentação"]);
    geminiFora = false;
  });
});

describe("correções no meio da conversa", () => {
  test("“não é dividido, é só meu…” corrige o lançamento em andamento (não cancela)", async () => {
    respostas.unshift([/Loja Azul/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 300, parcelas: 3, cartao: "Nubank",
      estabelecimento: "Loja Azul", dividir: true, confidence: 0.8 }]);
    const q1 = await say(ca, "comprei 300 na Loja Azul no cartão Nubank em 3 vezes dividido com a Bruna");
    expect(q1.reply).toContain("Como fica a divisão");
    respostas.unshift([/só meu/, { acao: "responder_pendente", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 300, parcelas: 3, cartao: "Nubank",
      estabelecimento: "Loja Azul", descricao: "Camiseta", categoria: "Vestuário", de_quem: "eu", dividir: false, confidence: 0.95 }]);
    const r = await say(ca, "Não é dividido com a Bruna, é só meu. E foi camiseta, vestuário.");
    expect(r.reply).not.toContain("cancelado");
    expect(r.reply).toContain("Registrei **R$ 300,00** em **Vestuário**");
    const rows = await q(`select member_id, settle_status from transactions where user_id = $1 and amount_cents = 10000 and deleted_at is null`, ca);
    expect(rows.length).toBe(3);
    expect(rows.every((x) => x.member_id === ca && x.settle_status === null)).toBe(true);
  });

  test("“e o lançamento? você fez?” responde o que falta, sem perder o que estava em andamento", async () => {
    respostas.unshift([/luminária/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 89, descricao: "Luminária", confidence: 0.9 }]);
    const q1 = await say(ca, "comprei uma luminária de 89 pra mim");
    expect(q1.reply).toMatch(/categoria/);
    respostas.unshift([/você fez/i, { acao: "status_pendente", intent: "OTHER", confidence: 0.9 }]);
    const r = await say(ca, "E o lançamento? Você fez?");
    expect(r.reply).toContain("Ainda não registrei");
    expect(r.reply).toMatch(/categoria/);
    const ok = await say(ca, "outros gastos");
    expect(ok.reply).toContain("Registrei **R$ 89,00** em **Outros gastos");
  });

  test("“não” sozinho cancela", async () => {
    respostas.unshift([/caneca/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 35, descricao: "Caneca", confidence: 0.9 }]);
    await say(ca, "comprei uma caneca de 35");
    const r = await say(ca, "não");
    expect(r.reply).toContain("cancelado");
  });

  test("áudio respondendo a categoria não pede para confirmar o valor da mensagem anterior", async () => {
    respostas.unshift([/agenda/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 508, descricao: "Agenda", confidence: 0.9 }]);
    const q1 = await say(ca, "comprei uma agenda de 508", "audio");
    expect(q1.reply).toMatch(/categoria/);
    respostas.unshift([/Lançar em educação/, { acao: "responder_pendente", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 508, descricao: "Agenda", categoria: "Educação", confidence: 0.9 }]);
    const r = await say(ca, "Lançar em educação", "audio");
    expect(r.reply).not.toContain("não tenho certeza");
    expect(r.reply).toContain("Registrei **R$ 508,00** em **Educação");
  });

  test("a IA recebe as mensagens anteriores da conversa", async () => {
    expect(prompts.length).toBeGreaterThan(0);
    const [{ rec }] = await q(`select fe_chat_state($1, '{"historico": true}') -> 'recentes' rec`, ca);
    expect(rec.length).toBeGreaterThan(2);
    expect(rec.some((m: any) => m.papel === "assistant")).toBe(true);
  });
});

describe("correções", () => {
  test("“o salário foi no dia 30/10” muda a data, mesmo com a IA repetindo a categoria atual", async () => {
    await say(ca, "Recebi 6 mil de salário.");
    respostas.push([/dia 30/, { intent: "EDIT_TRANSACTION", tipo: "receita", valor: 10, data: "2026-10-30", campo_correcao: "data",
      categoria: "Salário e remuneração", subcategoria: "Salário", descricao: "Salário", confidence: 0.95 }]);
    const r = await say(ca, "O salário foi recebido no dia 30 do 10 da mensagem anterior.");
    expect(r.reply).toContain("data:");
    expect(r.reply).toContain("**30/10/2026**");
    const [t] = await q(`select date::text d, amount_cents::int v from transactions where user_id = $1 and type = 'receita' and deleted_at is null order by created_at desc limit 1`, ca);
    expect([t.d, t.v]).toEqual(["2026-10-30", 600000]);
  });
});

describe("compra com valor a receber de alguém de fora da família", () => {
  const frase = "Comprei um corsa por 10 mil! Eu vou pagar 8 mil, preciso cobrar de outra pessoa os 2 mil, me lembrar de cobrar todo dia 10 de cada mês durante 10 meses";
  test("Corsa: compra de 10 mil hoje + 10 parcelas de 200 a receber (não 10 de 2.000, nada para a Bruna)", async () => {
    respostas.unshift([/corsa por 10 mil/, { intent: "CREATE_EXPENSE", tipo: "despesa", valor: 10000, descricao: "Corsa", categoria: "Transporte",
      dividir: false, a_receber: { valor: 2000, parcelas: 10, dia: 10, de: "outra pessoa" }, confidence: 0.95 }]);
    const r = await say(ca, frase);
    expect(r.reply).toContain("**R$ 10.000,00**");
    expect(r.reply).toContain("**10x de R$ 200,00**");
    expect(r.reply).not.toContain("Bruna");
    const desp = await q(`select amount_cents::int v, date::text d, member_id from transactions where user_id = $1 and description = 'Corsa' and deleted_at is null`, ca);
    expect(desp.map((t) => t.v)).toEqual([1000000]);
    const hoje = (await q(`select fe_today($1::uuid)::text d`, ca))[0].d;
    expect(desp[0].d).toBe(hoje);
    const rec = await q(`select amount_cents::int v, extract(day from date)::int dia from transactions where user_id = $1 and type = 'receita' and description like 'A receber%' and deleted_at is null`, ca);
    expect(rec.length).toBe(10);
    expect(rec.every((t) => t.v === 20000 && t.dia === 10)).toBe(true);
    // recebeu a 1ª parcela: dá baixa nela, sem criar outra receita
    respostas.unshift([/^recebi R\$ 200/, { intent: "CREATE_INCOME", tipo: "receita", valor: 200, confidence: 0.9 }]);
    const b = await say(ca, "recebi R$ 200,00");
    respostas.shift();
    const st = await q(`select status, count(*)::int n from transactions where user_id = $1 and type = 'receita' and amount_cents = 20000 and deleted_at is null group by status order by status`, ca);
    expect(b.reply).toContain("Marquei como *recebido*");
    expect(st.map((x) => [x.status, x.n])).toEqual([["efetivado", 1], ["previsto", 9]]);
    respostas.shift();
  });

  test("mesmo se a IA errar (divide com a família e usa o dia 10 como data), o app não joga a parte para a Bruna", async () => {
    respostas.unshift([/corsa por 10 mil/, { intent: "CREATE_EXPENSE", tipo: "despesa", valor: 10000, data: "2026-10-10", descricao: "Corsa",
      categoria: "Transporte", dividir: true, partes: [{ pessoa: "eu", valor: 8000 }], confidence: 0.95 }]);
    await q(`update transactions set deleted_at = now() where user_id = $1 and description = 'Corsa'`, ca);
    const r = await say(ca, frase.replace("corsa", "corsa"));
    expect(r.reply).not.toContain("Bruna");
    const desp = await q(`select amount_cents::int v, date::text d from transactions where user_id = $1 and description = 'Corsa' and deleted_at is null`, ca);
    const hoje = (await q(`select fe_today($1::uuid)::text d`, ca))[0].d;
    expect(desp.map((t) => [t.v, t.d])).toEqual([[1000000, hoje]]);
    respostas.shift();
  });
});
