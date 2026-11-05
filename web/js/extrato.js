// Leitura de extratos de banco em OFX e CSV (usada no app e no servidor — sem dependência de navegador).

/** Código de compensação → nome do banco (para reconhecer de qual conta/cartão é o arquivo) */
export const BANCOS = {
  "001": "Banco do Brasil", "033": "Santander", "041": "Banrisul", "070": "BRB", "077": "Inter", "104": "Caixa", "208": "BTG",
  "212": "Original", "237": "Bradesco", "260": "Nubank", "290": "PagBank", "323": "Mercado Pago", "336": "C6", "341": "Itaú",
  "380": "PicPay", "399": "HSBC", "422": "Safra", "655": "Neon", "735": "Neon", "748": "Sicredi", "756": "Sicoob", "403": "Cora",
  "197": "Stone", "102": "XP", "461": "Asaas", "536": "Neon", "637": "Sofisa", "623": "Pan", "081": "BS2",
};
/** apelidos que aparecem nos nomes das contas/cartões */
const APELIDOS = { "Banco do Brasil": ["bb", "brasil"], "Itaú": ["itau"], "Nubank": ["nu", "nubank", "roxinho"], "Caixa": ["cef", "caixa"], "Mercado Pago": ["mercado pago", "mp"] };

export function parseNum(s) {
  let v = String(s ?? "").trim().replace(/[R$\s]/g, "");
  if (!v) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
  if (/[DC]$/i.test(v)) { neg = /D$/i.test(v); v = v.slice(0, -1); }
  if (v.startsWith("-")) { neg = !neg ? true : neg; v = v.slice(1); }
  if (v.includes(",") && v.lastIndexOf(",") > v.lastIndexOf(".")) v = v.replace(/\./g, "").replace(",", ".");
  else v = v.replace(/,/g, "");
  const n = Number(v);
  return neg ? -Math.abs(n) : n;
}

export function parseDate(s) {
  s = String(s ?? "").trim();
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}

const nrm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** OFX (padrão dos bancos): lançamentos, se é cartão, banco e final da conta */
export function parseOFX(text) {
  const out = [];
  const tag = (b, t) => { const m = b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, "i")); return m ? m[1].trim() : ""; };
  for (const b of text.split(/<STMTTRN>/i).slice(1)) {
    const valor = parseNum(tag(b, "TRNAMT"));
    const data = parseDate(tag(b, "DTPOSTED"));
    const desc = [tag(b, "MEMO"), tag(b, "NAME")].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" - ");
    out.push({ data, valor, descricao: desc, id_externo: tag(b, "FITID") ? "ofx:" + tag(b, "FITID") : "" });
  }
  const cartao = /<CREDITCARDMSGSRSV1>/i.test(text);
  const codigo = (tag(text, "BANKID") || "").replace(/\D/g, "").slice(-3).padStart(3, "0");
  const org = tag(text, "ORG");
  const conta = tag(text, "ACCTID");
  return { itens: out, cartao, banco: BANCOS[codigo] || org || "", final: conta.replace(/\D/g, "").slice(-4) };
}

function splitCsvLine(line, sep) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** CSV (exportação do app do banco ou planilha): procura as colunas de data, valor e descrição */
export function parseCSV(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("O arquivo está vazio ou não tem linhas de lançamentos.");
  const sep = [";", ",", "\t"].map((s) => [s, Math.max(...lines.slice(0, 8).map((l) => splitCsvLine(l, s).length))]).sort((a, b) => b[1] - a[1])[0][0];
  // acha a linha de cabeçalho (algumas exportações têm linhas de título antes)
  const hi = lines.findIndex((l) => { const h = splitCsvLine(l, sep).map(nrm); return h.some((c) => /^(data|date|dt)/.test(c)) && h.some((c) => /(valor|amount|value|quantia|debito|credito)/.test(c)); });
  if (hi < 0) throw new Error("Não encontrei as colunas de data e valor. O arquivo precisa ter um cabeçalho com “Data” e “Valor”.");
  const head = splitCsvLine(lines[hi], sep).map(nrm);
  const find = (re) => head.findIndex((c) => re.test(c));
  const iData = find(/^(data|date|dt)/);
  let iValor = find(/^(valor|amount|value|quantia)/);
  if (iValor < 0) iValor = find(/(valor|amount|value)/);
  const iDesc = find(/(descri|historico|title|titulo|memo|estabelecimento|lancamento|detalhe)/);
  const iId = find(/^(identificador|id|fitid|codigo)$/);
  const iDeb = find(/^(debito|saida)/), iCred = find(/^(credito|entrada)/);
  const itens = [];
  for (const l of lines.slice(hi + 1)) {
    const c = splitCsvLine(l, sep);
    let valor = iValor >= 0 ? parseNum(c[iValor]) : NaN;
    if (Number.isNaN(valor) && (iDeb >= 0 || iCred >= 0)) {
      const d = iDeb >= 0 ? parseNum(c[iDeb]) : NaN, cr = iCred >= 0 ? parseNum(c[iCred]) : NaN;
      valor = !Number.isNaN(cr) && cr ? Math.abs(cr) : !Number.isNaN(d) && d ? -Math.abs(d) : NaN;
    }
    const descricao = iDesc >= 0 ? c[iDesc] : "";
    // linhas de saldo não são lançamentos
    if (/^saldo/i.test(nrm(descricao))) continue;
    itens.push({ data: parseDate(c[iData]), valor, descricao, id_externo: iId >= 0 && c[iId] ? "csv:" + c[iId] : "" });
  }
  // fatura do Nubank em CSV: date,title,amount (compras positivas)
  return { ofx: false, itens, cartao: head.includes("title") && head.includes("amount"), banco: head.includes("title") && head.includes("amount") ? "Nubank" : "", final: "" };
}

/** Lê o texto de um arquivo OFX ou CSV. */
export function parseExtrato(text) {
  return /<OFX>|OFXHEADER/i.test(text) ? { ...parseOFX(text), ofx: true } : parseCSV(text);
}

/** Qual conta/cartão cadastrado combina com o banco do arquivo (pelo nome ou instituição). */
export function guessDestino(banco, contas = [], cartoes = [], cartao = false, final = "") {
  const b = nrm(banco);
  if (!b) return null;
  const chaves = [b, ...(APELIDOS[banco] || []).map(nrm), ...b.split(" ").filter((w) => w.length >= 4)];
  const bate = (x) => {
    const t = nrm(`${x.nome} ${x.instituicao || ""}`);
    return chaves.some((k) => new RegExp(`(^|\\W)${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`).test(t)) || (final && t.includes(final));
  };
  const lista = cartao ? cartoes.map((k) => ({ ...k, kind: "k" })) : contas.map((a) => ({ ...a, kind: "c" }));
  const achados = lista.filter(bate);
  return achados.length ? achados[0] : null;
}
