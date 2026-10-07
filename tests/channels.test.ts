// Testes dos canais: app e WhatsApp chegam ao MESMO assistente e ao MESMO banco.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { localEngine } from "../dev/local_engine.ts";
import { createAppHandler, createTelegramHandler, createWhatsAppHandler, parseWebhook, toWhatsAppText } from "../supabase/functions/_shared/channels.ts";

const db = localEngine();
let user = "";
const PHONE = "5511988887777";
const sent: { to: string; body: string }[] = [];
const tgSent: string[] = [];

// "Meta" e "Gemini" falsos: registram envios e devolvem uma transcrição fixa para o áudio.
const fakeFetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("/messages")) {
    const b = JSON.parse(String(init?.body));
    sent.push({ to: b.to, body: b.text.body });
    return new Response("{}", { status: 200 });
  }
  if (u.endsWith("/MEDIA1")) return Response.json({ url: "https://media.example/audio.ogg" });
  if (u === "https://media.example/audio.ogg") return new Response(new Uint8Array([1, 2, 3]));
  if (u.includes("api.telegram.org/bot") && u.endsWith("/sendMessage")) {
    const b = JSON.parse(String(init?.body));
    tgSent.push(b.text);
    return new Response("{}", { status: 200 });
  }
  if (u.includes("getFile")) return Response.json({ ok: true, result: { file_path: "voice/file_1.oga" } });
  if (u.includes("api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3]));
  if (u.includes("generativelanguage")) {
    return Response.json({ candidates: [{ content: { parts: [{ text: "Ontem fui ao posto e gastei cento e cinquenta reais de gasolina" }] } }] });
  }
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const SECRET = "segredo-do-app";
const wa = createWhatsAppHandler({
  db, fetch: fakeFetch, ai: { geminiKey: "fake", fetch: fakeFetch },
  wa: { token: "t", phoneNumberId: "PNID", verifyToken: "meu-token", appSecret: SECRET },
});
const app = createAppHandler({ db, getUserId: async (t) => (t === "token-valido" ? user : null) });

let n = 0;
function waPost(message: object) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.${++n}`, from: PHONE, ...message }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  return wa(new Request("https://x/whatsapp-webhook", { method: "POST", body, headers: { "x-hub-signature-256": sig } }));
}
const lastSent = () => sent.at(-1)!.body;

beforeAll(async () => {
  [{ id: user }] = (await db.sql`insert into auth.users(email) values (${"canal" + crypto.randomUUID() + "@x.com"}) returning id`) as any[];
});

describe("WhatsApp", () => {
  test("verificação do webhook", async () => {
    const ok = await wa(new Request("https://x/w?hub.mode=subscribe&hub.verify_token=meu-token&hub.challenge=123"));
    expect(await ok.text()).toBe("123");
    const bad = await wa(new Request("https://x/w?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123"));
    expect(bad.status).toBe(403);
  });

  test("assinatura inválida é rejeitada", async () => {
    const r = await wa(new Request("https://x/w", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00" } }));
    expect(r.status).toBe(401);
  });

  test("número não vinculado recebe instruções", async () => {
    await waPost({ type: "text", text: { body: "gastei 10 no mercado" } });
    expect(lastSent()).toContain("Conectar WhatsApp");
  });

  test("vincula com o código gerado no app", async () => {
    const code = await db.sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      return ((await tx.unsafe(`select app_link_code() r`)) as any)[0].r.codigo;
    });
    await waPost({ type: "text", text: { body: `meu código é ${code}` } });
    expect(lastSent()).toContain("Conectado");
  });

  test("mensagem de texto registra despesa e responde no WhatsApp", async () => {
    await waPost({ type: "text", text: { body: "Gastei R$ 100 no supermercado" } });
    expect(lastSent()).toContain("*R$ 100,00*");
    expect(lastSent()).toContain("Supermercado");
  });

  test("áudio é baixado, transcrito e lançado", async () => {
    await waPost({ type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus" } });
    expect(lastSent()).toContain("Entendi seu áudio");
    expect(lastSent()).toContain("R$ 150,00");
    expect(lastSent()).toContain("Combustível");
  });

  test("mensagem repetida pela Meta não duplica", async () => {
    const before = sent.length;
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.fixo", from: PHONE, type: "text", text: { body: "gastei 5 no café" } }] } }] }] });
    const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    for (let i = 0; i < 2; i++) await wa(new Request("https://x/w", { method: "POST", body, headers: { "x-hub-signature-256": sig } }));
    expect(sent.length - before).toBe(1);
  });
});

describe("App", () => {
  test("sem login -> 401", async () => {
    const r = await app(new Request("https://x/assistant", { method: "POST", body: JSON.stringify({ text: "oi" }) }));
    expect(r.status).toBe(401);
  });

  test("consulta no app enxerga lançamentos feitos pelo WhatsApp", async () => {
    const r = await app(new Request("https://x/assistant", {
      method: "POST", headers: { authorization: "Bearer token-valido" },
      body: JSON.stringify({ text: "quanto gastei com alimentação esse mês?" }),
    }));
    const body = await r.json();
    expect(body.reply).toContain("R$ 105,00"); // 100 supermercado + 5 café, ambos via WhatsApp
  });

  test("histórico unificado mostra a conversa do WhatsApp", async () => {
    const rows = (await db.sql`select channel, content from chat_messages where user_id = ${user} order by created_at`) as any[];
    expect(rows.some((r) => r.channel === "whatsapp" && r.content.includes("supermercado"))).toBe(true);
    expect(rows.some((r) => r.channel === "app")).toBe(true);
  });
});

describe("utilitários", () => {
  test("parseWebhook ignora eventos sem mensagem (status de entrega)", () => {
    expect(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]);
  });
  test("negrito do WhatsApp", () => expect(toWhatsAppText("Registrei **R$ 5,00**")).toBe("Registrei *R$ 5,00*"));
});

describe("Telegram", () => {
  const tg = createTelegramHandler({ db, fetch: fakeFetch, ai: { geminiKey: "fake", fetch: fakeFetch }, tg: { token: "TOKEN", secret: "s3gredo" } });
  let upd = 1000;
  const post = (message: object, secret = "s3gredo") => tg(new Request("https://x/telegram-webhook", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: ++upd, message: { chat: { id: 777 }, from: { username: "cassio" }, ...message } }),
  }));

  test("segredo errado é rejeitado", async () => {
    expect((await post({ text: "oi" }, "errado")).status).toBe(401);
  });
  test("sem vínculo recebe instruções", async () => {
    await post({ text: "gastei 10" });
    expect(tgSent.at(-1)).toContain("Gerar código");
  });
  test("/start com código vincula (link direto do app)", async () => {
    const code = await db.sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      return ((await tx.unsafe(`select app_link_code() r`)) as any)[0].r.codigo;
    });
    await post({ text: `/start ${code}` });
    expect(tgSent.at(-1)).toContain("Conectado");
  });
  test("texto e áudio chegam à mesma conta (e a duplicidade é detectada entre canais)", async () => {
    await post({ text: "paguei 30 de uber" });
    expect(tgSent.at(-1)).toContain("*R$ 30,00*");
    // o áudio repete o gasto de gasolina já lançado pelo WhatsApp minutos antes
    await post({ voice: { file_id: "F1", mime_type: "audio/ogg" } });
    expect(tgSent.at(-1)).toContain("Entendi seu áudio");
    expect(tgSent.at(-1)).toContain("há poucos minutos");
    await post({ text: "não" });
    const [{ n }] = (await db.sql`select count(*)::int n from transactions where user_id = ${user} and origin = 'telegram' and deleted_at is null`) as any[];
    expect(n).toBe(1);
  });
});

describe("Trava do limite gratuito do WhatsApp", () => {
  test("para de enviar ao atingir o limite do mês", async () => {
    const limited = createWhatsAppHandler({
      db, fetch: fakeFetch, ai: {}, wa: { token: "t", phoneNumberId: "PNID", verifyToken: "v", monthlyLimit: 1 },
    });
    await db.sql`delete from messaging_usage where channel = 'whatsapp'`;
    const mk = (id: string) => new Request("https://x/w", { method: "POST", body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from: PHONE, type: "text", text: { body: "quanto gastei hoje?" } }] } }] }] }) });
    const before = sent.length;
    await limited(mk("lim.1"));
    await limited(mk("lim.2"));
    expect(sent.length - before).toBe(1);
    const [{ sent: n }] = (await db.sql`select sent from messaging_usage where channel = 'whatsapp'`) as any[];
    expect(n).toBe(1);
  });
});
