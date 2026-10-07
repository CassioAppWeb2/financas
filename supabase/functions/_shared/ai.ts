// Camada de IA substituível.
//  - Interpretação: regras locais primeiro; Gemini (plano gratuito) quando a frase é difícil.
//  - Transcrição de áudio: Gemini (gratuito) ou OpenAI Whisper — escolhido por variável de ambiente.
// A IA NUNCA grava no banco: ela só devolve um JSON que é validado aqui e executado pelo Motor Financeiro.

import { INTENTS, type Interpretation, type UserContext } from "./types.ts";
import { interpretRules } from "./interpreter_rules.ts";
import { findAmounts } from "./money.ts";
import { norm } from "./text.ts";

export interface AiConfig {
  geminiKey?: string;
  geminiModel?: string;      // padrão: gemini-2.5-flash
  openaiKey?: string;        // opcional (Whisper / GPT)
  groqKey?: string;          // opcional: Whisper gratuito e rápido na Groq
  sttProvider?: "gemini" | "openai";
  fetch?: typeof fetch;
}

const GEMINI_URL = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Modelos tentados em ordem: o Google aposenta modelos com frequência,
// então se um responder 404 (inexistente) ou 429/403 (sem cota grátis), tenta o próximo.
const GEMINI_FALLBACK = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-flash-latest", "gemini-3.5-flash-lite"];
let geminiWorking: string | undefined;

export async function geminiCall(cfg: AiConfig, body: unknown, timeoutMs: number): Promise<{ data: any; model: string }> {
  const f = cfg.fetch ?? fetch;
  const list = [...new Set([geminiWorking, cfg.geminiModel, ...GEMINI_FALLBACK].filter(Boolean) as string[])];
  let last = "";
  for (const model of list) {
    let res: Response;
    const t0 = Date.now();
    try {
      res = await f(GEMINI_URL(model), {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiKey! },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = `Gemini sem resposta em ${Math.round((Date.now() - t0) / 1000)}s (${model}): ${(e as Error).message}`;
      console.warn(last);
      if (geminiWorking === model) geminiWorking = undefined;
      continue;
    }
    if (res.ok) { geminiWorking = model; return { data: await res.json(), model }; }
    last = `Gemini ${res.status} (${model})`;
    console.warn(last, (await res.text()).slice(0, 300));
    if (![403, 404, 429, 500, 503].includes(res.status)) break;
    if (geminiWorking === model) geminiWorking = undefined;
  }
  throw new Error(last || "Gemini indisponível");
}

function buildPrompt(ctx: UserContext): string {
  const cats = ctx.categorias.map((c) => `${c.tipo}: ${c.nome}${c.subcategorias.length ? ` (${c.subcategorias.join(", ")})` : ""}`).join("\n");
  return `Você interpreta mensagens de um app de finanças pessoais no Brasil. Hoje é ${ctx.hoje} (fuso America/Sao_Paulo).
Responda SOMENTE com um objeto JSON com estes campos (omita os que não se aplicam):
{"intent": um de [${INTENTS.join(", ")}],
 "tipo": "despesa"|"receita"|"transferencia"|"investimento"|"resgate",
 "valor": número em reais (R$ 1.500,00 = 1500; "1,5 mil" = 1500),
 "data": "AAAA-MM-DD" (resolva "ontem", "dia 10" etc.; omita se não foi dita),
 "descricao": texto curto, "estabelecimento": nome do local se citado,
 "categoria": EXATAMENTE um nome da lista abaixo, "subcategoria": idem,
 "conta": nome de conta da lista, "conta_destino": idem, "parcelas": inteiro,
 "recorrente": booleano,
 "consulta": "total"|"maior"|"parcelas"|"saldo"|"disponivel"|"resumo"|"comparar"|"gastando_demais"|"posso_comprar",
 "periodo": {"inicio":"AAAA-MM-DD","fim":"AAAA-MM-DD","label":"texto curto"},
 "campo_correcao": "categoria"|"valor"|"data"|"descricao"|"conta",
 "confidence": 0 a 1}
Regras: NUNCA invente valores, datas ou categorias que não estejam na mensagem ou na lista. Se o valor não foi dito, omita "valor".
Se a categoria não for clara, omita "categoria". Perguntas sobre gastos/saldo/finanças são consultas (QUERY_* ou FINANCIAL_ANALYSIS).
Categorias do usuário:
${cats}
Contas: ${ctx.contas.join(", ")}`;
}

/** Garante que o JSON da IA só contém valores válidos e que existem no cadastro do usuário. */
export function sanitize(raw: any, text: string, ctx: UserContext): Interpretation | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Interpretation = { intent: INTENTS.includes(raw.intent) ? raw.intent : "OTHER", confidence: 0.5 };
  const tipos = ["despesa", "receita", "transferencia", "investimento", "resgate"];
  if (tipos.includes(raw.tipo)) out.tipo = raw.tipo;
  const v = Number(raw.valor);
  // só aceita valor se a mensagem realmente menciona um número
  if (Number.isFinite(v) && v > 0 && v < 1e9 && findAmounts(text).some((c) => c.role === "valor")) out.valor = Math.round(v * 100) / 100;
  const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
  if (isDate(raw.data)) { out.data = raw.data; out.data_explicita = true; }
  for (const k of ["descricao", "estabelecimento"] as const) {
    if (typeof raw[k] === "string" && raw[k].trim()) out[k] = raw[k].trim().slice(0, 80);
  }
  const kind = out.tipo === "receita" ? "receita" : "despesa";
  const cat = ctx.categorias.find((c) => c.tipo === kind && norm(c.nome) === norm(String(raw.categoria ?? "")));
  if (cat) {
    out.categoria = cat.nome;
    const sub = cat.subcategorias.find((s) => norm(s) === norm(String(raw.subcategoria ?? "")));
    if (sub) out.subcategoria = sub;
    out.categoria_confianca = 0.85;
  }
  const acc = (s: unknown) => ctx.contas.find((c) => norm(c) === norm(String(s ?? "")));
  out.conta = acc(raw.conta); out.conta_destino = acc(raw.conta_destino);
  const p = Number(raw.parcelas);
  if (Number.isInteger(p) && p >= 2 && p <= 72) out.parcelas = p;
  if (raw.recorrente === true) out.recorrente = true;
  const consultas = ["total", "maior", "parcelas", "saldo", "disponivel", "resumo", "comparar", "gastando_demais", "posso_comprar"];
  if (consultas.includes(raw.consulta)) out.consulta = raw.consulta;
  if (raw.periodo && isDate(raw.periodo.inicio) && isDate(raw.periodo.fim) && raw.periodo.inicio <= raw.periodo.fim) {
    out.periodo = { inicio: raw.periodo.inicio, fim: raw.periodo.fim, label: String(raw.periodo.label ?? "no período").slice(0, 40) };
  }
  if (["categoria", "valor", "data", "descricao", "conta"].includes(raw.campo_correcao)) out.campo_correcao = raw.campo_correcao;
  const c = Number(raw.confidence);
  out.confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.6;
  return out;
}

export async function interpretWithGemini(text: string, ctx: UserContext, cfg: AiConfig): Promise<Interpretation | null> {
  if (!cfg.geminiKey) return null;
  const { data, model } = await geminiCall(cfg, {
    systemInstruction: { parts: [{ text: buildPrompt(ctx) }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  }, 12000);
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) return null;
  const parsed = sanitize(JSON.parse(raw), text, ctx);
  if (parsed) { parsed.provider = "gemini"; parsed.model = model; }
  return parsed;
}

/**
 * Estratégia: regras primeiro (grátis e instantâneo). Se a confiança for baixa
 * e houver chave do Gemini, pergunta à IA. Valores encontrados pelas regras
 * têm prioridade (são extraídos literalmente do texto).
 */
export async function interpret(text: string, ctx: UserContext, cfg: AiConfig = {}): Promise<Interpretation> {
  const rules = interpretRules(text, ctx);
  if (rules.intent !== "OTHER" && rules.confidence >= 0.85) return rules;
  if (!cfg.geminiKey) return rules;
  try {
    const ai = await interpretWithGemini(text, ctx, cfg);
    if (!ai || ai.intent === "OTHER") return rules;
    if (rules.intent !== "OTHER" && rules.confidence >= ai.confidence) return rules;
    if (rules.valor !== undefined) { ai.valor = rules.valor; ai.alternativas = rules.alternativas; }
    if (rules.parcelas) ai.parcelas = rules.parcelas;
    if (!ai.data && rules.data) { ai.data = rules.data; ai.data_explicita = rules.data_explicita; }
    if (!ai.periodo && rules.periodo) ai.periodo = rules.periodo;
    ai.saudacao = rules.saudacao;
    return ai;
  } catch (e) {
    console.error("gemini falhou, usando regras:", (e as Error).message);
    return rules;
  }
}

// ---------------------------------------------------------------------------
// Transcrição de áudio (Speech-to-Text) — fornecedor substituível
// ---------------------------------------------------------------------------
export interface Transcription { text: string; provider: string; }

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function whisper(url: string, key: string, model: string, bytes: Uint8Array, mime: string, f: typeof fetch): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes as unknown as ArrayBuffer], { type: mime }), "audio." + (mime.split("/")[1]?.split(";")[0] || "ogg"));
  form.append("model", model);
  form.append("language", "pt");
  const r = await f(url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return String((await r.json()).text ?? "").trim();
}

export async function transcribeAudio(bytes: Uint8Array, mime: string, cfg: AiConfig): Promise<Transcription> {
  const f = cfg.fetch ?? fetch;
  if (cfg.groqKey) {
    try {
      const text = await whisper("https://api.groq.com/openai/v1/audio/transcriptions", cfg.groqKey, "whisper-large-v3-turbo", bytes, mime, f);
      return { text, provider: "groq-whisper" };
    } catch (e) {
      console.warn("Groq falhou:", (e as Error).message);
      if (!cfg.geminiKey && !cfg.openaiKey) throw e;
    }
  }
  const provider = cfg.sttProvider ?? (cfg.openaiKey && !cfg.geminiKey ? "openai" : "gemini");
  if (provider === "openai") {
    if (!cfg.openaiKey) throw new Error("OPENAI_API_KEY não configurada");
    const text = await whisper("https://api.openai.com/v1/audio/transcriptions", cfg.openaiKey, "whisper-1", bytes, mime, f);
    return { text, provider: "openai-whisper" };
  }
  if (!cfg.geminiKey) throw new Error("GEMINI_API_KEY não configurada");
  const { data: d, model } = await geminiCall(cfg, {
    contents: [{ role: "user", parts: [
      { text: "Transcreva fielmente este áudio em português do Brasil. Responda apenas com a transcrição, sem comentários." },
      { inlineData: { mimeType: mime.split(";")[0], data: toBase64(bytes) } },
    ] }],
    generationConfig: { temperature: 0 },
  }, 20000);
  return { text: String(d?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim(), provider: `gemini:${model}` };
}
