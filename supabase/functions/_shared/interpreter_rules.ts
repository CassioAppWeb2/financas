// Interpretador por regras: entende as frases mais comuns sem depender de IA externa.
// Gratuito, instantâneo e determinístico. Quando a confiança é baixa, o
// interpretador por IA (Gemini) é consultado — se estiver configurado.

import type { Interpretation, Intent, QueryKind, UserContext } from "./types.ts";
import { norm, capitalize } from "./text.ts";
import { extractAmount } from "./money.ts";
import { resolveDate, resolvePeriod } from "./dates.ts";
import { guessCategory } from "./categorizer.ts";

const wb = (s: string) => new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);

/** Procura nomes de categorias/subcategorias do próprio usuário na frase. */
export function matchUserCategory(text: string, ctx: UserContext, tipo?: "despesa" | "receita"):
  { categoria: string; subcategoria?: string } | null {
  const n = norm(text);
  let best: { categoria: string; subcategoria?: string; len: number } | null = null;
  for (const c of ctx.categorias) {
    if (tipo && c.tipo !== tipo) continue;
    const cn = norm(c.nome);
    if (cn !== "outros" && wb(cn).test(n) && (!best || cn.length > best.len)) best = { categoria: c.nome, len: cn.length };
    for (const s of c.subcategorias) {
      const sn = norm(s);
      if (wb(sn).test(n) && (!best || sn.length > best.len)) best = { categoria: c.nome, subcategoria: s, len: sn.length };
    }
  }
  return best ? { categoria: best.categoria, subcategoria: best.subcategoria } : null;
}

/** Cartão citado pelo nome ("no nubank", "cartão itaú visa") */
export function matchCard(text: string, ctx: UserContext): string | undefined {
  const n = norm(text);
  const hits = (ctx.cartoes ?? []).filter((c) => {
    const cn = norm(c);
    return wb(cn).test(n) || cn.split(" ").some((w) => w.length >= 4 && !/^(cartao|credito|visa|master|mastercard|elo|black|gold|platinum)$/.test(w) && wb(w).test(n));
  });
  return hits.sort((a, b) => b.length - a.length)[0];
}

/** Meta citada pelo nome */
export function matchGoal(text: string, ctx: UserContext): string | undefined {
  const n = norm(text);
  return (ctx.metas ?? []).filter((m) => {
    const mn = norm(m);
    return wb(mn).test(n) || mn.split(" ").some((w) => w.length >= 4 && wb(w).test(n));
  }).sort((a, b) => b.length - a.length)[0];
}

const MONTHS_N: Record<string, number> = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const ORD_N: Record<string, number> = { primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6, setimo: 7, oitavo: 8, nono: 9, decimo: 10 };

/** Prazo de meta: "até dezembro", "até março de 2027", "em 10 meses", "até o fim do ano", "até 15/03/2027" */
export function parseDeadline(n: string, today: string): string | undefined {
  const y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7));
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  let m = n.match(/\bate (?:o )?(?:fim|final) do ano(?: que vem)?\b/);
  if (m) return `${/que vem/.test(m[0]) ? y + 1 : y}-12-31`;
  m = n.match(/\b(?:ate|em|para) (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?: de (\d{4}))?\b/);
  if (m) { const mm = MONTHS_N[m[1]]; const yy = m[2] ? Number(m[2]) : (mm < mo ? y + 1 : y); return last(yy, mm); }
  m = n.match(/\b(?:em|daqui a|nos proximos|ate) (\d{1,3}) (meses|mes|anos|ano)\b/);
  if (m) { const k = Number(m[1]) * (/ano/.test(m[2]) ? 12 : 1); const d = new Date(Date.UTC(y, mo - 1 + k, Number(today.slice(8, 10)))); return d.toISOString().slice(0, 10); }
  m = n.match(/\bate (\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = n.match(/\b(?:ate|em) (\d{4})\b/);
  if (m && Number(m[1]) >= y) return `${m[1]}-12-31`;
  return undefined;
}

/** Nome de meta: "para a viagem", "meta da reforma", "juntar 5 mil pra comprar um carro" */
export function goalName(text: string): string | undefined {
  const lower = text.toLowerCase();
  const stop = "(?=\\s+(?:ate|até|em|de\\s+\\d|daqui|nos|no|na|r\\$|\\d)\\b|\\s*[.,!?]|\\s*$)";
  const pats = [
    new RegExp(`\\bmeta(?:\\s+(?:de|da|do|para|pra))?\\s+(?!de\\s+\\d)(?!economia)([a-zà-ú][a-zà-ú ]{1,40}?)${stop}`),
    new RegExp(`\\b(?:para|pra)\\s+(?:a\\s+|o\\s+|uma\\s+|um\\s+|minha\\s+|meu\\s+)?(?:comprar\\s+(?:a\\s+|o\\s+|uma\\s+|um\\s+)?|fazer\\s+(?:a\\s+|uma\\s+)?|trocar\\s+(?:de\\s+|o\\s+|a\\s+)?)?([a-zà-ú][a-zà-ú ]{1,40}?)${stop}`),
  ];
  for (const re of pats) {
    const m = re.exec(lower);
    if (!m) continue;
    const name = m[1].trim();
    if (/^(o|a|os|as|mim|nos|guardar|juntar|janeiro|fevereiro|marco|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|fim|final)$/.test(norm(name))) continue;
    return capitalize(name);
  }
  return undefined;
}

/** Recorrência: "todo dia 10", "quinto dia útil", "toda semana", "todo ano" */
export function parseRecurrence(n: string): { frequencia: "mensal" | "semanal" | "anual"; dia?: number; dia_util?: number } {
  if (/\b(toda semana|semanal|semanalmente|por semana|toda (segunda|terca|quarta|quinta|sexta|sabado|domingo))\b/.test(n)) return { frequencia: "semanal" };
  if (/\b(todo ano|anual|anualmente|por ano)\b/.test(n)) return { frequencia: "anual" };
  let m = n.match(/\b(primeiro|segundo|terceiro|quarto|quinto|sexto|setimo|oitavo|nono|decimo|\d{1,2})[oº]? dia util\b/);
  if (m) return { frequencia: "mensal", dia_util: ORD_N[m[1]] ?? Number(m[1]) };
  m = n.match(/\b(?:todo )?dia (\d{1,2})\b/);
  if (m) return { frequencia: "mensal", dia: Number(m[1]) };
  return { frequencia: "mensal" };
}

function matchAccount(text: string, ctx: UserContext): string | undefined {
  const n = norm(text);
  return ctx.contas
    .filter((c) => wb(norm(c)).test(n))
    .sort((a, b) => b.length - a.length)[0];
}

const ESTAB_SKIP = new Set(["cartao", "credito", "debito", "pix", "dinheiro", "especie", "boleto", "conta", "mes", "dia", "semana",
  "ano", "total", "valor", "vezes", "parcela", "parcelas", "vista", "final", "fim", "ultimo", "ultima", "mais", "meu", "minha", "casa", "almoco", "jantar", "janta", "lanche", "cafe da manha"]);
const ESTAB_STOP = new Set(["ontem", "hoje", "anteontem", "de", "do", "da", "dos", "das", "com", "por", "pra", "para", "pro", "e", "no", "na",
  "em", "reais", "real", "r$", "as", "a", "o", "que", "pelo", "pela", "via", "mas", "esse", "este", "essa", "esta", "semana", "mes", "agora"]);

/** "gastei 100 no Posto ABC" -> "Posto ABC" (com a grafia original). */
export function extractEstablishment(text: string, ctx?: UserContext): string | undefined {
  const lower = text.toLowerCase();
  const re = /(?:^|\s)(?:no|na|nos|nas|em|pelo|pela|ao)\s+([^\s,.!?;]+(?:\s+[^\s,.!?;]+){0,4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const words = m[1].split(/\s+/);
    const first = norm(words[0]);
    if (ESTAB_SKIP.has(first) || /^\d/.test(first) || first === "r$") continue;
    const kept: string[] = [];
    for (const w of words) {
      const nw = norm(w);
      if (ESTAB_STOP.has(nw) || /^\d/.test(nw) || nw === "r$") break;
      kept.push(w);
    }
    if (!kept.length) continue;
    const start = m.index + m[0].indexOf(m[1]);
    const phrase = text.slice(start, start + kept.join(" ").length);
    if (ctx && [...ctx.contas, ...(ctx.cartoes ?? [])].some((c) => norm(c) === norm(phrase) || norm(c).split(" ").includes(norm(phrase)))) continue; // é uma conta, não um estabelecimento
    return phrase === phrase.toLowerCase() ? capitalize(phrase) : phrase;
  }
  return undefined;
}

const GENERIC = new Set(["gasto", "despesa", "compra", "coisa", "coisas", "conta", "receita", "valor", "pagamento", "dinheiro", "pix"]);

/** Objeto da compra/recebimento: "comprei uma TV" -> "TV"; "paguei 200 de gasolina" -> "Gasolina". */
export function extractObject(text: string): string | undefined {
  const lower = text.toLowerCase();
  const stop = "(?=\\s+(?:de|por|no|na|nos|nas|em|com|pra|para|pelo|pela|ontem|hoje|anteontem|todo|toda|todos|por|r\\$|\\d|e\\s)|\\s*[.,!?]|\\s*$)";
  const patterns = [
    new RegExp(`(?:^|\\s)(?:comprei|paguei|assinei|recebi|pedi|renovei)\\s+(?:(?:uma|um|os|as|o|a|meus|minhas|meu|minha)\\s+)?([a-zà-ú][a-zà-ú ]{1,40}?)${stop}`),
    new RegExp(`(?:\\d[\\d.,]*|reais|real|mil|contos?)\\s+(?:de|em|com)\\s+(?:(?:uma|um|o|a)\\s+)?([a-zà-ú][a-zà-ú ]{1,40}?)(?=\\s+(?:no|na|em|ontem|hoje|anteontem|pelo|pela|com|e|todo|toda|todos|por|\\d)\\b|\\s*[.,!?]|\\s*$)`),
  ];
  for (const re of patterns) {
    const m = re.exec(lower);
    if (!m) continue;
    let obj = m[1].trim();
    if (GENERIC.has(norm(obj)) && !/^conta\b/.test(norm(obj))) continue;
    let start = m.index + m[0].lastIndexOf(m[1]);
    // "conta de luz", "conta de água"
    const after = lower.slice(start + obj.length);
    const ext = /^\s+de\s+([a-zà-ú]+)/.exec(after);
    if (norm(obj) === "conta" && ext) obj = `${obj}${ext[0]}`;
    if (norm(obj) === "conta" || GENERIC.has(norm(obj))) continue;
    if (/^(salario|meu salario)$/.test(norm(obj))) return "Salário";
    const orig = text.slice(start, start + obj.length);
    return orig === orig.toLowerCase() ? capitalize(orig) : orig;
  }
  return undefined;
}

function paymentMethod(n: string): string | undefined {
  if (/\bpix\b/.test(n)) return "pix";
  if (/\bdebito\b/.test(n)) return "debito";
  if (/\b(credito|cartao)\b/.test(n)) return "credito";
  if (/\bboleto\b/.test(n)) return "boleto";
  if (/\b(dinheiro|especie|a vista em dinheiro)\b/.test(n)) return "dinheiro";
  return undefined;
}

const RX = {
  greetingOnly: /^(oi+|ola|bom dia|boa tarde|boa noite|e ai|opa|hey|eai|tudo bem|tudo bom)[\s!.?,]*(assistente)?[\s!.?]*$/,
  greetingPrefix: /^(bom dia|boa tarde|boa noite|oi+|ola|opa)[\s,!.]+/,
  help: /\b(ajuda|help|o que (voce|vc) (faz|sabe|pode)|como (funciona|usar|te uso|uso)|comandos|menu)\b/,
  thanks: /^(obrigad[oa]|valeu|vlw|brigad[oa]|show|beleza|ok|certo|blz|top)[\s!.]*$/,
  delete: /\b(apag\w*|exclu\w*|delet\w*|remov\w*|desfaz\w*|desfazer)\b/,
  correct: /\b(corrig\w*|corrij\w*|mud[ae]r?|alter[ae]r?|troc[ae]r?|na verdade|errei|era pra ser|nao era|o certo e|o correto e)\b/,
  question: /\?\s*$|^(quanto|quantos|quantas|qual|quais|como|onde|estou|to |ta |posso|da pra|consigo|tenho|me (mostra|mostre|diga|fala|passa)|mostra|mostre|resumo|compare|compara|saldo|extrato|relatorio|analis)/,
  income: /\b(recebi|recebo|recebemos|ganhamos|ganhei|ganho|entrou|entraram|entra|caiu|cairam|cai|vendi|faturei|depositaram|me pagaram|me pagou|me pagam|me transferiram|me mandaram)\b/,
  expense: /\b(gastei|gasto|gastamos|paguei|pago|pagamos|comprei|compramos|pedimos|abastecemos|custou|custa|custam|saiu|sairam|torrei|desembolsei|assinei|abasteci|almocei|jantei|pedi|fiz uma compra|tive um gasto|tive uma despesa|despesa de|gasto de)\b/,
  investment: /\b(investi|apliquei|aportei|aporte de|guardei|coloquei na poupanca|coloquei no investimento)\b/,
  redemption: /\b(resgatei|resgate de|saquei da poupanca|tirei da poupanca|tirei do investimento)\b/,
  transfer: /\b(transferi|transferencia|passei|movi|mandei|enviei)\b/,
  recurring: /\b(todo mes|todos os meses|mensal|mensalmente|por mes|todo dia \d{1,2}|toda semana|todo (primeiro|segundo|terceiro|quarto|quinto|\d{1,2}o?) dia util|toda segunda|toda sexta)\b/,
};

const FAMILY_WORDS = /\b(gastamos|pagamos|compramos|recebemos|ganhamos|investimos|pedimos|abastecemos|da familia|pra familia|para a familia|para familia|da casa|pra casa|nosso|nossa|nossos|nossas|a gente|compartilhad\w*)\b/;

/** De quem é a consulta: 'eu' -> id da pessoa, outra pessoa da família, ou 'familia' (só compartilhados). */
export function detectMember(n: string, ctx: UserContext): string | undefined {
  const membros = ctx.membros ?? [];
  if (membros.length < 2) return undefined;
  if (/\b(compartilhad\w*|so da familia|somente da familia|gastos? (comuns|da casa))\b/.test(n)) return "familia";
  if (/\b(eu gastei|eu recebi|eu paguei|meus gastos|minhas despesas|minhas receitas|meu gasto|meus ganhos|so eu|somente eu|apenas eu|individual|so meus|so minhas|gastei sozinh\w)\b/.test(n)) return ctx.eu;
  const others = membros.filter((m) => !m.eu);
  for (const m of others) {
    const first = norm(m.nome).split(" ")[0];
    if (first.length >= 2 && new RegExp(`(^|[^a-z])${first}([^a-z]|$)`).test(n)) return m.id;
  }
  if (others.length === 1 && /\b(minha esposa|minha mulher|meu marido|minha companheira|meu companheiro|minha namorada|meu namorado|ela gastou|ele gastou|ela recebeu|ele recebeu)\b/.test(n)) return others[0].id;
  return undefined;
}

function detectQuery(n: string, text: string, ctx: UserContext): Partial<Interpretation> | null {
  const isQ = RX.question.test(n) || /\bquanto\b/.test(n) || /^(compare|compara|comparar)/.test(n);
  if (!isQ) return null;
  const today = ctx.hoje;
  const periodo = resolvePeriod(text, today);
  const amount = extractAmount(text);
  const membro_id = detectMember(n, ctx);
  const q = (intent: Intent, consulta?: QueryKind, extra: Partial<Interpretation> = {}): Partial<Interpretation> =>
    ({ intent, consulta, periodo, confidence: 0.9, membro_id, ...extra });

  if (/\b(posso|da pra|consigo|devo) (comprar|gastar com|pagar)\b|\bcabe no (meu )?orcamento\b/.test(n) && amount.valor)
    return q("FINANCIAL_ANALYSIS", "posso_comprar", { valor: amount.valor });
  if (/\bquanto (ainda )?(eu )?posso gastar\b|\bposso gastar quanto\b|\blimite (de gastos?|diario)\b|\bquanto (ainda )?posso\b/.test(n))
    return q("FINANCIAL_ANALYSIS", "disponivel");
  if (/\bdisponivel\b|\bsobra(ndo)?\b|\bsobrou\b/.test(n) && !/\blimite\b/.test(n)) return q("FINANCIAL_ANALYSIS", "disponivel");
  if (/\bsaldo\b|\bquanto (eu )?tenho\b|\btenho quanto\b|\bquanto (de )?dinheiro\b/.test(n))
    return q("QUERY_BALANCE", "saldo", { conta: matchAccount(text, ctx) });
  if (/\bparcela/.test(n)) {
    const p = /\b(proximo mes|mes que vem)\b/.test(n) || !/\b(mes passado|este mes|esse mes|neste mes)\b/.test(n)
      ? resolvePeriod("próximo mês", today) : periodo;
    return q("QUERY_EXPENSES", "parcelas", { periodo: /\b(proximo mes|mes que vem|este mes|esse mes|neste mes|mes passado)\b/.test(n) ? periodo : p });
  }
  if (/\b(alertas?|avisos?)\b/.test(n)) return q("QUERY_ALERTS");
  if (/\b(contas fixas|gastos fixos|despesas fixas|recorrencias|recorrentes|assinaturas|debitos automaticos)\b/.test(n)) return q("QUERY_RECURRING");
  const cartao = matchCard(text, ctx);
  if (/\b(fatura|cartao|cartoes|limite do|limite disponivel)\b/.test(n) || (cartao && /\b(fatura|limite|devo)\b/.test(n))) {
    const consulta: QueryKind = /\blimite\b/.test(n) ? "limite" : /\b(meus cartoes|quais cartoes|cartoes)\b/.test(n) && !/fatura/.test(n) ? "cartoes" : "fatura";
    return q("QUERY_CARD", consulta, { cartao, periodo: /\b(proxima|que vem|proximo mes)\b/.test(n) ? resolvePeriod("próximo mês", today) : undefined });
  }
  if (/\borcamento/.test(n)) return q("QUERY_BUDGET");
  if (/\bmetas?\b/.test(n) || (matchGoal(text, ctx) && /\b(falta|quanto|como esta|progresso)\b/.test(n))) return q("QUERY_GOAL", undefined, { meta: matchGoal(text, ctx) });
  if (/\bcompar(e|a|ar|ando|ado|acao|ativo)\b|\bem relacao ao\b|\bversus\b|\bvs\b/.test(n)) return q("QUERY_REPORT", "comparar");
  if (/\b(gastando|gastei|gasto) (demais|muito|d+emais)\b|\bexagerando\b|\bto bem\b|\bestou bem\b/.test(n))
    return q("FINANCIAL_ANALYSIS", "gastando_demais");
  if (/\bcomo (estao|esta|estou|vao|vai|anda|andam|ficou|ficaram)\b.*\b(financas|contas|gastos|dinheiro|financeiro|mes|vida financeira)\b|\bresumo\b|\bsituacao\b|\bbalanco\b|\banalise\b|\banalisa\b/.test(n))
    return q("FINANCIAL_ANALYSIS", "resumo");

  const isIncome = /\b(recebi|recebeu|recebemos|receitas?|ganhei|ganhou|ganhamos|entrou|entraram|faturei|vendi|vendas)\b/.test(n);
  const tipo = isIncome ? "receita" : "despesa";
  if (/\bmaior(es)? (despesa|gasto|compra|receita|entrada)|\bmais caro\b|\bgastei mais\b/.test(n))
    return q(isIncome || /maior receita|maior entrada/.test(n) ? "QUERY_INCOME" : "QUERY_EXPENSES", "maior",
      { tipo: /maior (receita|entrada)/.test(n) ? "receita" : "despesa" });

  const uc = matchUserCategory(text, ctx, tipo);
  const est = extractEstablishment(text, ctx);
  const properName = est && /[A-Z0-9]/.test(est.slice(1));
  const guess = uc ? null : guessCategory(text, tipo);
  if (properName) return q("QUERY_CATEGORY", "total", { tipo, estabelecimento: est });
  if (uc || guess) {
    return q(isIncome ? "QUERY_INCOME" : "QUERY_CATEGORY", "total", {
      tipo, categoria: uc?.categoria ?? guess!.categoria, subcategoria: uc?.subcategoria ?? guess?.subcategoria,
    });
  }
  if (est) return q("QUERY_CATEGORY", "total", { tipo, estabelecimento: est });
  if (isIncome) return q("QUERY_INCOME", "total", { tipo: "receita" });
  if (/\b(gast\w*|despesas?|paguei|pagou|pagamos|comprei|comprou|compramos|saiu|sairam)\b/.test(n)) return q("QUERY_EXPENSES", "total", { tipo: "despesa" });
  if (/\bconta\b/.test(n) && matchAccount(text, ctx)) return q("QUERY_BALANCE", "saldo", { conta: matchAccount(text, ctx) });
  return null;
}

export function interpretRules(input: string, ctx: UserContext): Interpretation {
  let text = input.trim().replace(/^(ei\s+|oi\s+)?assistente[,:!\s]+/i, "");
  let n = norm(text);
  const out: Interpretation = { intent: "OTHER", confidence: 0.3, provider: "regras" };

  if (RX.greetingOnly.test(n)) return { ...out, intent: "GREETING", confidence: 0.95 };
  if (RX.thanks.test(n)) return { ...out, intent: "GREETING", confidence: 0.9 };
  const g = n.match(RX.greetingPrefix);
  if (g) {
    out.saudacao = capitalize(g[1].startsWith("oi") ? "oi" : g[1]);
    text = text.slice(g[0].length);
    n = norm(text);
  }
  if (RX.help.test(n) && n.length < 60) return { ...out, intent: "HELP", confidence: 0.9 };

  const today = ctx.hoje;
  const amount = extractAmount(text);
  const tipoFiltro = /\b(despesa|gasto)\b/.test(n) ? "despesa" : /\b(receita|entrada)\b/.test(n) ? "receita" : undefined;

  // Apagar
  if (RX.delete.test(n) && (/\b(lancamento|despesa|receita|gasto|registro|ultim[oa]|isso|esse|essa|anterior|compra)\b/.test(n) || n.split(" ").length <= 3)) {
    return { ...out, intent: "DELETE_TRANSACTION", tipo: tipoFiltro, confidence: 0.9 };
  }

  // Corrigir
  if (RX.correct.test(n) && !RX.question.test(n)) {
    const kind = tipoFiltro as "despesa" | "receita" | undefined;
    const uc = matchUserCategory(text.replace(/\b(despesa|receita|lan[cç]amento)\b/gi, ""), ctx, kind);
    const guess = uc ? null : guessCategory(text, kind);
    const date = resolveDate(text, today);
    const base = { ...out, tipo: tipoFiltro as Interpretation["tipo"], confidence: 0.85 };
    if (/\bcategoria\b/.test(n) || uc || (guess && !amount.valor)) {
      if (uc || guess) {
        return { ...base, intent: "CORRECT_CATEGORY", campo_correcao: "categoria",
          categoria: uc?.categoria ?? guess!.categoria, subcategoria: uc?.subcategoria ?? guess?.subcategoria };
      }
      return { ...base, intent: "CORRECT_CATEGORY", campo_correcao: "categoria" };
    }
    if (amount.valor) return { ...base, intent: "EDIT_TRANSACTION", campo_correcao: "valor", valor: amount.valor, alternativas: amount.alternativas };
    if (date.explicita) return { ...base, intent: "EDIT_TRANSACTION", campo_correcao: "data", data: date.data };
    if (/\bconta\b/.test(n) && matchAccount(text, ctx)) return { ...base, intent: "EDIT_TRANSACTION", campo_correcao: "conta", conta: matchAccount(text, ctx) };
    return { ...base, intent: "EDIT_TRANSACTION" };
  }

  // Consultas
  // Cancelar recorrência: "não pago mais a Netflix", "cancela a assinatura do Spotify"
  if (/\b(parei de pagar|nao pago mais|nao vou mais pagar|cancel\w* (a |o )?(assinatura|recorrencia|conta fixa|debito automatico)|encerr\w* (a |o )?(assinatura|recorrencia|conta fixa)|cancelei (a |o )?)\b/.test(n) && !amount.valor) {
    const desc = text.replace(/^.*?\b(?:parei de pagar|n[aã]o pago mais|n[aã]o vou mais pagar|cancel\w*|encerr\w*)\s+(?:(?:a|o)\s+)?(?:(?:assinatura|recorr[eê]ncia|conta fixa|d[eé]bito autom[aá]tico)\s*(?:d[aeo]s?\s+)?)?/i, "").replace(/[.!?]+$/, "").trim();
    return { ...out, intent: "CANCEL_RECURRING", descricao: desc || undefined, confidence: 0.88 };
  }
  // Pagar fatura: "paguei a fatura do Nubank", "paguei o cartão"
  if (/\b(paguei|pago|quitei|pagar|vou pagar|paga)\b/.test(n) && (/\bfatura\b/.test(n) || /\b(paguei|quitei|pagar) (o |meu )?cartao\b/.test(n)) && !RX.question.test(n)) {
    const contaPg = /\b(da|pela|na|com a) conta\b|\bcom (o )?saldo\b|\bdebit\w*\b|\bpelo pix\b/.test(n) ? matchAccount(text.replace(/\bfatura d[oa]s? \S+/i, ""), ctx) : undefined;
    return { ...out, intent: "PAY_INVOICE", cartao: matchCard(text, ctx), valor: amount.valor, conta: contaPg,
      data: resolveDate(text, today).data, confidence: 0.9 };
  }
  // Aporte em meta: "guardei 500 na meta viagem", "tirei 200 da reserva"
  const metaNome = matchGoal(text, ctx);
  if (amount.valor && /\b(guardei|coloquei|depositei|separei|juntei|aportei|adicionei|poupei|economizei|tirei|retirei|saquei|usei|resgatei)\b/.test(n)
      && (/\bmeta\b/.test(n) || metaNome)) {
    const saida = /\b(tirei|retirei|saquei|usei|resgatei)\b/.test(n);
    return { ...out, intent: "GOAL_CONTRIBUTE", meta: metaNome ?? goalName(text), valor: saida ? -amount.valor : amount.valor,
      data: resolveDate(text, today).data, confidence: 0.9 };
  }
  // Nova meta: "quero juntar 20 mil até dezembro para a viagem"
  if (/\b(quero juntar|quero guardar|quero economizar|quero poupar|preciso juntar|criar (uma )?meta|nova meta|minha meta e|meta de \d)\b/.test(n) && !RX.question.test(n)) {
    return { ...out, intent: "CREATE_GOAL", valor: amount.valor, meta: goalName(text), prazo: parseDeadline(n, today), confidence: 0.88 };
  }
  // Orçamento: "orçamento de 1000 para alimentação", "quero gastar no máximo 600 com transporte"
  if (amount.valor && !RX.question.test(n) && /\b(orcamento|limite de gastos?|limite (de|para) (gastar|gasto)|gastar no maximo|gastar ate)\b/.test(n) && !/\bcartao\b/.test(n)) {
    const uc = matchUserCategory(text, ctx, "despesa");
    const g = uc ? null : guessCategory(text, "despesa");
    return { ...out, intent: "CREATE_BUDGET", valor: amount.valor, categoria: uc?.categoria ?? g?.categoria, confidence: 0.88 };
  }

  const query = detectQuery(n, text, ctx);
  const hasCreateVerb = RX.expense.test(n) || RX.income.test(n);
  if (query && !(hasCreateVerb && amount.valor && !RX.question.test(n) && !/\bquanto\b/.test(n))) {
    return { ...out, ...query } as Interpretation;
  }

  // Metas e orçamentos (Fase 2)

  // Lançamentos
  let intent: Intent | null = null;
  let tipo: Interpretation["tipo"];
  let conta: string | undefined, contaDestino: string | undefined;

  if (RX.redemption.test(n)) { intent = "CREATE_REDEMPTION"; tipo = "resgate"; }
  else if (RX.investment.test(n)) { intent = "CREATE_INVESTMENT"; tipo = "investimento"; }
  else if (RX.transfer.test(n) && /\b(para|pra|pro)\b/.test(n)) {
    const dest = text.match(/\b(?:para|pra|pro)\s+(?:a|o|minha|meu)?\s*([^\s,.!?]+(?:\s+[^\s,.!?]+){0,2})/i);
    const orig = text.match(/\b(?:do|da|de)\s+(?:minha|meu)?\s*([^\s,.!?]+(?:\s+[^\s,.!?]+){0,2})\s+(?:para|pra|pro)\b/i);
    const findAcc = (s?: string) => s ? ctx.contas.find((c) => norm(s).startsWith(norm(c)) || norm(c) === norm(s.split(" ")[0])) : undefined;
    contaDestino = findAcc(dest?.[1]);
    conta = findAcc(orig?.[1]);
    if (contaDestino || /\b(para|pra) (a |minha )?(poupanca|conta)\b/.test(n)) {
      intent = "CREATE_TRANSFER"; tipo = "transferencia";
      if (!contaDestino) contaDestino = dest?.[1];
    }
  }
  if (!intent) {
    if (RX.income.test(n) && !/\b(paguei|gastei|comprei)\b/.test(n)) { intent = "CREATE_INCOME"; tipo = "receita"; }
    else if (RX.expense.test(n) || RX.transfer.test(n)) { intent = "CREATE_EXPENSE"; tipo = "despesa"; }
  }
  const recurring = RX.recurring.test(n);

  // Sem verbo: "padaria 50", "uber 23,90"
  let verbless = false;
  if (!intent && amount.valor) {
    const gc = guessCategory(text) ?? null;
    const uc = matchUserCategory(text, ctx);
    if (gc || uc) {
      const kind = gc?.tipo ?? ctx.categorias.find((c) => c.nome === uc?.categoria)?.tipo ?? "despesa";
      intent = kind === "receita" ? "CREATE_INCOME" : "CREATE_EXPENSE"; tipo = kind; verbless = true;
    }
  }
  if (!intent) return out;
  if (recurring && (tipo === "despesa" || tipo === "receita")) intent = "CREATE_RECURRING";

  const date = resolveDate(text, today, !recurring);
  // compra no cartão: nome do cartão citado; se o mesmo nome também é conta, só vale como cartão com "cartão/crédito"
  let cartao: string | undefined;
  if (tipo === "despesa") {
    const cc = matchCard(text, ctx);
    const mencionaCartao = /\b(cartao|credito)\b/.test(n);
    if (cc && (mencionaCartao || !matchAccount(text, ctx))) cartao = cc;
  }
  const rec = recurring ? parseRecurrence(n) : undefined;
  const res: Interpretation = {
    ...out,
    intent,
    tipo,
    valor: amount.valor,
    alternativas: amount.alternativas,
    parcelas: amount.parcelas,
    data: date.data,
    data_explicita: date.explicita,
    recorrente: recurring,
    forma_pagamento: paymentMethod(n),
    familia: (ctx.membros?.length ?? 0) > 1 && FAMILY_WORDS.test(n) ? true : undefined,
    conta: conta ?? (tipo !== "transferencia" && !cartao ? matchAccount(text, ctx) : undefined),
    cartao,
    frequencia: rec?.frequencia, dia: rec?.dia, dia_util: rec?.dia_util,
    conta_destino: contaDestino,
    confidence: verbless ? 0.7 : amount.valor ? 0.92 : 0.8,
  };

  if (tipo === "despesa" || tipo === "receita") {
    res.estabelecimento = extractEstablishment(text, ctx);
    res.descricao = extractObject(text) ?? res.estabelecimento;
    const uc = matchUserCategory(text, ctx, tipo);
    const gc = guessCategory(text, tipo);
    if (gc && (!uc || (uc.categoria === gc.categoria && !uc.subcategoria))) {
      res.categoria = gc.categoria; res.subcategoria = gc.subcategoria; res.categoria_confianca = gc.confianca;
    } else if (uc) {
      res.categoria = uc.categoria; res.subcategoria = uc.subcategoria; res.categoria_confianca = 0.95;
    }
    if (res.descricao && res.conta && norm(res.descricao) === norm(res.conta)) res.descricao = undefined;
    if (res.descricao && res.cartao && norm(res.cartao).includes(norm(res.descricao))) res.descricao = undefined;
    // sem verbo ("netflix 55,90 todo dia 15", "mercado 20"): as palavras antes do valor viram a descrição
    if (!res.descricao) {
      const lead = text.match(/^\s*([A-Za-zÀ-ú][A-Za-zÀ-ú ]{1,30}?)\s+(?:r\$\s*)?\d/i);
      if (lead && !RX.expense.test(norm(lead[1])) && !RX.income.test(norm(lead[1])) && !/^(minha|meu|o|a)$/i.test(lead[1].trim())) {
        const w = lead[1].trim().replace(/^(minha|meu|a|o)\s+/i, "").replace(/\s+(custa|custou|de|por|e)$/i, "");
        if (w) res.descricao = capitalize(w);
      }
    }
  }
  return res;
}
