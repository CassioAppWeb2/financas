// Cliente do Motor Financeiro. Em produção chama as funções fe_* do banco
// pela API REST do Supabase usando a chave de serviço (que nunca vai ao navegador).
import type { EngineDb } from "./types.ts";

export class EngineError extends Error {}

export function postgrestEngine(url: string, serviceKey: string, f: typeof fetch = fetch): EngineDb {
  return {
    async rpc(fn, userId, payload = {}) {
      const res = await f(`${url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ p_user: userId, p: payload }),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new EngineError(body?.message ?? `Erro ${res.status} em ${fn}`);
      return body;
    },
  };
}

/** Valida o token do usuário logado no app e devolve o id dele. */
export async function getUserIdFromToken(url: string, anonKey: string, token: string, f: typeof fetch = fetch): Promise<string | null> {
  const res = await f(`${url}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ?? null;
}
