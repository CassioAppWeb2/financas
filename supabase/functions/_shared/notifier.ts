// Envio das notificações para o celular: chamado a cada 30 minutos pelo agendador do banco (pg_cron).
// Para cada aviso novo: Web Push nos aparelhos ativados e mensagem no Telegram (se conectado).

import type { EngineDb } from "./types.ts";
import { ensureVapid, sendPush, type PushSub } from "./webpush.ts";

const SYS = "00000000-0000-0000-0000-000000000000";

interface QueueItem {
  id: string; user_id: string; tipo: string; titulo: string; texto: string; link?: string; dados?: any;
  aparelhos: PushSub[]; telegram?: string | null;
}

export interface NotifyDeps { db: EngineDb; tgToken?: string; fetch?: typeof fetch; /** só para testes */ hora?: number }

export async function runNotifications(deps: NotifyDeps): Promise<{ avisos: number; push: number; telegram: number }> {
  const f = deps.fetch ?? fetch;
  const fila = await deps.db.rpc<QueueItem[]>("fe_push_queue", SYS, deps.hora !== undefined ? { hora: deps.hora } : {});
  if (!fila.length) return { avisos: 0, push: 0, telegram: 0 };
  const vapid = fila.some((x) => x.aparelhos.length) ? await ensureVapid(deps.db) : null;
  const ok: string[] = [], falhou: string[] = [], expirou: string[] = [];
  let push = 0, tg = 0;
  for (const n of fila) {
    for (const s of n.aparelhos) {
      const r = await sendPush(s, { title: n.titulo, body: n.texto, url: n.link ?? "#/", tag: `${n.tipo}:${n.id}` }, vapid!, f);
      (r === "ok" ? ok : r === "expirou" ? expirou : falhou).push(s.endpoint);
      if (r === "ok") push++;
    }
    if (n.telegram && deps.tgToken) {
      let texto = `🔔 *${n.titulo}*\n${n.texto}`;
      if (n.tipo === "renovar" && n.dados?.recorrencia_id) {
        texto += `\n\nResponda aqui: *mesmo valor*, o *novo valor* (ex.: 1.350) ou *encerrar*.`;
        // deixa a conversa pronta para entender a resposta
        try {
          const st = await deps.db.rpc<{ pending: unknown }>("fe_chat_state", n.user_id, {});
          if (!st.pending) {
            await deps.db.rpc("fe_chat_state", n.user_id, { pending: {
              kind: "renew_recurring", id: n.dados.recorrencia_id, nome: n.dados.descricao ?? "conta fixa", valor_cents: Number(n.dados.valor_cents ?? 0),
            } });
          }
        } catch { /* sem conversa ainda */ }
      }
      try {
        const r = await f(`https://api.telegram.org/bot${deps.tgToken}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: n.telegram, text: texto, parse_mode: "Markdown" }),
        });
        if (r.ok) tg++;
      } catch (e) { console.warn("telegram:", (e as Error).message); }
    }
  }
  await deps.db.rpc("fe_push_done", SYS, { ids: fila.map((x) => x.id), ok, falhou, expirou });
  return { avisos: fila.length, push, telegram: tg };
}

/** POST /assistant/notificar — só o agendador (com a chave gerada no banco) pode chamar. */
export function createNotifyHandler(deps: NotifyDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response("Método não permitido", { status: 405 });
    const key = req.headers.get("x-cron-key") ?? "";
    const real = (await deps.db.rpc<{ valor: string | null }>("fe_secret", SYS, { nome: "cron_key" })).valor;
    if (!real || key.length !== real.length || key !== real) return new Response("Não autorizado", { status: 401 });
    try {
      const r = await runNotifications(deps);
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    } catch (e) {
      console.error("notificações:", (e as Error).message);
      return new Response(JSON.stringify({ erro: (e as Error).message }), { status: 500, headers: { "content-type": "application/json" } });
    }
  };
}
