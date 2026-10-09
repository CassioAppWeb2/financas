// Manual do app: o assistente ensina a usar o aplicativo.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { isAppQuestion, manualAnswer, searchManual } from "../supabase/functions/_shared/manual.ts";

const db = localEngine();
let user = "";
const say = (text: string) => handleMessage({ user_id: user, channel: "app", type: "text", content: text, timestamp: new Date().toISOString() }, { db });
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];
const top = (t: string) => searchManual(t)[0]?.topic.id;

beforeAll(async () => {
  [{ id: user }] = await q(`insert into auth.users(email) values ('manual' || gen_random_uuid() || '@x.com') returning id`);
});

describe("reconhece dúvidas sobre o app", () => {
  const casos: [string, string][] = [
    ["o app fica pedindo permissão do microfone toda vez", "microfone"],
    ["como instalo o app no celular?", "instalar"],
    ["como conecto o telegram?", "telegram"],
    ["como faço para a Bruna entrar na família?", "familia"],
    ["como importo a fatura em pdf?", "importar"],
    ["como marco uma conta como paga?", "apagar"],
    ["onde vejo a fatura do cartão?", "cartoes"],
    ["como exporto para excel?", "relatorios"],
    ["como cadastro uma conta fixa?", "fixas"],
    ["como apago um lançamento errado?", "editar"],
    ["o app não atualizou, continua igual", "atualizar"],
    ["deu erro sem conexão com o servidor", "problemas"],
    ["como divido uma despesa com a Bruna?", "dividir"],
    ["o que é saldo projetado?", "inicio"],
    ["como coloco o saldo inicial da conta?", "contas"],
  ];
  for (const [t, id] of casos) test(t, () => {
    expect(isAppQuestion(t)).toBe(true);
    expect(top(t)).toBe(id);
  });
});

describe("não confunde com consultas e lançamentos", () => {
  for (const t of ["como estão minhas metas?", "como estão minhas finanças?", "quanto gastei este mês?", "posso comprar um celular de 1.800?",
    "gastei 50 no mercado", "qual minha maior despesa?", "cadastre o cartão Nubank que vence dia 10"]) {
    test(t, () => expect(isAppQuestion(t)).toBe(false));
  }
});

describe("pela conversa", () => {
  test("dúvida do microfone responde com o passo a passo", async () => {
    const r = await say("o microfone fica pedindo permissão toda hora, o que eu faço?");
    expect(r.reply).toContain("Permitir");
    expect(r.reply).toContain("iPhone");
  });
  test("chamando pelo nome também funciona", async () => {
    await say("seu nome agora é Jarbas");
    const r = await say("Jarbas, como eu conecto o Telegram?");
    expect(r.reply).toContain("Gerar código de conexão");
  });
  test("manual lista os assuntos", async () => {
    const r = await say("manual");
    expect(r.reply).toContain("Instalar o app no celular");
    expect(manualAnswer("como xyzabc funciona?")).toBeNull();
  });
  test("consultas de finanças continuam normais", async () => {
    const r = await say("quanto gastei este mês?");
    expect(r.reply).not.toContain("Manual");
  });
  test("ajuda menciona as dúvidas do app", async () => {
    expect((await say("ajuda")).reply).toContain("Dúvidas sobre o app");
  });
});
