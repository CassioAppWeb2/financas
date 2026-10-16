// Configurações → Reportar um erro: grava o relato, envia por e-mail (Resend) com as imagens e,
// se o e-mail não estiver configurado, usa o Telegram de quem recebe os relatos.
import { beforeAll, describe, expect, test } from "bun:test";
import { localEngine } from "../dev/local_engine.ts";
import { sendReport } from "../supabase/functions/_shared/report.ts";
import { createAppHandler } from "../supabase/functions/_shared/channels.ts";

const db = localEngine();
const q = async (sql: string, ...args: unknown[]) => (await db.sql.unsafe(sql, args)) as any[];
const newUser = async (name: string, email = `${name}.${crypto.randomUUID()}@x.com`) =>
  (await q(`insert into auth.users(email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, email, { name }))[0].id as string;

// 1x1 px PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
type Call = { url: string; init: RequestInit };
const fakeFetch = (calls: Call[], status = 200) => (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response("{}", { status }); }) as unknown as typeof fetch;

let bruna = "", destino = "", cassio = "";
beforeAll(async () => {
  destino = `cassio.${crypto.randomUUID()}@x.com`;
  cassio = await newUser("Cássio", destino);
  bruna = await newUser("Bruna");
  await q(`insert into telegram_connections(user_id, chat_id) values ($1, $2)`, cassio, String(Math.floor(Math.random() * 1e12)));
});

describe("Reportar um erro", () => {
  test("envia e-mail para o destino, com texto, imagens anexadas e resposta para quem relatou", async () => {
    const calls: Call[] = [];
    const r = await sendReport({ db, cfg: { to: destino, resendKey: "k" }, fetch: fakeFetch(calls) }, bruna, {
      texto: "Ao salvar a despesa aparece erro.\nAconteceu 2 vezes.", imagens: [{ nome: "print.png", tipo: "image/png", base64: PNG }],
      contexto: { tela: "#/lancamentos", versao: "2026.10.16", erros_recentes: ["10:00 TypeError: x"] },
    });
    expect(r.status).toBe("enviado");
    expect(r.email).toBe("enviado");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as any).authorization).toBe("Bearer k");
    const b = JSON.parse(String(calls[0].init.body));
    expect(b.to).toEqual([destino]);
    expect(b.reply_to).toContain("Bruna.");
    expect(b.subject).toContain("Ao salvar a despesa aparece erro.");
    expect(b.html).toContain("Aconteceu 2 vezes.");
    expect(b.html).toContain("#/lancamentos");
    expect(b.html).toContain("cid:img1");
    expect(b.attachments).toEqual([{ filename: "print.png", content: PNG, content_type: "image/png", content_id: "img1" }]);
    const [row] = await q(`select message, images, email_status, context->>'tela' tela from error_reports where user_id = $1 order by created_at desc limit 1`, bruna);
    expect(row).toEqual({ message: "Ao salvar a despesa aparece erro.\nAconteceu 2 vezes.", images: 1, email_status: "enviado", tela: "#/lancamentos" });
  });

  test("texto com HTML não vira código no e-mail", async () => {
    const calls: Call[] = [];
    await sendReport({ db, cfg: { to: destino, resendKey: "k" }, fetch: fakeFetch(calls) }, bruna, { texto: "<script>alert(1)</script> botão sumiu" });
    const b = JSON.parse(String(calls[0].init.body));
    expect(b.html).not.toContain("<script>");
    expect(b.html).toContain("&lt;script&gt;");
  });

  test("sem e-mail configurado: vai pelo Telegram de quem recebe, com as imagens", async () => {
    const calls: Call[] = [];
    const r = await sendReport({ db, cfg: { to: destino, tgToken: "T" }, fetch: fakeFetch(calls) }, bruna, {
      texto: "O gráfico não carrega", imagens: [{ tipo: "image/png", base64: PNG }, { tipo: "image/png", base64: PNG }],
    });
    expect(r.status).toBe("enviado");
    expect(r.email).toBe("nao_configurado");
    expect(r.telegram).toBe("enviado");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["sendMessage", "sendPhoto", "sendPhoto"]);
    expect(JSON.parse(String(calls[0].init.body)).text).toContain("O gráfico não carrega");
  });

  test("e-mail falhou e sem Telegram: fica guardado e avisa", async () => {
    const calls: Call[] = [];
    const r = await sendReport({ db, cfg: { to: "ninguem@x.com", resendKey: "k" }, fetch: fakeFetch(calls, 500) }, bruna, { texto: "Tela branca ao abrir" });
    expect(r.status).toBe("salvo");
    expect(r.aviso).toContain("guardado");
    const [row] = await q(`select email_status, error from error_reports where user_id = $1 and message = 'Tela branca ao abrir'`, bruna);
    expect(row.email_status).toBe("falhou");
    expect(row.error).toContain("500");
  });

  test("valida texto e imagens", async () => {
    const cfg = { to: destino, resendKey: "k" };
    await expect(sendReport({ db, cfg, fetch: fakeFetch([]) }, bruna, { texto: "oi" })).rejects.toThrow("mais de detalhe");
    await expect(sendReport({ db, cfg, fetch: fakeFetch([]) }, bruna, { texto: "erro grave", imagens: Array(6).fill({ tipo: "image/png", base64: PNG }) })).rejects.toThrow("no máximo 5");
    await expect(sendReport({ db, cfg, fetch: fakeFetch([]) }, bruna, { texto: "erro grave", imagens: [{ tipo: "application/pdf", base64: PNG }] })).rejects.toThrow("JPG, PNG");
  });

  test("pelo app: ação reportar_erro", async () => {
    const calls: Call[] = [];
    const h = createAppHandler({ db, getUserId: async () => bruna, report: { to: destino, resendKey: "k" }, reportFetch: fakeFetch(calls) });
    const res = await h(new Request("http://x/", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ acao: "reportar_erro", texto: "Não consigo apagar a conta" }) }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.status).toBe("enviado");
    expect(j.protocolo).toMatch(/^[0-9A-F]{8}$/);
    const bad = await h(new Request("http://x/", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ acao: "reportar_erro", texto: "" }) }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("detalhe");
  });
});
