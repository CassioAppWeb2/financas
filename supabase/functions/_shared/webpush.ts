// Notificações no celular/computador pelo padrão Web Push (gratuito, sem serviço externo pago).
// - Chaves VAPID geradas pelo próprio servidor e guardadas no banco (nunca saem do servidor).
// - Mensagem cifrada conforme RFC 8291 (aes128gcm) e assinada conforme RFC 8292 (VAPID).
// Usa só WebCrypto (funciona no Deno/Supabase e no Bun dos testes).

import type { EngineDb } from "./types.ts";

const enc = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...xs: Uint8Array[]) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

export interface Vapid { publicKey: string; privateJwk: JsonWebKey }

/** Gera um par de chaves VAPID (P-256). */
export async function generateVapid(): Promise<Vapid> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { publicKey: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
}

/** Chaves do servidor: lê do banco ou cria na primeira vez. */
export async function ensureVapid(db: EngineDb, user = "00000000-0000-0000-0000-000000000000"): Promise<Vapid> {
  const got = await db.rpc<{ valor: string | null }>("fe_secret", user, { nome: "vapid" });
  if (got.valor) return JSON.parse(got.valor);
  const v = await generateVapid();
  const saved = await db.rpc<{ valor: string }>("fe_secret", user, { nome: "vapid", valor: JSON.stringify(v) });
  return JSON.parse(saved.valor);   // se duas chamadas correrem juntas, vale a primeira gravada
}

/** Cabeçalho Authorization VAPID para o servidor de push do navegador. */
export async function vapidAuth(endpoint: string, v: Vapid, subject = "mailto:suporte@assistente-financeiro.app"): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${v.publicKey}`;
}

/** Cifra o conteúdo para a inscrição do navegador (RFC 8291, aes128gcm). */
export async function encryptPayload(plain: Uint8Array, p256dh: string, auth: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export interface PushSub { endpoint: string; p256dh: string; auth: string }
export type PushResult = "ok" | "expirou" | "falhou";

/** Envia uma notificação. "expirou" = a pessoa desinstalou/desativou (remover a inscrição). */
export async function sendPush(sub: PushSub, data: object, v: Vapid, f: typeof fetch = fetch): Promise<PushResult> {
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(data)), sub.p256dh, sub.auth);
    const r = await f(sub.endpoint, {
      method: "POST",
      headers: { authorization: await vapidAuth(sub.endpoint, v), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "normal" },
      body: body as unknown as BodyInit,
    });
    if (r.status === 404 || r.status === 410) return "expirou";
    if (!r.ok) { console.warn("push:", r.status, (await r.text()).slice(0, 160)); return "falhou"; }
    return "ok";
  } catch (e) { console.warn("push:", (e as Error).message); return "falhou"; }
}
