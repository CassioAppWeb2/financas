// Tela Mercado: indicadores oficiais (Banco Central) e simulador de investimentos.
// O app apenas apresenta informações — não recomenda nem escolhe investimentos.
import { icon } from "./icons.js";
import { PRODUTOS, simular, PREMISSAS, AVISO, fmtPct } from "./simulador.js";

const $ = (s, r = document) => r.querySelector(s);
const brl2 = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dBR = (iso) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";
const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const mesBR = (iso) => iso ? `${MES[+iso.slice(5, 7) - 1]}/${iso.slice(2, 4)}` : "";

const CARDS = [
  { k: "selic", t: "Selic (meta)", fmt: (v) => fmtPct(v) + " a.a.", quando: (x) => `vigente em ${dBR(x.data)}`, hint: "Taxa básica de juros (Copom)" },
  { k: "cdi", t: "CDI", fmt: (v) => fmtPct(v) + " a.a.", quando: (x) => dBR(x.data), hint: "Referência da renda fixa" },
  { k: "ipca_12m", t: "IPCA — 12 meses", fmt: (v) => fmtPct(v), quando: (x) => `até ${mesBR(x.data)}`, hint: "Inflação oficial (IBGE)" },
  { k: "ipca_mes", t: "IPCA — no mês", fmt: (v) => fmtPct(v), quando: (x) => mesBR(x.data), hint: "Variação de preços no mês" },
  { k: "poupanca", t: "Poupança", fmt: (v) => fmtPct(v, 4) + " a.m.", quando: (x) => `aniversário ${dBR(x.data)}`, hint: "Rendimento do mês" },
  { k: "dolar", t: "Dólar", fmt: (v) => brl2(v), quando: (x) => dBR(x.data), hint: "Comercial, venda (PTAX)" },
  { k: "euro", t: "Euro", fmt: (v) => brl2(v), quando: (x) => dBR(x.data), hint: "Venda" },
  { k: "igpm_mes", t: "IGP-M — no mês", fmt: (v) => fmtPct(v), quando: (x) => mesBR(x.data), hint: "Usado em aluguéis" },
];

function spark(hist, mensal) {
  const pts = (mensal ? hist : hist.slice(-60)).map((h) => Number(h.valor));
  if (pts.length < 2) return "";
  const W = 120, H = 34, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
}

let cache = null;

export async function mercadoView(page, C) {
  page.innerHTML = `
    <div class="page-head"><h1>Mercado</h1><button class="btn" id="mRef">${icon("repeat", 17)} Atualizar</button></div>
    <p class="mk-aviso">${icon("bell", 16)} ${AVISO}</p>
    <div class="grid mk-grid" id="mkInd"><div class="empty">Buscando os indicadores…</div></div>
    <p class="small muted" id="mkFonte"></p>
    <section class="card" id="sim" style="margin-top:16px">
      <h2>Simulador</h2>
      <p class="small muted" style="margin-top:-6px">Compare quanto um valor renderia com as taxas de hoje. Os resultados aparecem na ordem que você marcou — o app não indica qual escolher.</p>
      <form id="simF" class="sim-form" novalidate>
        <div class="row">
          <div class="field"><label>Valor inicial (R$)</label><input class="input num" name="inicial" inputmode="decimal" value="R$ 10.000,00"></div>
          <div class="field"><label>Aporte mensal (R$)</label><input class="input num" name="mensal" inputmode="decimal" placeholder="R$ 0,00"></div>
          <div class="field"><label>Prazo (meses)</label><input class="input num" name="meses" type="number" min="1" max="600" value="12">
            <div class="chips-sm">${[[6, "6 meses"], [12, "1 ano"], [24, "2 anos"], [60, "5 anos"]].map(([m, l]) => `<button type="button" data-m="${m}">${l}</button>`).join("")}</div></div>
        </div>
        <div class="field"><label>Aplicações para comparar</label>
          <div class="prods">
            ${prodRow("poupanca", true)}
            ${prodRow("cdb", true, "pct", "% do CDI")}
            ${prodRow("lci", false, "pct", "% do CDI")}
            ${prodRow("tesouro_selic", true)}
            ${prodRow("prefixado", false, "taxa", "% a.a.")}
            ${prodRow("ipca", false, "taxa", "% a.a. + IPCA")}
          </div></div>
        <button class="btn primary">${icon("chart", 17)} Simular</button>
      </form>
      <div id="simOut"></div>
    </section>`;
  const f = $("#simF", page);
  $(".chips-sm", f).onclick = (e) => { const m = e.target.closest("[data-m]"); if (m) { f.meses.value = m.dataset.m; f.requestSubmit(); } };
  f.onsubmit = (e) => { e.preventDefault(); runSim(page, C); };
  $("#mRef", page).onclick = () => load(page, C, true);
  await load(page, C, false);
}

function prodRow(k, on, param, suf) {
  const p = PRODUTOS[k];
  return `<label class="prod"><input type="checkbox" name="p_${k}" ${on ? "checked" : ""}>
    <span class="prod-name">${p.nome}${p.isento ? ' <span class="tag ok">isento de IR</span>' : ""}</span>
    ${param ? `<span class="prod-param"><input class="input num" name="v_${k}" inputmode="decimal" data-pct value="${String(p[param]).replace(".", ",")}"><span class="small muted">${suf}</span></span>` : ""}</label>`;
}

async function load(page, C, force) {
  const host = $("#mkInd", page);
  try {
    if (!force) cache = await C.api.rpc("app_market");
    if (force || !cache || cache.desatualizado || !Object.keys(cache.indicadores || {}).length) {
      if (force) { $("#mRef", page).disabled = true; }
      try { cache = await C.api.ask({ acao: "mercado", forcar: force }); } catch (e) { if (!cache || !Object.keys(cache.indicadores || {}).length) throw e; C.toast("Não consegui atualizar agora; mostrando os últimos valores."); }
      $("#mRef", page).disabled = false;
    }
  } catch (e) { host.innerHTML = `<div class="empty">Não consegui buscar os indicadores agora. ${C.esc(e.message)}</div>`; return; }
  const I = cache.indicadores || {};
  host.innerHTML = CARDS.filter((c) => I[c.k]).map((c) => {
    const x = I[c.k], v = Number(x.valor), ant = x.anterior == null ? null : Number(x.anterior);
    const diff = ant == null || ant === v ? "" : `<span class="mk-var ${v > ant ? "up" : "down"}">${v > ant ? "▲" : "▼"} ${c.k === "dolar" || c.k === "euro" ? brl2(Math.abs(v - ant)) : fmtPct(Math.abs(v - ant), c.k === "poupanca" ? 4 : 2).replace("%", " p.p.")}</span>`;
    return `<div class="card mk-card"><div class="mk-top"><span class="mk-name">${c.t}</span>${diff}</div>
      <div class="mk-val num">${c.fmt(v)}</div>
      ${spark(x.historico || [], x.frequencia === "mensal")}
      <div class="mk-foot"><span>${c.quando(x)}</span><span class="muted">${c.hint}</span></div></div>`;
  }).join("") || `<div class="empty">Sem dados no momento.</div>`;
  const quando = cache.atualizado_em ? new Date(cache.atualizado_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  $("#mkFonte", page).textContent = `Fonte: ${cache.fonte || "Banco Central do Brasil"}. Atualizado em ${quando} (o app busca de novo a cada 6 horas).`;
  runSim(page, C);
}

function runSim(page, C) {
  const out = $("#simOut", page), f = $("#simF", page);
  if (!cache) return;
  const I = cache.indicadores || {};
  const ind = { selic: I.selic?.valor ?? null, cdi: I.cdi?.valor ?? null, ipca12: I.ipca_12m?.valor ?? null, poupanca_mes: I.poupanca?.valor ?? null, tr_mes: I.tr?.valor ?? null };
  for (const k in ind) if (ind[k] != null) ind[k] = Number(ind[k]);
  const inicial = C.parseMoney(f.inicial.value) || 0, mensal = C.parseMoney(f.mensal.value) || 0, meses = Math.max(1, Math.min(600, Math.round(Number(f.meses.value) || 12)));
  if (!(inicial > 0 || mensal > 0)) { out.innerHTML = `<p class="small expense">Informe o valor inicial ou o aporte mensal.</p>`; return; }
  const sel = Object.keys(PRODUTOS).filter((k) => f["p_" + k].checked);
  if (!sel.length) { out.innerHTML = `<p class="small expense">Marque pelo menos uma aplicação.</p>`; return; }
  const rows = sel.map((k) => {
    const base = PRODUTOS[k], inp = f["v_" + k];
    const prod = { ...base };
    if (inp) { const v = C.parseMoney(inp.value); if (v >= 0) prod[base.tipo === "cdi" ? "pct" : "taxa"] = v; }
    return simular({ inicial, mensal, meses, produto: prod, ind });
  });
  const prazo = meses % 12 === 0 ? `${meses / 12} ${meses === 12 ? "ano" : "anos"}` : `${meses} meses`;
  out.innerHTML = `<h3 class="sim-h">Resultado em ${prazo}</h3><div class="sim-res">${rows.map((r) => r.erro ? `<div class="sim-row"><b>${C.esc(r.produto || "")}</b> <span class="small muted">${r.erro}</span></div>` : `
    <div class="sim-row">
      <div class="sim-l"><b>${C.esc(r.produto)}</b><span class="small muted">${fmtPct(r.taxa_aa)} a.a. · ${r.isento ? "isento de IR" : `IR ${fmtPct(r.aliquota_ir, 1)} no fim`}</span></div>
      <div class="sim-r"><span class="num sim-liq">${C.brl(r.liquido_cents)}</span>
        <span class="small muted num">investido ${C.brl(r.investido_cents)} · IR ${r.isento ? "—" : C.brl(r.ir_cents)} · rendeu ${C.brl(r.rendimento_liquido_cents)} (${fmtPct(r.rentab_liquida_pct)})</span></div>
    </div>`).join("")}</div>
    <ul class="premissas small muted">${PREMISSAS.map((p) => `<li>${p}</li>`).join("")}</ul>`;
}
