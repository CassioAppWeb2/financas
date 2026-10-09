// Investimentos no assistente: indicadores do dia, simulações e explicações.
// REGRA FIXA: o app NUNCA recomenda, escolhe, ordena como "melhor" ou indica investimento.
// Ele só apresenta informações e simulações; a decisão é sempre da pessoa.

import { fold } from "./naming.ts";
import { findAmounts } from "./money.ts";
import { brl } from "./text.ts";
import type { Mercado } from "./mercado.ts";
import { simInputs } from "./mercado.ts";
// @ts-ignore módulo JS compartilhado com a tela do app
import { PRODUTOS, simular, PREMISSAS, AVISO, fmtPct } from "../../../web/js/simulador.js";

export { AVISO };
export const AVISO_CURTO = "ℹ️ Informação educativa, não é recomendação de investimento. A decisão é sua.";

const pctBR = (v: number, casas = 2) => fmtPct(v, casas) as string;
const dBR = (iso?: string | null) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}${iso.slice(0, 4) !== String(new Date().getFullYear()) ? "/" + iso.slice(0, 4) : ""}` : "";
const mesBR = (iso?: string | null) => {
  if (!iso) return "";
  const m = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(iso.slice(5, 7)) - 1];
  return `${m}/${iso.slice(2, 4)}`;
};

// ---------------------------------------------------------------------------
// O que a pessoa está perguntando
// ---------------------------------------------------------------------------
const IND_WORDS: Record<string, RegExp> = {
  selic: /\bselic\b|juros basicos|taxa basica/,
  cdi: /\bcdi\b/,
  ipca: /\bipca\b|inflacao/,
  igpm: /\bigp-?m\b/,
  poupanca: /\bpoupanca\b/,
  dolar: /\bdolar\b|\bdolares\b/,
  euro: /\beuro\b|\beuros\b/,
  tr: /\btr\b|taxa referencial/,
};

/** Pedido de recomendação / escolha (que o app NÃO faz). */
const ADVICE = /\b(onde (?:devo|posso|eu|vale|e melhor) (?:investir|aplicar|colocar|deixar)|qual (?:o |a |e o |e a )?(?:melhor|mais (?:rentavel|seguro|vantajos))|(?:melhor|melhores) (?:investimento|aplicacao|opcao|acao|acoes|fundo|cdb|banco|corretora|lugar)|devo (?:investir|aplicar|comprar|vender|resgatar|sacar|tirar|trocar|colocar)|vale (?:a pena|mais) (?:investir|aplicar|comprar|vender|deixar|colocar|trocar)|vale a pena (?:o|a|os|as)?\s*(?:cdb|lci|lca|tesouro|poupanca|acao|acoes|fii|dolar|bitcoin|cripto|fundo)|(?:me )?(?:recomenda|indica|sugere)\w*|o que (?:voce )?(?:acha|sugere|recomenda|indica) (?:de|que|sobre|eu)|(?:em que|no que|onde) (?:investir|aplico|invisto|coloco)|qual investimento|compro (?:dolar|euro|acoes|acao|bitcoin|cripto|ouro)|e hora de (?:comprar|vender|investir)|(?:vai|vao) (?:subir|cair)|(?:quanto|qual) (?:vai|deve) (?:ficar|estar|ser) (?:o|a) (?:dolar|selic|bolsa|ibovespa|cdi|inflacao))\b/;
const INVEST_CTX = /\b(invest|aplic|cdb|lci|lca|\blc\b|rdb|tesouro|poupanca|acao|acoes|bolsa|fii|fundo|cripto|bitcoin|dolar|euro|ouro|renda fixa|renda variavel|previdencia|debenture|cri|cra|selic|cdi|ipca|dinheiro parado|reserva)\w*/;

const SIM = /\b(simul\w*|quanto (?:rende|renderia|vai render|rendem|da|daria|teria|vou ter|terei|fica|ficaria)|rende quanto|renderia|rendimento de)\b/;

export type InvestKind = "advice" | "simulate" | "indicators" | "explain" | null;

export function classifyInvest(text: string): InvestKind {
  const f = fold(text);
  if (ADVICE.test(f) && INVEST_CTX.test(f)) return "advice";
  if (SIM.test(f) && (INVEST_CTX.test(f) || /\b\d+[.,]?\d*\s*%/.test(f))) return "simulate";
  if (explainTopic(text)) return "explain";
  // perguntas sobre o próprio dinheiro ("quanto tenho na poupança?") são do app, não do mercado
  if (/\b(gastei|gastamos|gasto|gastos|recebi|paguei|tenho|temos|saldo|fatura|lancei|lancamento|minha|meu|minhas|meus|nossa|nosso|conta)\b/.test(f)) return null;
  const asksInd = Object.values(IND_WORDS).some((r) => r.test(f)) || /\bindicadores?\b|\bmercado financeiro\b|\bcotac/.test(f);
  if (asksInd && (/\?|^(qual|quanto|como (?:esta|anda|ta)|me (?:mostra|passa|diz)|mostra|ver|valor|cotacao|taxa)/.test(f.trim()) || /\b(hoje|agora|atual|esta|ta)\b/.test(f) || f.trim().split(/\s+/).length <= 3)) return "indicators";
  return null;
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------
export function indicatorsReply(m: Mercado, text = ""): string {
  const I = m.indicadores ?? {};
  if (!Object.keys(I).length) return "Não consegui buscar os indicadores agora. Tente de novo em alguns minutos.";
  const f = fold(text);
  const want = Object.entries(IND_WORDS).filter(([, r]) => r.test(f)).map(([k]) => k);
  const all = !want.length || /\bindicadores?\b|mercado/.test(f);
  const line = (k: string) => {
    switch (k) {
      case "selic": return I.selic && `• *Selic (meta)*: ${pctBR(I.selic.valor)} ao ano${I.selic.anterior != null && I.selic.anterior !== I.selic.valor ? ` (antes ${pctBR(I.selic.anterior)})` : ""}`;
      case "cdi": return I.cdi && `• *CDI*: ${pctBR(I.cdi.valor)} ao ano`;
      case "ipca": return I.ipca_12m && `• *IPCA (inflação)*: ${pctBR(I.ipca_12m.valor)} em 12 meses (até ${mesBR(I.ipca_12m.data)})${I.ipca_mes ? `; ${pctBR(I.ipca_mes.valor)} em ${mesBR(I.ipca_mes.data)}` : ""}`;
      case "igpm": return I.igpm_mes && `• *IGP-M*: ${pctBR(I.igpm_mes.valor)} em ${mesBR(I.igpm_mes.data)}`;
      case "poupanca": return I.poupanca && `• *Poupança*: ${pctBR(I.poupanca.valor, 4)} no mês (depósitos com aniversário em ${dBR(I.poupanca.data)})`;
      case "tr": return I.tr && `• *TR*: ${pctBR(I.tr.valor, 4)} no mês`;
      case "dolar": return I.dolar && `• *Dólar*: ${brl(Math.round(I.dolar.valor * 100))}${varTxt(I.dolar)} (${dBR(I.dolar.data)})`;
      case "euro": return I.euro && `• *Euro*: ${brl(Math.round(I.euro.valor * 100))}${varTxt(I.euro)} (${dBR(I.euro.data)})`;
    }
    return null;
  };
  const keys = all ? ["selic", "cdi", "ipca", "poupanca", "dolar", "euro", "igpm"] : want;
  const lines = keys.map(line).filter(Boolean);
  const quando = m.atualizado_em ? new Date(m.atualizado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  return `📈 *Indicadores*\n${lines.join("\n")}\n\nFonte: Banco Central do Brasil${quando ? ` · atualizado ${quando}` : ""}.\nQuer simular? Ex.: “quanto rende 10 mil no CDB 100% do CDI em 1 ano?”\n${AVISO_CURTO}`;
}
function varTxt(x: { valor: number; historico: { data: string; valor: number }[] }) {
  const h = x.historico ?? [];
  const ref = h.length > 22 ? h[h.length - 22] : h[0];
  if (!ref || !ref.valor) return "";
  const v = (x.valor / ref.valor - 1) * 100;
  return ` (${v >= 0 ? "+" : ""}${pctBR(v)} em ~30 dias)`;
}

/** Entende o pedido de simulação. */
export function parseSimulation(text: string) {
  const f = fold(text);
  const produtos: any[] = [];
  const pctNear = (re: RegExp) => { const m = re.exec(f); return m ? Number(m[1].replace(",", ".")) : undefined; };
  if (/\bpoupanca\b/.test(f)) produtos.push({ ...PRODUTOS.poupanca });
  if (/\b(cdb|rdb|\blc\b|letra de cambio)\b/.test(f) || (/% do cdi/.test(f) && !/\b(lci|lca)\b/.test(f))) {
    produtos.push({ ...PRODUTOS.cdb, nome: /\bcdb\b/.test(f) || !/\b(rdb|lc)\b/.test(f) ? "CDB" : PRODUTOS.cdb.nome, pct: pctNear(/(?:cdb|rdb|\blc\b)[^%]{0,25}?(\d+[.,]?\d*)\s*%/) ?? pctNear(/(\d+[.,]?\d*)\s*%\s*(?:do )?cdi/) ?? 100 });
  }
  if (/\b(lci|lca)\b/.test(f)) produtos.push({ ...PRODUTOS.lci, nome: /\blca\b/.test(f) && !/\blci\b/.test(f) ? "LCA" : /\blci\b/.test(f) && !/\blca\b/.test(f) ? "LCI" : "LCI / LCA", pct: pctNear(/(?:lci|lca)[^%]{0,25}?(\d+[.,]?\d*)\s*%/) ?? 100 });
  if (/tesouro selic|\bselic\b/.test(f) && /tesouro|selic/.test(f) && !/tesouro (pre|ipca)/.test(f)) produtos.push({ ...PRODUTOS.tesouro_selic });
  if (/\b(prefixad\w*|pre-?fixad\w*|tesouro pre)\b/.test(f)) produtos.push({ ...PRODUTOS.prefixado, taxa: pctNear(/(?:prefixad\w*|pre)[^%]{0,25}?(\d+[.,]?\d*)\s*%/) ?? 12, _taxaPadrao: !/(prefixad\w*|pre)[^%]{0,25}?\d+[.,]?\d*\s*%/.test(f) });
  if (/ipca\s*\+|ipca mais|tesouro ipca/.test(f)) produtos.push({ ...PRODUTOS.ipca, taxa: pctNear(/ipca\s*(?:\+|mais)\s*(\d+[.,]?\d*)/) ?? 6, _taxaPadrao: !/ipca\s*(?:\+|mais)\s*\d/.test(f) });

  // prazo
  const NUM: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, doze: 12, quinze: 15, vinte: 20, trinta: 30 };
  let meses = 12;
  const pz = /(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta)\s*(anos?|mes(?:es)?)\b/.exec(f);
  if (pz) { const n = Number(pz[1]) || NUM[pz[1]] || 1; meses = /ano/.test(pz[2]) ? n * 12 : n; }
  else if (/\b(meio ano|seis meses)\b/.test(f)) meses = 6;
  meses = Math.min(Math.max(1, Math.round(meses)), 600);

  // valores (sem os percentuais e o prazo)
  const limpo = text.replace(/\d+[.,]?\d*\s*%/g, " ").replace(/ipca\s*(\+|mais)\s*\d+[.,]?\d*/gi, " ")
    .replace(/(\d+|um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta)\s*(anos?|m[eê]s(es)?)\b/gi, " ");
  const vals = (t: string) => findAmounts(t).filter((a) => a.role === "valor" && a.value > 0).map((a) => a.value);
  let inicial = 0, aporte = 0;
  const mk = /\b(?:por|ao|todo|cada)\s+m[eê]s\b|\bmensa(?:l|is)\b|\bmensalmente\b/i.exec(limpo);
  if (mk) {
    const antes = vals(limpo.slice(0, mk.index));
    aporte = antes.pop() ?? 0;
    inicial = antes[0] ?? vals(limpo.slice(mk.index + mk[0].length))[0] ?? 0;
  } else {
    const v = vals(limpo);
    inicial = v[0] ?? 0;
    if (/\baport/i.test(limpo) && v.length > 1) aporte = v[1];
  }
  return { produtos, meses, inicial, aporte };
}

export function simulationReply(text: string, m: Mercado): string {
  const p = parseSimulation(text);
  if (!p.inicial && !p.aporte) return "Para simular, me diga o valor e o prazo. Ex.: “quanto rende 10 mil no CDB 110% do CDI em 2 anos?” ou “simule 500 por mês na poupança por 3 anos”.";
  const ind = simInputs(m);
  const produtos = p.produtos.length ? p.produtos : [{ ...PRODUTOS.poupanca }, { ...PRODUTOS.cdb, nome: "CDB" }, { ...PRODUTOS.tesouro_selic }];
  const prazo = p.meses % 12 === 0 ? `${p.meses / 12} ${p.meses === 12 ? "ano" : "anos"}` : `${p.meses} ${p.meses === 1 ? "mês" : "meses"}`;
  const head = `🧮 *Simulação* — ${p.inicial ? brl(Math.round(p.inicial * 100)) : ""}${p.inicial && p.aporte ? " + " : ""}${p.aporte ? `${brl(Math.round(p.aporte * 100))} por mês` : ""} por ${prazo}`;
  const blocks = produtos.map((prod: any) => {
    const r: any = simular({ inicial: p.inicial, mensal: p.aporte, meses: p.meses, produto: prod, ind });
    if (r.erro) return `*${prod.nome}*: ${r.erro}`;
    const base = prod.tipo === "cdi" ? ` (CDI ${pctBR(ind.cdi!)} → ${pctBR(r.taxa_aa)} a.a.)`
      : prod.tipo === "selic" ? ` (Selic ${pctBR(ind.selic!)} a.a.)`
      : prod.tipo === "ipca" ? ` (IPCA 12m ${pctBR(ind.ipca12!)} + ${pctBR(prod.taxa)} → ${pctBR(r.taxa_aa)} a.a.)`
      : prod.tipo === "poupanca" ? ` (${pctBR(ind.poupanca_mes!, 4)} ao mês)` : "";
    return `*${r.produto}*${base}${prod._taxaPadrao ? " _(taxa de exemplo — diga a taxa que você viu)_" : ""}\n` +
      `• Investido: ${brl(r.investido_cents)} → bruto ${brl(r.bruto_cents)}\n` +
      `• IR: ${r.isento ? "isento" : `${brl(r.ir_cents)}`} → *líquido ${brl(r.liquido_cents)}* (rendimento ${brl(r.rendimento_liquido_cents)}, ${pctBR(r.rentab_liquida_pct)})`;
  });
  return `${head}\n\n${blocks.join("\n\n")}\n\n_Premissas: taxas de hoje mantidas no prazo todo; sem custódia, IOF ou variação de preço antes do vencimento. São estimativas._\n${AVISO_CURTO}\nVeja e compare mais opções na tela *Mercado*.`;
}

/** Resposta para pedidos de recomendação: o app não escolhe — apresenta informações. */
export function adviceReply(m: Mercado | null): string {
  const I = m?.indicadores ?? {};
  const taxas = [I.selic && `Selic ${pctBR(I.selic.valor)} a.a.`, I.cdi && `CDI ${pctBR(I.cdi.valor)} a.a.`, I.ipca_12m && `IPCA ${pctBR(I.ipca_12m.valor)} em 12 meses`, I.poupanca && `poupança ${pctBR(I.poupanca.valor, 4)} no mês`].filter(Boolean).join(" · ");
  return `🤝 Eu não recomendo, não escolho e não indico investimentos — essa decisão é sempre sua (se quiser uma recomendação personalizada, procure um profissional certificado).

O que posso fazer é te dar informações para você decidir:
• *Comparar com números*: “simule 10 mil por 2 anos na poupança, CDB 110% do CDI e LCI 95% do CDI”.
• *Explicar cada tipo*: “o que é LCI?”, “como funciona o Tesouro IPCA+?”, “diferença entre CDB e LCI”.
• *Pontos para avaliar*: risco e garantia (FGC, Tesouro Nacional), liquidez (quando dá para sacar), prazo, imposto de renda e taxas.
${taxas ? `\nHoje: ${taxas} (Banco Central).` : ""}
${AVISO_CURTO}`;
}

// ---------------------------------------------------------------------------
// Explicações (neutras, sem indicar o que escolher)
// ---------------------------------------------------------------------------
const GLOSSARIO: { re: RegExp; titulo: string; texto: string }[] = [
  { re: /\bpoupanca\b/, titulo: "Poupança", texto: "Aplicação simples em bancos. Rende mensalmente no “aniversário” do depósito: 0,5% ao mês + TR quando a Selic está acima de 8,5% ao ano; abaixo disso, 70% da Selic + TR. Isenta de IR, liquidez diária (mas o rendimento só entra no aniversário). Garantida pelo FGC até o limite legal." },
  { re: /\b(cdb|rdb|letra de cambio|\blc\b)\b/, titulo: "CDB / RDB / LC", texto: "Títulos emitidos por bancos/financeiras: você empresta dinheiro e recebe juros, geralmente um percentual do CDI (ex.: 100% do CDI) ou taxa prefixada. Tem IR regressivo (22,5% a 15%) e garantia do FGC até o limite legal. A liquidez depende do título (diária ou só no vencimento)." },
  { re: /\b(lci|lca)\b/, titulo: "LCI / LCA", texto: "Letras de Crédito Imobiliário/do Agronegócio, emitidas por bancos. Isentas de IR para pessoa física e garantidas pelo FGC até o limite legal. Costumam pagar um percentual do CDI menor que CDBs equivalentes por causa da isenção, e têm carência mínima antes do resgate." },
  { re: /tesouro selic/, titulo: "Tesouro Selic", texto: "Título público (empresta ao governo) que acompanha a taxa Selic. Liquidez diária pelo Tesouro Direto, IR regressivo, pequena variação de preço no dia a dia. Garantia do Tesouro Nacional." },
  { re: /tesouro (pre|prefixado)|\bprefixad/, titulo: "Prefixado", texto: "A taxa é definida na compra (ex.: 12% ao ano) e não muda até o vencimento. Se vender antes, o preço pode estar maior ou menor (marcação a mercado). IR regressivo." },
  { re: /tesouro ipca|ipca ?\+|ipca mais/, titulo: "Tesouro IPCA+ / títulos IPCA+", texto: "Pagam a inflação (IPCA) mais uma taxa fixa (ex.: IPCA + 6% a.a.), preservando o poder de compra. Vender antes do vencimento pode dar ganho ou perda pela marcação a mercado. IR regressivo." },
  { re: /\bcdi\b/, titulo: "CDI", texto: "Taxa de juros dos empréstimos entre bancos, muito próxima da Selic. Serve de referência para a renda fixa: “100% do CDI” significa render o mesmo que essa taxa." },
  { re: /\bselic\b/, titulo: "Selic", texto: "Taxa básica de juros da economia, definida pelo Copom (Banco Central) a cada ~45 dias. Influencia o rendimento da renda fixa e o custo dos empréstimos." },
  { re: /\bipca\b|inflacao/, titulo: "IPCA (inflação)", texto: "Índice oficial de inflação do Brasil, medido pelo IBGE. Mostra quanto os preços subiram; um investimento só aumenta seu poder de compra se render acima dele." },
  { re: /\bigp-?m\b/, titulo: "IGP-M", texto: "Índice de preços da FGV, muito usado para reajustar aluguéis. Varia mais que o IPCA por ser influenciado por preços de atacado e câmbio." },
  { re: /\bfgc\b|fundo garantidor/, titulo: "FGC", texto: "Fundo Garantidor de Créditos: se um banco quebrar, garante CDB, LCI, LCA, LC, RDB e poupança até o limite legal por CPF e por instituição (consulte o valor atualizado no site do FGC). Não cobre Tesouro Direto (que é garantido pelo Tesouro), ações nem fundos." },
  { re: /imposto de renda|\bir\b|tabela regressiva|come-?cotas/, titulo: "Imposto de renda na renda fixa", texto: "Tabela regressiva sobre o rendimento: até 180 dias 22,5%; 181 a 360 dias 20%; 361 a 720 dias 17,5%; acima de 720 dias 15%. Resgates antes de 30 dias também pagam IOF. Poupança, LCI e LCA são isentas para pessoa física." },
  { re: /liquidez/, titulo: "Liquidez", texto: "É a facilidade de transformar o investimento em dinheiro. Liquidez diária: dá para resgatar a qualquer dia. Outros só podem ser resgatados no vencimento ou após uma carência." },
  { re: /reserva de emergencia/, titulo: "Reserva de emergência", texto: "Dinheiro guardado para imprevistos (perda de renda, saúde, conserto). Muitas pessoas consideram alguns meses de gastos e costumam buscar aplicações com liquidez diária e baixo risco — mas o valor e onde guardar dependem da sua situação; a escolha é sua." },
  { re: /\b(acao|acoes|bolsa|ibovespa|renda variavel)\b/, titulo: "Ações / renda variável", texto: "Ações são pedaços de empresas negociados na bolsa (B3). O preço sobe e desce todo dia e pode haver perdas; não há garantia do FGC. Ganhos podem vir da valorização e de dividendos, com regras próprias de IR." },
  { re: /\b(fii|fiis|fundos? imobiliarios?)\b/, titulo: "Fundos imobiliários (FII)", texto: "Fundos negociados na bolsa que investem em imóveis ou títulos do setor. Costumam distribuir rendimentos mensais; as cotas variam de preço e podem ter perdas. Sem garantia do FGC." },
  { re: /\b(fundo|fundos) de investimento|\bfundos?\b/, titulo: "Fundos de investimento", texto: "Você compra cotas e um gestor aplica o dinheiro conforme a política do fundo (renda fixa, multimercado, ações…). Há taxa de administração (e às vezes de performance) e, em vários tipos, o come-cotas. Não têm garantia do FGC." },
  { re: /\b(cripto|bitcoin|criptomoeda)/, titulo: "Criptomoedas", texto: "Ativos digitais com preços muito voláteis, sem garantia do FGC nem do governo. Podem ter fortes altas e quedas em pouco tempo." },
  { re: /\b(tesouro direto)\b/, titulo: "Tesouro Direto", texto: "Programa para pessoas físicas comprarem títulos públicos pela internet, a partir de valores baixos, por meio de uma instituição financeira. Tipos principais: Selic, Prefixado e IPCA+. Garantia do Tesouro Nacional." },
  { re: /\b(previdencia|pgbl|vgbl)\b/, titulo: "Previdência privada (PGBL/VGBL)", texto: "Planos de longo prazo administrados por seguradoras/bancos. PGBL pode deduzir contribuições do IR (declaração completa); VGBL tributa só o rendimento. Há taxas e tabelas de IR (progressiva ou regressiva) a escolher." },
];

function explainTopic(text: string) {
  const f = fold(text);
  if (!/\b(o que (?:e|sao|significa)|como funciona\w*|me explica|explica|diferenca|qual a diferenca|o que quer dizer|significa|entender)\b/.test(f)) return null;
  return GLOSSARIO.filter((g) => g.re.test(f));
}

export function explainReply(text: string): string | null {
  const hits = explainTopic(text);
  if (!hits || !hits.length) return null;
  return `${hits.slice(0, 3).map((h) => `📚 *${h.titulo}*\n${h.texto}`).join("\n\n")}\n\n${AVISO_CURTO}`;
}

// ---------------------------------------------------------------------------
// Trava de segurança na resposta da IA: se ela tentar recomendar, troca pela resposta neutra
// ---------------------------------------------------------------------------
const RECOMENDA = /\b(recomendo|recomendaria|indico|eu indicaria|sugiro (?:que )?(?:voce )?(?:invista|aplique|compre|venda|coloque|escolha|opte|resgate)|minha (?:sugestao|recomendacao|indicacao)|a melhor (?:opcao|escolha|alternativa|aplicacao|investimento)|o melhor investimento|(?:voce )?deveria (?:investir|aplicar|comprar|vender|colocar|escolher|optar|resgatar)|vale mais a pena|compensa mais|e mais vantajoso (?:para|pra) voce|invista (?:em|no|na|nos|nas)|aplique (?:em|no|na|nos|nas)|opte (?:por|pelo|pela)|escolha (?:o|a) (?:cdb|lci|lca|tesouro|poupanca|fundo|acao))\b/;
export function looksLikeAdvice(reply: string): boolean {
  // "não recomendo", "nunca indico", "nem escolho" são justamente o que queremos dizer
  const f = fold(reply).replace(/\b(?:nao|nunca|nem)(?: \w+)?? (?:recomend\w*|indic\w*|sugir\w*|sugiro|sugere|escolh\w*|ordeno)\b/g, " ");
  return RECOMENDA.test(f);
}

export const AGENT_RULES = `REGRAS SOBRE INVESTIMENTOS (obrigatórias, sem exceção):
- Você NUNCA recomenda, sugere, indica, escolhe ou ordena investimentos, produtos, bancos, corretoras, ações, fundos ou criptomoedas. Nunca diga qual é "melhor", "mais vantajoso", "vale a pena" ou o que a pessoa "deveria" fazer, nem em hipótese ou "na sua situação".
- Nunca preveja preços, juros ou câmbio ("vai subir/cair").
- Você APENAS apresenta informações: explica como cada tipo funciona (risco, garantia, liquidez, prazo, imposto), mostra os indicadores oficiais (ferramenta indicadores_mercado) e faz simulações com números (ferramenta simular_investimento). Ao comparar, mostre os números lado a lado sem eleger vencedor.
- Se pedirem recomendação, diga gentilmente que o app não recomenda nem escolhe — a decisão é da pessoa — e ofereça informações e simulações. Para recomendação personalizada, sugira procurar um profissional certificado.
- Termine respostas sobre investimentos com: "${AVISO_CURTO}"`;

export { PREMISSAS };
