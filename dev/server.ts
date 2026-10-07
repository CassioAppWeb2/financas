// Servidor LOCAL que imita o Supabase (login, /rest/v1/rpc e a função "assistant") para testar o app sem internet.
// Uso: ./dev/reset_db.sh && bun dev/server.ts  → http://localhost:5173
// NÃO é usado em produção.
import { localEngine } from "./local_engine.ts";
import { createAppHandler } from "../supabase/functions/_shared/channels.ts";

const db = localEngine();
const sql = db.sql;
const tokens = new Map<string, { id: string; email: string }>();
const WEB = new URL("../web/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 5173);

const json = (b: unknown, status = 200) => Response.json(b, { status });
const issue = (u: { id: string; email: string }) => {
  const access_token = crypto.randomUUID(), refresh_token = crypto.randomUUID();
  tokens.set(access_token, u); tokens.set("r:" + refresh_token, u);
  return { access_token, refresh_token, expires_in: 3600, user: { id: u.id, email: u.email } };
};
const userOf = (req: Request) => tokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

// FAKE_EXTRACT=1: simula a leitura de PDF (sem IA) para testar a tela de importação
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const fakeExtract = process.env.FAKE_EXTRACT ? async () => ({
  tipo: "fatura_cartao" as const, banco: "Nubank", cartao: "Nubank", total: 205.9,
  itens: [
    { data: today, descricao: "UBER *TRIP", valor: 25.9 },
    { data: today, descricao: "POSTO SHELL", valor: 150 },
    { data: today, descricao: "PADARIA REAL", valor: 30, categoria: "Alimentação" },
    { data: today, descricao: "PAGAMENTO RECEBIDO", valor: -400 },
  ],
}) : undefined;
const assistant = createAppHandler({ db, getUserId: async (t) => tokens.get(t)?.id ?? null, extract: fakeExtract });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/auth/v1/signup") {
        const b = await req.json();
        if (String(b.password ?? "").length < 6) return json({ msg: "Password should be at least 6 characters." }, 422);
        const hash = await Bun.password.hash(b.password);
        const rows = await sql`insert into auth.users(email, encrypted_password, raw_user_meta_data)
          values (${b.email}, ${hash}, ${b.data ?? {}}) on conflict (email) do nothing returning id, email`;
        if (!rows.length) return json({ msg: "User already registered" }, 422);
        return json(issue(rows[0]));
      }
      if (p === "/auth/v1/token") {
        const b = await req.json();
        if (url.searchParams.get("grant_type") === "refresh_token") {
          const u = tokens.get("r:" + b.refresh_token);
          return u ? json(issue(u)) : json({ error_description: "Invalid Refresh Token" }, 400);
        }
        const [u] = await sql`select id, email, encrypted_password from auth.users where email = ${b.email}`;
        if (!u || !u.encrypted_password || !(await Bun.password.verify(b.password, u.encrypted_password)))
          return json({ error_description: "Invalid login credentials" }, 400);
        return json(issue(u));
      }
      if (p === "/auth/v1/logout") return new Response(null, { status: 204 });
      if (p === "/auth/v1/user") { const u = userOf(req); return u ? json(u) : json({ msg: "unauthorized" }, 401); }

      const rpc = p.match(/^\/rest\/v1\/rpc\/(app_[a-z_]+)$/);
      if (rpc) {
        const u = userOf(req);
        if (!u) return json({ message: "JWT expired" }, 401);
        const b = await req.json().catch(() => ({}));
        try {
          const r = await sql.begin(async (tx) => {
            await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [u.id]);
            await tx.unsafe(`set local role authenticated`);
            return tx.unsafe(`select to_jsonb(public.${rpc[1]}($1::jsonb)) as r`, [b.p ?? {}]);
          });
          return json(r[0].r);
        } catch (e) {
          return json({ message: (e as Error).message }, 400);
        }
      }
      if (p === "/functions/v1/assistant") return assistant(req);

      // arquivos estáticos do app
      const file = Bun.file(WEB + (p === "/" ? "index.html" : p.slice(1)));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ message: (e as Error).message }, 500);
    }
  },
});
console.log(`App local em http://localhost:${PORT}`);
