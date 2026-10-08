// O ASSISTENTE FINANCEIRO — único ponto de entrada para TODOS os canais.
// CONVERSAR → INTERPRETAR → VALIDAR → CLASSIFICAR → LANÇAR → ATUALIZAR → ANALISAR → RESPONDER
//
// Este arquivo não sabe se a mensagem veio do app ou do WhatsApp.
// Ele não grava nada diretamente: toda operação passa pelo Motor Financeiro (fe_*).

import type { AssistantReply, Card, EngineDb, IncomingMessage, Interpretation, UserContext } from "./types.ts";
import { runAgent, confirmAgent, type AgentCall, type GeminiContent } from "./agent.ts";
import { interpret, extractStatement, StatementError, type AiConfig, type Statement } from "./ai.ts";
import { interpretRules, matchUserCategory, matchCard, matchGoal } from "./interpreter_rules.ts";
import { guessCategory } from "./categorizer.ts";
import { extractAmount, findAmounts } from "./money.ts";
import { resolveDate, addDays } from "./dates.ts";
import { brl, dateBR, norm, pct } from "./text.ts";

export interface AssistantDeps {
  db: EngineDb;
  ai?: AiConfig;
  /** leitura de fatura/extrato (substituível nos testes) */
  extract?: (bytes: Uint8Array, mime: string, uc: UserContext) => Promise<Statement>;
}

interface ImportDest { cartao?: string; conta?: string; }

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
  | { kind: "ask_card"; interp: Interpretation; options: string[] }
  | { kind: "ask_goal"; interp: Interpretation; options: string[] }
  | { kind: "confirm_cancel_recurring"; id: string; label: string }
  | { kind: "import_dest"; st: Statement; options: string[]; campo: "cartao" | "conta" }
  | { kind: "confirm_import"; st: Statement; dest: ImportDest }
  | { kind: "ask_member_card"; interp: Interpretation; membro_id: string; options: string[] }
  | { kind: "confirm_settle"; pessoa_id: string; forma?: string; data?: string; label: string }
  | { kind: "agent"; history: GeminiContent[] }
  | { kind: "confirm_value"; interp: Interpretation }
  | { kind: "agent_confirm"; call: AgentCall; history: GeminiContent[] }
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
    role: "user", channel: msg.channel, content: content || "(áudio vazio)", message_type: msg.type, audio_provider: msg.audio_provider, audio_path: msg.audio_path,
  });
  const uc = await db.rpc<UserContext>("fe_context", user, {});
  const state = await db.rpc<{ pending: Pending | null }>("fe_chat_state", user, {});
  const c: Ctx = { msg: { ...msg, content }, user, uc, deps };

  let out: Outcome | null = null;
  try {
    if (msg.document) out = await documentFlow(c);
    if (!out && !content) out = { reply: "Não consegui entender o áudio. Pode repetir ou digitar?" };
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
    case "CREATE_RECURRING": out = await recurringFlow(i, c); break;
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
    case "QUERY_CARD": out = await cardsQuery(i, c); break;
    case "PAY_INVOICE": out = await payInvoiceFlow(i, c); break;
    case "CREATE_BUDGET": out = await budgetSetFlow(i, c); break;
    case "QUERY_BUDGET": out = await budgetsQuery(c); break;
    case "CREATE_GOAL": out = await goalCreateFlow(i, c); break;
    case "GOAL_CONTRIBUTE": out = await goalContributeFlow(i, c); break;
    case "QUERY_GOAL": out = await goalsQuery(i, c); break;
    case "QUERY_RECURRING": out = await recurringsQuery(c); break;
    case "CANCEL_RECURRING": out = await cancelRecurringFlow(i, c); break;
    case "QUERY_ALERTS": out = await alertsQuery(c); break;
    case "QUERY_DEBTS": out = await debtsQuery(c); break;
    case "SETTLE_DEBT": out = await settleFlow(i, c); break;
    case "GREETING":
      out = /obrigad|valeu|vlw|brigad/.test(norm(c.msg.content))
        ? { reply: "De nada! 😊 Estou por aqui quando precisar." }
        : { reply: `Olá${c.uc.nome ? `, ${c.uc.nome}` : ""}! 👋 Me conte um gasto ou recebimento, ou pergunte sobre suas finanças.` };
      break;
    case "HELP": out = { reply: HELP }; break;
    case "ADMIN": out = await agentFlow(c, []); break;
    default:
      if (c.deps.ai?.geminiKey) { out = await agentFlow(c, []); break; }
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
💳 *Cartão*: “comprei uma TV de 3.000 em 10x no cartão Nubank”, “quanto está a fatura?”, “paguei a fatura do Nubank”
📄 *Fatura em PDF*: mande o PDF ou a foto da fatura do cartão (ou do extrato) que eu leio e lanço tudo
🤝 *Dividir*: “jantar de 150 no Nubank dividido com a Bruna”, “250 no mercado, metade no meu cartão e metade no da Bruna”, “quanto devo?”, “acertei com a Bruna”
🛠️ *Cadastros conversando*: “cadastre para a Bruna o cartão Nubank que vence dia 10”, “crie a conta Itaú com saldo de 2.300”, “mude o limite do Nubank para 8 mil”
🔄 *Contas fixas*: “minha internet custa 120 todo dia 10”, “recebo 7 mil todo quinto dia útil”, “não pago mais a Netflix”
🎯 *Metas*: “quero juntar 20 mil até dezembro para a viagem”, “guardei 500 na meta viagem”, “como estão minhas metas?”
💵 *Orçamento*: “orçamento de 1.000 para alimentação”, “como está meu orçamento?”
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
    parcelas: i.parcelas, forma_pagamento: i.forma_pagamento, familia: i.familia, cartao: i.cartao,
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
    const audio = c.msg.type === "audio" ? "🎧 Não identifiquei o valor no áudio. " : "";
    return { reply: `${audio}Entendi ${TIPO_LABEL[tipo]}${what}. Qual foi o valor?`, pending: { kind: "ask_value", interp: i } };
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

  // Áudio com valor "fraco" (ex.: "dois" de "dois cartões", ou um valor muito baixo sem "reais"): confirma antes
  if (c.msg.type === "audio" && !extra.confirmado && !extra.valor_confirmado && weakAudioAmount(c.msg.content, i.valor)) {
    return {
      reply: `🎧 No áudio entendi o valor **${brl(Math.round(i.valor * 100))}**${i.descricao ? ` (${i.descricao})` : ""}, mas não tenho certeza. Está certo? Responda *sim* ou diga o valor correto.`,
      pending: { kind: "confirm_value", interp: i },
    };
  }
  if (i.dividir && tipo === "despesa") return splitFlow(i, c);
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
    case "needs_card": case "unknown_card":
      return {
        reply: `${r.status === "unknown_card" ? `Não encontrei o cartão “${r.cartao}”. ` : ""}Em qual cartão foi ${TIPO_LABEL[tipo] === "uma despesa" ? "a compra" : "o lançamento"} de ${brl(Math.round(i.valor * 100))}? ${r.cartoes.join(" · ")}`,
        pending: { kind: "ask_card", interp: i, options: r.cartoes },
      };
    case "no_cards":
      return {
        reply: `Você ainda não cadastrou cartões de crédito (cadastre em *Cartões* no app). Registro os ${brl(Math.round(i.valor * 100))} como gasto na conta? (*sim* / *não*)`,
        pending: { kind: "confirm_create", interp: { ...i, cartao: undefined, forma_pagamento: undefined } },
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
  const conta = t.cartao ? ` no cartão **${t.cartao}**` : i.conta ? ` na conta ${t.conta}` : "";
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
  if (r.cartao && r.fatura) {
    reply += `\n💳 Entra na fatura que vence em ${dateBR(r.lancamento.fatura_vencimento)}${r.parcelas > 1 ? " (1ª parcela)" : ""}.`;
    if (r.limite_disponivel_cents != null) reply += ` Limite disponível: ${brl(r.limite_disponivel_cents)}.`;
  }
  if (!r.cartao && i.forma_pagamento === "credito" && !(c.uc.cartoes ?? []).length) {
    reply += `\n💡 Dica: cadastre seus cartões em *Cartões* no app para eu separar as compras por fatura e controlar o limite.`;
  }
  if (r.orcamento && r.orcamento.percentual >= 80) {
    const o = r.orcamento;
    reply += o.percentual >= 100
      ? `\n🚨 ${o.categoria} passou do orçamento do mês: ${brl(o.gasto_cents)} de ${brl(o.limite_cents)} (${Math.round(o.percentual)}%).`
      : `\n⚠️ ${o.categoria} já usou ${Math.round(o.percentual)}% do orçamento (${brl(o.gasto_cents)} de ${brl(o.limite_cents)}).`;
  }
  if ((i.categoria_confianca ?? 1) < 0.8 && t.categoria === "Outros") reply += `\nSe preferir outra categoria, é só dizer: “muda a categoria para …”.`;
  if (t.tipo === "receita") {
    const a = await c.deps.db.rpc<any>("fe_available", c.user, {});
    reply += `\n\nConsiderando os lançamentos cadastrados, a previsão de saldo livre até o fim do mês é de **${brl(a.disponivel_cents)}** (estimativa).`;
  }
  return { reply, cards: [{ type: "transaction", data: { ...t, valor_total_cents: r.valor_total_cents, parcelas: r.parcelas } }], pending: null };
}

async function recurringFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  if (i.valor === undefined) return { reply: "Qual é o valor desse lançamento recorrente?", pending: { kind: "ask_value", interp: { ...i, intent: "CREATE_RECURRING" } } };
  const tipo = i.tipo === "receita" ? "receita" : "despesa";
  const r = await c.deps.db.rpc<any>("fe_save_recurring", c.user, {
    tipo, valor: i.valor, descricao: i.descricao, categoria: i.categoria, subcategoria: i.subcategoria, conta: i.conta, cartao: i.cartao,
    frequencia: i.frequencia, dia: i.dia, dia_util: i.dia_util, familia: i.familia, origem: origin(c),
  });
  const rec = { ...i, intent: "CREATE_RECURRING" as const };
  if (r.status === "needs_category") {
    return { reply: `Entendi ${TIPO_LABEL[tipo]} recorrente de ${brl(Math.round(i.valor * 100))}. Em qual categoria?\n${categoryList(c, tipo)}`, pending: { kind: "ask_category", interp: rec } };
  }
  if (r.status === "unknown_card") {
    const cards = c.uc.cartoes ?? [];
    return cards.length
      ? { reply: `Em qual cartão? ${cards.join(" · ")}`, pending: { kind: "ask_card", interp: rec, options: cards } }
      : { reply: "Você ainda não cadastrou cartões. Cadastre em *Cartões* no app e me diga de novo. 🙂", pending: null };
  }
  if (r.status === "unknown_account") return { reply: `Não encontrei a conta “${r.conta}”. Suas contas: ${c.uc.contas.join(", ")}.`, pending: { kind: "ask_account", interp: rec, campo: "conta" } };
  const x = r.recorrencia;
  const onde = x.cartao ? ` no cartão ${x.cartao}` : x.conta ? ` (${x.conta})` : "";
  let reply = `🔄 Conta fixa criada: **${x.descricao}** — ${brl(x.valor_cents)} ${x.quando}${onde}, em ${x.categoria}${x.subcategoria ? ` > ${x.subcategoria}` : ""}.`;
  reply += `\nVou lançar sozinho ${x.frequencia === "semanal" ? "toda semana" : x.frequencia === "anual" ? "todo ano" : "todo mês"}${x.proxima ? `; o próximo é em ${dateBR(r.primeira)}` : ""}. Para parar, é só dizer “não pago mais ${x.descricao.toLowerCase()}”.`;
  if (r.data_mes_atual) {
    reply += `\n\nA deste mês (${dateBR(r.data_mes_atual)}) já passou. Quer que eu registre também? (*sim* / *não*)`;
    return { reply, pending: { kind: "confirm_create", interp: { ...i, intent: tipo === "receita" ? "CREATE_INCOME" : "CREATE_EXPENSE", recorrente: false, data: r.data_mes_atual, data_explicita: true } } };
  }
  return { reply, pending: null };
}

/** Valor que veio de um áudio e merece confirmação: escrito por extenso sem "reais" ou muito baixo. */
function weakAudioAmount(text: string, valor?: number): boolean {
  if (valor === undefined) return false;
  const c = findAmounts(text).filter((x) => x.role === "valor" && Math.abs(x.value - valor) < 0.001);
  if (!c.length) return true;                           // o valor não aparece claro no que foi transcrito
  const best = Math.max(...c.map((x) => x.strength));
  return best === 1 || (valor < 10 && best < 3);       // "dois", "três" ou "5" solto
}

/** Encaminha uma interpretação já completa para o fluxo certo (usado ao responder perguntas pendentes). */
function saveFlow(i: Interpretation, c: Ctx, extra: Record<string, unknown> = {}): Promise<Outcome> {
  switch (i.intent) {
    case "CREATE_RECURRING": return recurringFlow(i, c);
    case "CREATE_GOAL": return goalCreateFlow(i, c);
    case "GOAL_CONTRIBUTE": return goalContributeFlow(i, c);
    case "CREATE_BUDGET": return budgetSetFlow(i, c);
    case "PAY_INVOICE": return payInvoiceFlow(i, c);
    default: return createFlow(i, c, extra);
  }
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
  const agentAnswer = p.kind === "agent" && !/^(nao|cancela|cancelar|cancele|esquece|deixa pra la|deixa|para|pare)[.!]*$/.test(n);
  if (NO.test(n) && p.kind !== "ask_correction" && !agentAnswer) return { reply: "Ok, cancelado. 👍", pending: null };
  const yes = YES.test(n);

  switch (p.kind) {
    case "confirm_create": if (yes) return createFlow(p.interp, c); break;
    case "confirm_value": {
      if (yes) return saveFlow(p.interp, c, { valor_confirmado: true });
      const a = extractAmount(text);
      if (a.valor) return saveFlow({ ...p.interp, valor: a.valor, alternativas: a.alternativas }, c, { valor_confirmado: true });
      if (!looksLikeNewCommand(text, c.uc)) return { reply: "Qual é o valor certo? Ex.: *1.000* ou *mil reais*." };
      break;
    }
    case "confirm_duplicate": if (yes) return createFlow(p.interp, c, { forcar: true }); break;
    case "confirm_category": {
      if (yes) return createFlow(p.interp, c, { confirmado: true });
      const cat = pickCategory(text, c, p.interp.tipo);
      if (cat) return createFlow({ ...p.interp, ...cat, categoria_confianca: 1 }, c);
      break;
    }
    case "ask_category": {
      const cat = pickCategory(text, c, p.interp.tipo);
      if (cat) return saveFlow({ ...p.interp, ...cat, categoria_confianca: 1 }, c);
      if (!looksLikeNewCommand(text, c.uc)) {
        return { reply: `Não encontrei essa categoria. Escolha uma destas (ou crie uma nova em Categorias):\n${categoryList(c, p.interp.tipo ?? "despesa")}` };
      }
      break;
    }
    case "ask_value": {
      const a = extractAmount(text);
      if (a.valor && !looksLikeNewCommand(text, c.uc)) {
        const interp = { ...p.interp, valor: a.valor, alternativas: a.alternativas };
        return saveFlow(interp, c);
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
      if (acc) return saveFlow({ ...p.interp, [p.campo]: acc }, c);
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
    case "ask_card": {
      const card = matchCard(text, c.uc) ?? p.options.find((o) => norm(o).includes(n) || n.includes(norm(o)));
      if (card) return saveFlow({ ...p.interp, cartao: card }, c);
      if (!looksLikeNewCommand(text, c.uc)) return { reply: `Não encontrei esse cartão. Seus cartões: ${p.options.join(" · ")}` };
      break;
    }
    case "ask_goal": {
      const g = matchGoal(text, c.uc) ?? p.options.find((o) => norm(o).includes(n) || n.includes(norm(o)));
      if (g) return saveFlow({ ...p.interp, meta: g }, c);
      if (!looksLikeNewCommand(text, c.uc)) return { reply: `Não encontrei essa meta. Suas metas: ${p.options.join(" · ")}` };
      break;
    }
    case "import_dest": {
      const opt = p.options.find((o) => norm(o) === n) ?? p.options.find((o) => n.includes(norm(o)) || norm(o).includes(n)) ??
        (p.campo === "cartao" ? matchCard(text, c.uc) : undefined);
      if (opt) return importPreview(p.st, p.campo === "cartao" ? { cartao: opt } : { conta: opt }, c);
      if (!looksLikeNewCommand(text, c.uc)) return { reply: `Não encontrei. Escolha uma destas opções: ${p.options.join(" · ")}` };
      break;
    }
    case "confirm_import": {
      if (yes) return importConfirm(p.st, p.dest, c);
      if (/\b(lista|listar|ver|mostra|mostrar|detalhe|detalhes|quais)\b/.test(n)) {
        const r = await c.deps.db.rpc<any>("fe_import", c.user, { ...p.dest, vencimento: p.st.vencimento, itens: statementItems(p.st) });
        const novas = r.itens.filter((x: any) => x.situacao === "nova");
        const lines = novas.slice(0, 60).map((x: any) => `• ${dateBR(x.data).slice(0, 5)} ${x.descricao} — ${x.tipo === "receita" ? "−" : ""}${brl(x.valor_cents)} (${x.categoria}${x.subcategoria ? " > " + x.subcategoria : ""})`);
        return {
          reply: `Lançamentos que vou registrar:\n${lines.join("\n")}${novas.length > 60 ? `\n… e mais ${novas.length - 60}` : ""}\n\nLanço todos? (*sim* / *não*) — depois você pode corrigir categorias no app.`,
          pending: p,
        };
      }
      break;
    }
    case "ask_member_card": {
      const card = p.options.find((o) => norm(o) === n) ?? p.options.find((o) => n.includes(norm(o)) || norm(o).includes(n)) ?? matchCard(text, c.uc);
      if (card) {
        const partes = (p.interp.partes ?? []).map((x) => x.membro === p.membro_id ? { ...x, cartao: card } : x);
        return splitFlow({ ...p.interp, partes }, c);
      }
      if (!looksLikeNewCommand(text, c.uc)) return { reply: `Escolha um destes cartões: ${p.options.join(" · ")}` };
      break;
    }
    case "confirm_settle": {
      if (/^(ok|okay|dispensa\w*|esquece)\b/.test(n)) {
        const r = await c.deps.db.rpc<any>("fe_settle", c.user, { pessoa_id: p.pessoa_id, acao: "dispensar", origem: origin(c) });
        return { reply: r.status === "nothing" ? "Não há nada pendente. 👍" : `👍 Ok, dispensei o acerto de ${brl(r.valor_cents)} — sem lançamento.`, pending: null };
      }
      if (yes || /\b(paguei|pago|ja paguei)\b/.test(n)) {
        const r = await c.deps.db.rpc<any>("fe_settle", c.user, { pessoa_id: p.pessoa_id, acao: "pago", forma: p.forma, data: p.data, origem: origin(c) });
        if (r.status === "nothing") return { reply: "Não há nada pendente para acertar. 👍", pending: null };
        return { reply: `✅ Acerto registrado: ${r.devedor} pagou ${brl(r.valor_cents)} para ${r.credor}.` +
          (r.transferencia ? `\nLancei como transferência: ${r.conta_origem} → ${r.conta_destino} (não conta como despesa nova).` : `\n(Não lancei transferência porque falta conta cadastrada de um de vocês.)`), pending: null };
      }
      break;
    }
    case "agent": {
      const r = interpretRules(text, c.uc);
      if (r.intent !== "OTHER" && r.intent !== "ADMIN" && r.intent !== "GREETING" && r.confidence >= 0.9 && !/^\d/.test(n)) break;  // mudou de assunto
      return agentFlow(c, p.history);
    }
    case "agent_confirm": {
      if (yes) return { reply: await confirmAgent(p.call, agentCtx(c)), pending: null };
      break;
    }
    case "confirm_cancel_recurring": {
      if (yes) {
        const r = await c.deps.db.rpc<any>("fe_cancel_recurring", c.user, { id: p.id, origem: origin(c) });
        return { reply: `✅ Pronto, encerrei ${p.label}.${r.futuros_removidos ? ` Tirei ${r.futuros_removidos} lançamento(s) futuro(s) que já estavam previstos.` : ""}`, pending: null };
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
// ---------------------------------------------------------------------------
// Agente (IA com ferramentas): cadastros por conversa e perguntas livres
// ---------------------------------------------------------------------------
function agentCtx(c: Ctx) { return { db: c.deps.db, user: c.user, uc: c.uc, origem: origin(c) }; }

async function agentFlow(c: Ctx, history: GeminiContent[]): Promise<Outcome> {
  if (!c.deps.ai?.geminiKey) {
    return { reply: "Para cadastros por conversa preciso da IA, que não está configurada. Use as telas *Cartões*, *Contas* e *Categorias* no app.", pending: null };
  }
  try {
    const r = await runAgent(c.msg.content, history, agentCtx(c), c.deps.ai);
    if (r.confirm) return { reply: r.reply, pending: { kind: "agent_confirm", call: r.confirm.call, history: r.confirm.history } };
    return { reply: r.reply, pending: r.history ? { kind: "agent", history: r.history } : null };
  } catch (e) {
    console.error("agente:", (e as Error).message);
    return { reply: "Não consegui falar com a IA agora. 😕 Tente de novo em instantes — ou faça o cadastro pelas telas do app (*Cartões*, *Contas*, *Categorias*).", pending: null };
  }
}

// ---------------------------------------------------------------------------
// Compras divididas e acertos da família
// ---------------------------------------------------------------------------
async function splitFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  const partes = i.partes?.map((x) => ({ membro_id: x.membro, cartao: x.cartao, cartao_do_membro: x.cartao_do_membro, conta: x.conta }));
  const r = await c.deps.db.rpc<any>("fe_create_split", c.user, { ...enginePayload(i, c), familia: undefined, dividir: true, partes });
  const total = brl(Math.round((i.valor ?? 0) * 100));
  switch (r.status) {
    case "created": {
      const lines = r.partes.map((x: any) => {
        const quem = x.membro_id === c.user ? "Você" : x.membro;
        const onde = x.cartao ? `no cartão ${x.cartao}${x.fatura ? ` (fatura de ${dateBR(x.fatura)})` : ""}` : x.conta ? `na conta ${x.conta}` : "";
        return `• ${quem}: ${brl(x.valor_cents)} ${onde}${x.deve_para ? ` — a acertar com ${x.deve_para === c.uc.nome ? "você" : x.deve_para.split(" ")[0]}` : ""}`;
      });
      const t = r.lancamento;
      let reply = `✅ Registrei ${total}${t?.categoria ? ` em **${t.categoria}${t.subcategoria ? ` > ${t.subcategoria}` : ""}**` : ""}, dividido:\n${lines.join("\n")}`;
      if (r.parcelas > 1) reply += `\n(em ${r.parcelas}x)`;
      const devendo = r.partes.filter((x: any) => x.deve_para);
      if (devendo.length) {
        const outro = devendo[0].deve_para === c.uc.nome ? devendo[0].membro : devendo[0].deve_para;
        reply += `\n\n🤝 Vou somar isso nos *acertos do mês*. Quando acertarem, diga “acertei com ${outro.split(" ")[0]}” ou toque em *Paguei* no app.`;
      }
      return { reply, cards: t ? [{ type: "transaction", data: { ...t, valor_cents: Math.round((i.valor ?? 0) * 100) } }] : undefined, pending: null };
    }
    case "no_family": return { reply: "Para dividir gastos, convide a outra pessoa em *Configurações → Família* no app. 🙂", pending: null };
    case "needs_value": return { reply: `${c.msg.type === "audio" ? "🎧 Não identifiquei o valor no áudio. " : ""}Qual foi o valor total da compra?`, pending: { kind: "ask_value", interp: i } };
    case "needs_category":
      return { reply: `Entendi uma compra de ${total} dividida. Em qual categoria?\n${categoryList(c, "despesa")}`, pending: { kind: "ask_category", interp: { ...i, categoria: undefined, subcategoria: undefined } } };
    case "needs_member_card":
      return { reply: `${r.membro.split(" ")[0]} ainda não tem cartão cadastrado no app. 💳 Peça para ${r.membro_id === c.user ? "você" : "ela/ele"} cadastrar em *Cartões* (entrando com o próprio login, ou você cadastra e escolhe "De quem é o cartão") e me mande de novo.`, pending: null };
    case "choose_member_card":
      return { reply: `Qual cartão ${r.membro_id === c.user ? "seu" : `de ${r.membro.split(" ")[0]}`}? ${r.cartoes.join(" · ")}`,
        pending: { kind: "ask_member_card", interp: i, membro_id: r.membro_id, options: r.cartoes } };
    case "needs_card": case "unknown_card":
      if (!r.cartoes?.length) return { reply: "Você ainda não cadastrou cartões. Cadastre em *Cartões* no app. 💳", pending: null };
      return { reply: `${r.status === "unknown_card" ? `Não encontrei o cartão “${r.cartao}”. ` : ""}Em qual cartão foi? ${r.cartoes.join(" · ")}`, pending: { kind: "ask_card", interp: i, options: r.cartoes } };
    case "no_cards": return { reply: "Ainda não há cartões cadastrados. Cadastre em *Cartões* no app e me mande de novo. 💳", pending: null };
    case "unknown_account": return { reply: `Não encontrei a conta “${r.conta}”. Contas: ${c.uc.contas.join(", ")}.`, pending: { kind: "ask_account", interp: i, campo: "conta" } };
  }
  return { reply: "Não consegui registrar a divisão. Confira os dados e tente de novo.", pending: null };
}

async function debtsQuery(c: Ctx): Promise<Outcome> {
  const d = await c.deps.db.rpc<any>("fe_debts", c.user, {});
  if (!d.devo.length && !d.recebo.length) return { reply: "Nenhum acerto pendente este mês. 👍" + (d.futuro_cents ? `\n(Há ${brl(d.futuro_cents)} de parcelas divididas para os próximos meses.)` : "") };
  const lines: string[] = [];
  for (const x of d.devo) lines.push(`🔴 Você deve ${brl(x.total_cents)} para ${x.pessoa.split(" ")[0]} (${x.itens.length} gasto(s) dividido(s))`);
  for (const x of d.recebo) lines.push(`🟢 ${x.pessoa.split(" ")[0]} deve ${brl(x.total_cents)} para você (${x.itens.length} gasto(s) dividido(s))`);
  const ex = [...d.devo, ...d.recebo][0];
  return { reply: `🤝 Acertos do mês:\n${lines.join("\n")}\n\nQuando pagarem, diga “acertei com ${ex.pessoa.split(" ")[0]}” (ou “fiz pix pra ${ex.pessoa.split(" ")[0]}”).` };
}

async function settleFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  const d = await c.deps.db.rpc<any>("fe_debts", c.user, {});
  const devo = d.devo.find((x: any) => x.pessoa_id === i.pessoa_id)?.total_cents ?? 0;
  const recebo = d.recebo.find((x: any) => x.pessoa_id === i.pessoa_id)?.total_cents ?? 0;
  const nome = (c.uc.membros ?? []).find((m) => m.id === i.pessoa_id)?.nome.split(" ")[0] ?? "a outra pessoa";
  const liquido = devo - recebo;
  if (!liquido) return { reply: `Não há acerto pendente com ${nome} este mês. 👍`, pending: null };
  const label = liquido > 0 ? `você pagou ${brl(liquido)} para ${nome}` : `${nome} pagou ${brl(-liquido)} para você`;
  const aviso = i.valor && Math.round(i.valor * 100) !== Math.abs(liquido) ? `\n⚠️ O acerto pendente é de ${brl(Math.abs(liquido))} (você falou ${brl(Math.round(i.valor * 100))}). Registro o acerto completo.` : "";
  return {
    reply: `🤝 Vou registrar que ${label}${i.forma_pagamento ? ` (${i.forma_pagamento})` : ""}, quitando os gastos divididos do mês, e lançar a transferência entre as contas de vocês.${aviso}\nConfirma? (*sim* / *não*) — ou *ok* para só dispensar, sem lançamento.`,
    pending: { kind: "confirm_settle", pessoa_id: i.pessoa_id!, forma: i.forma_pagamento, data: i.data, label },
  };
}

// ---------------------------------------------------------------------------
// Cartões e faturas
// ---------------------------------------------------------------------------
const SITUACAO: Record<string, string> = { aberta: "aberta", fechada: "fechada, aguardando pagamento", vencida: "⚠️ vencida", paga: "✅ paga", vazia: "sem lançamentos" };

async function cardsQuery(i: Interpretation, c: Ctx): Promise<Outcome> {
  const cards = await c.deps.db.rpc<any[]>("fe_cards", c.user, {});
  if (!cards.length) return { reply: "Você ainda não cadastrou cartões de crédito. Cadastre em *Cartões* no app (nome, dia de fechamento e de vencimento) e depois é só dizer “gastei 50 no cartão”. 💳" };
  const alvo = i.cartao ? cards.filter((k) => k.nome === i.cartao) : cards;
  if (i.consulta === "limite") {
    return { reply: alvo.map((k) => k.limite_cents == null ? `💳 ${k.nome}: limite não informado (usado ${brl(k.usado_cents)}).`
      : `💳 ${k.nome}: limite ${brl(k.limite_cents)} · usado ${brl(k.usado_cents)} · **disponível ${brl(k.disponivel_cents)}**`).join("\n") };
  }
  if (i.consulta === "cartoes") {
    return { reply: "💳 Seus cartões:\n" + cards.map((k) => `• ${k.nome}: fecha dia ${k.fechamento}, vence dia ${k.vencimento} — fatura atual ${brl(k.fatura_atual.total_cents)}`).join("\n") };
  }
  const proxima = /proxim|que vem/.test(norm(c.msg.content));
  const lines = alvo.map((k) => {
    const ant = k.fatura_anterior, cur = k.fatura_atual;
    if (proxima) {
      const nx = k.proximas[0];
      return nx ? `💳 ${k.nome}: a próxima fatura (vence ${dateBR(nx.vencimento)}) já tem **${brl(nx.total_cents)}** lançados.` : `💳 ${k.nome}: a próxima fatura ainda não tem lançamentos.`;
    }
    let l = `💳 **${k.nome}** — fatura atual: **${brl(cur.total_cents)}** (fecha ${dateBR(cur.fechamento)}, vence ${dateBR(cur.vencimento)}, ${SITUACAO[cur.situacao] ?? cur.situacao}).`;
    if (ant.total_cents > 0 && ant.situacao !== "paga") l += `\n   Fatura anterior (venc. ${dateBR(ant.vencimento)}): ${brl(ant.restante_cents)} a pagar — ${SITUACAO[ant.situacao]}.`;
    else if (ant.total_cents > 0) l += `\n   Fatura anterior (venc. ${dateBR(ant.vencimento)}): ${brl(ant.total_cents)} — paga.`;
    if (k.limite_cents != null) l += `\n   Limite disponível: ${brl(k.disponivel_cents)}.`;
    return l;
  });
  return { reply: lines.join("\n") };
}

async function payInvoiceFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_pay_invoice", c.user, { cartao: i.cartao, valor: i.valor, conta: i.conta, data: i.data, origem: origin(c), mensagem_original: c.msg.content });
  if (r.status === "needs_card" || r.status === "unknown_card") {
    if (!r.cartoes?.length) return { reply: "Você ainda não cadastrou cartões. Cadastre em *Cartões* no app. 💳", pending: null };
    return { reply: `${r.status === "unknown_card" ? "Não encontrei esse cartão. " : ""}Qual fatura você pagou? ${r.cartoes.join(" · ")}`, pending: { kind: "ask_card", interp: { ...i, intent: "PAY_INVOICE" }, options: r.cartoes } };
  }
  if (r.status === "unknown_account") return { reply: `Não encontrei a conta “${r.conta}”. Suas contas: ${c.uc.contas.join(", ")}.`, pending: { kind: "ask_account", interp: { ...i, intent: "PAY_INVOICE" }, campo: "conta" } };
  if (r.status === "nothing_to_pay") return { reply: `A fatura do ${r.cartao} com vencimento em ${dateBR(r.fatura.vencimento)} não tem valor em aberto. 👍`, pending: null };
  const f = r.fatura;
  return {
    reply: `✅ Registrei o pagamento de **${brl(r.valor_cents)}** da fatura do ${r.cartao} (venc. ${dateBR(f.vencimento)}), saindo da conta ${r.conta}.` +
      (f.restante_cents > 0 ? `\nAinda restam ${brl(f.restante_cents)} nessa fatura.` : "\nFatura quitada. 🎉") +
      `\n_Pagamento de fatura não conta como despesa nova: as compras já foram contadas quando você gastou._`,
    cards: [{ type: "transaction", data: r.lancamento }], pending: null,
  };
}

// ---------------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------------
function goalLine(g: any): string {
  let l = `${g.icone ?? "🎯"} **${g.nome}**: ${brl(g.atual_cents)} de ${brl(g.objetivo_cents)} (${Math.round(g.progresso)}%)`;
  if (g.status === "concluida") return l + " — concluída! 🎉";
  l += ` · faltam ${brl(g.falta_cents)}`;
  if (g.prazo) l += `\n   Prazo ${dateBR(g.prazo)}: guardar ~${brl(g.por_mes_cents ?? 0)}/mês (${brl(g.por_semana_cents ?? 0)}/semana)`;
  if (g.previsao) l += `\n   No ritmo atual, conclui por volta de ${dateBR(g.previsao)} (estimativa)${g.atrasada ? " — depois do prazo ⚠️" : ""}`;
  return l;
}

async function goalCreateFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  if (i.valor === undefined) return { reply: "Qual é o valor que você quer juntar?", pending: { kind: "ask_value", interp: { ...i, intent: "CREATE_GOAL" } } };
  const r = await c.deps.db.rpc<any>("fe_save_goal", c.user, { nome: i.meta ?? "Minha meta", valor: i.valor, prazo: i.prazo, origem: origin(c) });
  const g = r.meta;
  let reply = `🎯 Meta criada: **${g.nome}** — ${brl(g.objetivo_cents)}${g.prazo ? ` até ${dateBR(g.prazo)}` : ""}.`;
  if (g.por_mes_cents) reply += `\nPara chegar lá, guarde cerca de **${brl(g.por_mes_cents)} por mês** (${brl(g.por_semana_cents)} por semana).`;
  else reply += `\nSem prazo definido — se quiser, diga “até dezembro” ou ajuste em *Metas* no app.`;
  reply += `\nQuando guardar dinheiro, me diga: “guardei 500 na meta ${g.nome.toLowerCase()}”.`;
  return { reply, pending: null };
}

async function goalContributeFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  if (i.valor === undefined) return { reply: "Qual foi o valor?", pending: { kind: "ask_value", interp: { ...i, intent: "GOAL_CONTRIBUTE" } } };
  const r = await c.deps.db.rpc<any>("fe_goal_contribute", c.user, { meta: i.meta, valor: i.valor, data: i.data, origem: origin(c) });
  if (r.status === "no_goals") return { reply: "Você ainda não tem metas. Crie uma dizendo, por exemplo: “quero juntar 5 mil até dezembro para a viagem”. 🎯", pending: null };
  if (r.status === "needs_goal") return { reply: `Em qual meta? ${r.metas.join(" · ")}`, pending: { kind: "ask_goal", interp: { ...i, intent: "GOAL_CONTRIBUTE" }, options: r.metas } };
  const g = r.meta;
  const verbo = r.valor_cents > 0 ? `Guardei ${brl(r.valor_cents)} na` : `Tirei ${brl(-r.valor_cents)} da`;
  return { reply: `💰 ${verbo} meta **${g.nome}**.\n${goalLine(g)}`, pending: null };
}

async function goalsQuery(i: Interpretation, c: Ctx): Promise<Outcome> {
  const gs = (await c.deps.db.rpc<any[]>("fe_goals", c.user, {})).filter((g) => !i.meta || g.nome === i.meta);
  if (!gs.length) return { reply: "Você ainda não tem metas. Crie uma dizendo, por exemplo: “quero juntar 20 mil até dezembro para a viagem”. 🎯" };
  return { reply: gs.map(goalLine).join("\n\n") };
}

// ---------------------------------------------------------------------------
// Orçamentos
// ---------------------------------------------------------------------------
async function budgetSetFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  if (i.valor === undefined) return { reply: "Qual valor de orçamento por mês?", pending: { kind: "ask_value", interp: { ...i, intent: "CREATE_BUDGET" } } };
  if (!i.categoria) return { reply: `Para qual categoria? ${categoryList(c, "despesa")}`, pending: { kind: "ask_category", interp: { ...i, intent: "CREATE_BUDGET", tipo: "despesa" } } };
  const r = await c.deps.db.rpc<any>("fe_set_budget", c.user, { categoria: i.categoria, valor: i.valor, origem: origin(c) });
  if (r.status === "unknown_category") return { reply: `Não encontrei a categoria “${r.categoria}”.\n${categoryList(c, "despesa")}`, pending: { kind: "ask_category", interp: { ...i, intent: "CREATE_BUDGET", tipo: "despesa" } } };
  const st = r.situacao;
  let reply = r.valor_cents === 0 ? `Pronto, tirei o orçamento de ${r.categoria}.` : `💵 Orçamento de **${r.categoria}**: ${brl(r.valor_cents)} por mês, a partir deste mês.`;
  if (st && r.valor_cents) reply += `\nEste mês: ${brl(st.gasto_cents)} gastos (${Math.round(st.percentual)}%).` +
    (st.percentual >= 100 ? " 🚨 Já passou do limite." : st.percentual >= 80 ? " ⚠️ Já está perto do limite." : " Aviso quando chegar a 80%.");
  return { reply, pending: null };
}

async function budgetsQuery(c: Ctx): Promise<Outcome> {
  const b = await c.deps.db.rpc<any>("fe_budgets", c.user, {});
  if (!b.itens.length) return { reply: "Você ainda não definiu orçamentos. Ex.: “orçamento de 1.000 para alimentação”. 💵" };
  const ico = (s: string) => s === "estourado" ? " 🚨" : s === "atencao" ? " ⚠️" : "";
  const lines = b.itens.map((x: any) => `${x.icone ?? "•"} ${x.categoria}: ${brl(x.gasto_cents)} / ${brl(x.limite_cents)} (${Math.round(x.percentual)}%)${ico(x.situacao)}`);
  return {
    reply: `💵 Orçamento do mês:\n${lines.join("\n")}\n**Total: ${brl(b.total_gasto_cents)} de ${brl(b.total_limite_cents)}**`,
    cards: [{ type: "bars", title: "Orçamento do mês", items: b.itens.map((x: any) => ({ label: x.categoria, icon: x.icone, value_cents: x.gasto_cents, pct: Math.min(100, x.percentual), hint: `de ${brl(x.limite_cents)}` })) }],
  };
}

// ---------------------------------------------------------------------------
// Contas fixas (recorrências) e alertas
// ---------------------------------------------------------------------------
async function recurringsQuery(c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_recurrings", c.user, {});
  if (!r.itens.length) return { reply: "Você ainda não tem contas fixas cadastradas. Ex.: “minha internet custa 120 todo dia 10”. 🔄" };
  const line = (x: any) => `• ${x.descricao}: ${brl(x.valor_cents)} ${x.quando}${x.cartao ? ` (cartão ${x.cartao})` : ""}${x.proxima ? ` — próx. ${dateBR(x.proxima)}` : ""}`;
  const desp = r.itens.filter((x: any) => x.tipo === "despesa"), rec = r.itens.filter((x: any) => x.tipo === "receita");
  let reply = "";
  if (rec.length) reply += `💰 Receitas fixas:\n${rec.map(line).join("\n")}\n`;
  if (desp.length) reply += `${rec.length ? "\n" : ""}🔄 Despesas fixas:\n${desp.map(line).join("\n")}\n`;
  reply += `\nPor mês: ${brl(r.receitas_mes_cents)} de receitas e ${brl(r.despesas_mes_cents)} de despesas fixas.`;
  return { reply };
}

async function cancelRecurringFlow(i: Interpretation, c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_recurrings", c.user, {});
  const alvo = norm(i.descricao ?? "");
  const found = r.itens.filter((x: any) => alvo && (norm(x.descricao).includes(alvo) || alvo.includes(norm(x.descricao)) || norm(x.subcategoria ?? "").includes(alvo)));
  if (found.length !== 1) {
    if (!r.itens.length) return { reply: "Você não tem contas fixas cadastradas." };
    return { reply: `${found.length ? "Encontrei mais de uma" : "Não encontrei essa conta fixa"}. Qual devo encerrar? ${r.itens.map((x: any) => x.descricao).join(" · ")}` };
  }
  const x = found[0];
  const label = `**${x.descricao}** (${brl(x.valor_cents)} ${x.quando})`;
  return { reply: `Vou encerrar a conta fixa ${label}: ela para de ser lançada e tiro os lançamentos futuros já previstos. Confirma? (*sim* / *não*)`, pending: { kind: "confirm_cancel_recurring", id: x.id, label } };
}

async function alertsQuery(c: Ctx): Promise<Outcome> {
  const a = await c.deps.db.rpc<any[]>("fe_alerts", c.user, {});
  if (!a.length) return { reply: "Nenhum alerta no momento. 👍 Orçamentos, faturas e metas estão em dia." };
  return { reply: "🔔 Alertas:\n" + a.map((x) => `${x.icone} ${x.texto}`).join("\n") };
}

// ---------------------------------------------------------------------------
// Fatura / extrato em PDF ou foto
// ---------------------------------------------------------------------------
const PDF_SENHA = "🔒 Esse PDF está protegido por senha, e assim não consigo ler.\n\nPara tirar a senha: abra o PDF (ele vai pedir a senha, normalmente os primeiros dígitos do CPF), toque em *Imprimir* e escolha *Salvar como PDF*. O arquivo novo fica sem senha — é só me mandar ele.\n\nOutra opção: baixe a fatura em *OFX* ou *CSV* no app do banco e importe em *Cartões → Importar fatura*.";

/** Itens no formato do motor, com a categoria sugerida pelas regras (mais precisas) ou pela IA. */
function statementItems(st: Statement) {
  return st.itens.map((it) => {
    const despesa = st.tipo === "fatura_cartao" ? it.valor > 0 : it.valor < 0;
    const g = guessCategory(it.descricao, despesa ? "despesa" : "receita");
    const useRule = g && (g.confianca >= 0.8 || !it.categoria);
    return {
      data: it.data, valor: it.valor, descricao: it.descricao, parcela: it.parcela,
      categoria: useRule ? g!.categoria : despesa ? it.categoria : undefined,
      subcategoria: useRule ? g!.subcategoria : undefined,
    };
  });
}

/** Para a tela de importação do app: lê o documento e devolve os itens já com categoria sugerida (nada é gravado). */
export async function readStatement(bytes: Uint8Array, mime: string, user: string, deps: AssistantDeps) {
  const uc = await deps.db.rpc<UserContext>("fe_context", user, {});
  const extract = deps.extract ?? ((b: Uint8Array, m: string, u: UserContext) => extractStatement(b, m, u, deps.ai ?? {}));
  const st = await extract(bytes, mime, uc);
  const hint = [st.cartao, st.banco].filter(Boolean).join(" ");
  const cards = uc.cartoes ?? [];
  const cartao = st.tipo === "fatura_cartao" ? ((hint && matchCard(hint, uc)) || (cards.length === 1 ? cards[0] : undefined)) : undefined;
  const conta = st.tipo === "extrato_conta" && st.banco ? uc.contas.find((a) => norm(a).includes(norm(st.banco!)) || norm(st.banco!).includes(norm(a))) : undefined;
  return { tipo: st.tipo, banco: st.banco, final_cartao: st.final_cartao, vencimento: st.vencimento, total: st.total, cartao, conta, itens: statementItems(st) };
}

async function documentFlow(c: Ctx): Promise<Outcome> {
  const d = c.msg.document!;
  const extract = c.deps.extract ?? ((b: Uint8Array, m: string, uc: UserContext) => extractStatement(b, m, uc, c.deps.ai ?? {}));
  let st: Statement;
  try {
    st = await extract(d.bytes, d.mime, c.uc);
  } catch (e) {
    const code = e instanceof StatementError ? e.code : "";
    if (code === "senha") return { reply: PDF_SENHA, pending: null };
    if (code === "grande") return { reply: "Esse arquivo é grande demais (máximo 15 MB). Tente mandar só as páginas dos lançamentos.", pending: null };
    if (code === "sem_ia") return { reply: "A leitura de PDF ainda não está configurada no servidor.", pending: null };
    console.error("fatura:", (e as Error).message);
    return { reply: "Não consegui ler esse documento. 😕 Confira se é a fatura ou o extrato (PDF ou foto nítida) e tente de novo. Se preferir, baixe o arquivo *OFX* ou *CSV* no app do banco e importe em *Cartões → Importar fatura*.", pending: null };
  }
  if (st.tipo === "fatura_cartao") {
    const cards = c.uc.cartoes ?? [];
    if (!cards.length) {
      return { reply: `📄 Li uma fatura${st.banco ? ` do ${st.banco}` : ""} com ${st.itens.length} lançamentos, mas você ainda não cadastrou cartões.\nCadastre em *Cartões* no app (nome, dia de fechamento e de vencimento) e me mande a fatura de novo. 💳`, pending: null };
    }
    const hint = [st.cartao, st.banco].filter(Boolean).join(" ");
    const card = (hint && matchCard(hint, c.uc)) || (hint && cards.find((k) => norm(hint).includes(norm(k)) || norm(k).split(" ").some((w) => w.length >= 4 && norm(hint).includes(w)))) ||
      (cards.length === 1 ? cards[0] : undefined);
    if (!card) {
      return { reply: `📄 Li uma fatura${st.banco ? ` do ${st.banco}` : ""}${st.final_cartao ? ` (final ${st.final_cartao})` : ""} com ${st.itens.length} lançamentos. De qual cartão ela é? ${cards.join(" · ")}`,
        pending: { kind: "import_dest", st, options: cards, campo: "cartao" } };
    }
    return importPreview(st, { cartao: card }, c);
  }
  const contas = c.uc.contas;
  const conta = st.banco ? contas.find((a) => norm(a).includes(norm(st.banco!)) || norm(st.banco!).includes(norm(a))) : undefined;
  if (!conta) {
    return { reply: `📄 Li um extrato${st.banco ? ` do ${st.banco}` : ""} com ${st.itens.length} lançamentos. De qual conta ele é? ${contas.join(" · ")}`,
      pending: { kind: "import_dest", st, options: contas, campo: "conta" } };
  }
  return importPreview(st, { conta }, c);
}

async function importPreview(st: Statement, dest: ImportDest, c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_import", c.user, { ...dest, vencimento: dest.cartao ? st.vencimento : undefined, itens: statementItems(st) });
  if (r.status === "unknown_card" || r.status === "unknown_account") return { reply: "Não encontrei essa conta/cartão no seu cadastro.", pending: null };
  const novas = r.itens.filter((x: any) => x.situacao === "nova");
  const dups = r.itens.filter((x: any) => x.situacao === "duplicada");
  const pags = r.itens.filter((x: any) => x.situacao === "pagamento");
  const onde = dest.cartao ? `a fatura do *${r.cartao}*${st.vencimento ? ` (vencimento ${dateBR(st.vencimento)})` : ""}` : `o extrato da conta *${r.conta}*`;
  let reply = `📄 Li ${onde}: ${r.itens.length} lançamentos.`;
  if (dest.cartao && st.total != null) {
    const soma = r.itens.filter((x: any) => x.situacao === "nova" || x.situacao === "duplicada")
      .reduce((s: number, x: any) => s + (x.tipo === "despesa" ? x.valor_cents : -x.valor_cents), 0);
    const total = Math.round(st.total * 100);
    reply += Math.abs(soma - total) <= 5
      ? `\n✅ A soma confere com o total da fatura (${brl(total)}).`
      : `\n⚠️ A soma do que li (${brl(soma)}) é diferente do total da fatura (${brl(total)}). Pode ser saldo anterior, juros ou alguma linha que não consegui ler — confira depois em *Cartões*.`;
  }
  if (dups.length) reply += `\n🔁 ${dups.length} já estavam lançados e não entram de novo.`;
  if (pags.length) reply += `\n💳 ${pags.length} pagamento(s) de fatura ignorado(s).`;
  if (!novas.length) return { reply: `${reply}\n\nNão há nada novo para lançar. 👍`, pending: null };
  const porCat = new Map<string, { icone: string; total: number; n: number }>();
  for (const x of novas.filter((y: any) => y.tipo === "despesa")) {
    const k = porCat.get(x.categoria) ?? { icone: x.icone ?? "•", total: 0, n: 0 };
    k.total += x.valor_cents; k.n++; porCat.set(x.categoria, k);
  }
  const cats = [...porCat.entries()].sort((a, b) => b[1].total - a[1].total).map(([nome, v]) => `${v.icone} ${nome}: ${brl(v.total)} (${v.n})`);
  const totDesp = novas.filter((y: any) => y.tipo === "despesa").reduce((s: number, y: any) => s + y.valor_cents, 0);
  const totRec = novas.filter((y: any) => y.tipo === "receita").reduce((s: number, y: any) => s + y.valor_cents, 0);
  reply += `\n\n*Novos: ${novas.length}*${totDesp ? ` · gastos ${brl(totDesp)}` : ""}${totRec ? ` · ${dest.cartao ? "estornos" : "entradas"} ${brl(totRec)}` : ""}`;
  if (cats.length) reply += `\n${cats.join("\n")}`;
  reply += `\n\nLanço tudo? (*sim* / *não*) — ou diga *lista* para ver um por um.`;
  return { reply, pending: { kind: "confirm_import", st, dest } };
}

async function importConfirm(st: Statement, dest: ImportDest, c: Ctx): Promise<Outcome> {
  const r = await c.deps.db.rpc<any>("fe_import", c.user, { ...dest, vencimento: dest.cartao ? st.vencimento : undefined, itens: statementItems(st), confirmar: true, origem: "importacao" });
  let reply = `✅ Pronto! Lancei ${r.importados} lançamento(s) ${dest.cartao ? `na fatura do ${r.cartao}` : `na conta ${r.conta}`}.`;
  if (r.fatura) reply += `\nTotal dessa fatura no app: *${brl(r.fatura.total_cents)}*${r.fatura.restante_cents > 0 ? `, vence ${dateBR(r.fatura.vencimento)}` : ""}.`;
  reply += `\nSe alguma categoria ficou errada, corrija em *Lançamentos* no app — eu aprendo e acerto nas próximas faturas.`;
  return { reply, pending: null };
}

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
  if (a.faturas_cents) fatos.push(`faturas de cartão a pagar: ${brl(a.faturas_cents)}`);
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
  if (o.alertas?.length) reply += `\n\n🔔 ` + o.alertas.slice(0, 3).map((x: any) => `${x.icone} ${x.texto}`).join("\n");
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
