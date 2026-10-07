// Implementação LOCAL do acesso ao Motor Financeiro (para testes e servidor de desenvolvimento).
// Em produção é usado postgrestEngine (supabase/functions/_shared/engine.ts).
import { SQL } from "bun";
import type { EngineDb } from "../supabase/functions/_shared/types.ts";

export const DB_URL = process.env.LOCAL_DB_URL ?? "postgres://postgres@127.0.0.1:54329/financas";

export function localEngine(sql = new SQL(DB_URL)): EngineDb & { sql: SQL } {
  return {
    sql,
    async rpc(fn, userId, payload = {}) {
      if (!/^fe_[a-z_]+$/.test(fn)) throw new Error("função inválida");
      const rows = await sql.unsafe(`select to_jsonb(public.${fn}($1::uuid, $2::jsonb)) as r`, [userId, payload]);
      return rows[0].r;
    },
  };
}
