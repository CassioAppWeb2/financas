// "Reportar um erro" (Configurações do app): grava o relato e envia por e-mail, com as imagens anexadas.
// E-mail via Resend (plano gratuito). Se o e-mail não estiver configurado ou falhar, manda pelo Telegram
// de quem recebe os relatos (se estiver conectado), para nada se perder.

import type { EngineDb } from "./types.ts";

export interface ReportConfig {
  /** chave da Resend (segredo RESEND_API_KEY no Supabase) */
  resendKey?: string;
  /** para onde vão os relatos */
  to: string;
  /** remetente; sem domínio próprio, a Resend só aceita onboarding@resend.dev (e só envia para o e-mail da própria conta) */
  from?: string;
  /** bot do Telegram, para o envio reserva */
  tgToken?: string;
}

export interface ReportImage { nome?: string; tipo?: string; base64: string }
export interface ReportBody { texto?: string; imagens?: ReportImage[]; contexto?: Record<string, unknown> }
export interface ReportResult { status: "enviado" | "salvo"; email: string; telegram: string; aviso?: string; protocolo: string }

export class ReportError extends Error {}

const MAX_IMGS = 5;
const MAX_B64 = 7_000_000;        // ~5 MB por imagem (o app já reduz antes de enviar)
const MAX_TOTAL = 24_000_000;
const TIPOS = /^image\/(jpeg|png|webp|gif)$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ext = (t: string) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[t] ?? "jpg");

const ROTULOS: Record<string, string> = {
  tela: "Tela", versao: "Versão do app", navegador: "Navegador / aparelho", tela_tamanho: "Tamanho da tela",
  instalado: "App instalado", tema: "Tema", fuso: "Fuso horário", quando: "Data/hora no aparelho", online: "Com internet", erros_recentes: "Erros registrados pelo app",
};

function validar(body: ReportBody): { texto: string; imagens: Required<ReportImage>[] } {
  const texto = String(body.texto ?? "").trim();
  if (texto.length < 5) throw new ReportError("Descreva o erro com um pouco mais de detalhe.");
  if (texto.length > 5000) throw new ReportError("O texto ficou muito longo (máximo 5.000 caracteres).");
  const imgs = Array.isArray(body.imagens) ? body.imagens : [];
  if (imgs.length > MAX_IMGS) throw new ReportError(`Envie no máximo ${MAX_IMGS} imagens.`);
  let total = 0;
  const imagens = imgs.map((im, i) => {
    const tipo = String(im?.tipo ?? "image/jpeg").toLowerCase();
    const b64 = String(im?.base64 ?? "").replace(/^data:[^,]*,/, "");
    if (!TIPOS.test(tipo)) throw new ReportError("Envie as imagens em JPG, PNG ou WEBP.");
    if (!b64 || b64.length > MAX_B64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new ReportError(`A imagem ${i + 1} é grande demais ou está com problema.`);
    total += b64.length;
    const nome = String(im?.nome ?? "").replace(/[^\w.\- ]+/g, "").slice(0, 60) || `imagem-${i + 1}.${ext(tipo)}`;
    return { nome, tipo, base64: b64 };
  });
  if (total > MAX_TOTAL) throw new ReportError("As imagens juntas ficaram grandes demais. Envie menos imagens.");
  return { texto, imagens };
}

function contextoLinhas(ctx: Record<string, unknown>): [string, string][] {
  return Object.entries(ctx ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [ROTULOS[k] ?? k, Array.isArray(v) ? v.map(String).join("\n") : typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string])
    .map(([k, v]) => [k.slice(0, 60), v.slice(0, 2000)]);
}

export async function sendReport(deps: { db: EngineDb; cfg: ReportConfig; fetch?: typeof fetch }, userId: string, body: ReportBody): Promise<ReportResult> {
  const f = deps.fetch ?? fetch;
  const { texto, imagens } = validar(body);
  const ctx = (body.contexto && typeof body.contexto === "object") ? body.contexto : {};
  const salvo = await deps.db.rpc<{ id: string; nome: string | null; email: string | null; telegram_destino: string | null }>(
    "fe_report_save", userId, { texto, contexto: ctx, imagens: imagens.length, destino: deps.cfg.to });
  const protocolo = salvo.id.slice(0, 8).toUpperCase();
  const quem = `${salvo.nome || "Usuário"}${salvo.email ? ` <${salvo.email}>` : ""}`;
  const linhas = contextoLinhas(ctx);
  const resumo = texto.split("\n")[0].slice(0, 60);

  // ---- e-mail
  let email = "nao_configurado", erro = "";
  if (deps.cfg.resendKey) {
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#13232a;max-width:680px">
      <h2 style="margin:0 0 4px">🐞 Novo relato de erro</h2>
      <p style="margin:0 0 16px;color:#4b5c61">Protocolo <b>${protocolo}</b> · enviado por <b>${esc(quem)}</b></p>
      <div style="white-space:pre-wrap;background:#f3f6f5;border-radius:10px;padding:14px 16px;line-height:1.5">${esc(texto)}</div>
      ${imagens.length ? `<h3 style="margin:22px 0 8px">Imagens (${imagens.length})</h3>${imagens.map((im, i) =>
        `<p style="margin:0 0 12px"><img src="cid:img${i + 1}" alt="${esc(im.nome)}" style="max-width:100%;border:1px solid #dfe6e4;border-radius:8px"></p>`).join("")}
        <p style="color:#86959a;font-size:13px">As imagens também seguem como anexo.</p>` : ""}
      ${linhas.length ? `<h3 style="margin:22px 0 8px">Informações do aparelho</h3><table style="border-collapse:collapse;font-size:13px">${linhas.map(([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#4b5c61;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td></tr>`).join("")}</table>` : ""}
      <p style="color:#86959a;font-size:13px;margin-top:22px">Para falar com quem enviou, é só responder este e-mail.</p></div>`;
    const text = `Novo relato de erro — protocolo ${protocolo}\nEnviado por: ${quem}\n\n${texto}\n\n${linhas.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
    try {
      const r = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${deps.cfg.resendKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: deps.cfg.from || "Assistente Financeiro <onboarding@resend.dev>",
          to: [deps.cfg.to],
          ...(salvo.email ? { reply_to: salvo.email } : {}),
          subject: `🐞 Erro no app: ${resumo}${resumo.length < texto.length ? "…" : ""} (${protocolo})`,
          html, text,
          attachments: imagens.map((im, i) => ({ filename: im.nome, content: im.base64, content_type: im.tipo, content_id: `img${i + 1}` })),
        }),
      });
      if (r.ok) email = "enviado";
      else { email = "falhou"; erro = `e-mail ${r.status}: ${(await r.text()).slice(0, 300)}`; console.warn("relato:", erro); }
    } catch (e) { email = "falhou"; erro = `e-mail: ${(e as Error).message}`; console.warn("relato:", erro); }
  }

  // ---- reserva: Telegram de quem recebe os relatos
  let telegram = "nao_usado";
  if (email !== "enviado" && deps.cfg.tgToken && salvo.telegram_destino) {
    try {
      const api = `https://api.telegram.org/bot${deps.cfg.tgToken}`;
      const msg = `🐞 Relato de erro ${protocolo}\nDe: ${quem}\n\n${texto}${linhas.length ? `\n\n— Aparelho —\n${linhas.map(([k, v]) => `${k}: ${v}`).join("\n")}` : ""}`.slice(0, 4000);
      const r = await f(`${api}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: salvo.telegram_destino, text: msg }) });
      telegram = r.ok ? "enviado" : "falhou";
      for (const [i, im] of imagens.entries()) {
        const fd = new FormData();
        fd.append("chat_id", salvo.telegram_destino);
        fd.append("caption", `Relato ${protocolo} — imagem ${i + 1}`);
        fd.append("photo", new Blob([Uint8Array.from(atob(im.base64), (c) => c.charCodeAt(0))], { type: im.tipo }), im.nome);
        await f(`${api}/sendPhoto`, { method: "POST", body: fd });
      }
    } catch (e) { telegram = "falhou"; erro = `${erro} telegram: ${(e as Error).message}`.trim(); }
  }

  await deps.db.rpc("fe_report_done", userId, { id: salvo.id, email, telegram, erro: erro || null });
  const ok = email === "enviado" || telegram === "enviado";
  return {
    status: ok ? "enviado" : "salvo", email, telegram, protocolo,
    ...(ok ? {} : { aviso: "Seu relato foi guardado, mas o envio por e-mail ainda não está ativo no servidor. Ele não se perde." }),
  };
}
