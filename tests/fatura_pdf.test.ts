// Fatura em PDF/foto: leitura (simulada), prévia, duplicidade, confirmação e lançamentos na fatura certa.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { isEncryptedPdf, sanitizeStatement, type Statement } from "../supabase/functions/_shared/ai.ts";

const db = localEngine();
const q = async (sql: string, ...a: unknown[]) => (await db.sql.unsafe(sql, a)) as any[];
let user = "", due = "", hoje = "", cardId = "";
let fake: Statement;
const addDays = (iso: string, n: number) => { const x = new Date(iso + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const deps = () => ({ db, extract: async () => structuredClone(fake) });
const say = (text: string) => handleMessage({ user_id: user, channel: "telegram", type: "text", content: text, timestamp: new Date().toISOString() }, deps());
const sendDoc = (bytes = new Uint8Array([37, 80, 68, 70])) =>
  handleMessage({ user_id: user, channel: "telegram", type: "text", content: "📄 fatura.pdf", timestamp: new Date().toISOString(),
    document: { bytes, mime: "application/pdf", name: "fatura.pdf" } }, deps());

beforeAll(async () => {
  [{ id: user }] = await q(`insert into auth.users(email) values ('pdf' || gen_random_uuid() || '@x.com') returning id`);
  await say("oi");
  ({ id: cardId } = await db.rpc<any>("fe_save_card", user, { nome: "Nubank", fechamento: 5, vencimento: 12, limite: 5000 }));
  hoje = (await q(`select fe_today($1)::text t`, user))[0].t;
  due = (await q(`select fe_invoice_due($1, $2::date)::text d`, cardId, hoje))[0].d;
  await say("gastei 80 no mercado no cartão nubank");
  fake = {
    tipo: "fatura_cartao", banco: "Nu Pagamentos", cartao: "Nubank", vencimento: due, total: 535.9,
    itens: [
      { data: hoje, descricao: "MERCADO BOM PRECO", valor: 80, categoria: "Alimentação" },
      { data: hoje, descricao: "UBER *TRIP", valor: 25.9, categoria: "Outros" },
      { data: hoje, descricao: "POSTO SHELL CENTRO", valor: 150 },
      { data: addDays(hoje, -95), descricao: "MAGAZINE TV", valor: 300, parcela: "4/10", categoria: "Outros" },
      { data: hoje, descricao: "PAGAMENTO RECEBIDO", valor: -500 },
      { data: hoje, descricao: "ESTORNO UBER", valor: -20 },
    ],
  };
});

describe("fatura em PDF pelo Telegram", () => {
  test("prévia: cartão reconhecido, soma confere, duplicado e pagamento separados", async () => {
    const r = await sendDoc();
    expect(r.reply).toContain("fatura do *Nubank*");
    expect(r.reply).toContain("A soma confere");
    expect(r.reply).toContain("1 já estavam lançados");
    expect(r.reply).toContain("pagamento");
    expect(r.reply).toContain("Novos: 4");
    expect(r.reply).toContain("Lanço tudo?");
  });

  test("lista mostra os itens com categoria", async () => {
    const r = await say("lista");
    expect(r.reply).toContain("UBER *TRIP");
    expect(r.reply).toContain("Transporte > Uber");
    expect(r.reply).toContain("Combustível");
  });

  test("confirmação lança na fatura certa, com parcela no mês da fatura e estorno abatendo", async () => {
    const r = await say("sim");
    expect(r.reply).toContain("Lancei 4");
    const rows = await q(`select description, type, amount_cents::int v, invoice_due::text d, date::text dt from transactions
      where user_id = $1 and card_id = $2 and deleted_at is null order by created_at`, user, cardId);
    expect(rows.length).toBe(5);
    expect(rows.every((x) => x.d === due)).toBe(true);
    const tv = rows.find((x) => x.description.startsWith("MAGAZINE TV"));
    expect(tv.description).toBe("MAGAZINE TV (4/10)");
    expect(tv.dt >= addDays(due, -45)).toBe(true);
    const inv = await db.rpc<any>("fe_card_invoice", user, { cartao_id: cardId, vencimento: due });
    expect(inv.fatura.total_cents).toBe(53590);
  });

  test("mandar a mesma fatura de novo não duplica", async () => {
    const r = await sendDoc();
    expect(r.reply).toContain("Não há nada novo");
  });

  test("PDF com senha", async () => {
    const enc = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF");
    expect(isEncryptedPdf(enc)).toBe(true);
    expect(isEncryptedPdf(new TextEncoder().encode("%PDF-1.7\ntrailer\n<< /Root 1 0 R >>"))).toBe(false);
    const r = await handleMessage({ user_id: user, channel: "telegram", type: "text", content: "📄 fatura.pdf", timestamp: new Date().toISOString(),
      document: { bytes: enc, mime: "application/pdf" } }, { db, ai: { geminiKey: "teste" } });
    expect(r.reply).toContain("protegido por senha");
  });

  test("sem cartão cadastrado pede para cadastrar", async () => {
    const [{ id: u2 }] = await q(`insert into auth.users(email) values ('pdf2' || gen_random_uuid() || '@x.com') returning id`);
    const r = await handleMessage({ user_id: u2, channel: "telegram", type: "text", content: "📄 f.pdf", timestamp: new Date().toISOString(),
      document: { bytes: new Uint8Array([1]), mime: "application/pdf" } }, deps());
    expect(r.reply).toContain("ainda não cadastrou cartões");
  });
});

describe("validação do que a IA leu", () => {
  test("descarta linhas inválidas e categorias inexistentes", () => {
    const st = sanitizeStatement({ tipo: "fatura_cartao", vencimento: "2026-11-12", total: "100.5", itens: [
      { data: "2026-10-01", descricao: "  LOJA   X ", valor: 10, categoria: "Lazer" },
      { data: "01/10", descricao: "ruim", valor: 5 },
      { data: "2026-10-02", descricao: "zero", valor: 0 },
      { data: "2026-10-03", descricao: "cat inventada", valor: 7, categoria: "Bitcoin", parcela: "2/3" },
    ] }, { hoje: "2026-10-07", contas: [], categorias: [{ tipo: "despesa", nome: "Lazer", subcategorias: [] }] });
    expect(st.itens.length).toBe(2);
    expect(st.itens[0]).toEqual({ data: "2026-10-01", descricao: "LOJA X", valor: 10, parcela: undefined, categoria: "Lazer" });
    expect(st.itens[1].categoria).toBeUndefined();
    expect(st.itens[1].parcela).toBe("2/3");
    expect(st.total).toBe(100.5);
  });
});
