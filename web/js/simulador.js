// Simulador de investimentos (usado pela tela Mercado e pelo assistente).
// Só faz contas com os indicadores do dia: não recomenda nem ordena opções.

/** Produtos que o simulador conhece. */
export const PRODUTOS = {
  poupanca: { nome: "Poupança", tipo: "poupanca", isento: true },
  cdb: { nome: "CDB / LC / RDB", tipo: "cdi", pct: 100, isento: false },
  lci: { nome: "LCI / LCA", tipo: "cdi", pct: 90, isento: true },
  tesouro_selic: { nome: "Tesouro Selic", tipo: "selic", isento: false },
  prefixado: { nome: "Prefixado", tipo: "pre", taxa: 12, isento: false },
  ipca: { nome: "IPCA +", tipo: "ipca", taxa: 6, isento: false },
};

/** Alíquota de IR da renda fixa pelo tempo aplicado (tabela regressiva). */
export function irAliquota(dias) {
  if (dias <= 180) return 0.225;
  if (dias <= 360) return 0.2;
  if (dias <= 720) return 0.175;
  return 0.15;
}

const mensal = (aa) => Math.pow(1 + aa, 1 / 12) - 1;

/** Taxa anual usada para o produto (fração), ou null se faltar indicador. */
export function taxaAnual(prod, ind) {
  switch (prod.tipo) {
    case "poupanca": return ind.poupanca_mes == null ? null : Math.pow(1 + ind.poupanca_mes / 100, 12) - 1;
    case "cdi": return ind.cdi == null ? null : (ind.cdi / 100) * ((prod.pct ?? 100) / 100);
    case "selic": return ind.selic == null ? null : Math.max(0, ind.selic - 0.1) / 100;   // Selic efetiva ≈ meta − 0,10
    case "pre": return (prod.taxa ?? 0) / 100;
    case "ipca": return ind.ipca12 == null ? null : (1 + ind.ipca12 / 100) * (1 + (prod.taxa ?? 0) / 100) - 1;
  }
  return null;
}

export function nomeProduto(prod) {
  if (prod.tipo === "cdi") return `${prod.nome} ${fmtPct(prod.pct ?? 100, 0)} do CDI`;
  if (prod.tipo === "pre") return `${prod.nome} ${fmtPct(prod.taxa ?? 0)} a.a.`;
  if (prod.tipo === "ipca") return `IPCA + ${fmtPct(prod.taxa ?? 0)} a.a.`;
  return prod.nome;
}
export const fmtPct = (v, casas = 2) => `${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

/**
 * Simula um investimento.
 * @param {{inicial:number, mensal?:number, meses:number, produto:object, ind:object}} o valores em reais
 * Aportes: o valor inicial no começo e o aporte mensal no início de cada mês (inclusive o primeiro).
 * IR calculado por aporte, conforme o tempo que cada um ficou aplicado.
 */
export function simular({ inicial = 0, mensal: aporte = 0, meses, produto, ind }) {
  const aa = taxaAnual(produto, ind);
  if (aa == null) return { erro: "Indicador indisponível no momento." };
  const im = mensal(aa);
  let bruto = 0, investido = 0, ir = 0;
  for (let t = 0; t < meses; t++) {
    const dep = (t === 0 ? inicial : 0) + aporte;
    if (dep <= 0) continue;
    const n = meses - t;
    const fim = dep * Math.pow(1 + im, n);
    const ganho = fim - dep;
    investido += dep; bruto += fim;
    if (!produto.isento && ganho > 0) ir += ganho * irAliquota(n * 30);
  }
  const liquido = bruto - ir;
  const c = (v) => Math.round(v * 100);
  return {
    produto: nomeProduto(produto), isento: Boolean(produto.isento),
    taxa_aa: aa * 100,
    investido_cents: c(investido), bruto_cents: c(bruto), ir_cents: c(ir), liquido_cents: c(liquido),
    rendimento_liquido_cents: c(liquido - investido),
    rentab_liquida_pct: investido > 0 ? ((liquido - investido) / investido) * 100 : 0,
    aliquota_ir: produto.isento ? 0 : irAliquota(meses * 30) * 100,
  };
}

export const PREMISSAS = [
  "Estimativa com as taxas de hoje mantidas por todo o prazo — na prática elas mudam.",
  "Aportes no início de cada mês; IR da renda fixa pela tabela regressiva (22,5% a 15%), por aporte.",
  "Não considera taxas de custódia/administração, IOF (resgate antes de 30 dias) nem variação de preço antes do vencimento (Tesouro e prefixados).",
  "Poupança, LCI e LCA são isentas de IR para pessoa física. CDB, LC, LCI e LCA têm garantia do FGC até o limite legal; Tesouro Direto tem garantia do Tesouro Nacional.",
];

export const AVISO = "Informação e simulação educativas — não é recomendação de investimento. O app não escolhe nem indica aplicações: a decisão é sempre sua.";
