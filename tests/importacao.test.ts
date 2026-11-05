// Importação de extrato do banco (OFX/CSV): leitura do arquivo, banco reconhecido, contas a pagar quitadas,
// pagamento de fatura reconhecido, categorias sugeridas pela IA e envio pelo chat/Telegram.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { createAppHandler } from "../supabase/functions/_shared/channels.ts";
// @ts-ignore módulo JS
import { parseExtrato, guessDestino } from "../web/js/extrato.js";

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
const iso = (n: number) => { const d = new Date(Date.now() - 3 * 3600_000); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ofxDate = (s: string) => s.replace(/-/g, "") + "120000[-3:BRT]";

// IA de mentira para categorias: "ZAFFARI" -> Alimentação > Supermercado
const fakeFetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  const pergunta = String(url).includes("groq") ? body.messages.at(-1).content : body.contents.at(-1).parts[0].text;
  let itens: any[] = [];
  try { itens = JSON.parse(pergunta); } catch { /* não é categorização */ }
  const json = Array.isArray(itens) ? { itens: itens.filter((x) => /ZAFFARI/i.test(x.descricao)).map((x) => ({ linha: x.linha, categoria: "Alimentação", subcategoria: "Supermercado" })) } : { intent: "OTHER" };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }), { status: 200 });
}) as unknown as typeof fetch;
const ai = { geminiKey: "teste", fetch: fakeFetch };

let u = "", conta = "", card = "";
const OFX_CONTA = () => `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>0041</BANKID><ACCTID>12345678</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${ofxDate(iso(-1))}<TRNAMT>-1200.00<FITID>A1<MEMO>PIX ENVIADO IMOBILIARIA SOL</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${ofxDate(iso(-2))}<TRNAMT>-850.40<FITID>A2<MEMO>PAGAMENTO FATURA NUBANK</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${ofxDate(iso(-3))}<TRNAMT>-187.35<FITID>A3<MEMO>COMPRA CARTAO DEB ZAFFARI ESTRELA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>${ofxDate(iso(-4))}<TRNAMT>5000.00<FITID>A4<MEMO>CREDITO SALARIO EMPRESA X</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

beforeAll(async () => {
  u = await newUser("Cássio");
  conta = (await asUser(u, "app_save_account", { nome: "Banrisul", tipo: "corrente", saldo_inicial: 3000 })).id;
  card = (await asUser(u, "app_save_card", { nome: "Nubank", fechamento: 5, vencimento: 12 })).id;
  // aluguel a pagar (pendente) que vai aparecer no extrato
  await asUser(u, "app_save_transaction", { tipo: "despesa", valor: 1200, data: iso(2), descricao: "Aluguel", categoria: "Moradia e contas da casa", conta_id: conta, pendente: true });
});

describe("leitura do arquivo", () => {
  test("OFX da conta: lançamentos, banco pelo código (041 = Banrisul) e destino reconhecido", () => {
    const p = parseExtrato(OFX_CONTA());
    expect([p.ofx, p.cartao, p.banco, p.final, p.itens.length]).toEqual([true, false, "Banrisul", "5678", 4]);
    expect(p.itens[0]).toMatchObject({ data: iso(-1), valor: -1200, descricao: "PIX ENVIADO IMOBILIARIA SOL", id_externo: "ofx:A1" });
    const d = guessDestino(p.banco, [{ id: "x", nome: "Itaú" }, { id: "y", nome: "Conta Banrisul" }], [], false);
    expect(d.id).toBe("y");
  });
  test("OFX de cartão (Nubank, código 260) e CSV do Nubank", () => {
    const p = parseExtrato(`<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKID>260</BANKID><STMTTRN><DTPOSTED>20261101<TRNAMT>-50.00<FITID>B1<MEMO>Uber</STMTTRN></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`);
    expect([p.cartao, p.banco, p.itens[0].valor]).toEqual([true, "Nubank", -50]);
    const csv = parseExtrato("date,title,amount\n2026-11-01,Uber,23.90\n2026-11-02,Ifood,58.00");
    expect([csv.cartao, csv.banco, csv.itens.length, csv.itens[1].valor]).toEqual([true, "Nubank", 2, 58]);
    expect(guessDestino("Nubank", [], [{ id: "k", nome: "Nubank" }], true).id).toBe("k");
  });
  test("CSV com colunas Débito/Crédito, separador ; e linha de saldo", () => {
    const p = parseExtrato("Extrato conta corrente\nData;Histórico;Débito;Crédito;Saldo\n03/11/2026;COMPRA ZAFFARI;187,35;;2.812,65\n04/11/2026;SALARIO;;5.000,00;7.812,65\n04/11/2026;SALDO DO DIA;;;7.812,65");
    expect(p.itens.map((x: any) => [x.data, x.valor])).toEqual([["2026-11-03", -187.35], ["2026-11-04", 5000]]);
  });
});

describe("análise na importação", () => {
  const itens = () => parseExtrato(OFX_CONTA()).itens;
  test("prévia: aluguel a pagar vira 'marcar como paga'; pagamento de fatura vira pagamento do cartão", async () => {
    const r = await asUser<any>(u, "app_import", { conta_id: conta, itens: itens() });
    const sit = r.itens.map((x: any) => x.situacao);
    expect(sit).toEqual(["quita_pendente", "pagamento_fatura", "nova", "nova"]);
    expect(r.itens[0].pendente.descricao).toBe("Aluguel");
    expect(r.itens[1].cartao).toBe("Nubank");
  });
  test("a IA sugere categoria para o que as regras não reconhecem", async () => {
    const h = createAppHandler({ db, ai, getUserId: async () => u });
    const res = await h(new Request("http://x/", { method: "POST", headers: { authorization: "Bearer t" },
      body: JSON.stringify({ acao: "categorizar", itens: [{ linha: 3, descricao: "COMPRA CARTAO DEB ZAFFARI ESTRELA", tipo: "despesa" }] }) }));
    expect((await res.json()).itens).toEqual([{ linha: 3, categoria: "Alimentação", subcategoria: "Supermercado" }]);
  });
  test("confirmar: quita o aluguel, registra o pagamento da fatura e lança o resto; de novo, nada duplica", async () => {
    const r = await asUser<any>(u, "app_import", { conta_id: conta, itens: itens(), confirmar: true });
    expect([r.importados, r.quitados, r.faturas_pagas]).toEqual([2, 1, 1]);
    const [alug] = await q(`select status, account_id from transactions where user_id = $1 and description = 'Aluguel'`, u);
    expect(alug.status).toBe("efetivado");
    const [pag] = await q(`select type, card_id, amount_cents::int v from transactions where user_id = $1 and type = 'pagamento_fatura'`, u);
    expect([pag.card_id, pag.v]).toEqual([card, 85040]);
    const [{ n }] = await q(`select count(*)::int n from transactions where user_id = $1 and type = 'despesa' and amount_cents = 85040`, u);
    expect(n).toBe(0);   // não virou despesa
    const again = await asUser<any>(u, "app_import", { conta_id: conta, itens: itens() });
    expect(again.itens.every((x: any) => x.situacao === "duplicada")).toBe(true);
  });
});

describe("pelo chat / Telegram", () => {
  test("arquivo OFX enviado na conversa: prévia com o que vai acontecer e lança com “sim”", async () => {
    const u2 = await newUser("Ana");
    await asUser(u2, "app_save_account", { nome: "Banrisul", tipo: "corrente", saldo_inicial: 0 });
    await asUser(u2, "app_save_card", { nome: "Nubank", fechamento: 5, vencimento: 12 });
    const bytes = new TextEncoder().encode(OFX_CONTA());
    const r = await handleMessage({ user_id: u2, channel: "telegram", type: "text", content: "📄 extrato.ofx", timestamp: "",
      document: { bytes, mime: "text/ofx", name: "extrato.ofx" } }, { db, ai });
    expect(r.reply).toContain("o extrato da conta *Banrisul*");
    expect(r.reply).toContain("pagamento(s) de fatura (Nubank)");
    expect(r.reply).toContain("Lanço tudo?");
    const ok = await handleMessage({ user_id: u2, channel: "telegram", type: "text", content: "sim", timestamp: "" }, { db, ai });
    expect(ok.reply).toContain("Lancei 3 lançamento(s)");   // Pix, Zaffari e salário (ela não tinha aluguel a pagar)
    expect(ok.reply).toContain("1 pagamento(s) de fatura registrado(s)");
    const [z] = await q(`select c.name, s.name sub from transactions t join categories c on c.id = t.category_id left join subcategories s on s.id = t.subcategory_id
      where t.user_id = $1 and t.amount_cents = 18735`, u2);
    expect([z.name, z.sub]).toEqual(["Alimentação", "Supermercado"]);
  });
});
