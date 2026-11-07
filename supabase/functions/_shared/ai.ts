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

// O Google aposenta e sobrecarrega modelos com frequência. Para não ficar esperando um
// modelo lento, a pergunta vai para vários modelos AO MESMO TEMPO e vale a primeira resposta boa.
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-flash-latest"];

/** Texto da resposta do Gemini (ignora partes que não são texto). */
export function textOf(data: any): string {
  return (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
}

export async function geminiCall(cfg: AiConfig, body: unknown, timeoutMs: number, models?: string[]): Promise<{ data: any; model: string }> {
  const f = cfg.fetch ?? fetch;
  const list = models ?? [...new Set([cfg.geminiModel, ...GEMINI_MODELS].filter(Boolean) as string[])];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const payload = JSON.stringify(body);
  const errors: string[] = [];
  try {
    return await Promise.any(list.map(async (model) => {
      const res = await f(GEMINI_URL(model), {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiKey! },
        body: payload,
        signal: ctrl.signal,
      });
      if (!res.ok) { errors.push(`${model}: ${res.status}`); throw new Error(String(res.status)); }
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      if (!parts.some((x: any) => x.text || x.functionCall)) { errors.push(`${model}: vazio`); throw new Error("vazio"); }
      return { data, model };
    }));
  } catch {
    const msg = `Gemini indisponível (${errors.join(", ") || "sem resposta a tempo"})`;
    console.warn(msg);
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/**
 * Para entender frases, os modelos "lite" respondem mais rápido mas erram mais (ex.: confundem
 * quantidade com preço). Pergunta a todos; se um lite chegar primeiro, espera um pouco por um completo.
 */
export async function geminiPreferFull(cfg: AiConfig, body: unknown, timeoutMs: number, esperaMs = 3500): Promise<{ data: any; model: string }> {
  const all = [...new Set([cfg.geminiModel, ...GEMINI_MODELS].filter(Boolean) as string[])];
  const full = all.filter((m) => !/lite/.test(m)), lite = all.filter((m) => /lite/.test(m));
  if (!full.length || !lite.length) return geminiCall(cfg, body, timeoutMs, all);
  const pFull = geminiCall(cfg, body, timeoutMs, full);
  const pLite = geminiCall(cfg, body, timeoutMs, lite);
  pFull.catch(() => {}); pLite.catch(() => {});
  const first = await Promise.any([pFull.then((r) => ({ r, full: true })), pLite.then((r) => ({ r, full: false }))])
    .catch(() => { throw new Error("Gemini indisponível"); });
  if (first.full) return first.r;
  const f = await Promise.race([pFull.catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), esperaMs))]);
  return f ?? first.r;
}

// ---------------------------------------------------------------------------
// INTERPRETAÇÃO COM IA
// A IA lê a mensagem com o contexto da pessoa (categorias, contas, cartões, família), as últimas
// mensagens da conversa e o lançamento que está em andamento. Ela devolve um JSON; tudo é
// conferido aqui (valores precisam estar na mensagem, nomes precisam existir) e só o Motor grava.
// ---------------------------------------------------------------------------
export interface Turn { papel: "user" | "assistant"; texto: string }
/** lançamento em andamento (ainda NÃO registrado) e a pergunta que o assistente fez */
export interface PendingCtx { lancamento: Interpretation; pergunta: string }
export type AiAction = "nova_mensagem" | "responder_pendente" | "cancelar_pendente" | "status_pendente";

function buildPrompt(ctx: UserContext, pend?: PendingCtx): string {
  const cats = ctx.categorias.map((c) => `${c.tipo}: ${c.nome}${c.subcategorias.length ? ` (${c.subcategorias.join(", ")})` : ""}`).join("\n");
  const membros = (ctx.membros ?? []);
  const eu = membros.find((m) => m.eu)?.nome ?? ctx.nome ?? "a pessoa";
  const outros = membros.filter((m) => !m.eu).map((m) => m.nome);
  const resumoPend = pend ? JSON.stringify(Object.fromEntries(Object.entries(pend.lancamento).filter(([k, v]) =>
    v !== undefined && !["confidence", "provider", "model", "alternativas", "categoria_confianca", "data_explicita"].includes(k)))) : "";
  return `Você é o cérebro de um assistente de finanças pessoais no Brasil. Hoje é ${ctx.hoje} (fuso America/Sao_Paulo).
Quem está falando: ${eu}.${outros.length ? ` Família no app: ${eu} (quem fala) e ${outros.join(", ")}.` : ""}
Leia a ÚLTIMA mensagem do usuário (as anteriores são só contexto) e responda SOMENTE com um objeto JSON:
{"acao": "nova_mensagem" | "responder_pendente" | "cancelar_pendente" | "status_pendente",
 "intent": um de [${INTENTS.join(", ")}],
 "tipo": "despesa"|"receita"|"transferencia"|"investimento"|"resgate",
 "valor": número em reais do TOTAL (R$ 1.500,00 = 1500; "1,5 mil" = 1500; "total de 508" = 508),
 "quantidade": inteiro, quantas unidades foram compradas ("5 cervejas" = 5; "duas pizzas" = 2),
 "valor_unitario": preço de UMA unidade, se foi dito ("12 cada", "cada uma custou 12", "a 12 reais a unidade"),
 "pagamentos": [{"forma_pagamento": ..., "conta": ..., "cartao": ..., "quantidade": n, "valor": reais}] — SÓ quando a mesma compra foi paga de formas diferentes ("3 no Pix e 2 em dinheiro", "100 no débito e o resto no crédito"),
 "parcelas": inteiro (compra parcelada: "em 4x", "quatro parcelas", "dividido em 10 vezes"),
 "data": "AAAA-MM-DD" (só se a data foi dita: "ontem", "dia 10"),
 "descricao": o que foi comprado/recebido, curto, com inicial maiúscula (ex.: "Camisetas", "Sofá"),
 "estabelecimento": nome da loja/empresa se citado (ex.: "Minimal Club"),
 "categoria": EXATAMENTE um nome da lista, "subcategoria": idem (escolha a mais adequada ao que foi comprado: camisetas -> Vestuário),
 "conta": nome de conta da lista, "conta_destino": idem, "cartao": nome de cartão da lista (compra no crédito),
 "forma_pagamento": "credito"|"debito"|"pix"|"dinheiro"|"boleto",
 "de_quem": "eu" | "familia" | nome de outra pessoa da família (de quem é o gasto; "compramos/nosso/da casa" = familia; "só meu/sozinho" = eu),
 "dividir": true/false (compra dividida ENTRE PESSOAS da família; "dividido em 4 parcelas" NÃO é dividir, é parcelas; "não é dividido", "só meu", "sozinho" = false),
 "divisao_igual": true se for meio a meio / metade / partes iguais,
 "partes": [{"pessoa": "eu" ou nome, "valor": reais, "percentual": número}] (só o que foi dito),
 "membro": "eu" | "familia" | nome (em CONSULTAS: de quem são os gastos perguntados; "quanto gastei" = eu; "quanto gastamos/a família gastou" = familia),
 "recorrente": booleano, "frequencia": "mensal"|"semanal"|"anual", "dia": dia do mês, "dia_util": n-ésimo dia útil,
 "meta": nome de meta, "prazo": "AAAA-MM-DD",
 "consulta": "total"|"maior"|"parcelas"|"saldo"|"disponivel"|"resumo"|"comparar"|"gastando_demais"|"posso_comprar"|"fatura"|"limite"|"cartoes",
 "periodo": {"inicio":"AAAA-MM-DD","fim":"AAAA-MM-DD","label":"texto curto"},
 "campo_correcao": "categoria"|"valor"|"data"|"descricao"|"conta",
 "confidence": 0 a 1}
${pend ? `HÁ UM LANÇAMENTO EM ANDAMENTO (ainda NÃO foi registrado): ${resumoPend}
A última pergunta do assistente foi: "${pend.pergunta.slice(0, 400)}"
- Se a mensagem responde, completa ou CORRIGE esse lançamento (ex.: dá a categoria, diz que não é dividido, troca o cartão, muda o valor): acao="responder_pendente" e devolva TODOS os campos do lançamento já corrigidos.
- Se pede para desistir dele: acao="cancelar_pendente". Se pergunta se já foi feito/lançado: acao="status_pendente".
- Se é um assunto novo, sem relação: acao="nova_mensagem".` : `Não há lançamento em andamento: use acao="nova_mensagem".`}
Regras: NUNCA invente valores, datas, contas ou cartões que não estejam na mensagem (ou no lançamento em andamento). Se o valor não foi dito, omita "valor".
QUANTIDADE NÃO É PREÇO: em "comprei 5 cervejas, 3 delas no Pix e 2 em dinheiro" os números 5, 3 e 2 são quantidades — quantidade=5, pagamentos=[{"forma_pagamento":"pix","quantidade":3},{"forma_pagamento":"dinheiro","quantidade":2}] e SEM "valor" (o preço não foi dito).
Se depois disserem "cada uma é 12", isso é valor_unitario=12 (responder_pendente); não some nem multiplique você mesmo, só informe quantidade e valor_unitario.
Ignore no início da mensagem palavras soltas que não fazem parte do pedido (ruído do áudio, como "o que você diz?").
Categoria pelo SENTIDO do que foi comprado: bebidas/cerveja em bar ou festa -> lazer (restaurantes de lazer/bares), cerveja no mercado -> supermercado; "Hobbies" só para passatempos (artesanato, coleções, instrumentos).
Use as mensagens anteriores só para entender referências ("o mesmo", "aquele", "foi no Nubank").
Perguntas sobre gastos/saldo/finanças são consultas (QUERY_* ou FINANCIAL_ANALYSIS). Cadastros/alterações de cartão, conta ou categoria = ADMIN.
PAY_INVOICE = pagou a fatura do cartão; GOAL_CONTRIBUTE = guardou/tirou dinheiro de uma meta; CANCEL_RECURRING = parou de pagar uma conta fixa; QUERY_RECURRING = listar contas fixas; QUERY_ALERTS = avisos; QUERY_DEBTS = quem deve para quem; SETTLE_DEBT = acertou com alguém da família.
Categorias do usuário:
${cats}
Contas: ${ctx.contas.join(", ") || "nenhuma"}
Cartões de crédito: ${(ctx.cartoes ?? []).join(", ") || "nenhum"}
Metas: ${(ctx.metas ?? []).join(", ") || "nenhuma"}`;
}

/** Garante que o JSON da IA só contém valores válidos e que existem no cadastro do usuário. */
export function sanitize(raw: any, text: string, ctx: UserContext, pend?: PendingCtx): (Interpretation & { acao?: AiAction }) | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Interpretation & { acao?: AiAction } = { intent: INTENTS.includes(raw.intent) ? raw.intent : "OTHER", confidence: 0.5 };
  if (["nova_mensagem", "responder_pendente", "cancelar_pendente", "status_pendente"].includes(raw.acao)) out.acao = raw.acao;
  if (!pend) out.acao = "nova_mensagem";
  const tipos = ["despesa", "receita", "transferencia", "investimento", "resgate"];
  if (tipos.includes(raw.tipo)) out.tipo = raw.tipo;
  const v = Number(raw.valor);
  // só aceita valor que está na mensagem (ou que já estava no lançamento em andamento)
  const ditos = findAmounts(text).filter((c) => c.role === "valor").map((c) => c.value);
  const okValor = (x: number) => ditos.some((d) => Math.abs(d - x) < 0.005) || (pend?.lancamento.valor !== undefined && Math.abs(pend.lancamento.valor - x) < 0.005);
  if (Number.isFinite(v) && v > 0 && v < 1e9 && okValor(v)) out.valor = Math.round(v * 100) / 100;
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
    out.categoria_confianca = 0.9;
  }
  const acc = (s: unknown) => ctx.contas.find((c) => norm(c) === norm(String(s ?? "")));
  out.conta = acc(raw.conta); out.conta_destino = acc(raw.conta_destino);
  const p = Number(raw.parcelas);
  if (Number.isInteger(p) && p >= 2 && p <= 72) out.parcelas = p;
  if (raw.recorrente === true) out.recorrente = true;
  if (["mensal", "semanal", "anual"].includes(raw.frequencia)) out.frequencia = raw.frequencia;
  const dia = Number(raw.dia), du = Number(raw.dia_util);
  if (Number.isInteger(dia) && dia >= 1 && dia <= 31) out.dia = dia;
  if (Number.isInteger(du) && du >= 1 && du <= 22) out.dia_util = du;
  const card = (ctx.cartoes ?? []).find((c) => norm(c) === norm(String(raw.cartao ?? "")));
  if (card) out.cartao = card;
  if (["credito", "debito", "pix", "dinheiro", "boleto"].includes(raw.forma_pagamento)) out.forma_pagamento = raw.forma_pagamento;
  if (typeof raw.meta === "string" && raw.meta.trim()) {
    out.meta = (ctx.metas ?? []).find((m) => norm(m) === norm(raw.meta)) ?? (out.intent === "CREATE_GOAL" ? raw.meta.trim().slice(0, 60) : undefined);
  }
  if (isDate(raw.prazo)) out.prazo = raw.prazo;
  if (out.intent === "GOAL_CONTRIBUTE" && Number.isFinite(v) && v < 0 && out.valor === undefined && okValor(-v)) out.valor = Math.round(v * 100) / 100;
  const consultas = ["total", "maior", "parcelas", "saldo", "disponivel", "resumo", "comparar", "gastando_demais", "posso_comprar", "fatura", "limite", "cartoes"];
  if (consultas.includes(raw.consulta)) out.consulta = raw.consulta;
  if (raw.periodo && isDate(raw.periodo.inicio) && isDate(raw.periodo.fim) && raw.periodo.inicio <= raw.periodo.fim) {
    out.periodo = { inicio: raw.periodo.inicio, fim: raw.periodo.fim, label: String(raw.periodo.label ?? "no período").slice(0, 40) };
  }
  if (["categoria", "valor", "data", "descricao", "conta"].includes(raw.campo_correcao)) out.campo_correcao = raw.campo_correcao;

  // família: de quem é, filtro de consulta e divisão
  const membros = ctx.membros ?? [];
  const pessoa = (x: unknown): string | undefined => {
    const n = norm(String(x ?? ""));
    if (!n) return undefined;
    if (/^(eu|meu|minha|mim|voce)$/.test(n)) return membros.find((m) => m.eu)?.id;
    if (/^(familia|nos|todos|casa|compartilhado)$/.test(n)) return "familia";
    return membros.find((m) => norm(m.nome) === n || norm(m.nome).split(" ")[0] === n.split(" ")[0])?.id;
  };
  if (membros.length > 1) {
    const dq = pessoa(raw.de_quem);
    if (dq === "familia") out.familia = true;
    else if (dq && membros.find((m) => m.id === dq)?.eu) out.familia = false;
    else if (dq) out.membro_id = dq;
    const mb = pessoa(raw.membro);
    if (mb && /^(QUERY_|FINANCIAL_ANALYSIS)/.test(out.intent)) out.membro_id = mb;
    if (raw.dividir === true && out.tipo !== "receita") {
      out.dividir = true; out.familia = undefined; out.membro_id = undefined;
      if (raw.divisao_igual === true) out.divisao_igual = true;
      if (Array.isArray(raw.partes)) {
        const partes = raw.partes.map((x: any) => {
          const m = pessoa(x?.pessoa);
          if (!m || m === "familia") return null;
          const val = Number(x?.valor), pct = Number(x?.percentual);
          if (Number.isFinite(pct) && pct > 0 && pct <= 100) return { membro: m, percentual: pct };
          if (Number.isFinite(val) && val > 0 && okValor(val)) return { membro: m, valor: Math.round(val * 100) / 100 };
          return null;
        }).filter(Boolean);
        if (partes.length) out.partes = partes;
      }
    } else if (raw.dividir === false) {
      out.dividir = false;
    }
  }
  unitsAndPayments(raw, out, text, ctx, pend, okValor);
  const c = Number(raw.confidence);
  out.confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.6;
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const FORMAS = ["credito", "debito", "pix", "dinheiro", "boleto"];

/**
 * Compra por unidade e pagamento em mais de uma forma. As contas são feitas AQUI (a IA só diz
 * quantidades e preços), e cada número precisa ter sido dito na mensagem ou no lançamento em andamento.
 */
function unitsAndPayments(raw: any, out: Interpretation, text: string, ctx: UserContext, pend: PendingCtx | undefined, okValor: (x: number) => boolean) {
  const old = pend?.lancamento;
  const numerosDitos = new Set(findAmounts(text).map((a) => a.value));
  for (const q of [old?.quantidade, ...(old?.pagamentos ?? []).map((p) => p.quantidade)]) if (q) numerosDitos.add(q);
  const okQtd = (q: unknown): q is number => Number.isInteger(q) && (q as number) >= 1 && (q as number) <= 1000 && numerosDitos.has(q as number);

  const qtd = Number(raw.quantidade);
  if (okQtd(qtd)) out.quantidade = qtd;
  else if (old?.quantidade) out.quantidade = old.quantidade;
  const vu = Number(raw.valor_unitario);
  if (Number.isFinite(vu) && vu > 0 && okValor(vu)) out.valor_unitario = r2(vu);
  else if (old?.valor_unitario) out.valor_unitario = old.valor_unitario;

  // formas de pagamento (só valem com 2 ou mais)
  let pags: NonNullable<Interpretation["pagamentos"]> = [];
  if (Array.isArray(raw.pagamentos)) {
    for (const p of raw.pagamentos.slice(0, 5)) {
      const forma = FORMAS.includes(p?.forma_pagamento) ? p.forma_pagamento : undefined;
      const conta = ctx.contas.find((c) => norm(c) === norm(String(p?.conta ?? "")));
      const cartao = (ctx.cartoes ?? []).find((c) => norm(c) === norm(String(p?.cartao ?? "")));
      if (!forma && !conta && !cartao) continue;
      const q = Number(p?.quantidade), v = Number(p?.valor);
      pags.push({
        forma_pagamento: forma ?? (cartao ? "credito" : undefined), conta, cartao,
        quantidade: okQtd(q) ? q : undefined,
        valor: Number.isFinite(v) && v > 0 && okValor(v) ? r2(v) : undefined,
      });
    }
  }
  // respondendo a um lançamento em andamento sem repetir as formas: mantém as que já estavam
  if (pags.length < 2 && (old?.pagamentos?.length ?? 0) >= 2) pags = old!.pagamentos!.map((p) => ({ ...p }));
  if (pags.length < 2) pags = [];

  if (out.valor_unitario !== undefined) {
    // preço por unidade: total = unidades x preço (as unidades de cada forma, se ditas)
    const somaQ = pags.reduce((s, p) => s + (p.quantidade ?? 0), 0);
    const q = out.quantidade ?? (somaQ || undefined);
    if (q) { out.quantidade = q; out.valor = r2(q * out.valor_unitario); }
    for (const p of pags) if (p.quantidade) p.valor = r2(p.quantidade * out.valor_unitario);
  }
  if (pags.length) {
    const sem = pags.filter((p) => p.valor === undefined);
    const soma = pags.reduce((s, p) => s + (p.valor ?? 0), 0);
    if (!sem.length) out.valor = r2(soma);
    else if (out.valor !== undefined && sem.length === 1 && out.valor > soma) sem[0].valor = r2(out.valor - soma);   // "100 no débito e o resto no crédito"
    else if (out.valor !== undefined && sem.length === pags.length && pags.every((p) => p.quantidade)) {
      // total dito + unidades de cada forma: reparte proporcionalmente (centavos que sobram vão para a última)
      const tq = pags.reduce((s, p) => s + p.quantidade!, 0);
      let resto = Math.round(out.valor * 100);
      pags.forEach((p, k) => {
        const cts = k === pags.length - 1 ? resto : Math.round(Math.round(out.valor! * 100) * p.quantidade! / tq);
        p.valor = cts / 100; resto -= cts;
      });
      if (!out.quantidade) out.quantidade = tq;
    }
    out.pagamentos = pags;
    if (out.forma_pagamento && pags.some((p) => p.forma_pagamento && p.forma_pagamento !== out.forma_pagamento)) out.forma_pagamento = undefined;
  }
  // quantidade com preço ainda não dito: o "valor" que a IA tirou da frase é, na verdade, uma das quantidades
  if (out.valor_unitario === undefined && out.quantidade && out.valor !== undefined && !pags.length
      && out.valor <= out.quantidade && Number.isInteger(out.valor) && !findAmounts(text).some((a) => a.role === "valor" && a.strength >= 3)) {
    out.valor = undefined;
  }
  if (pags.length && pags.some((p) => p.valor === undefined) && out.valor !== undefined && pend?.lancamento.valor !== out.valor
      && !findAmounts(text).some((a) => a.role === "valor" && Math.abs(a.value - out.valor!) < 0.005 && a.strength >= 2)) {
    out.valor = undefined;
  }
}

const GROQ_MODEL = "llama-3.3-70b-versatile";

/** Chama a IA (Gemini; se falhar, Groq) e devolve o JSON já conferido. */
export async function interpretWithAI(text: string, ctx: UserContext, cfg: AiConfig, history: Turn[] = [], pend?: PendingCtx)
  : Promise<(Interpretation & { acao?: AiAction }) | null> {
  const system = buildPrompt(ctx, pend);
  const turns = history.slice(-8).filter((t) => t.texto?.trim());
  const errs: string[] = [];
  if (cfg.geminiKey) {
    try {
      const contents = [...turns.map((t) => ({ role: t.papel === "user" ? "user" : "model", parts: [{ text: t.texto }] })), { role: "user", parts: [{ text }] }];
      // junta mensagens seguidas do mesmo papel (o Gemini exige alternância)
      const merged: any[] = [];
      for (const x of contents) { const last = merged[merged.length - 1]; if (last && last.role === x.role) last.parts[0].text += "\n" + x.parts[0].text; else merged.push(x); }
      if (merged[0]?.role === "model") merged.shift();
      const { data, model } = await geminiPreferFull(cfg, {
        systemInstruction: { parts: [{ text: system }] },
        contents: merged,
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }, 12000);
      const raw = textOf(data);
      const parsed = raw ? sanitize(JSON.parse(raw), text, ctx, pend) : null;
      if (parsed) { parsed.provider = "gemini"; parsed.model = model; return parsed; }
    } catch (e) { errs.push((e as Error).message); }
  }
  if (cfg.groqKey) {
    try {
      const f = cfg.fetch ?? fetch;
      const r = await f("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.groqKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: GROQ_MODEL, temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "system", content: system },
            ...turns.map((t) => ({ role: t.papel === "user" ? "user" : "assistant", content: t.texto })),
            { role: "user", content: text }],
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`Groq ${r.status}`);
      const j = await r.json();
      const parsed = sanitize(JSON.parse(j?.choices?.[0]?.message?.content ?? "null"), text, ctx, pend);
      if (parsed) { parsed.provider = "groq"; parsed.model = GROQ_MODEL; return parsed; }
    } catch (e) { errs.push((e as Error).message); }
  }
  if (errs.length) console.warn("IA indisponível:", errs.join(" | "));
  return null;
}

/** Mantida para compatibilidade (testes e chamadas antigas). */
export const interpretWithGemini = (text: string, ctx: UserContext, cfg: AiConfig) => interpretWithAI(text, ctx, { ...cfg, groqKey: undefined });

/** Frases curtas e óbvias ("55,98 farmácia", "gastei 50 no mercado"): as regras resolvem sem esperar a IA. */
function rulesAreEnough(r: Interpretation, text: string): boolean {
  const words = norm(text).split(" ").length;
  if (r.intent === "GREETING" || r.intent === "HELP") return words <= 4;
  if (r.confidence < 0.9 || words > 7) return false;
  if (/^CREATE_(EXPENSE|INCOME)$/.test(r.intent)) {
    return r.valor !== undefined && !!r.categoria && (r.categoria_confianca ?? 0) >= 0.85 && !r.dividir && !r.parcelas && !r.alternativas;
  }
  return false;
}

/** Junta a leitura da IA com a das regras: a IA entende o sentido; os números ditos valem pelo texto. */
export function mergeAI(ai: Interpretation, rules: Interpretation): Interpretation {
  const out: Interpretation = { ...ai };
  // compra por unidade / em várias formas: o valor é calculado a partir do que a IA separou; as regras
  // confundiriam uma quantidade ("2 com dinheiro") com o preço
  const porUnidade = (ai.quantidade ?? 0) > 1 || (ai.pagamentos?.length ?? 0) > 1 || ai.valor_unitario !== undefined;
  if (!porUnidade && rules.valor !== undefined && (ai.valor === undefined || (rules.alternativas?.length ?? 0) > 1)) { out.valor = rules.valor; out.alternativas = rules.alternativas; }
  if (rules.parcelas && !ai.parcelas) out.parcelas = rules.parcelas;
  if (!ai.data && rules.data) { out.data = rules.data; out.data_explicita = rules.data_explicita; }
  if (!ai.periodo && rules.periodo) out.periodo = rules.periodo;
  if (!out.categoria && rules.categoria) { out.categoria = rules.categoria; out.subcategoria = rules.subcategoria; out.categoria_confianca = rules.categoria_confianca; }
  if (!out.estabelecimento && rules.estabelecimento) out.estabelecimento = rules.estabelecimento;
  if (!out.cartao && rules.cartao && out.forma_pagamento !== "pix" && out.forma_pagamento !== "dinheiro") out.cartao = rules.cartao;
  if (!out.conta && rules.conta && !out.cartao) out.conta = rules.conta;
  if (!out.forma_pagamento && rules.forma_pagamento && !out.pagamentos?.length) out.forma_pagamento = rules.forma_pagamento;
  if (rules.frequencia && !out.frequencia) { out.frequencia = rules.frequencia; out.dia = rules.dia; out.dia_util = rules.dia_util; }
  // divisão: a IA decide SE é dividido (entende "dividido em 4 parcelas" e "é só meu"); valores ditos vêm das regras se a IA não pegou
  if (ai.dividir === true && !ai.partes?.length && rules.partes?.length) out.partes = rules.partes;
  if (ai.dividir === true && !ai.divisao_igual && rules.divisao_igual) out.divisao_igual = true;
  if (ai.dividir === undefined && rules.dividir) { out.dividir = true; out.partes = rules.partes; out.divisao_igual = rules.divisao_igual; }
  if (out.dividir === false) { out.dividir = undefined; out.partes = undefined; out.divisao_igual = undefined; }
  if (out.familia === false) out.familia = undefined;
  out.saudacao = rules.saudacao;
  return out;
}

/**
 * Estratégia: a IA lê primeiro (entende frases livres, correções e o contexto da conversa);
 * as regras servem de atalho para frases óbvias e de reserva se a IA estiver fora do ar.
 */
export async function interpret(text: string, ctx: UserContext, cfg: AiConfig = {}, history: Turn[] = []): Promise<Interpretation> {
  const rules = interpretRules(text, ctx);
  if (!cfg.geminiKey && !cfg.groqKey) return rules;
  if (rulesAreEnough(rules, text)) return rules;
  try {
    const ai = await interpretWithAI(text, ctx, cfg, history);
    if (!ai || ai.intent === "OTHER") return rules;
    // numa frase de lançamento bem clara para as regras, a IA hesitante não muda o tipo
    if (rules.intent !== "OTHER" && ai.intent !== rules.intent && rules.confidence >= 0.92 && ai.confidence < 0.6) return rules;
    delete (ai as any).acao;
    return mergeAI(ai, rules);
  } catch (e) {
    console.error("IA falhou, usando regras:", (e as Error).message);
    return rules;
  }
}

// ---------------------------------------------------------------------------
// Categorias para lançamentos de extrato (OFX/CSV) que as regras não reconheceram
// ---------------------------------------------------------------------------
export interface ItemParaCategorizar { linha: number; descricao: string; tipo: "despesa" | "receita" }
export interface CategoriaSugerida { linha: number; categoria: string; subcategoria?: string }

export async function categorizeItems(itens: ItemParaCategorizar[], ctx: UserContext, cfg: AiConfig): Promise<CategoriaSugerida[]> {
  if (!itens.length || (!cfg.geminiKey && !cfg.groqKey)) return [];
  const cats = ctx.categorias.map((c) => `${c.tipo}: ${c.nome}${c.subcategorias.length ? ` (${c.subcategorias.join(", ")})` : ""}`).join("\n");
  const system = `Você classifica lançamentos de extrato bancário brasileiro nas categorias do usuário.
As descrições vêm como o banco escreve (ex.: "COMPRA CARTAO DEB MC 03/11 ZAFFARI", "PIX ENVIADO JOAO SILVA", "PAG BOLETO CEEE").
Para cada item, escolha EXATAMENTE uma categoria da lista do mesmo tipo (despesa ou receita) e, se fizer sentido, uma subcategoria dela.
Se não der para saber (ex.: um Pix para uma pessoa), use a categoria de "outros" do tipo.
Responda SOMENTE com JSON: {"itens":[{"linha":n,"categoria":"...","subcategoria":"..."}]}
Categorias do usuário:
${cats}`;
  const out: CategoriaSugerida[] = [];
  for (let k = 0; k < itens.length; k += 120) {
    const lote = itens.slice(k, k + 120);
    const pergunta = JSON.stringify(lote.map((x) => ({ linha: x.linha, tipo: x.tipo, descricao: x.descricao.slice(0, 120) })));
    let raw: any = null;
    if (cfg.geminiKey) {
      try {
        const { data } = await geminiCall(cfg, {
          systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: pergunta }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }, 25000);
        raw = JSON.parse(textOf(data) || "null");
      } catch (e) { console.warn("categorizar (Gemini):", (e as Error).message); }
    }
    if (!raw && cfg.groqKey) {
      try {
        const f = cfg.fetch ?? fetch;
        const r = await f("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST", headers: { authorization: `Bearer ${cfg.groqKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: GROQ_MODEL, temperature: 0, response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: pergunta }] }),
          signal: AbortSignal.timeout(25000),
        });
        if (r.ok) raw = JSON.parse((await r.json())?.choices?.[0]?.message?.content ?? "null");
      } catch (e) { console.warn("categorizar (Groq):", (e as Error).message); }
    }
    for (const x of Array.isArray(raw?.itens) ? raw.itens : []) {
      const item = lote.find((y) => y.linha === Number(x?.linha));
      if (!item) continue;
      const cat = ctx.categorias.find((c) => c.tipo === item.tipo && norm(c.nome) === norm(String(x?.categoria ?? "")));
      if (!cat) continue;
      const sub = cat.subcategorias.find((s2) => norm(s2) === norm(String(x?.subcategoria ?? "")));
      out.push({ linha: item.linha, categoria: cat.nome, ...(sub ? { subcategoria: sub } : {}) });
    }
  }
  return out;
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
  // contexto: ajuda o reconhecimento de valores ("mil reais", "R$ 1.250,00") e termos de finanças
  form.append("prompt", "Mensagem de controle financeiro em português do Brasil, com valores em reais. Exemplos: gastei mil reais no mercado; paguei R$ 1.250,00 no cartão Nubank; recebi 3 mil de salário; comprei um computador de 2.500 reais dividido em dois cartões.");
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
  }, 40000);
  return { text: textOf(d).trim(), provider: `gemini:${model}` };
}

// ---------------------------------------------------------------------------
// Leitura de fatura / extrato em PDF ou foto (Gemini)
// A IA só LÊ o documento; nada é lançado sem a confirmação da pessoa.
// ---------------------------------------------------------------------------
export interface StatementItem { data: string; descricao: string; valor: number; parcela?: string; categoria?: string; subcategoria?: string; id_externo?: string; }
export interface Statement {
  tipo: "fatura_cartao" | "extrato_conta" | "cupom_fiscal";
  /** cupom/nota fiscal: loja, data da compra, forma de pagamento e categoria sugerida */
  estabelecimento?: string;
  data?: string;
  forma_pagamento?: "credito" | "debito" | "pix" | "dinheiro";
  categoria?: string;
  subcategoria?: string;
  banco?: string;
  cartao?: string;
  final_cartao?: string;
  vencimento?: string;
  fechamento?: string;
  total?: number;
  itens: StatementItem[];
  model?: string;
}

export class StatementError extends Error { constructor(public code: "senha" | "ilegivel" | "sem_ia" | "grande", msg: string) { super(msg); } }

/** PDF com senha (criptografado) — a IA não consegue ler. */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 400000)));
  return /\/Encrypt\s/.test(tail) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(head);
}

function statementPrompt(ctx: UserContext): string {
  const cats = ctx.categorias.filter((c) => c.tipo === "despesa").map((c) => `${c.nome}${c.subcategorias.length ? ` (${c.subcategorias.join(", ")})` : ""}`).join("; ");
  return `Você lê faturas de cartão de crédito, extratos bancários e cupons/notas fiscais de compra brasileiros. Hoje é ${ctx.hoje}.
Responda SOMENTE com JSON neste formato:
{"tipo":"fatura_cartao"|"extrato_conta"|"cupom_fiscal",
 "estabelecimento":"nome da loja (cupom)","data":"AAAA-MM-DD da compra (cupom)","forma_pagamento":"credito"|"debito"|"pix"|"dinheiro"|null (cupom),
 "categoria":"categoria da compra (cupom)","subcategoria":"subcategoria se souber (cupom)","banco":"nome do banco/emissor","cartao":"nome do cartão se aparecer","final_cartao":"4 últimos dígitos se aparecerem",
 "vencimento":"AAAA-MM-DD (fatura)","fechamento":"AAAA-MM-DD se aparecer","total":número (total da fatura ou null),
 "itens":[{"data":"AAAA-MM-DD","descricao":"texto do lançamento como está","valor":número,"parcela":"3/10 se for parcela","categoria":"uma das categorias abaixo"}]}
Regras:
- Liste TODOS os lançamentos da fatura/extrato, de todas as páginas e de todos os cartões adicionais. Não invente nada que não esteja no documento.
- Em FATURA: compras, parcelas, tarifas, juros e IOF com valor POSITIVO; pagamentos, estornos e créditos com valor NEGATIVO. Não inclua linhas de resumo, subtotais, "total da fatura anterior", limites ou parcelamentos futuros.
- Em EXTRATO de conta: saídas NEGATIVAS e entradas POSITIVAS. Ignore linhas de saldo.
- Datas sem ano: use o ano coerente com o vencimento/período do documento.
- CUPOM ou NOTA FISCAL de uma compra (NFC-e, cupom de supermercado, nota de loja, recibo): tipo "cupom_fiscal"; "total" = valor TOTAL PAGO (depois de descontos); "itens" = produtos com descricao e valor (data = data da compra); use o nome fantasia da loja em "estabelecimento"; forma_pagamento conforme o cupom (cartão de crédito -> "credito", débito -> "debito").
- valor em reais como número (1.234,56 -> 1234.56).
- categoria: escolha a mais provável entre: ${cats}. Se não souber, use "Outros gastos" (despesa) ou "Outras receitas" (receita).`;
}

export async function extractStatement(bytes: Uint8Array, mime: string, ctx: UserContext, cfg: AiConfig): Promise<Statement> {
  if (!cfg.geminiKey) throw new StatementError("sem_ia", "Leitura de PDF não configurada no servidor.");
  if (bytes.length > 15_000_000) throw new StatementError("grande", "Arquivo muito grande (máximo 15 MB).");
  const m = mime.split(";")[0].toLowerCase();
  if (m === "application/pdf" && isEncryptedPdf(bytes)) throw new StatementError("senha", "PDF protegido por senha.");
  const body = {
    systemInstruction: { parts: [{ text: statementPrompt(ctx) }] },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: m, data: toBase64(bytes) } }, { text: "Extraia os lançamentos deste documento." }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };
  const all = [...new Set([cfg.geminiModel, ...GEMINI_MODELS].filter(Boolean) as string[])];
  let r: { data: any; model: string };
  try { r = await geminiCall(cfg, body, 70000, all.filter((x) => !/lite/.test(x))); }
  catch { r = await geminiCall(cfg, body, 45000, all.filter((x) => /lite/.test(x))); }
  let raw: any;
  try { raw = JSON.parse(textOf(r.data)); } catch { throw new StatementError("ilegivel", "Não consegui ler o documento."); }
  const st = sanitizeStatement(raw, ctx);
  st.model = r.model;
  if (!st.itens.length && !(st.tipo === "cupom_fiscal" && (st.total ?? 0) > 0)) throw new StatementError("ilegivel", "Não encontrei lançamentos no documento.");
  return st;
}

/** Valida o JSON da IA: datas, valores e categorias que existem no cadastro. */
export function sanitizeStatement(raw: any, ctx: UserContext): Statement {
  const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
  const cats = new Map(ctx.categorias.filter((c) => c.tipo === "despesa").map((c) => [norm(c.nome), c.nome]));
  const st: Statement = {
    tipo: raw?.tipo === "extrato_conta" ? "extrato_conta" : raw?.tipo === "cupom_fiscal" ? "cupom_fiscal" : "fatura_cartao",
    estabelecimento: typeof raw?.estabelecimento === "string" ? raw.estabelecimento.replace(/\s+/g, " ").trim().slice(0, 60) || undefined : undefined,
    data: isDate(raw?.data) ? raw.data : undefined,
    forma_pagamento: ["credito", "debito", "pix", "dinheiro"].includes(raw?.forma_pagamento) ? raw.forma_pagamento : undefined,
    categoria: cats.get(norm(String(raw?.categoria ?? ""))),
    subcategoria: typeof raw?.subcategoria === "string" ? raw.subcategoria.slice(0, 40) : undefined,
    banco: typeof raw?.banco === "string" ? raw.banco.slice(0, 40) : undefined,
    cartao: typeof raw?.cartao === "string" ? raw.cartao.slice(0, 40) : undefined,
    final_cartao: typeof raw?.final_cartao === "string" ? raw.final_cartao.replace(/\D/g, "").slice(-4) || undefined : undefined,
    vencimento: isDate(raw?.vencimento) ? raw.vencimento : undefined,
    fechamento: isDate(raw?.fechamento) ? raw.fechamento : undefined,
    total: Number.isFinite(Number(raw?.total)) && raw?.total !== null ? Math.round(Number(raw.total) * 100) / 100 : undefined,
    itens: [],
  };
  for (const it of Array.isArray(raw?.itens) ? raw.itens.slice(0, 1500) : []) {
    const v = Number(it?.valor);
    if (!isDate(it?.data) && !(st.tipo === "cupom_fiscal" && st.data)) continue;
    if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 1e8) continue;
    if (!isDate(it?.data)) it.data = st.data;
    const parcela = typeof it?.parcela === "string" && /^\d{1,2}\/\d{1,2}$/.test(it.parcela.trim()) ? it.parcela.trim() : undefined;
    st.itens.push({
      data: it.data, valor: Math.round(v * 100) / 100, parcela,
      descricao: String(it?.descricao ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || "Lançamento",
      categoria: cats.get(norm(String(it?.categoria ?? ""))),
    });
  }
  return st;
}
