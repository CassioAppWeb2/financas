// O ASSISTENTE FINANCEIRO — único ponto de entrada para TODOS os canais.
// CONVERSAR → INTERPRETAR → VALIDAR → CLASSIFICAR → LANÇAR → ATUALIZAR → ANALISAR → RESPONDER
//
// Este arquivo não sabe se a mensagem veio do app ou do WhatsApp.
// Ele não grava nada diretamente: toda operação passa pelo Motor Financeiro (fe_*).

import type { AssistantReply, Card, EngineDb, IncomingMessage, Interpretation, UserContext } from "./types.ts";
import { interpret, type AiConfig } from "./ai.ts";
import { interpretRules, matchUserCategory } from "./interpreter_rules.ts";
import { guessCategory } from "./categorizer.ts";
import { extractAmount, findAmounts } from "./money.ts";
import { resolveDate, addDays } from "./dates.ts";
import { brl, dateBR, norm, pct } from "./text.ts";

export interface AssistantDeps { db: EngineDb; ai?: AiConfig; }

export interface QueueItem { texto: string; data?: string; }

type Pending = (
  | { kind: "ask_value"; interp: Interpretation }
  | { kind: "choose_value"; interp: Interpretation; options: number[] }
  | { kind: "ask_category"; interp: Interpretation }
  | { kind: "confirm_category"; interp: Interpretation }
  | { kind: "ask_account"; interp: Interpretation; campo: "conta" | "conta_destino" }
  | { kind: "confirm_duplicate"; interp: Interpretation }
  | { kind: "confirm_create"; interp: Interpretation }
  | { kind: "confirm_delete"; id: string; label: string }
  | { kind: "ask_correction"; id: string; label: string; tipo: string }
) & { fila?: QueueItem[] };

interface Outcome extends AssistantReply { pending?: Pending | null; }

interface Ctx {
  msg: IncomingMessage;
  user: string;
  uc: UserContext;
  deps: AssistantDeps;
  interpretationId?: string;
}

const SUB_ICON: Record<string, string> = {
  Supermercado: "🛒", Padaria: "🥖", Restaurante: "🍽️", Delivery: "🛵", Lanches: "🥪", Combustível: "⛽", Uber: "🚕",
  "Transporte público": "🚌", Energia: "💡", Água: "🚿", Internet: "🌐", Aluguel: "🏠", Medicamentos: "💊",
  Streaming: "📺", Roupas: "👕", Calçados: "👟", Viagens: "✈️", Cinema: "🎬", Cursos: "🎓",
};

const YES = /^(sim|s|isso|pode|pode sim|confirmo|confirma|confirmado|ok|okay|claro|isso mesmo|correto|certo|registra|registrar|manda|bora|exato|positivo|uhum|aham|yes)\b/;
const NO = /^(nao|n|cancela|cancelar|cancele|deixa|deixa pra la|esquece|nada|negativo|para|pare)\b/;

// ---------------------------------------------------------------------------
export async function handleMessage(msg: IncomingMessage, deps: AssistantDeps): Promise<AssistantReply> {
  const { db } = deps;
  const user = msg.user_id;
  const content = msg.content.trim().slice(0, 2000);
  const saved = await db.rpc<{ id: string }>("fe_chat_append", user, {
    role: "user", channel: msg.channel, content: content || "(áudio vazio)", message_type: msg.type, audio_provider: msg.audio_provider,
  });
  const uc = await db.rpc<UserContext>("fe_context", user, {});
  const state = await db.rpc<{ pending: Pending | null }>("fe_chat_state", user, {});
  const c: Ctx = { msg: { ...msg, content }, user, uc, deps };

  let out: Outcome | null = null;
  try {
    if (!content) out = { reply: "Não consegui entender o áudio. Pode repetir ou digitar?" };
    if (!out && state.pending) {
      out = await resolvePending(state.pending, c);
      const fila = state.pending.fila ?? [];
      if (out && out.pending === null && fila.length) {
        const more = await processQueue(fila, c, saved.id);
        out = { reply: `${out.reply}\n\n${more.reply}`, cards: [...(out.cards ?? []), ...(more.cards ?? [])], pending: more.pending ?? null };
      }
    }
    if (!out) {
      const itens = splitItems(content, uc);
      if (itens) out = await processQueue(itens, c, saved.id);
    }
    if (!out) {
      const interp = await interpret(content, uc, deps.ai);
      const log = await db.rpc<{ id: string }>("fe_log_interpretation", user, {
        chat_message_id: saved.id, provider: interp.provider ?? "regras", model: interp.model,
        input: content, output: interp, confidence: interp.confidence,
      });
      c.interpretationId = log.id;
      out = await dispatch(interp, c);
    }
  } catch (e) {
    console.error("assistente:", (e as Error).message);
    out = { reply: `⚠️ Não consegui concluir: ${(e as Error).message}`, pending: null };
  }

  if (msg.type === "audio" && content) out.reply = `🎙️ Entendi seu áudio: “${content}”\n\n${out.reply}`;
  if (out.pending !== undefined) await db.rpc("fe_chat_state", user, { pending: out.pending });
  await db.rpc("fe_chat_append", user, { role: "assistant", channel: msg.channel, content: out.reply, cards: out.cards ?? null });
  return { reply: out.reply, cards: out.cards, intent: out.intent };
}

// ---------------------------------------------------------------------------
// Roteamento por intenção
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Vários lançamentos numa só mensagem: "gastei 20 no mercado e 50 de combustível"
// ---------------------------------------------------------------------------
const CREATE_INTENTS = new Set(["CREATE_EXPENSE", "CREATE_INCOME", "CREATE_RECURRING", "CREATE_INVESTMENT", "CREATE_REDEMPTION", "CREATE_TRANSFER"]);
const SEP = /(\s*(?:;|,(?=\s))\s*(?:e\s+)?|\s+e\s+(?:tamb[eé]m\s+|mais\s+)?|\s+mais\s+|\s+depois\s+)/i;

function itemOk(text: string, uc: UserContext): boolean {
  const r = interpretRules(text, uc);
  return CREATE_INTENTS.has(r.intent) && r.valor !== undefined && !r.alternativas && !!(r.categoria || r.estabelecimento || r.descricao || r.conta_destino);
}

/** Divide a mensagem em vários lançamentos, ou devolve null se for um só. */
export function splitItems(text: string, uc: UserContext): QueueItem[] | null {
  const n = norm(text);
  if (/\?\s*$/.test(text) || /^(quanto|qual|quais|posso|como|compare|compara)\b/.test(n) || /\bou\b/.test(n)) return null;
  if (findAmounts(text).filter((a) => a.role === "valor" && a.value > 0).length < 2) return null;
  const parts = text.split(SEP);
  const pieces: string[] = [];
  let cur = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const next = parts[i + 1] ?? "";
    // só separa quando os dois lados já formam lançamentos completos
    const prefixo = verbPrefix(cur);
    if (itemOk(cur, uc) && (itemOk(next, uc) || (prefixo && itemOk(prefixo + next, uc)))) { pieces.push(cur); cur = next; }
    else cur = cur + parts[i] + next;
  }
  pieces.push(cur);
  if (pieces.length < 2) return null;
  const quando = resolveDate(text, uc.hoje);
  const prefixo = verbPrefix(pieces[0]);
  return pieces.map((p) => {
    const semVerbo = prefixo && !verbPrefix(p) && interpretRules(p, uc).confidence < 0.85;
    const texto = (semVerbo ? prefixo + p : p).trim().replace(/[.!]+$/, "");
    const d = resolveDate(texto, uc.hoje);
    return { texto, data: !d.explicita && quando.explicita ? quando.data : undefined };
  });
}

/** "Gastei R$ 20 no mercado" -> "Gastei " (verbo inicial para repetir nos próximos itens) */
function verbPrefix(text: string): string {
  const m = text.match(/^\s*((?:eu\s+|n[oó]s\s+|a gente\s+)?[a-zà-ú]+(?:\s+(?:com|de|em))?\s+)(?=r\$|\d|[a-zà-ú]+\s)/i);
  if (!m) return "";
  return /^(eu\s+|n[oó]s\s+|a gente\s+)?(gastei|gastamos|paguei|pagamos|comprei|compramos|recebi|recebemos|ganhei|ganhamos|investi|apliquei|abasteci|pedi|pedimos)\b/i.test(m[1].trim()) ? m[1] : "";
}

async function processQueue(itens: QueueItem[], c: Ctx, chatMessageId: string): Promise<Outcome> {
  const replies: string[] = [];
  const cards: Card[] = [];
  for (let k = 0; k < itens.length; k++) {
    const it = itens[k];
    const interp = await interpret(it.texto, c.uc, c.deps.ai);
    if (it.data && !interp.data_explicita && CREATE_INTENTS.has(interp.intent)) { interp.data = it.data; interp.data_explicita = true; }
    const log = await c.deps.db.rpc<{ id: string }>("fe_log_interpretation", c.user, {
      chat_message_id: chatMessageId, provider: interp.provider ?? "regras", model: interp.model,
      input: it.texto, output: interp, confidence: interp.confidence,
    });
    c.interpretationId = log.id;
    const o = await dispatch(interp, { ...c, msg: { ...c.msg, content: it.texto } });
    replies.push(itens.length > 1 ? `${k + 1}) ${o.reply}` : o.reply);
    cards.push(...(o.cards ?? []));
    if (o.pending) {
      const resto = itens.slice(k + 1);
      if (resto.length) replies.push(`(Depois disso registro ${resto.length === 1 ? "o próximo item" : `os outros ${resto.length} itens`}.)`);
      return { reply: replies.join("\n"), cards, pending: { ...o.pending, fila: resto } };
    }
  }
  return { reply: replies.join("\n"), cards, pending: null };
}

async function dispatch(i: Interpretation, c: Ctx): Promise<Outcome> {
  const greet = i.saudacao ? `${i.saudacao}! ${/dia/.test(i.saudacao) ? "☀️ " : ""}` : "";
  let out: Outcome;
  switch (i.intent) {
    case "CREATE_EXPENSE": case "CREATE_INCOME": case "CREATE_TRANSFER": case "CREATE_INVESTMENT": case "CREATE_REDEMPTION":
      out = await createFlow(i, c); break;
    case "CREATE_RECURRING": out = recurringFlow(i); break;
    case "QUERY_EXPENSES": case "QUERY_INCOME": case "QUERY_CATEGORY":
      out = i.consulta === "maior" ? await largest(i, c) : i.consulta === "parcelas" ? await installments(i, c) : await totals(i, c); break;
    case "QUERY_BALANCE": case "QUERY_ACCOUNT": out = await balances(i, c); break;
    case "QUERY_REPORT": out = await compare(c); break;
    case "FINANCIAL_ANALYSIS":
      out = i.consulta === "disponivel" ? await available(c, /\bhoje\b/.test(norm(c.msg.content)))
        : i.consulta === "posso_comprar" ? await canBuy(i, c)
        : i.consulta === "gastando_demais" ? await spendingTooMuch(c)
        : await overview(c);
      break;
    case "DELETE_TRANSACTION": out = await deleteFlow(i, c); break;
    case "EDIT_TRANSACTION": case "CORRECT_CATEGORY": out = await correctFlow(i, c); break;
    case "QUERY_CARD": out = soon("Cartões de crédito e faturas"); break;
    case "QUERY_BUDGET": case "CREATE_BUDGET": out = soon("Orçamentos por categoria"); break;
    case "QUERY_GOAL": case "CREATE_GOAL": out = soon("Metas financeiras"); break;
    case "GREETING":
      out = /obrigad|valeu|vlw|brigad/.test(norm(c.msg.content))
        ? { reply: "De nada! 😊 Estou por aqui quando precisar." }
        : { reply: `Olá${c.uc.nome ? `, ${c.uc.nome}` : ""}! 👋 Me conte um gasto ou recebimento, ou pergunte sobre suas finanças.` };
      break;
    case "HELP": out = { reply: HELP }; break;
    default:
      out = { reply: "Hmm, não entendi. 🤔 Você pode dizer, por exemplo:\n• “gastei 50 na padaria”\n• “recebi 1.000 de salário”\n• “quanto gastei este mês?”\n\nDigite *ajuda* para ver tudo o que eu faço." };
  }
  out.intent = i.intent;
  if (greet) out.reply = greet + out.reply;
  return out;
}

const HELP = `Sou seu assistente financeiro. Basta conversar comigo:

💸 *Registrar*: “gastei 87,50 no mercado”, “paguei 200 de gasolina ontem”, “comprei uma TV de 2.400 em 10 vezes”
🧾 *Vários de uma vez*: “gastei 20 no mercado e 50 de combustível”
💰 *Receitas*: “recebi 1.000 de salário”, “entrou 3 mil de vendas”
🔁 *Transferir*: “transferi 500 do Nubank para a Poupança”
📊 *Consultar*: “quanto gastei este mês?”, “quanto gastei com alimentação?”, “qual minha maior despesa?”, “quanto tenho na conta?”
🧠 *Analisar*: “quanto posso gastar até o fim do mês?”, “como estão minhas finanças?”, “compare com o mês passado”, “posso comprar um celular de 1.800?”
✏️ *Corrigir*: “muda a categoria para lazer”, “apague o último lançamento”
👨‍👩‍👧 *Família*: “gastamos 300 no mercado” (compartilhado), “quanto eu gastei?”, “quanto minha esposa gastou?”

Também entendo áudio — no app (🎙️), no WhatsApp e no Telegram.`;

function soon(what: string): Outcome {
  return { reply: `🚧 ${what} chegam na próxima fase do app. Por enquanto posso registrar receitas e despesas, consultar gastos e saldos e analisar seu mês.` };
}

// ---------------------------------------------------------------------------
// LANÇAMENTOS
// ---------------------------------------------------------------------------
function enginePayload(i: Interpretation, c: Ctx, extra: Record<string, unknown> = {}) {
  return {
    tipo: i.tipo, valor: i.valor, data: i.data, descricao: i.descricao, estabelecimento: i.estabelecimento,
    categoria: i.categoria, subcategoria: i.subcategoria, conta: i.conta, conta_destino: i.conta_destino,
    parcelas: i.parcelas, forma_pagamento: i.forma_pagamento, familia: i.familia,
    origem: origin(c),
    mensagem_original: c.msg.content,
    transcricao: c.msg.type === "audio" ? c.msg.content : undefined,
    interpretation_id: c.interpretationId,
    ...extra,
  };
}

const TIPO_LABEL: Record<string, string> = {
  despesa: "uma despesa", receita: "uma receita", transferencia: "uma transferência", investimento: "um investimento", resgate: "um resgate",
};

function categoryList(c: Ctx, tipo: string): string {
  return c.uc.categorias.filter((x) => x.tipo === (tipo === "receita" ? "receita" : "despesa")).map((x) => `${x.icone ?? ""} ${x.nome}`.trim()).join(" · ");
}

async function createFlow(i: Interpretation, c: Ctx, extra: Record<string, unknown> = {}): Promise<Outcome> {
  const tipo = i.tipo ?? "despesa";
  if (i.valor === undefined) {
    const what = i.descricao ? ` (${i.descricao})` : "";
    return { reply: `Entendi ${TIPO_LABEL[tipo]}${what}. Qual foi o valor?`, pending: { kind: "ask_value", interp: i } };
  }
  if (i.alternativas && i.alternativas.length > 1) {
    return {
      reply: `Você quis dizer ${i.alternativas.map((v) => brl(Math.round(v * 100))).join(" ou ")}?`,
      pending: { kind: "choose_value", interp: i, options: i.alternativas },
    };
  }
  if ((tipo === "despesa" || tipo === "receita") && i.categoria && (i.categoria_confianca ?? 1) < 0.7 && !extra.confirmado) {
    return {
      reply: `Entendi ${TIPO_LABEL[tipo]} de ${brl(Math.round(i.valor * 100))}. Registro em **${i.categoria}**? Responda *sim* ou diga a categoria certa.`,
      pending: { kind: "confirm_category", interp: i },
    };
  }

  const r = await c.deps.db.rpc<any>("fe_create_transaction", c.user, enginePayload(i, c, extra));
  switch (r.status) {
    case "created": return createdReply(r, i, c);
    case "needs_category":
      return {
        reply: `Entendi ${TIPO_LABEL[tipo]} de ${brl(r.valor_cents)}${i.descricao ? ` (${i.descricao})` : ""}. Em qual categoria devo registrar?\n${categoryList(c, tipo)}`,
        pending: { kind: "ask_category", interp: { ...i, categoria: undefined, subcategoria: undefined } },
      };
    case "possible_duplicate": {
      const e = r.existente;
      return {
        reply: `⚠️ Você já registrou ${brl(e.valor_cents)} em ${e.descricao} há poucos minutos. É um novo lançamento? Responda *sim* para registrar de novo ou *não* para cancelar.`,
        pending: { kind: "confirm_duplicate", interp: i },
      };
    }
    case "unknown_account":
      return {
        reply: `Não encontrei a conta “${r.conta}”. Suas contas: ${c.uc.contas.join(", ")}. Em qual devo registrar?`,
        pending: { kind: "ask_account", interp: i, campo: "conta" },
      };
    case "needs_destination_account":
      return {
        reply: `Para qual conta foi a transferência? Suas contas: ${c.uc.contas.join(", ")}.`,
        pending: { kind: "ask_account", interp: i, campo: "conta_destino" },
      };
    default:
      return { reply: "Não consegui registrar. Pode reformular?", pending: null };
  }
}

async function createdReply(r: any, i: Interpretation, c: Ctx): Promise<Outcome> {
  const t = r.lancamento;
  const today = c.uc.hoje;
  const when = t.data === today ? "" : t.data === addDays(today, -1) ? " ontem" : t.data === addDays(today, -2) ? " anteontem" : ` em ${dateBR(t.data)}`;
  const cat = t.categoria ? `**${t.categoria}${t.subcategoria ? ` > ${t.subcategoria}` : ""}**` : "";
  const icon = SUB_ICON[t.subcategoria] ?? t.icone ?? "✅";
  const parc = r.parcelas > 1 ? ` em ${r.parcelas}x de ${brl(r.valor_parcela_cents)} (1ª parcela em ${dateBR(t.data)})` : "";
  const conta = i.conta ? ` na conta ${t.conta}` : "";
  let reply: string;
  switch (t.tipo) {
    case "receita": reply = `💰 Registrei${when} sua receita de **${brl(r.valor_total_cents)}** em ${cat}${conta}. ✅`; break;
    case "transferencia": reply = `🔁 Transferência de **${brl(r.valor_total_cents)}** de ${t.conta} para ${t.conta_destino} registrada${when}. ✅`; break;
    case "investimento": reply = `📈 Registrei${when} um investimento de **${brl(r.valor_total_cents)}** saindo de ${t.conta}. ✅`; break;
    case "resgate": reply = `📥 Registrei${when} um resgate de **${brl(r.valor_total_cents)}** para ${t.conta}. ✅`; break;
    default: reply = `${icon} Registrei${when} **${brl(r.valor_total_cents)}** em ${cat}${parc}${conta}. ✅`;
  }
  if (isFamily(c) && t.membro_id === null && ["despesa", "receita"].includes(t.tipo)) reply += `\n👨‍👩‍👧 Lançado como gasto da **Família** (compartilhado).`;
  if (r.categoria_origem === "aprendida") reply += `\n(Reconheci “${t.estabelecimento}” pelo seu histórico.)`;
  if ((i.categoria_confianca ?? 1) < 0.8 && t.categoria === "Outros") reply += `\nSe preferir outra categoria, é só dizer: “muda a categoria para …”.`;
  if (t.tipo === "receita") {
    const a = await c.deps.db.rpc<any>("fe_available", c.user, {});
    reply += `\n\nConsiderando os lançamentos cadastrados, a previsão de saldo livre até o fim do mês é de **${brl(a.disponivel_cents)}** (estimativa).`;
  }
  return { reply, cards: [{ type: "transaction", data: { ...t, valor_total_cents: r.valor_total_cents, parcelas: r.parcelas } }], pending: null };
}

function recurringFlow(i: Interpretation): Outcome {
  if (i.valor === undefined) return { reply: "Qual é o valor desse lançamento recorrente?", pending: { kind: "ask_value", interp: { ...i, intent: "CREATE_RECURRING" } } };
  const tipo = i.tipo === "receita" ? "receita" : "despesa";
  const cat = i.categoria ? ` em ${i.categoria}${i.subcategoria ? ` > ${i.subcategoria}` : ""}` : "";
  return {
    reply: `🔁 Entendi ${TIPO_LABEL[tipo]} recorrente de ${brl(Math.round(i.valor * 100))}${cat}.\nO cadastro automático de recorrências chega na próxima fase do app. Quer que eu registre o lançamento deste mês agora${i.data ? ` (${dateBR(i.data)})` : ""}? Responda *sim* ou *não*.`,
    pending: { kind: "confirm_create", interp: { ...i, intent: tipo === "receita" ? "CREATE_INCOME" : "CREATE_EXPENSE", recorrente: false } },
  };
}

// ---------------------------------------------------------------------------
// RESPOSTAS A PERGUNTAS PENDENTES
// ---------------------------------------------------------------------------
function looksLikeNewCommand(text: string, uc: UserContext): boolean {
  const r = interpretRules(text, uc);
  return r.intent !== "OTHER" && r.intent !== "GREETING" && r.confidence >= 0.85;
}

async function resolvePending(p: Pending, c: Ctx): Promise<Outcome | null> {
  const text = c.msg.content;
  const n = norm(text);
  if (NO.test(n) && p.kind !== "ask_correction") return { reply: "Ok, cancelado. 👍", pending: null };
  const yes = YES.test(n);

  switch (p.kind) {
    case "confirm_create": if (yes) return createFlow(p.interp, c); break;
    case "confirm_duplicate": if (yes) return createFlow(p.interp, c, { forcar: true }); break;
    case "confirm_category": {
      if (yes) return createFlow(p.interp, c, { confirmado: true });
      const cat = pickCategory(text, c, p.interp.tipo);
      if (cat) return createFlow({ ...p.interp, ...cat, categoria_confianca: 1 }, c);
      break;
    }
    case "ask_category": {
      const cat = pickCategory(text, c, p.interp.tipo);
      if (cat) return createFlow({ ...p.interp, ...cat, categoria_confianca: 1 }, c);
      if (!looksLikeNewCommand(text, c.uc)) {
        return { reply: `Não encontrei essa categoria. Escolha uma destas (ou crie uma nova em Categorias):\n${categoryList(c, p.interp.tipo ?? "despesa")}` };
      }
      break;
    }
    case "ask_value": {
      const a = extractAmount(text);
      if (a.valor && !looksLikeNewCommand(text, c.uc)) {
        const interp = { ...p.interp, valor: a.valor, alternativas: a.alternativas };
        return interp.intent === "CREATE_RECURRING" ? recurringFlow(interp) : createFlow(interp, c);
      }
      if (!looksLikeNewCommand(text, c.uc)) return { reply: "Não identifiquei o valor. Pode me dizer só o número? Ex.: 120,50" };
      break;
    }
    case "choose_value": {
      let v: number | undefined;
      if (/\b(primeir|1o|o 1)\w*/.test(n)) v = p.options[0];
      else if (/\b(segund|2o|o 2)\w*/.test(n)) v = p.options[1];
      else {
        const a = extractAmount(text);
        if (a.valor) v = p.options.find((o) => o === a.valor || (a.alternativas ?? []).includes(o)) ?? a.valor;
      }
      if (v !== undefined) return createFlow({ ...p.interp, valor: v, alternativas: undefined }, c);
      break;
    }
    case "ask_account": {
      const acc = c.uc.contas.find((a) => n.includes(norm(a)));
      if (acc) return createFlow({ ...p.interp, [p.campo]: acc }, c);
      if (!looksLikeNewCommand(text, c.uc)) return { reply: `Não encontrei essa conta. Suas contas: ${c.uc.contas.join(", ")}.` };
      break;
    }
    case "confirm_delete": {
      if (yes) {
        const r = await c.deps.db.rpc<any>("fe_delete_transaction", c.user, { id: p.id, origem: origin(c) });
        if (r.status !== "deleted") return { reply: "Esse lançamento não existe mais.", pending: null };
        return { reply: `🗑️ Apaguei ${p.label}${r.quantidade > 1 ? ` (${r.quantidade} parcelas)` : ""}.`, pending: null };
      }
      break;
    }
    case "ask_correction": {
      if (NO.test(n)) return { reply: "Ok, nada foi alterado. 👍", pending: null };
      const fix = parseCorrection(text, c, p.tipo);
      if (fix) return applyCorrection({ id: p.id, ...fix }, c);
      if (!looksLikeNewCommand(text, c.uc)) {
        return { reply: "Não entendi a correção. Diga, por exemplo: “a categoria é Lazer”, “o valor é 45” ou “foi ontem”." };
      }
      break;
    }
  }
  if (yes || NO.test(n)) return { reply: "Ok! 👍", pending: null };
  return null; // não era resposta: segue como mensagem nova (e a pergunta antiga é descartada)
}

function pickCategory(text: string, c: Ctx, tipo?: string): { categoria: string; subcategoria?: string } | null {
  const kind = tipo === "receita" ? "receita" : "despesa";
  const n = norm(text);
  const exact = c.uc.categorias.find((x) => x.tipo === kind && norm(x.nome) === n.replace(/^(em |na |no |e |é |eh )/, ""));
  if (exact) return { categoria: exact.nome };
  const uc = matchUserCategory(text, c.uc, kind);
  if (uc) return uc;
  const g = guessCategory(text, kind);
  return g ? { categoria: g.categoria, subcategoria: g.subcategoria } : null;
}

const origin = (c: Ctx) => (c.msg.channel === "app" ? "app_chat" : c.msg.channel);
const isFamily = (c: Ctx) => (c.uc.membros?.length ?? 0) > 1;
const memberName = (c: Ctx, id?: string) => id === "familia" ? "Família" : c.uc.membros?.find((m) => m.id === id)?.nome;
function bySplit(rows: any[] | undefined, c: Ctx): string {
  if (!isFamily(c) || !rows?.length) return "";
  return "\n👨‍👩‍👧 Por pessoa: " + rows.map((x: any) => `${x.membro_id === c.uc.eu ? "Você" : x.membro}${x.membro_id ? "" : " (compartilhado)"} ${brl(x.total_cents)}`).join(" · ");
}

// ---------------------------------------------------------------------------
// CORRIGIR / APAGAR
// ---------------------------------------------------------------------------
function txLabel(t: any): string {
  const total = t.installment_total ? ` em ${t.installment_total}x` : "";
  const desc = String(t.description ?? "").replace(/ \(\d+\/\d+\)$/, "");
  return `**${desc}** — ${brl(t.amount_cents)}${total} (${dateBR(t.date)})`;
}

async function deleteFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  const t = await c.deps.db.rpc<any>("fe_target", c.user, { id: "ultimo", tipo: i.tipo });
  if (!t?.id) return { reply: "Não encontrei lançamentos para apagar." };
  const quem = isFamily(c) ? ` · ${t.member_id === null ? "Família" : t.member_id === c.uc.eu ? "seu" : memberName(c, t.member_id) ?? ""}` : "";
  const label = txLabel(t) + quem;
  return { reply: `Vou apagar o último lançamento que você registrou: ${label}. Confirma? (*sim* / *não*)`, pending: { kind: "confirm_delete", id: t.id, label } };
}

function parseCorrection(text: string, c: Ctx, tipo?: string): Record<string, unknown> | null {
  const n = norm(text);
  const kind = tipo === "receita" ? "receita" : "despesa";
  const cat = matchUserCategory(text, c.uc, kind) ?? (() => { const g = guessCategory(text, kind); return g ? { categoria: g.categoria, subcategoria: g.subcategoria } : null; })();
  const a = extractAmount(text);
  const d = resolveDate(text, c.uc.hoje);
  if (cat && (/categoria/.test(n) || !a.valor)) return { categoria: cat.categoria, subcategoria: cat.subcategoria };
  if (a.valor) return { valor: a.valor };
  if (d.explicita) return { data: d.data };
  const desc = text.match(/descri[cç][aã]o (?:é|e|para|pra)?\s*(.+)$/i);
  if (desc) return { descricao: desc[1].trim() };
  return null;
}

async function applyCorrection(p: Record<string, unknown>, c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_update_transaction", c.user, { ...p, origem: origin(c) });
  if (r.status === "not_found") return { reply: "Não encontrei o lançamento para corrigir.", pending: null };
  if (r.status === "unknown_category") return { reply: `Não encontrei a categoria “${r.categoria}”.`, pending: null };
  if (r.status === "unknown_account") return { reply: `Não encontrei a conta “${r.conta}”.`, pending: null };
  const a = r.antes, t = r.lancamento;
  const changes: string[] = [];
  if (a.categoria !== t.categoria || a.subcategoria !== t.subcategoria)
    changes.push(`categoria: ${a.categoria ?? "—"}${a.subcategoria ? ` > ${a.subcategoria}` : ""} → **${t.categoria}${t.subcategoria ? ` > ${t.subcategoria}` : ""}**`);
  if (a.valor_cents !== t.valor_cents) changes.push(`valor: ${brl(a.valor_cents)} → **${brl(t.valor_cents)}**`);
  if (a.data !== t.data) changes.push(`data: ${dateBR(a.data)} → **${dateBR(t.data)}**`);
  if (a.descricao !== t.descricao) changes.push(`descrição: ${a.descricao} → **${t.descricao}**`);
  if (a.conta !== t.conta) changes.push(`conta: ${a.conta} → **${t.conta}**`);
  let reply = changes.length ? `✏️ Pronto! ${t.descricao.replace(/ \(\d+\/\d+\)$/, "")}: ${changes.join("; ")}.` : "Nada mudou — o lançamento já estava assim.";
  if (t.estabelecimento && a.categoria !== t.categoria) reply += `\nDa próxima vez em “${t.estabelecimento}”, já uso essa categoria.`;
  return { reply, cards: [{ type: "transaction", data: t }], pending: null };
}

async function correctFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  const fix: Record<string, unknown> = {};
  if (i.categoria) { fix.categoria = i.categoria; fix.subcategoria = i.subcategoria; }
  else if (i.campo_correcao === "valor" && i.valor) fix.valor = i.valor;
  else if (i.campo_correcao === "data" && i.data) fix.data = i.data;
  else if (i.campo_correcao === "conta" && i.conta) fix.conta = i.conta;
  if (Object.keys(fix).length) return applyCorrection({ id: "ultimo", tipo: i.tipo, ...fix }, c);
  const t = await c.deps.db.rpc<any>("fe_target", c.user, { id: "ultimo", tipo: i.tipo });
  if (!t?.id) return { reply: "Não encontrei lançamentos para corrigir." };
  const label = txLabel(t);
  return {
    reply: `O que devo corrigir em ${label}?\nDiga, por exemplo: “a categoria é Lazer”, “o valor é 45” ou “foi ontem”.`,
    pending: { kind: "ask_correction", id: t.id, label, tipo: t.type },
  };
}

// ---------------------------------------------------------------------------
// CONSULTAS (sempre com dados reais do banco)
// ---------------------------------------------------------------------------
function capToToday(i: Interpretation, c: Ctx) {
  const p = i.periodo ?? { inicio: c.uc.hoje.slice(0, 8) + "01", fim: c.uc.hoje, label: "neste mês" };
  const fim = p.inicio <= c.uc.hoje && p.fim > c.uc.hoje ? c.uc.hoje : p.fim;
  return { ...p, fim };
}

async function totals(i: Interpretation, c: Ctx): Promise<Outcome> {
  const p = capToToday(i, c);
  const tipo = i.intent === "QUERY_INCOME" || i.tipo === "receita" ? "receita" : "despesa";
  const r = await c.deps.db.rpc<any>("fe_period_totals", c.user, {
    inicio: p.inicio, fim: p.fim, tipo, categoria: i.categoria, subcategoria: i.subcategoria, estabelecimento: i.estabelecimento,
    membro_id: i.membro_id,
  });
  const quem = !isFamily(c) || i.membro_id === c.uc.eu ? "você" : i.membro_id === "familia" ? "a família (gastos compartilhados)"
    : i.membro_id ? memberName(c, i.membro_id)! : "a família";
  const verbo = (quem === "você" ? "" : quem + " ") + (tipo === "receita" ? (quem === "você" ? "recebeu" : "recebeu") : "gastou");
  const alvo = r.subcategoria ? ` com ${r.categoria} > ${r.subcategoria}` : r.categoria ? ` com ${r.categoria}`
    : r.estabelecimento ? ` em “${i.estabelecimento ?? r.estabelecimento}”` : "";
  if (!r.quantidade) return { reply: `Não encontrei ${tipo === "receita" ? "receitas" : "despesas"}${alvo}${quem !== "você" && quem !== "a família" ? ` de ${quem}` : ""} ${p.label}.` };
  let reply = `📊 ${capitalizeFirst(p.label)} ${quem === "você" ? "você " : ""}${verbo}${alvo} **${brl(r.total_cents)}** (${r.quantidade} ${r.quantidade === 1 ? "lançamento" : "lançamentos"}).`;
  if (!i.membro_id) reply += bySplit(r.por_membro, c);
  const cards: Card[] = [];
  if (!r.categoria && !r.estabelecimento && r.por_categoria.length > 1) {
    const top = r.por_categoria.slice(0, 5);
    reply += "\n" + top.map((x: any) => `${x.icone ?? "•"} ${x.categoria}: ${brl(x.total_cents)} (${pct((x.total_cents / r.total_cents) * 100)})`).join("\n");
    cards.push({ type: "bars", title: `${tipo === "receita" ? "Receitas" : "Despesas"} por categoria`,
      items: top.map((x: any) => ({ label: x.categoria, icon: x.icone, value_cents: x.total_cents, pct: (x.total_cents / r.total_cents) * 100 })) });
  }
  return { reply, cards };
}

const capitalizeFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function largest(i: Interpretation, c: Ctx): Promise<Outcome> {
  const p = capToToday(i, c);
  const r = await c.deps.db.rpc<any>("fe_largest", c.user, { inicio: p.inicio, fim: p.fim, tipo: i.tipo ?? "despesa", membro_id: i.membro_id });
  const t = r.lancamento;
  if (!t) return { reply: `Não encontrei ${i.tipo === "receita" ? "receitas" : "despesas"} ${p.label}.` };
  return {
    reply: `${i.tipo === "receita" ? "💰 Sua maior receita" : "🔝 Sua maior despesa"} ${p.label} foi **${t.descricao}**: ${brl(t.valor_cents)} em ${dateBR(t.data)}${t.categoria ? ` (${t.categoria}${t.subcategoria ? ` > ${t.subcategoria}` : ""})` : ""}${isFamily(c) ? ` — de ${t.membro_id === c.uc.eu ? "você" : t.membro}` : ""}.`,
    cards: [{ type: "transaction", data: t }],
  };
}

async function installments(i: Interpretation, c: Ctx): Promise<Outcome> {
  const p = i.periodo!;
  const r = await c.deps.db.rpc<any>("fe_period_totals", c.user, { inicio: p.inicio, fim: p.fim, tipo: "despesa", somente_parcelas: true });
  if (!r.quantidade) return { reply: `Você não tem parcelas lançadas ${p.label}.` };
  return { reply: `💳 ${capitalizeFirst(p.label)} você tem **${brl(r.total_cents)}** em parcelas já lançadas (${r.quantidade} ${r.quantidade === 1 ? "parcela" : "parcelas"}).` };
}

async function balances(i: Interpretation, c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_balances", c.user, {});
  const contas = r.contas.filter((a: any) => a.status === "ativa");
  const one = i.conta ? contas.find((a: any) => norm(a.nome) === norm(i.conta!)) : null;
  if (one) return { reply: `🏦 Saldo de ${one.nome}: **${brl(one.saldo_cents)}**.` };
  const lines = contas.map((a: any) => `• ${a.nome}: ${brl(a.saldo_cents)}`).join("\n");
  return {
    reply: `🏦 Saldo atual (lançamentos até hoje):\n${lines}\n**Total: ${brl(r.total_cents)}**`,
    cards: [{ type: "list", title: "Saldos", items: contas.map((a: any) => ({ label: a.nome, value_cents: a.saldo_cents })) }],
  };
}

async function available(c: Ctx, focoHoje = false): Promise<Outcome> {
  const a = await c.deps.db.rpc<any>("fe_available", c.user, {});
  const fatos = [`Saldo atual nas contas: **${brl(a.saldo_atual_cents)}**`];
  if (a.despesas_previstas_cents) fatos.push(`despesas já lançadas até ${dateBR(a.fim_mes)}: ${brl(a.despesas_previstas_cents)}`);
  if (a.receitas_previstas_cents) fatos.push(`receitas previstas: ${brl(a.receitas_previstas_cents)}`);
  if (a.meta_economia_cents) fatos.push(`meta de economia do mês: ${brl(a.meta_economia_cents)}`);
  let reply = `📌 ${fatos.join("; ")}.\n\n`;
  if (a.disponivel_cents <= 0) {
    reply += `Pelos dados cadastrados, **não há folga** para novos gastos até o fim do mês (estimativa: ${brl(a.disponivel_cents)}).`;
  } else if (focoHoje) {
    reply += `Para fechar o mês no azul, a estimativa é gastar até **${brl(a.diario_cents)} hoje** (e por dia), considerando ${a.dias_restantes} dias restantes e ${brl(a.disponivel_cents)} disponíveis.`;
  } else {
    reply += `**Estimativa:** você pode gastar cerca de **${brl(a.disponivel_cents)}** até o fim do mês${a.meta_economia_cents ? " mantendo sua meta de economia" : ""} — aproximadamente **${brl(a.diario_cents)} por dia** nos ${a.dias_restantes} dias restantes.`;
  }
  reply += "\n_Cálculo baseado apenas no que está cadastrado no app._";
  return {
    reply,
    cards: [{ type: "summary", title: "Quanto posso gastar (estimativa)", items: [
      { label: "Disponível até o fim do mês", value_cents: a.disponivel_cents },
      { label: "Por dia", value_cents: a.diario_cents, hint: `${a.dias_restantes} dias restantes` },
    ] }],
  };
}

async function canBuy(i: Interpretation, c: Ctx): Promise<Outcome> {
  const a = await c.deps.db.rpc<any>("fe_available", c.user, {});
  const v = Math.round((i.valor ?? 0) * 100);
  const d = a.disponivel_cents, meta = a.meta_economia_cents;
  let reply: string;
  if (d >= v) {
    reply = `✅ Pelos seus dados atuais, a compra de ${brl(v)} **cabe** no mês: sobrariam cerca de ${brl(d - v)} até o fim do mês${meta ? `, mantendo sua meta de guardar ${brl(meta)}` : ""} (estimativa).`;
  } else if (meta && d + meta >= v) {
    const nova = meta - (v - d);
    reply = `⚠️ A compra de ${brl(v)} caberia no saldo, mas reduziria sua economia deste mês de ${brl(meta)} para cerca de ${brl(nova)} (estimativa).\nSe quiser manter a meta, o ideal é adiar a compra ou reduzir outras despesas em aproximadamente ${brl(v - d)}.`;
  } else {
    reply = `🚫 Pelos dados cadastrados, a compra de ${brl(v)} **não cabe** neste mês: faltariam cerca de ${brl(v - Math.max(d, 0))} (estimativa).\nVale adiar ou reduzir outras despesas.`;
  }
  reply += "\n_Considerei saldo atual, lançamentos futuros do mês e sua meta de economia cadastrados no app._";
  return { reply };
}

async function overview(c: Ctx): Promise<Outcome> {
  const o = await c.deps.db.rpc<any>("fe_month_overview", c.user, {});
  const a = await c.deps.db.rpc<any>("fe_available", c.user, {});
  const saldoMes = o.receitas_cents - o.despesas_cents;
  let reply = `📒 Neste mês ${isFamily(c) ? "a família" : "você"} recebeu **${brl(o.receitas_cents)}** e gastou **${brl(o.despesas_cents)}**. `;
  reply += saldoMes >= 0 ? `Seu saldo positivo até agora é de **${brl(saldoMes)}**.` : `Até agora as despesas superam as receitas em **${brl(-saldoMes)}**.`;
  reply += bySplit(o.despesas_por_membro, c).replace("Por pessoa:", "Gastos por pessoa:");
  if (o.compromissos_futuros_cents) reply += `\nVocê ainda tem ${brl(o.compromissos_futuros_cents)} em despesas lançadas para os próximos dias do mês.`;
  if (o.receitas_previstas_cents) reply += `\nHá ${brl(o.receitas_previstas_cents)} em receitas previstas.`;
  if (o.por_categoria.length) {
    reply += `\n\nMaiores gastos: ` + o.por_categoria.slice(0, 3).map((x: any) => `${x.icone ?? ""} ${x.categoria} ${brl(x.total_cents)}`).join(" · ");
  }
  reply += `\n\n**Estimativa:** ${a.disponivel_cents > 0 ? `seu limite para novos gastos até o fim do mês é de cerca de ${brl(a.disponivel_cents)} (${brl(a.diario_cents)}/dia)` : "não há folga para novos gastos até o fim do mês"}${a.meta_economia_cents ? `, considerando sua meta de guardar ${brl(a.meta_economia_cents)}` : ""}.`;
  return {
    reply,
    cards: [{ type: "summary", title: "Mês atual", items: [
      { label: "Receitas", value_cents: o.receitas_cents },
      { label: "Despesas", value_cents: o.despesas_cents },
      { label: "Saldo do mês", value_cents: saldoMes },
    ] }],
  };
}

async function spendingTooMuch(c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_analysis", c.user, {});
  const proj = Math.round((r.despesas_atual_cents / Math.max(r.dia, 1)) * r.dias_no_mes);
  let reply = `📈 Até hoje (dia ${r.dia}) você gastou **${brl(r.despesas_atual_cents)}**. Se mantiver esse ritmo, a projeção é de aproximadamente **${brl(proj)}** no mês (estimativa).`;
  if (r.meses_com_historico > 0 && r.media_despesas_3m_cents > 0) {
    const media = Math.round(r.media_despesas_3m_cents * 3 / r.meses_com_historico);
    const diff = ((proj - media) / media) * 100;
    reply += `\nSua média mensal recente é de ${brl(media)}: ${Math.abs(diff) < 5 ? "você está dentro da média." : diff > 0 ? `a projeção está **${pct(diff)} acima** da média. ⚠️` : `a projeção está ${pct(-diff)} abaixo da média. 👏`}`;
  } else {
    reply += "\nAinda não há histórico de meses anteriores para comparar.";
  }
  const rec = r.receitas_atual_cents;
  if (rec > 0 && proj > rec) reply += `\n⚠️ Nesse ritmo, as despesas devem superar as receitas registradas até agora (${brl(rec)}).`;
  const altas = (r.categorias as any[])
    .filter((x) => x.anterior_mesmo_periodo_cents > 0 && x.atual_cents > x.anterior_mesmo_periodo_cents * 1.2)
    .slice(0, 2)
    .map((x) => `${x.icone ?? ""} ${x.categoria} subiu ${pct(((x.atual_cents - x.anterior_mesmo_periodo_cents) / x.anterior_mesmo_periodo_cents) * 100)} em relação ao mesmo período do mês passado`);
  if (altas.length) reply += "\n" + altas.join("\n");
  return { reply };
}

async function compare(c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_analysis", c.user, {});
  const a = r.despesas_atual_cents, b = r.despesas_anterior_mesmo_periodo_cents;
  let reply = `📊 Até o dia ${r.dia}, você gastou **${brl(a)}** neste mês`;
  if (b > 0) {
    const d = a - b;
    reply += `, contra ${brl(b)} no mesmo período do mês passado — ${d === 0 ? "igual" : d > 0 ? `**${brl(d)} a mais** (+${pct((d / b) * 100)})` : `**${brl(-d)} a menos** (${pct((d / b) * 100)})`}.`;
  } else reply += ". Não há despesas no mesmo período do mês passado para comparar.";
  reply += `\nO mês passado fechou com ${brl(r.receitas_anterior_cents)} de receitas e ${brl(r.despesas_anterior_cents)} de despesas.`;
  const cats = (r.categorias as any[]).filter((x) => x.atual_cents !== x.anterior_mesmo_periodo_cents)
    .sort((x, y) => Math.abs(y.atual_cents - y.anterior_mesmo_periodo_cents) - Math.abs(x.atual_cents - x.anterior_mesmo_periodo_cents)).slice(0, 3);
  if (cats.length) {
    reply += "\n\nMaiores variações:\n" + cats.map((x) => {
      const d = x.atual_cents - x.anterior_mesmo_periodo_cents;
      return `${x.icone ?? "•"} ${x.categoria}: ${brl(x.anterior_mesmo_periodo_cents)} → ${brl(x.atual_cents)} (${d > 0 ? "+" : "−"}${brl(Math.abs(d))})`;
    }).join("\n");
  }
  return { reply };
}
