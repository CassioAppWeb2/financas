// Contas fixas com período e renovação, central de notificações e envio para o celular (Web Push + Telegram).
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { handleMessage } from "../supabase/functions/_shared/assistant.ts";
import { encryptPayload, generateVapid, vapidAuth, b64u, unb64u } from "../supabase/functions/_shared/webpush.ts";
import { runNotifications, createNotifyHandler } from "../supabase/functions/_shared/notifier.ts";

const db = localEngine();
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];
const fe = <T = any>(fn: string, uid: string, p: object = {}) => db.rpc<T>(fn, uid, p as Record<string, unknown>);
const asUser = <T = any>(uid: string, fn: string, p: object = {}) =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await tx.unsafe(`set local role authenticated`);
    return ((await tx.unsafe(`select to_jsonb(public.${fn}($1::jsonb)) r`, [p])) as any)[0].r as T;
  });
const newUser = async (name: string) =>
  (await q(`insert into auth.users(email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, `${name}.${crypto.randomUUID()}@x.com`, { name }))[0].id as string;
let u = "";
const say = (text: string, channel: "app" | "telegram" = "app") => handleMessage({ user_id: u, channel, type: "text", content: text, timestamp: "" }, { db });
const enc = new TextEncoder();

beforeAll(async () => { u = await newUser("Notif"); });

// ---------------------------------------------------------------- criptografia (o lado do navegador decifra)
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };

describe("Web Push", () => {
  test("mensagem cifrada é decifrada pelo navegador (RFC 8291)", async () => {
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = JSON.stringify({ title: "Vence hoje", body: "Aluguel — R$ 1.200,00" });
    const body = await encryptPayload(enc.encode(msg), b64u(uaPub), b64u(auth));
    // cabeçalho: salt(16) rs(4) idlen(1) keyid(65)
    const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), idlen = body[20];
    expect(rs).toBe(4096); expect(idlen).toBe(65);
    const asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
    const ikm = (await hmac(await hmac(auth, shared), cat(enc.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
    const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
    expect(plain[plain.length - 1]).toBe(2);
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(msg);
  });
  test("assinatura VAPID confere com a chave pública", async () => {
    const v = await generateVapid();
    const h = await vapidAuth("https://fcm.googleapis.com/fcm/send/abc", v);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(k).toBe(v.publicKey);
    const [a, b, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(unb64u(b))).aud).toBe("https://fcm.googleapis.com");
    const pub = await crypto.subtle.importKey("raw", unb64u(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(s), enc.encode(`${a}.${b}`))).toBe(true);
  });
});

// ---------------------------------------------------------------- contas fixas
describe("contas fixas com período", () => {
  test("12 meses: lança todos e continua ativa", async () => {
    const r = await fe("fe_save_recurring", u, { tipo: "despesa", valor: 1200, descricao: "Aluguel", categoria: "Moradia e contas da casa", subcategoria: "Aluguel", dia: 5, meses: 12 });
    const x = r.recorrencia;
    expect(x.ativa).toBe(true);
    expect(x.fim).toBeTruthy();
    const [{ n }] = await q(`select count(*)::int n from transactions where recurring_id = $1 and deleted_at is null`, x.id);
    expect(n).toBe(12);
  });
  test("sem fim: só até o mês que vem", async () => {
    const r = await fe("fe_save_recurring", u, { tipo: "despesa", valor: 60, descricao: "Academia", categoria: "Cuidados pessoais", dia: 15, sem_fim: true });
    const [{ n }] = await q(`select count(*)::int n from transactions where recurring_id = $1 and deleted_at is null`, r.recorrencia.id);
    expect(n).toBeLessThanOrEqual(2);
    expect(r.recorrencia.fim).toBeNull();
  });
  test("no fim, avisa e renova com reajuste sem mexer nos meses já lançados", async () => {
    const [rec] = await q(`select * from recurring_transactions where user_id = $1 and description = 'Aluguel'`, u);
    // simula: o período termina daqui a 20 dias
    await q(`update recurring_transactions set end_date = (select fe_today($1)) + 20 where id = $2`, u, rec.id);
    await fe("fe_notify_scan", u);
    let ns = await asUser<any>(u, "app_notifications");
    const aviso = ns.itens.find((x: any) => x.tipo === "renovar");
    expect(aviso.texto).toContain("Aluguel");
    expect(aviso.ativa).toBe(true);
    const antes = (await q(`select count(*)::int n from transactions where recurring_id = $1 and deleted_at is null and amount_cents = 120000`, rec.id))[0].n;
    const r = await asUser<any>(u, "app_renew_recurring", { id: rec.id, meses: 12, valor: 1300 });
    expect(r.status).toBe("renovada");
    const [{ n }] = await q(`select count(*)::int n from transactions where recurring_id = $1 and deleted_at is null and amount_cents = 130000`, rec.id);
    expect(n).toBeGreaterThanOrEqual(12);
    const [{ m }] = await q(`select count(*)::int m from transactions where recurring_id = $1 and deleted_at is null and amount_cents = 120000`, rec.id);
    expect(m).toBe(antes);
    ns = await asUser<any>(u, "app_notifications");
    expect(ns.itens.find((x: any) => x.tipo === "renovar" && x.ativa)).toBeUndefined();
  });
});

describe("assistente", () => {
  test("pergunta o período e programa 12 meses", async () => {
    const a = await say("a escola do meu filho custa 1043 todo dia 10");
    expect(a.reply).toContain("Por quanto tempo");
    const b = await say("sim");
    expect(b.reply).toContain("Conta fixa criada");
    expect(b.reply).toContain("12 lançamentos");
  });
  test("período já na frase: não pergunta", async () => {
    const r = await say("minha internet custa 120 todo dia 20 por 24 meses");
    expect(r.reply).toContain("Conta fixa criada");
    expect(r.reply).toContain("24 lançamentos");
  });
  test("se mudar de assunto, esquece a pergunta", async () => {
    await say("plano de saúde 450 todo dia 3");
    const r = await say("quanto gastei este mês com alimentação?");
    expect(r.reply).not.toContain("Não entendi o período");
    const [{ pending }] = await q(`select fe_chat_state($1, '{}'::jsonb)->'pending' pending`, u);
    expect(pending).toBeNull();
  });
  test("renovar com reajuste pelo chat", async () => {
    const r = await say("a escola teve reajuste para 1.150");
    expect(r.reply).toContain("Renovei");
    expect(r.reply).toContain("R$ 1.150,00");
  });
  test("renovar pergunta o valor quando só fala em reajuste", async () => {
    const a = await say("a internet vai ter reajuste");
    expect(a.reply).toContain("novo valor");
    const b = await say("135");
    expect(b.reply).toContain("R$ 135,00");
  });
});

// ---------------------------------------------------------------- central e envio
describe("notificações", () => {
  test("conta atrasada vira aviso uma vez só e some quando paga", async () => {
    const cat = (await q(`select id from categories where user_id = $1 and kind = 'despesa' order by name limit 1`, u))[0].id;
    const t = await asUser<any>(u, "app_save_transaction", { tipo: "despesa", valor: 99, descricao: "Conta de água", categoria_id: cat, pendente: true,
      data: (await q(`select ((select fe_today($1)) - 3)::text d`, u))[0].d });
    await fe("fe_notify_scan", u); await fe("fe_notify_scan", u);
    const [{ n }] = await q(`select count(*)::int n from notifications where user_id = $1 and dedupe = $2`, u, "atraso:" + t.lancamento.id);
    expect(n).toBe(1);
    let ns = await asUser<any>(u, "app_notifications");
    expect(ns.nao_lidas).toBeGreaterThan(0);
    await asUser(u, "app_set_paid", { id: t.lancamento.id, pago: true });
    ns = await asUser<any>(u, "app_notifications");
    expect(ns.itens.find((x: any) => x.dados?.tx_id === t.lancamento.id && x.ativa)).toBeUndefined();
    await asUser(u, "app_notifications_read", {});
    expect((await asUser<any>(u, "app_notifications")).nao_lidas).toBe(0);
  });

  test("envio: push nos aparelhos + Telegram, e não reenvia", async () => {
    const v = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const p256dh = b64u(await crypto.subtle.exportKey("raw", v.publicKey)), auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
    await asUser(u, "app_push_subscribe", { endpoint: "https://push.example/ok", keys: { p256dh, auth } });
    await asUser(u, "app_push_subscribe", { endpoint: "https://push.example/gone", keys: { p256dh, auth } });
    await q(`insert into telegram_connections(user_id, chat_id) values ($1, $2) on conflict do nothing`, u, 'tg-' + crypto.randomUUID());
    await q(`update notifications set read_at = null, pushed_at = null where user_id = $1`, u);
    const calls: string[] = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = String(url); calls.push(s);
      if (s.includes("/gone")) return new Response("", { status: 410 });
      if (s.includes("push.example")) { expect((init?.headers as any).authorization).toMatch(/^vapid t=/); return new Response("", { status: 201 }); }
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    const r = await runNotifications({ db, tgToken: "x", fetch: f, hora: 10 });
    const [{ meus, enviados }] = await q(`select count(*)::int meus, count(pushed_at)::int enviados from notifications where user_id = $1`, u);
    expect(meus).toBeGreaterThan(0);
    expect(enviados).toBe(meus);
    expect(r.push).toBeGreaterThanOrEqual(meus);
    expect(calls.filter((c) => c.includes("push.example/ok")).length).toBe(meus);
    expect(calls.filter((c) => c.includes("api.telegram.org")).length).toBeGreaterThanOrEqual(meus);
    const [{ falhas }] = await q(`select failures falhas from push_subscriptions where endpoint = 'https://push.example/gone'`);
    expect(falhas).toBe(99);
    calls.length = 0;
    const r2 = await runNotifications({ db, tgToken: "x", fetch: f, hora: 10 });
    expect(r2.avisos).toBe(0);
  });

  test("fora do horário (madrugada) não envia", async () => {
    await q(`update notifications set pushed_at = null, read_at = null where user_id = $1`, u);
    const r = await runNotifications({ db, fetch: (async () => new Response("")) as typeof fetch, hora: 3 });
    expect(r.avisos).toBe(0);
  });

  test("agendador precisa da chave certa", async () => {
    const h = createNotifyHandler({ db, fetch: (async () => new Response("")) as typeof fetch, hora: 3 });
    expect((await h(new Request("http://x/notificar", { method: "POST", headers: { "x-cron-key": "errada" } }))).status).toBe(401);
    const [{ value }] = await q(`select value from app_secrets where name = 'cron_key'`);
    expect((await h(new Request("http://x/notificar", { method: "POST", headers: { "x-cron-key": value } }))).status).toBe(200);
  });

  test("renovação pelo Telegram: o aviso já deixa a conversa pronta", async () => {
    const v = await newUser("Tg");
    await fe("fe_save_recurring", v, { tipo: "despesa", valor: 800, descricao: "Condomínio", categoria: "Moradia e contas da casa", dia: 8, meses: 12 });
    await q(`update recurring_transactions set end_date = (select fe_today($1)) + 10 where user_id = $1`, v);
    await q(`insert into telegram_connections(user_id, chat_id) values ($1, $2) on conflict do nothing`, v, 'tg-' + crypto.randomUUID());
    const sent: string[] = [];
    await runNotifications({ db, tgToken: "x", hora: 10, fetch: (async (_u: any, init?: RequestInit) => { sent.push(String(init?.body ?? "")); return new Response("{}"); }) as typeof fetch });
    expect(sent.some((s) => s.includes("Condom") && s.includes("encerrar"))).toBe(true);
    const r = await handleMessage({ user_id: v, channel: "telegram", type: "text", content: "mesmo valor", timestamp: "" }, { db });
    expect(r.reply).toContain("Renovei");
    expect(r.reply).toContain("R$ 800,00");
  });
});
