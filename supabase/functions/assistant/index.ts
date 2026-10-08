// Função de servidor única com três canais:
//   POST /functions/v1/assistant            -> app (chat e áudio do app)
//   GET|POST /functions/v1/assistant/whatsapp -> webhook da Meta WhatsApp Cloud API
//   POST /functions/v1/assistant/telegram     -> webhook do robô do Telegram
import { createAppHandler, createTelegramHandler, createWhatsAppHandler } from "../_shared/channels.ts";
import { postgrestEngine, getUserIdFromToken } from "../_shared/engine.ts";
import { supabaseAudioStore } from "../_shared/storage.ts";
import { SUPABASE_URL, SERVICE_KEY, ANON_KEY, aiConfig, waConfig, tgConfig } from "../_shared/config.ts";

declare const Deno: { serve(h: (r: Request) => Response | Promise<Response>): void };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const db = postgrestEngine(SUPABASE_URL, SERVICE_KEY);
const store = supabaseAudioStore(SUPABASE_URL, SERVICE_KEY);   // áudios ficam 7 dias para ouvir de novo
const waitUntil = typeof EdgeRuntime !== "undefined" ? (p: Promise<unknown>) => EdgeRuntime!.waitUntil(p) : undefined;

const app = createAppHandler({ db, ai: aiConfig, store, getUserId: (token) => getUserIdFromToken(SUPABASE_URL, ANON_KEY, token) });
const whatsapp = createWhatsAppHandler({ db, ai: aiConfig, store, wa: waConfig, waitUntil });
const telegram = createTelegramHandler({ db, ai: aiConfig, store, tg: tgConfig, waitUntil });

Deno.serve((req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/whatsapp")) return whatsapp(req);
  if (path.endsWith("/telegram")) return telegram(req);
  return app(req);
});
