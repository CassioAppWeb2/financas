// Família: duas pessoas, mesmo banco, visão familiar e individual.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";

const db = localEngine();
let cassio = "", ana = "", outro = "";

const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];
const asUser = <T>(uid: string, fn: string, p: object = {}) =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await tx.unsafe(`set local role authenticated`);
    return ((await tx.unsafe(`select to_jsonb(public.${fn}($1::jsonb)) r`, [p])) as any)[0].r as T;
  });
const say = (uid: string, content: string, channel: "app" | "whatsapp" | "telegram" = "app") =>
  handleMessage({ user_id: uid, channel, type: "text", content, timestamp: "" }, { db });
const newUser = async (name: string) =>
  (await q(`insert into auth.users(email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
    `${name}.${crypto.randomUUID()}@x.com`, { name }))[0].id as string;

beforeAll(async () => {
  cassio = await newUser("Cássio");
  ana = await newUser("Ana");
  outro = await newUser("Fulano");
});

describe("convite e entrada na família", () => {
  test("titular gera convite e a esposa entra", async () => {
    const inv = await asUser<any>(cassio, "app_family_invite");
    expect(inv.codigo).toHaveLength(8);
    const r = await asUser<any>(ana, "app_family_join", { codigo: inv.codigo.toLowerCase() });
    expect(r).toMatchObject({ status: "ok", titular: "Cássio" });
    const boot = await asUser<any>(ana, "app_bootstrap");
    expect(boot.familia.titular).toBe(false);
    expect(boot.familia.membros.map((m: any) => m.nome)).toEqual(["Cássio", "Ana"]);
  });

  test("convite já usado não vale de novo", async () => {
    const inv = await asUser<any>(cassio, "app_family_invite");
    await asUser(ana, "app_family_join", { codigo: inv.codigo }).catch(() => {});
    await expect(asUser(outro, "app_family_join", { codigo: inv.codigo })).rejects.toThrow(/inválido/);
  });

  test("membro não pode convidar", async () => {
    await expect(asUser(ana, "app_family_invite")).rejects.toThrow(/titular/);
  });
});

describe("lançamentos e consultas família x individual", () => {
  test("cada um registra pelo seu canal", async () => {
    expect((await say(ana, "gastei 100 no supermercado", "telegram")).reply).toContain("R$ 100,00");
    expect((await say(cassio, "paguei 200 de gasolina", "whatsapp")).reply).toContain("R$ 200,00");
    const r = await say(cassio, "gastamos 300 no mercado");
    expect(r.reply).toContain("Família");
    const rows = await q(`select member_id, created_by, user_id from transactions where user_id = $1 and deleted_at is null order by created_at`, cassio);
    expect(rows.map((x) => x.member_id)).toEqual([ana, cassio, null]);
    expect(rows.every((x) => x.user_id === cassio)).toBe(true);
  });

  test("total da família com divisão por pessoa", async () => {
    const r = await say(ana, "quanto gastei esse mês?");
    expect(r.reply).toContain("a família gastou");
    expect(r.reply).toContain("R$ 600,00");
    expect(r.reply).toContain("Por pessoa");
    expect(r.reply).toContain("Você R$ 100,00");
  });

  test("individual: eu / esposa / pelo nome / compartilhados", async () => {
    expect((await say(cassio, "quanto eu gastei esse mês?")).reply).toContain("R$ 200,00");
    expect((await say(cassio, "quanto minha esposa gastou?")).reply).toContain("R$ 100,00");
    expect((await say(ana, "quanto o Cássio gastou?")).reply).toContain("R$ 200,00");
    expect((await say(ana, "quanto foram os gastos compartilhados?")).reply).toContain("R$ 300,00");
  });

  test("dashboard com filtro por pessoa", async () => {
    const fam = await asUser<any>(ana, "app_dashboard", {});
    const meu = await asUser<any>(ana, "app_dashboard", { membro_id: ana });
    expect(fam.despesas_cents).toBe(60000);
    expect(meu.despesas_cents).toBe(10000);
    expect(fam.despesas_por_membro).toHaveLength(3);
  });

  test("lançamento pelo formulário para a família", async () => {
    const cat = (await asUser<any>(ana, "app_bootstrap")).categorias.find((c: any) => c.nome === "Moradia");
    const r = await asUser<any>(ana, "app_save_transaction", { tipo: "despesa", valor: 50, categoria_id: cat.id, membro: "familia" });
    expect(r.lancamento.membro).toBe("Família");
    const lista = await asUser<any>(cassio, "app_transactions", { membro_id: "familia" });
    expect(lista.itens.length).toBe(2);
  });

  test("'apague o último' apaga só o que a própria pessoa registrou", async () => {
    await say(cassio, "gastei 12 no café");
    const r1 = await say(ana, "apague o último lançamento");
    expect(r1.reply).toContain("Família"); // o último que a Ana registrou foi o de Moradia para a família
    await say(ana, "sim");
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id = $1 and deleted_at is null and description ilike '%café%'`, cassio);
    expect(n).toBe(1);
  });

  test("contas e categorias são compartilhadas", async () => {
    await asUser(ana, "app_save_account", { nome: "Nubank Ana", tipo: "digital" });
    const boot = await asUser<any>(cassio, "app_bootstrap");
    expect(boot.contas.contas.map((c: any) => c.nome)).toContain("Nubank Ana");
  });

  test("conversa de cada um é separada", async () => {
    const hist = await asUser<any[]>(ana, "app_chat_history");
    expect(hist.some((m) => m.content.includes("gasolina"))).toBe(false);
  });
});

describe("isolamento e saída", () => {
  test("outra família não vê nada", async () => {
    expect((await say(outro, "quanto gastei esse mês?")).reply).toContain("Não encontrei");
    const n = await db.sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [outro]);
      await tx.unsafe(`set local role authenticated`);
      return ((await tx.unsafe(`select count(*)::int n from transactions`)) as any)[0].n;
    });
    expect(n).toBe(0);
  });

  test("RLS: a esposa lê os lançamentos da família direto da tabela", async () => {
    const n = await db.sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [ana]);
      await tx.unsafe(`set local role authenticated`);
      return ((await tx.unsafe(`select count(*)::int n from transactions`)) as any)[0].n;
    });
    expect(n).toBeGreaterThan(3);
  });

  test("quem já tem lançamentos não entra em outra família", async () => {
    await say(outro, "gastei 10 na padaria");
    const inv = await asUser<any>(cassio, "app_family_invite");
    await expect(asUser(outro, "app_family_join", { codigo: inv.codigo })).rejects.toThrow(/lançamentos/);
  });

  test("titular remove a pessoa e ela volta a ter dados só dela", async () => {
    await asUser(cassio, "app_family_remove", { membro_id: ana });
    const r = await say(ana, "quanto gastei esse mês?");
    expect(r.reply).toContain("Não encontrei");
    expect((await asUser<any>(cassio, "app_bootstrap")).familia.membros).toHaveLength(1);
  });
});
