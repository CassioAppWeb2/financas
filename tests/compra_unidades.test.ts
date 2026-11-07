// Compra por unidade e paga de formas diferentes (caso real, por áudio):
//   "Jarbas, comprei 5 cervejas, 3 delas paguei no Pix e 2 com dinheiro."  ->  pergunta o preço
//   "Cada cerveja é R$ 12,00."  ->  R$ 36 no Pix (conta do banco) + R$ 24 em dinheiro (Carteira)
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { sanitize } from "../supabase/functions/_shared/ai.ts";
import { findAmounts, extractAmount } from "../supabase/functions/_shared/money.ts";

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

const respostas: [RegExp, object][] = [];
const fakeFetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  const groq = String(url).includes("groq");
  const ultima = groq ? body.messages.at(-1).content : body.contents.at(-1).parts[0].text;
  const hit = respostas.find(([rx]) => rx.test(ultima.split("\n").at(-1)));
  const json = JSON.stringify(hit ? hit[1] : { intent: "OTHER", confidence: 0.2 });
  if (groq) return new Response(JSON.stringify({ choices: [{ message: { content: json } }] }), { status: 200 });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: json }] } }] }), { status: 200 });
}) as unknown as typeof fetch;
const ai = { geminiKey: "teste", groqKey: "teste", fetch: fakeFetch };
let u = "";
const say = (content: string, type: "text" | "audio" = "audio") => handleMessage({ user_id: u, channel: "app", type, content, timestamp: "" }, { db, ai });
const doDia = () => q(`select t.amount_cents::int v, t.description d, a.name conta, c.name cat from transactions t
  left join accounts a on a.id = t.account_id left join categories c on c.id = t.category_id
  where t.user_id = $1 and t.deleted_at is null order by t.created_at, t.amount_cents desc`, u);

beforeAll(async () => {
  u = await newUser("Cássio");
  await asUser(u, "app_save_account", { nome: "Conta banri", tipo: "corrente", saldo_inicial: 1000 });
});

describe("números de quantidade não viram preço", () => {
  test("“5 cervejas, 3 delas no Pix e 2 com dinheiro” não tem valor", () => {
    const t = "comprei 5 cervejas, 3 delas paguei no Pix e 2 com dinheiro";
    expect(findAmounts(t).filter((a) => a.role === "valor")).toEqual([]);
    expect(extractAmount(t).valor).toBeUndefined();
    // mas "paguei 50 no pix" continua sendo valor
    expect(extractAmount("paguei 50 no pix").valor).toBe(50);
  });

  test("a IA não pode transformar uma quantidade em preço; as contas são feitas pelo app", () => {
    const uc = { hoje: "2026-11-06", categorias: [], contas: ["Carteira"], cartoes: [], membros: [] } as any;
    const t = "comprei 5 cervejas, 3 delas paguei no Pix e 2 com dinheiro";
    const r = sanitize({ intent: "CREATE_EXPENSE", tipo: "despesa", valor: 2, quantidade: 5, descricao: "Cervejas",
      pagamentos: [{ forma_pagamento: "pix", quantidade: 3 }, { forma_pagamento: "dinheiro", quantidade: 2 }] }, t, uc)!;
    expect(r.valor).toBeUndefined();
    expect(r.quantidade).toBe(5);
    const pend = { lancamento: r, pergunta: "Quanto custou cada uma?" };
    const r2 = sanitize({ acao: "responder_pendente", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 60, valor_unitario: 12 }, "Cada cerveja é R$ 12,00.", uc, pend)!;
    expect(r2.valor).toBe(60);
    expect(r2.pagamentos?.map((p) => [p.forma_pagamento, p.valor])).toEqual([["pix", 36], ["dinheiro", 24]]);
  });

  test("total dito + unidades de cada forma: reparte proporcionalmente", () => {
    const uc = { hoje: "2026-11-06", categorias: [], contas: [], cartoes: [], membros: [] } as any;
    const r = sanitize({ intent: "CREATE_EXPENSE", tipo: "despesa", valor: 50, quantidade: 5,
      pagamentos: [{ forma_pagamento: "pix", quantidade: 3 }, { forma_pagamento: "dinheiro", quantidade: 2 }] },
      "comprei 5 cervejas por 50 reais, 3 no pix e 2 em dinheiro", uc)!;
    expect(r.pagamentos?.map((p) => p.valor)).toEqual([30, 20]);
  });
});

describe("conversa por áudio (caso real)", () => {
  test("pergunta o preço e lança uma despesa por forma de pagamento, cada uma na conta certa", async () => {
    respostas.push([/5 cervejas/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 2, quantidade: 5,
      descricao: "Cervejas", categoria: "Lazer e entretenimento", subcategoria: "Restaurantes de lazer", forma_pagamento: "pix",
      pagamentos: [{ forma_pagamento: "pix", quantidade: 3 }, { forma_pagamento: "dinheiro", quantidade: 2 }], confidence: 0.9 }]);
    respostas.push([/Cada cerveja/, { acao: "responder_pendente", intent: "CREATE_EXPENSE", tipo: "despesa", valor_unitario: 12, valor: 60, confidence: 0.9 }]);

    const r1 = await say("O que você diz? Jarbas, comprei 5 cervejas, 3 delas paguei no Pix e 2 com dinheiro.");
    expect(r1.reply).toContain("Quanto custou cada uma");
    expect(r1.reply).not.toContain("R$ 2,00");
    expect(await doDia()).toEqual([]);

    const r2 = await say("Cada cerveja é R$ 12,00.");
    expect(r2.reply).toContain("total **R$ 60,00**");
    const tx = await doDia();
    expect(tx.map((t) => [t.v, t.conta])).toEqual([[3600, "Conta banri"], [2400, "Carteira"]]);
    expect(tx[0].d).toBe("Cervejas (3 un.)");
  });

  test("resposta curta “12” sem IA também vale como preço de cada uma", async () => {
    respostas.push([/6 refrigerantes/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", quantidade: 6,
      descricao: "Refrigerantes", categoria: "Alimentação", subcategoria: "Supermercado",
      pagamentos: [{ forma_pagamento: "pix", quantidade: 4 }, { forma_pagamento: "dinheiro", quantidade: 2 }], confidence: 0.9 }]);
    await say("comprei 6 refrigerantes, 4 no pix e 2 em dinheiro", "text");
    const r = await say("8", "text");
    expect(r.reply).toContain("total **R$ 48,00**");
    const tx = (await doDia()).slice(-2);
    expect(tx.map((t) => [t.v, t.conta])).toEqual([[3200, "Conta banri"], [1600, "Carteira"]]);
  });

  test("Pix sem dizer a conta vai para a conta do banco, não para a Carteira", async () => {
    respostas.push([/pastel/, { acao: "nova_mensagem", intent: "CREATE_EXPENSE", tipo: "despesa", valor: 15, descricao: "Pastel",
      categoria: "Alimentação", subcategoria: "Lanches", forma_pagamento: "pix", confidence: 0.9 }]);
    await say("paguei 15 reais de pastel no pix na feira de hoje à tarde", "text");
    const [t] = (await doDia()).slice(-1);
    expect([t.v, t.conta]).toEqual([1500, "Conta banri"]);
  });
});
