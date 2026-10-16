// Lê a configuração das variáveis de ambiente do Supabase (Deno).
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são fornecidas automaticamente.
import type { AiConfig } from "./ai.ts";
import type { TelegramConfig, WhatsAppConfig } from "./channels.ts";
import type { ReportConfig } from "./report.ts";

declare const Deno: { env: { get(k: string): string | undefined } };
const env = (k: string) => Deno.env.get(k) || undefined;

export const SUPABASE_URL = env("SUPABASE_URL")!;
export const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = env("SUPABASE_ANON_KEY")!;

export const aiConfig: AiConfig = {
  geminiKey: env("GEMINI_API_KEY"),
  geminiModel: env("GEMINI_MODEL"),
  openaiKey: env("OPENAI_API_KEY"),
  groqKey: env("GROQ_API_KEY"),
  sttProvider: env("STT_PROVIDER") as AiConfig["sttProvider"],
};

export const waConfig: WhatsAppConfig = {
  token: env("WHATSAPP_TOKEN"),
  phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
  verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
  appSecret: env("WHATSAPP_APP_SECRET"),
  graphVersion: env("WHATSAPP_GRAPH_VERSION"),
  monthlyLimit: env("WHATSAPP_MONTHLY_LIMIT") ? Number(env("WHATSAPP_MONTHLY_LIMIT")) : undefined,
};

export const tgConfig: TelegramConfig = {
  token: env("TELEGRAM_BOT_TOKEN"),
  secret: env("TELEGRAM_WEBHOOK_SECRET"),
};

/** "Reportar um erro" no app: e-mail pela Resend (segredo RESEND_API_KEY); sem ele, vai pelo Telegram. */
export const reportConfig: ReportConfig = {
  resendKey: env("RESEND_API_KEY"),
  to: env("REPORT_EMAIL") || "cassio_filipin@hotmail.com",
  from: env("REPORT_FROM"),
  tgToken: env("TELEGRAM_BOT_TOKEN"),
};
