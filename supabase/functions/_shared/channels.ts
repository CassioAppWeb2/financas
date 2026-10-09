// CANAIS: convertem cada origem para o formato interno IncomingMessage.
// Nenhuma regra financeira aqui — só transporte.

import type { EngineDb, IncomingMessage } from "./types.ts";
import { handleMessage, readStatement, type AssistantDeps } from "./assistant.ts";
import { transcribeAudio, StatementError, type AiConfig } from "./ai.ts";
import type { AudioStore } from "./storage.ts";
import { ensureMarket } from "./mercado.ts";

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

// ---------------------------------------------------------------------------
// Canal APP (Web/PWA)
// ---------------------------------------------------------------------------
export interface AppDeps {
  db: EngineDb;
  ai?: AiConfig;
  store?: AudioStore;
  extract?: AssistantDeps["extract"];
  getUserId: (token: string) => Promise<string | null>;
  marketFetch?: typeof fetch;
}

// limite simples por instância: 30 mensagens/minuto por usuário
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

export function createAppHandler(deps: AppDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method === "GET") return json({ ok: true, service: "assistente" });
    if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = token ? await deps.getUserId(token) : null;
    if (!userId) return json({ error: "Sessão expirada. Entre novamente." }, 401);
    if (rateLimited(userId)) return json({ error: "Muitas mensagens em pouco tempo. Aguarde um minuto." }, 429);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

    // Tela "Mercado": indicadores do Banco Central (busca de novo se estiverem velhos ou se pedirem)
    if (body?.acao === "mercado") {
      try { return json(await ensureMarket(deps.db, userId, deps.marketFetch ?? fetch, body.forcar === true)); }
      catch (e) { return json({ error: `Não consegui buscar os indicadores (${(e as Error).message}).` }, 502); }
    }

    // Tela "Importar extrato": lê PDF/foto da fatura e devolve os itens para a prévia (nada é gravado aqui)
    if (body?.acao === "ler_extrato") {
      if (typeof body.arquivo_base64 !== "string" || body.arquivo_base64.length > 21_000_000) return json({ error: "Arquivo ausente ou grande demais (máximo 15 MB)." }, 400);
      const mime = String(body.mime ?? "application/pdf");
      if (!/^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/.test(mime)) return json({ error: "Envie a fatura em PDF ou foto (JPG/PNG)." }, 400);
      try {
        const bytes = Uint8Array.from(atob(body.arquivo_base64), (ch) => ch.charCodeAt(0));
        return json(await readStatement(bytes, mime, userId, { db: deps.db, ai: deps.ai, extract: deps.extract }));
      } catch (e) {
        const code = e instanceof StatementError ? e.code : "";
        const msg = code === "senha" ? "Este PDF tem senha. Abra-o, toque em Imprimir → Salvar como PDF e envie o arquivo novo (fica sem senha)."
          : code === "sem_ia" ? "A leitura de PDF ainda não está configurada no servidor."
          : `Não consegui ler o documento (${(e as Error).message}).`;
        return json({ error: msg, codigo: code || "erro" }, 422);
      }
    }

    let content = typeof body?.text === "string" ? body.text.slice(0, 2000) : "";
    let type: IncomingMessage["type"] = body?.type === "audio" ? "audio" : "text";
    let audio_provider: string | undefined = type === "audio" ? "navegador" : undefined;
    let audio_path: string | undefined;

    // Áudio enviado como arquivo (quando o navegador não transcreve sozinho)
    if (typeof body?.audio_base64 === "string" && body.audio_base64.length < 8_000_000) {
      try {
        const bytes = Uint8Array.from(atob(body.audio_base64), (ch) => ch.charCodeAt(0));
        const mime = String(body.mime ?? "audio/webm");
        const saving = deps.store?.save(userId, bytes, mime);   // guarda enquanto transcreve
        const t = await transcribeAudio(bytes, mime, deps.ai ?? {});
        content = t.text; type = "audio"; audio_provider = t.provider;
        audio_path = await saving;
      } catch (e) {
        return json({ error: `Não consegui transcrever o áudio (${(e as Error).message}).` }, 422);
      }
    }
    // Foto de cupom/nota fiscal (ou PDF de fatura) enviada pelo chat do app
    let document: IncomingMessage["document"];
    if (typeof body?.foto_base64 === "string") {
      if (body.foto_base64.length > 21_000_000) return json({ error: "Foto grande demais (máximo 15 MB)." }, 400);
      const mime = String(body.mime ?? "image/jpeg");
      if (!/^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/.test(mime)) return json({ error: "Envie uma foto (JPG/PNG) ou PDF." }, 400);
      document = { bytes: Uint8Array.from(atob(body.foto_base64), (ch) => ch.charCodeAt(0)), mime, name: mime === "application/pdf" ? "documento.pdf" : "foto.jpg" };
      if (!content.trim()) content = mime === "application/pdf" ? "📄 Documento" : "📷 Foto de cupom/nota";
    }
    if (!content.trim()) return json({ error: "Mensagem vazia" }, 400);

    const msg: IncomingMessage = { user_id: userId, channel: "app", type, content, timestamp: new Date().toISOString(), audio_provider, audio_path, document };
    const reply = await handleMessage(msg, { db: deps.db, ai: deps.ai, marketFetch: deps.marketFetch, extract: deps.extract });
    return json(type === "audio" ? { ...reply, transcricao: content, audio_path } : reply);
  };
}

// ---------------------------------------------------------------------------
// Canal WHATSAPP (Meta WhatsApp Business Cloud API)
// ---------------------------------------------------------------------------
export interface WhatsAppConfig {
  token?: string;          // WHATSAPP_TOKEN (token permanente do app da Meta)
  phoneNumberId?: string;  // WHATSAPP_PHONE_NUMBER_ID
  verifyToken?: string;    // WHATSAPP_VERIFY_TOKEN (você escolhe; usado na verificação do webhook)
  appSecret?: string;      // WHATSAPP_APP_SECRET (valida a assinatura das chamadas)
  graphVersion?: string;
  monthlyLimit?: number;   // WHATSAPP_MONTHLY_LIMIT: trava para nunca passar da cota gratuita (padrão 950 de 1.000)
}

export interface WhatsAppDeps {
  db: EngineDb;
  ai?: AiConfig;
  store?: AudioStore;
  wa: WhatsAppConfig;
  fetch?: typeof fetch;
  waitUntil?: (p: Promise<unknown>) => void;
}

export interface WaMessage { id: string; from: string; type: string; text?: string; media_id?: string; mime?: string; }

/** Extrai as mensagens do JSON enviado pela Meta. */
export function parseWebhook(body: any): WaMessage[] {
  const out: WaMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      for (const m of ch?.value?.messages ?? []) {
        const msg: WaMessage = { id: m.id, from: String(m.from ?? ""), type: m.type };
        if (m.type === "text") msg.text = m.text?.body ?? "";
        else if (m.type === "audio") { msg.media_id = m.audio?.id; msg.mime = m.audio?.mime_type ?? "audio/ogg"; }
        else if (m.type === "button") msg.text = m.button?.text;
        else if (m.type === "interactive") msg.text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        out.push(msg);
      }
    }
  }
  return out;
}

/** Markdown do app -> formatação do WhatsApp (*negrito*, _itálico_). */
export function toWhatsAppText(md: string): string {
  return md.replace(/\*\*(.+?)\*\*/g, "*$1*").slice(0, 4000);
}

async function hmacHex(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data as unknown as ArrayBuffer));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifySignature(raw: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const expected = await hmacHex(secret, raw);
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const seen = new Set<string>(); // evita processar a mesma mensagem duas vezes (a Meta reenvia em caso de demora)

const WELCOME = "✅ Conectado à sua conta! Agora é só me mandar seus gastos e receitas por aqui, em texto ou áudio. Ex.: “gastei 50 na padaria”. Digite *ajuda* para ver tudo o que eu faço.";
const BAD_CODE = "Esse código não é válido ou expirou. Gere um novo no app, em *Configurações → Conectar WhatsApp e Telegram*.";
const NOT_LINKED = "Olá! 👋 Para usar o assistente por aqui, abra o app, vá em *Configurações → Conectar WhatsApp e Telegram*, toque em *Gerar código* e envie aqui o código de 6 dígitos.";

export function createWhatsAppHandler(deps: WhatsAppDeps) {
  const f = deps.fetch ?? fetch;
  const graph = `https://graph.facebook.com/${deps.wa.graphVersion ?? "v21.0"}`;

  async function send(to: string, text: string) {
    if (!deps.wa.token || !deps.wa.phoneNumberId) { console.warn("WhatsApp sem credenciais; resposta não enviada"); return; }
    // Trava de custo: a Meta dá 1.000 respostas grátis por mês por número. Acima do limite, não envia
    // (a resposta continua salva e aparece no chat do app).
    const quota = await deps.db.rpc<{ allowed: boolean; sent: number }>("fe_usage_take", null, { channel: "whatsapp", limite: deps.wa.monthlyLimit ?? 950 });
    if (!quota.allowed) { console.warn(`Limite mensal do WhatsApp atingido (${quota.sent}); resposta não enviada`); return; }
    const r = await f(`${graph}/${deps.wa.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.wa.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: toWhatsAppText(text) } }),
    });
    if (!r.ok) console.error("erro ao enviar WhatsApp", r.status);
  }

  async function downloadMedia(mediaId: string): Promise<Uint8Array> {
    const meta = await f(`${graph}/${mediaId}`, { headers: { authorization: `Bearer ${deps.wa.token}` } });
    if (!meta.ok) throw new Error("mídia indisponível");
    const { url } = await meta.json();
    const file = await f(url, { headers: { authorization: `Bearer ${deps.wa.token}` } });
    if (!file.ok) throw new Error("falha ao baixar áudio");
    return new Uint8Array(await file.arrayBuffer());
  }

  async function process(m: WaMessage) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    if (seen.size > 5000) seen.clear();

    const phone = m.from.replace(/\D/g, "");
    const { user_id } = await deps.db.rpc<{ user_id: string | null }>("fe_whatsapp_lookup", null, { phone });

    if (!user_id) {
      const code = (m.text ?? "").replace(/\D/g, "");
      if (/^\d{6}$/.test(code)) {
        const r = await deps.db.rpc<any>("fe_whatsapp_link", null, { phone, code });
        if (r.status === "linked") {
          await send(m.from, WELCOME);
          return;
        }
        await send(m.from, BAD_CODE);
        return;
      }
      await send(m.from, NOT_LINKED);
      return;
    }

    if (rateLimited(user_id)) { await send(m.from, "Muitas mensagens em pouco tempo. Aguarde um minuto. 🙏"); return; }

    let content = m.text ?? "";
    let type: IncomingMessage["type"] = "text";
    let audio_provider: string | undefined;
    let audio_path: string | undefined;
    if (m.type === "audio" && m.media_id) {
      try {
        const bytes = await downloadMedia(m.media_id);
        const saving = deps.store?.save(user_id, bytes, m.mime ?? "audio/ogg");
        const t = await transcribeAudio(bytes, m.mime ?? "audio/ogg", deps.ai ?? {});
        content = t.text; type = "audio"; audio_provider = t.provider;
        audio_path = await saving;
      } catch (e) {
        console.error("áudio WhatsApp:", (e as Error).message);
        await send(m.from, "Não consegui entender o áudio agora. Pode enviar por texto?");
        return;
      }
    } else if (!["text", "button", "interactive"].includes(m.type)) {
      await send(m.from, "Por enquanto entendo mensagens de texto e áudio. 🙂");
      return;
    }

    const reply = await handleMessage(
      { user_id, channel: "whatsapp", type, content, timestamp: new Date().toISOString(), audio_provider, audio_path, media_ref: m.media_id },
      { db: deps.db, ai: deps.ai },
    );
    await send(m.from, reply.reply);
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET") {
      // Verificação do webhook pela Meta
      if (url.searchParams.get("hub.mode") === "subscribe" && deps.wa.verifyToken &&
          url.searchParams.get("hub.verify_token") === deps.wa.verifyToken) {
        return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const raw = new Uint8Array(await req.arrayBuffer());
    if (deps.wa.appSecret && !(await verifySignature(raw, req.headers.get("x-hub-signature-256"), deps.wa.appSecret))) {
      return new Response("invalid signature", { status: 401 });
    }
    let body: any;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response("bad request", { status: 400 }); }

    const work = Promise.all(parseWebhook(body).map((m) => process(m).catch((e) => console.error("whatsapp:", e?.message))));
    if (deps.waitUntil) deps.waitUntil(work); else await work;
    return new Response("ok", { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// Canal TELEGRAM (Bot API oficial — gratuita, sem limite de mensagens)
// ---------------------------------------------------------------------------
export interface TelegramConfig {
  token?: string;   // TELEGRAM_BOT_TOKEN (dado pelo @BotFather)
  secret?: string;  // TELEGRAM_WEBHOOK_SECRET (você escolhe; o Telegram envia em cada chamada)
}

export interface TelegramDeps {
  db: EngineDb;
  ai?: AiConfig;
  store?: AudioStore;
  tg: TelegramConfig;
  fetch?: typeof fetch;
  waitUntil?: (p: Promise<unknown>) => void;
}

export interface TgMessage {
  update_id: number; chat_id: string; username?: string; text?: string; file_id?: string; mime?: string;
  doc_id?: string; doc_mime?: string; doc_name?: string; doc_size?: number;
}

export function parseTelegramUpdate(u: any): TgMessage | null {
  const m = u?.message ?? u?.edited_message;
  if (!m?.chat?.id) return null;
  const media = m.voice ?? m.audio;
  const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : undefined;
  const doc = m.document ?? (photo ? { file_id: photo.file_id, mime_type: "image/jpeg", file_name: "foto.jpg", file_size: photo.file_size } : undefined);
  return {
    update_id: u.update_id, chat_id: String(m.chat.id), username: m.from?.username,
    text: m.text ?? m.caption, file_id: media?.file_id, mime: media?.mime_type ?? (m.voice ? "audio/ogg" : undefined),
    doc_id: doc?.file_id, doc_mime: doc?.mime_type, doc_name: doc?.file_name, doc_size: doc?.file_size,
  };
}

/** Markdown do app -> Markdown simples do Telegram (*negrito*). */
export function toTelegramText(md: string): string {
  return md.replace(/\*\*(.+?)\*\*/g, "*$1*").slice(0, 4000);
}

const seenTg = new Set<number>();

export function createTelegramHandler(deps: TelegramDeps) {
  const f = deps.fetch ?? fetch;
  const api = (method: string) => `https://api.telegram.org/bot${deps.tg.token}/${method}`;

  async function send(chatId: string, text: string) {
    if (!deps.tg.token) { console.warn("Telegram sem token; resposta não enviada"); return; }
    const post = (body: object) => f(api("sendMessage"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await post({ chat_id: chatId, text: toTelegramText(text), parse_mode: "Markdown" });
    if (!r.ok) await post({ chat_id: chatId, text: text.replace(/\*\*/g, "") }); // se a formatação falhar, manda texto puro
  }

  async function download(fileId: string): Promise<Uint8Array> {
    const r = await f(api(`getFile?file_id=${encodeURIComponent(fileId)}`));
    const path = (await r.json())?.result?.file_path;
    if (!path) throw new Error("arquivo indisponível");
    const file = await f(`https://api.telegram.org/file/bot${deps.tg.token}/${path}`);
    if (!file.ok) throw new Error("falha ao baixar áudio");
    return new Uint8Array(await file.arrayBuffer());
  }

  async function process(m: TgMessage) {
    if (seenTg.has(m.update_id)) return;
    seenTg.add(m.update_id);
    if (seenTg.size > 5000) seenTg.clear();

    const { user_id } = await deps.db.rpc<{ user_id: string | null }>("fe_telegram_lookup", null, { chat_id: m.chat_id });
    const text = (m.text ?? "").trim();

    if (!user_id) {
      const code = text.replace(/^\/start\s*/i, "").replace(/\D/g, "");
      if (/^\d{6}$/.test(code)) {
        const r = await deps.db.rpc<any>("fe_telegram_link", null, { chat_id: m.chat_id, code, username: m.username });
        await send(m.chat_id, r.status === "linked" ? WELCOME : BAD_CODE);
        return;
      }
      await send(m.chat_id, NOT_LINKED);
      return;
    }
    if (/^\/start\b/i.test(text)) { await send(m.chat_id, "Você já está conectado. 🙂 Me conte um gasto ou pergunte sobre suas finanças."); return; }
    if (rateLimited(user_id)) { await send(m.chat_id, "Muitas mensagens em pouco tempo. Aguarde um minuto. 🙏"); return; }

    if (m.doc_id) {
      const mime = (m.doc_mime ?? "").toLowerCase();
      const pdf = mime === "application/pdf" || /\.pdf$/i.test(m.doc_name ?? "");
      if (!pdf && !/^image\/(jpeg|png|webp)$/.test(mime)) {
        await send(m.chat_id, "Por enquanto leio faturas e extratos em *PDF* ou *foto*. Para outros arquivos (OFX/CSV), use *Cartões → Importar fatura* no app.");
        return;
      }
      if ((m.doc_size ?? 0) > 15_000_000) { await send(m.chat_id, "Esse arquivo é grande demais (máximo 15 MB)."); return; }
      await send(m.chat_id, "📄 Recebi! Estou lendo os lançamentos… isso pode levar até 1 minuto.");
      let bytes: Uint8Array;
      try { bytes = await download(m.doc_id); } catch { await send(m.chat_id, "Não consegui baixar o arquivo do Telegram. Pode mandar de novo?"); return; }
      const reply = await handleMessage(
        { user_id, channel: "telegram", type: "text", content: `📄 ${m.doc_name ?? "documento"}${text ? ` — ${text}` : ""}`, timestamp: new Date().toISOString(),
          media_ref: m.doc_id, document: { bytes, mime: pdf ? "application/pdf" : mime, name: m.doc_name } },
        { db: deps.db, ai: deps.ai },
      );
      await send(m.chat_id, reply.reply);
      return;
    }

    let content = text.replace(/^\/(ajuda|help)\b/i, "ajuda");
    let type: IncomingMessage["type"] = "text";
    let audio_provider: string | undefined;
    let audio_path: string | undefined;
    if (m.file_id) {
      try {
        const bytes = await download(m.file_id);
        const saving = deps.store?.save(user_id, bytes, m.mime ?? "audio/ogg");
        const t = await transcribeAudio(bytes, m.mime ?? "audio/ogg", deps.ai ?? {});
        content = t.text; type = "audio"; audio_provider = t.provider;
        audio_path = await saving;
      } catch (e) {
        console.error("áudio Telegram:", (e as Error).message);
        await send(m.chat_id, "Não consegui entender o áudio agora. Pode enviar por texto?");
        return;
      }
    }
    if (!content) { await send(m.chat_id, "Por enquanto entendo mensagens de texto e áudio. 🙂"); return; }

    const reply = await handleMessage(
      { user_id, channel: "telegram", type, content, timestamp: new Date().toISOString(), audio_provider, audio_path, media_ref: m.file_id },
      { db: deps.db, ai: deps.ai },
    );
    await send(m.chat_id, reply.reply);
  }

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response("ok", { status: 200 });
    if (deps.tg.secret && req.headers.get("x-telegram-bot-api-secret-token") !== deps.tg.secret) {
      return new Response("forbidden", { status: 401 });
    }
    let body: any;
    try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
    const m = parseTelegramUpdate(body);
    if (!m) return new Response("ok", { status: 200 });
    const work = process(m).catch((e) => console.error("telegram:", e?.message));
    if (deps.waitUntil) deps.waitUntil(work); else await work;
    return new Response("ok", { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// Indicadores públicos (GET /assistant/mercado): só leitura, dados públicos do Banco Central
// ---------------------------------------------------------------------------
export function createMarketHandler(deps: { db: EngineDb; marketFetch?: typeof fetch; systemUser?: string }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "GET") return json({ error: "Método não permitido" }, 405);
    try {
      const m = await ensureMarket(deps.db, deps.systemUser ?? "00000000-0000-0000-0000-000000000000", deps.marketFetch ?? fetch);
      const resumo = Object.fromEntries(Object.entries(m.indicadores).map(([k, x]) => [k, { nome: x.nome, valor: x.valor, unidade: x.unidade, data: x.data }]));
      return json({ fonte: m.fonte, atualizado_em: m.atualizado_em, indicadores: resumo });
    } catch (e) { return json({ error: (e as Error).message }, 502); }
  };
}
