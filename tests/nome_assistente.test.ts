// Nome do assistente: batizar ("seu nome agora é Jarbas") e ser chamado pelo nome.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { stripVocative, detectRename, asksName } from "../supabase/functions/_shared/naming.ts";

const db = localEngine();
let user = "";
const say = (text: string) => handleMessage({ user_id: user, channel: "app", type: "text", content: text, timestamp: new Date().toISOString() }, { db });
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];

beforeAll(async () => {
  [{ id: user }] = await q(`insert into auth.users(email) values ('nome' || gen_random_uuid() || '@x.com') returning id`);
});

describe("regras de nome", () => {
  test("pedidos de nome", () => {
    expect(detectRename("seu nome agora é Jarbas")).toBe("Jarbas");
    expect(detectRename("pode se chamar jarbas")).toBe("Jarbas");
    expect(detectRename("vou te chamar de Dona Neide, tá?")).toBe("Dona Neide");
    expect(detectRename("quero te chamar de Jarvis")).toBe("Jarvis");
    expect(detectRename("muda seu nome para Zé")).toBe("Zé");
    expect(detectRename("tira seu nome")).toBe("");
    expect(detectRename("pode se chamar")).toBeNull();
    expect(detectRename("gastei 50 no mercado")).toBeUndefined();
  });
  test("vocativo", () => {
    expect(stripVocative("Jarbas, gastei 50 no mercado", "Jarbas")).toEqual({ text: "gastei 50 no mercado", chamou: true });
    expect(stripVocative("jarbás gastei 50", "Jarbas").text).toBe("gastei 50");
    expect(stripVocative("quanto gastei hoje, Jarbas?", "Jarbas")).toEqual({ text: "quanto gastei hoje?", chamou: true });
    expect(stripVocative("bom dia Jarbas, gastei 20 na padaria", "Jarbas").text).toBe("bom dia, gastei 20 na padaria");
    expect(stripVocative("Oi Jarbas", "Jarbas").text).toBe("Oi");
    expect(stripVocative("Jarbas", "Jarbas").text).toBe("");
    expect(stripVocative("gastei 50 no Jarbaszinho", "Jarbas").chamou).toBe(false);
    expect(stripVocative("Jarbas, gastei 50", null).chamou).toBe(false);
    expect(asksName("qual é o seu nome?")).toBe(true);
  });
});

describe("conversa", () => {
  test("sem nome, explica como dar um", async () => {
    expect((await say("qual é o seu nome?")).reply).toContain("Ainda não tenho nome");
  });
  test("batiza e passa a responder pelo nome", async () => {
    const r = await say("a partir de agora você se chama Jarbas");
    expect(r.reply).toContain("meu nome é *Jarbas*");
    const [{ assistant_name }] = await q(`select assistant_name from profiles where id = $1`, user);
    expect(assistant_name).toBe("Jarbas");
    expect((await say("qual seu nome?")).reply).toContain("Jarbas");
  });
  test("chamado pelo nome, lança normalmente", async () => {
    const r = await say("Jarbas, gastei 42 na padaria");
    expect(r.reply).toContain("R$ 42,00");
    expect(r.reply).toContain("Padaria");
    const r2 = await say("quanto gastei este mês, Jarbas?");
    expect(r2.reply).toContain("42,00");
  });
  test("só o nome = atende", async () => {
    expect((await say("Jarbas")).reply).toContain("Estou aqui");
    expect((await say("oi Jarbas")).reply).toContain("Aqui é Jarbas");
  });
  test("nome inválido e remoção", async () => {
    expect((await say("seu nome agora é 123")).reply).toContain("Use só letras");
    expect((await say("tira seu nome")).reply).toContain("voltei a ser");
    const [{ assistant_name }] = await q(`select assistant_name from profiles where id = $1`, user);
    expect(assistant_name).toBeNull();
  });
});

describe("não confunde com outros pedidos", () => {
  test("cadastros e valores", () => {
    expect(detectRename("crie uma conta que vai se chamar Itaú")).toBeUndefined();
    expect(detectRename("a partir de agora é 50 reais o almoço")).toBeUndefined();
    expect(detectRename("a partir de agora você é o Jarbas")).toBe("Jarbas");
    expect(detectRename("vai se chamar Jarbas")).toBe("Jarbas");
  });
});
