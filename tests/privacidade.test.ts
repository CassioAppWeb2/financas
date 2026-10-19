// Privacidade na família: base compartilhada, mas cada pessoa escolhe o que mostra.
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
const say = (uid: string, content: string) => handleMessage({ user_id: uid, channel: "app", type: "text", content, timestamp: "" }, { db });
let ca = "", br = "";
const despesas = async (uid: string, membro_id = "") => Number((await asUser(uid, "app_dashboard", { membro_id })).despesas_cents);

beforeAll(async () => {
  ca = await newUser("Cássio"); br = await newUser("Bruna");
  const inv = await asUser(ca, "app_family_invite");
  await asUser(br, "app_family_join", { codigo: inv.codigo });
  await asUser(ca, "app_save_account", { nome: "Banrisul", tipo: "corrente", saldo_inicial: 1000 });
  await asUser(br, "app_save_account", { nome: "Itaú Bruna", tipo: "corrente", saldo_inicial: 2000 });
  await asUser(ca, "app_save_card", { nome: "Nubank", fechamento: 5, vencimento: 12 });
  await asUser(br, "app_save_card", { nome: "Inter Bruna", fechamento: 3, vencimento: 10 });
  await say(br, "gastei 100 no mercado");            // individual da Bruna
  await say(br, "gastamos 200 na farmácia");         // da família
  await say(ca, "gastei 50 na padaria");             // individual do Cássio
});

describe("cada um vê o seu + o da família", () => {
  test("ninguém liberou: o Cássio não vê os gastos nem as contas/cartões da Bruna", async () => {
    expect(await despesas(ca)).toBe(5000 + 20000);
    expect(await despesas(br)).toBe(10000 + 20000);
    const lista = await asUser<any>(ca, "app_transactions", {});
    expect(JSON.stringify(lista)).not.toContain("10000");
    const boot = await asUser<any>(ca, "app_bootstrap");
    expect(boot.contas.contas.map((a: any) => a.nome)).not.toContain("Itaú Bruna");
    expect(boot.cartoes.map((k: any) => k.nome)).toEqual(["Nubank"]);
    expect(boot.familia.membros.find((m: any) => m.nome === "Bruna").compartilha_gastos).toBe(false);
    const dash = await asUser<any>(ca, "app_dashboard", {});
    expect(dash.despesas_por_membro.map((x: any) => x.membro).sort()).toEqual(["Cássio", "Família"]);
  });

  test("pelo assistente também: “quanto a Bruna gastou?” respeita a privacidade", async () => {
    const r = await say(ca, "quanto a Bruna gastou este mês?");
    expect(r.reply).toContain("Bruna não compartilha os gastos individuais");
    const total = await say(ca, "quanto gastei este mês?");
    expect(total.reply).not.toContain("350,00");
  });

  test("compra dividida aparece para os dois (a parte de cada um e o acerto)", async () => {
    await say(ca, "comprei uma geladeira de 1.000 no cartão nubank, dividido: eu 600 e a bruna 400");
    const d = await asUser<any>(br, "app_debts", { mes: "2099-12" });
    expect(d.devo[0].total_cents).toBe(40000);
    const d2 = await asUser<any>(ca, "app_debts", { mes: "2099-12" });
    expect(d2.recebo[0].total_cents).toBe(40000);
    // a fatura do Cássio tem a compra inteira
    const [{ tot }] = await q(`select sum(amount_cents)::int tot from transactions where user_id = $1 and description like 'Geladeira%'`, ca);
    expect(tot).toBe(100000);
  });

  test("a Bruna libera os gastos: o Cássio passa a ver (e pode filtrar por ela)", async () => {
    await asUser(br, "app_family_share", { gastos: true });
    expect(await despesas(ca)).toBeGreaterThanOrEqual(5000 + 20000 + 10000);
    expect(await despesas(ca, br)).toBeGreaterThanOrEqual(10000);
    const r = await say(ca, "quanto a Bruna gastou este mês?");
    expect(r.reply).not.toContain("não compartilha");
    // contas ainda privadas
    const boot = await asUser<any>(ca, "app_bootstrap");
    expect(boot.contas.contas.map((a: any) => a.nome)).not.toContain("Itaú Bruna");
  });

  test("libera contas e cartões: orçamento familiar completo", async () => {
    const s = await asUser<any>(br, "app_family_share", { contas: true });
    expect(s).toEqual({ gastos: true, contas: true });
    const boot = await asUser<any>(ca, "app_bootstrap");
    expect(boot.contas.contas.map((a: any) => a.nome)).toContain("Itaú Bruna");
    expect(boot.cartoes.map((k: any) => k.nome).sort()).toEqual(["Inter Bruna", "Nubank"]);
  });

  test("a Bruna desliga de novo: volta a ser só dela", async () => {
    await asUser(br, "app_family_share", { gastos: false, contas: false });
    expect(await despesas(ca)).toBe(5000 + 20000 + 60000);   // dele + família + a parte dele na geladeira
    const boot = await asUser<any>(ca, "app_bootstrap");
    expect(boot.cartoes.map((k: any) => k.nome)).toEqual(["Nubank"]);
  });
});
