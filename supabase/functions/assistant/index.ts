// Função de servidor única com três canais:
//   POST /functions/v1/assistant            -> app (chat e áudio do app)
//   GET|POST /functions/v1/assistant/whatsapp -> webhook da Meta WhatsApp Cloud API
//   POST /functions/v1/assistant/telegram     -> webhook do robô do Telegram
import { createAppHandler, createMarketHandler, createTelegramHandler, createWhatsAppHandler } from "../_shared/channels.ts";
import { postgrestEngine, getUserIdFromToken } from "../_shared/engine.ts";
import { supabaseAudioStore } from "../_shared/storage.ts";
import { createNotifyHandler } from "../_shared/notifier.ts";
import { SUPABASE_URL, SERVICE_KEY, ANON_KEY, aiConfig, waConfig, tgConfig, reportConfig } from "../_shared/config.ts";

declare const Deno: { serve(h: (r: Request) => Response | Promise<Response>): void };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const db = postgrestEngine(SUPABASE_URL, SERVICE_KEY);
const store = supabaseAudioStore(SUPABASE_URL, SERVICE_KEY);   // áudios ficam 7 dias para ouvir de novo
const waitUntil = typeof EdgeRuntime !== "undefined" ? (p: Promise<unknown>) => EdgeRuntime!.waitUntil(p) : undefined;

const app = createAppHandler({ db, ai: aiConfig, store, getUserId: (token) => getUserIdFromToken(SUPABASE_URL, ANON_KEY, token), report: reportConfig });
const whatsapp = createWhatsAppHandler({ db, ai: aiConfig, store, wa: waConfig, waitUntil });
const telegram = createTelegramHandler({ db, ai: aiConfig, store, tg: tgConfig, waitUntil });
const mercado = createMarketHandler({ db });
const notificar = createNotifyHandler({ db, tgToken: tgConfig.token });

Deno.serve((req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/whatsapp")) return whatsapp(req);
  if (path.endsWith("/telegram")) return telegram(req);
  if (path.endsWith("/mercado")) return mercado(req);
  if (path.endsWith("/notificar")) return notificar(req);
  return app(req);
});
