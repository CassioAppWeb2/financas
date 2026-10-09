// Telas da Fase 2: Cartões e faturas, Contas fixas, Metas, Orçamentos, Relatórios e Importação de extrato.
import { incomeExpenseChart, lineChart, categoryBars } from "./charts.js";
import * as ex from "./export.js";
import { icon } from "./icons.js";

let C; // utilidades do app principal (injeção para evitar dependência circular)
export function init(ctx) { C = ctx; }

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const opts = (arr, sel) => arr.map(([v, l]) => `<option value="${C.esc(v)}" ${v === sel ? "selected" : ""}>${C.esc(l)}</option>`).join("");
const err = (m, msg) => { const e = $(".form-err", m); e.textContent = msg; e.classList.remove("hidden"); };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dueShift = (iso, day, n) => { // mesma data de vencimento, n meses depois (dia limitado ao fim do mês)
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1 + n, 1));
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, lastDay(y, m))).padStart(2, "0")}`;
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const bar = (p, cls = "") => `<div class="pbar ${cls}"><i style="width:${Math.max(0, Math.min(100, p))}%"></i></div>`;
const SIT = { aberta: ["Aberta", ""], fechada: ["Fechada", "warn"], vencida: ["Vencida", "bad"], paga: ["Paga", "ok"], vazia: ["Sem lançamentos", ""] };
const sitTag = (s) => { const [l, c] = SIT[s] || [s, ""]; return `<span class="tag ${c}">${l}</span>`; };
const CARD_COLORS = ["#8a05be", "#ec7000", "#cc092f", "#0f6b4f", "#1f4fa3", "#222222", "#b8860b"];

function catSelects(m, f, tipo, catId, subId) {
  const cats = C.state.boot.categorias.filter((c) => c.tipo === tipo);
  f.categoria_id.innerHTML = `<option value="">Escolha…</option>` + opts(cats.map((c) => [c.id, `${c.icone || ""} ${c.nome}`]), catId);
  const subs = () => {
    const c = C.state.boot.categorias.find((x) => x.id === f.categoria_id.value);
    f.subcategoria_id.innerHTML = `<option value="">—</option>` + opts((c?.subcategorias || []).map((s) => [s.id, s.nome]), subId);
  };
  f.categoria_id.onchange = subs; subs();
}

/** Opções "onde": contas ativas e (para despesas) cartões. Valor "c:<id>" = conta, "k:<id>" = cartão. */
function payOptions(withCards, sel) {
  const b = C.state.boot;
  const acc = b.contas.contas.filter((a) => a.status === "ativa").map((a) => [`c:${a.id}`, `🏦 ${a.nome}`]);
  const cards = withCards ? (b.cartoes || []).map((k) => [`k:${k.id}`, `💳 ${k.nome}`]) : [];
  return opts([...acc, ...cards], sel ?? `c:${b.contas.contas.find((a) => a.padrao)?.id}`);
}

// =====================================================================
// CARTÕES
// =====================================================================
export async function cardsView(page) {
  await C.loadBoot();
  const cards = await C.api.rpc("app_cards");
  const total = cards.reduce((s, k) => s + Number(k.fatura_atual.total_cents), 0);
  page.innerHTML = `
    <div class="page-head"><h1>Cartões</h1><div class="row">
      ${cards.length ? `<button class="btn" id="imp">${icon("upload", 17)} Importar fatura</button>` : ""}
      <button class="btn primary" id="newCard">${icon("plus", 17)} Novo cartão</button></div></div>
    ${cards.length ? `<div class="grid kpis" style="margin-bottom:14px">
      <div class="card kpi"><div class="label">Faturas atuais</div><div class="value num">${C.brl(total)}</div><div class="hint">soma das faturas em aberto</div></div>
      <div class="card kpi"><div class="label">Limite disponível</div><div class="value num">${C.brl(cards.reduce((s, k) => s + Number(k.disponivel_cents ?? 0), 0))}</div><div class="hint">cartões com limite informado</div></div></div>` : ""}
    <div class="grid two" id="cardList">${cards.map((k) => {
      const atual = k.fatura_atual, ant = k.fatura_anterior;
      const pend = ant.restante_cents > 0 && ant.situacao !== "paga";
      return `<div class="card cc" data-id="${k.id}">
        <div class="cc-face" style="--cc:${C.esc(k.cor || "#1f4fa3")}"><div class="cc-name">${C.esc(k.nome)}</div><div class="cc-days">fecha dia ${k.fechamento} · vence dia ${k.vencimento}${C.family() ? ` · ${k.membro_id === null ? "família" : k.membro_id === C.state.boot.perfil.id ? "meu" : C.esc((k.membro || "").split(" ")[0])}` : ""}</div></div>
        <div class="kv"><span>Fatura atual ${sitTag(atual.situacao)}</span><b class="num">${C.brl(atual.total_cents)}</b></div>
        <div class="small muted">Fecha ${C.dateBR(atual.fechamento)} · vence ${C.dateBR(atual.vencimento)}</div>
        ${pend ? `<div class="notice" style="margin-top:10px">Fatura de ${C.dateBR(ant.vencimento)}: <b>${C.brl(ant.restante_cents)}</b> a pagar ${sitTag(ant.situacao)}</div>` : ""}
        ${k.limite_cents != null ? `<div class="kv small" style="margin-top:10px"><span>Limite usado</span><span class="num">${C.brl(k.usado_cents)} de ${C.brl(k.limite_cents)}</span></div>
          ${bar(pct(k.usado_cents, k.limite_cents), pct(k.usado_cents, k.limite_cents) >= 90 ? "bad" : "")}
          <div class="small muted">Disponível: <b class="num">${C.brl(k.disponivel_cents)}</b></div>` : ""}
        <div class="row" style="margin-top:12px">
          <button class="btn small primary" data-act="fatura">Ver fatura</button>
          ${pend || atual.situacao === "fechada" || atual.situacao === "vencida" ? `<button class="btn small" data-act="pagar">Pagar fatura</button>` : ""}
          <span class="spacer"></span><button class="btn small ghost" data-act="edit">${icon("edit", 16)} Editar</button></div>
      </div>`;
    }).join("") || `<div class="card empty" style="grid-column:1/-1"><div class="big">${icon("card", 34)}</div><p><b>Nenhum cartão cadastrado.</b></p>
      <p class="muted">Cadastre seus cartões com o dia de fechamento e de vencimento. Depois é só dizer ao assistente “comprei uma TV de 3.000 em 10x no Nubank” que eu coloco cada parcela na fatura certa.</p></div>`}</div>
    <p class="small muted" style="margin-top:12px">Compras feitas <b>no dia do fechamento</b> ou depois entram na fatura seguinte. Pagar a fatura não conta como despesa nova — as compras já foram contadas quando você gastou.</p>`;
  const reload = () => cardsView(page);
  $("#newCard").onclick = () => cardForm(null, reload);
  $("#imp")?.addEventListener("click", () => importDialog({ cartao: true }, reload));
  $("#cardList").onclick = (e) => {
    const box = e.target.closest("[data-id]"), act = e.target.closest("[data-act]")?.dataset.act;
    if (!box || !act) return;
    const k = cards.find((x) => x.id === box.dataset.id);
    if (act === "edit") cardForm(k, reload);
    if (act === "fatura") invoiceDialog(k, k.fatura_atual.vencimento, reload);
    if (act === "pagar") payDialog(k, k.fatura_anterior.restante_cents > 0 && k.fatura_anterior.situacao !== "paga" ? k.fatura_anterior : k.fatura_atual, reload);
  };
  C.setRefresh(reload);
}

function cardForm(k, after) {
  const contas = C.state.boot.contas.contas.filter((a) => a.status === "ativa");
  C.modal(`<h2>${k ? "Editar cartão" : "Novo cartão"}</h2>
    <form id="kf" novalidate>
      <div class="field"><label>Nome do cartão</label><input class="input" name="nome" maxlength="40" value="${C.esc(k?.nome || "")}" placeholder="Ex.: Nubank, Itaú Visa"></div>
      <div class="row">
        <div class="field"><label>Dia do fechamento</label><input class="input num" name="fechamento" type="number" min="1" max="31" value="${k?.fechamento || ""}" placeholder="Ex.: 5"></div>
        <div class="field"><label>Dia do vencimento</label><input class="input num" name="vencimento" type="number" min="1" max="31" value="${k?.vencimento || ""}" placeholder="Ex.: 12"></div>
      </div>
      <div class="row">
        <div class="field"><label>Limite (R$) <span class="muted">opcional</span></label><input class="input num" name="limite" inputmode="decimal" value="${C.moneyInput(k?.limite_cents)}" placeholder="R$ 0,00"></div>
        <div class="field"><label>Pagar a fatura pela conta</label><select class="input" name="conta">${opts(contas.map((a) => [a.id, a.nome]), k?.conta_pagamento_id || contas.find((a) => a.padrao)?.id)}</select></div>
      </div>
      ${C.family() ? `<div class="field"><label>De quem é o cartão?</label><select class="input" name="membro">
        ${C.state.boot.familia.membros.map((mm) => `<option value="${mm.id}" ${(k ? k.membro_id === mm.id : mm.eu) ? "selected" : ""}>${mm.eu ? "Meu" : "De " + C.esc(mm.nome)}</option>`).join("")}
        <option value="familia" ${k && k.membro_id === null ? "selected" : ""}>Da família</option></select>
        <span class="small muted">Quem paga a fatura. Compras divididas pagas com este cartão viram acerto com o dono.</span></div>` : ""}
      <div class="field"><label>Cor</label><div class="colors">${CARD_COLORS.map((c) => `<label><input type="radio" name="cor" value="${c}" ${c === (k?.cor || CARD_COLORS[4]) ? "checked" : ""}><i style="background:${c}"></i></label>`).join("")}</div></div>
      <p class="small muted">O fechamento é o dia em que a fatura fecha (as compras desse dia em diante vão para a próxima).</p>
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions">${k ? `<button type="button" class="btn" id="arch">Arquivar</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn" id="kc">Cancelar</button><button class="btn primary">Salvar</button></div>
    </form>`, (m, close) => {
    const f = $("#kf", m);
    $("#kc", m).onclick = close;
    $("#arch", m)?.addEventListener("click", async () => {
      if (!(await C.confirmBox(`Arquivar o cartão ${k.nome}? Os lançamentos continuam no histórico.`, "Arquivar", true))) return;
      try { await C.api.rpc("app_archive_card", { id: k.id }); close(); C.state.boot = null; C.toast("Cartão arquivado"); after(); } catch (x) { C.toast(x.message); }
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fe = Number(f.fechamento.value), ve = Number(f.vencimento.value);
      if (!f.nome.value.trim()) return err(m, "Informe o nome do cartão.");
      if (!(fe >= 1 && fe <= 31 && ve >= 1 && ve <= 31)) return err(m, "Informe os dias de fechamento e vencimento (1 a 31).");
      const lim = f.limite.value.trim() ? C.parseMoney(f.limite.value) : null;
      if (lim !== null && !(lim >= 0)) return err(m, "Limite inválido.");
      try {
        await C.api.rpc("app_save_card", { id: k?.id, nome: f.nome.value.trim(), fechamento: fe, vencimento: ve, limite: lim ?? "", cor: f.cor.value, conta_pagamento_id: f.conta.value, ...(f.membro ? { membro: f.membro.value } : {}) });
        close(); C.state.boot = null; C.toast("Cartão salvo ✅"); after();
      } catch (x) { err(m, x.message); }
    };
  });
}

function invoiceDialog(k, due, after) {
  C.modal(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">💳 ${C.esc(k.nome)}</h2>
      <div class="month-nav"><button data-n="-1" aria-label="Fatura anterior">${icon("left", 18)}</button><span id="invTitle"></span><button data-n="1" aria-label="Próxima fatura">${icon("right", 18)}</button></div></div>
    <div id="invBody"><div class="empty">Carregando…</div></div>
    <div class="modal-actions"><button class="btn" id="invClose">Fechar</button><span class="spacer"></span><button class="btn primary hidden" id="invPay">Pagar esta fatura</button></div>`, (m, close) => {
    $("#invClose", m).onclick = close;
    let cur = due, fat = null;
    const load = async () => {
      $("#invTitle", m).textContent = `venc. ${C.dateBR(cur)}`;
      const r = await C.api.rpc("app_card_invoice", { cartao_id: k.id, vencimento: cur });
      fat = r.fatura;
      const compras = r.itens.filter((t) => t.tipo !== "pagamento_fatura"), pags = r.itens.filter((t) => t.tipo === "pagamento_fatura");
      $("#invBody", m).innerHTML = `
        <div class="grid kpis" style="margin:12px 0">
          <div class="card kpi"><div class="label">Total ${sitTag(fat.situacao)}</div><div class="value num">${C.brl(fat.total_cents)}</div><div class="hint">fecha ${C.dateBR(fat.fechamento)}</div></div>
          <div class="card kpi"><div class="label">Pago</div><div class="value num income">${C.brl(fat.pago_cents)}</div></div>
          <div class="card kpi"><div class="label">Falta pagar</div><div class="value num ${fat.restante_cents > 0 ? "expense" : ""}">${C.brl(fat.restante_cents)}</div></div></div>
        <div class="list">${compras.map(C.txItem).join("") || `<div class="empty">Nenhuma compra nesta fatura.</div>`}</div>
        ${pags.length ? `<h3 class="small" style="margin:14px 0 4px">Pagamentos</h3><div class="list">${pags.map((t) => `<div class="item"><div class="emoji">✅</div><div class="body"><div class="title">Pagamento</div><div class="sub">${C.esc(t.conta || "")} · ${C.dateBR(t.data)}</div></div><div class="amount num">${C.brl(t.valor_cents)}</div></div>`).join("")}</div>` : ""}`;
      C.bindTxClicks($("#invBody .list", m), compras, () => { close(); after(); });
      $("#invPay", m).classList.toggle("hidden", !(fat.restante_cents > 0));
    };
    $$(".month-nav button", m).forEach((b) => (b.onclick = () => { cur = dueShift(cur, k.vencimento, Number(b.dataset.n)); load(); }));
    $("#invPay", m).onclick = () => { close(); payDialog(k, fat, after); };
    load().catch((x) => C.toast(x.message));
  });
}

function payDialog(k, fat, after) {
  const contas = C.state.boot.contas.contas.filter((a) => a.status === "ativa");
  C.modal(`<h2>Pagar fatura — ${C.esc(k.nome)}</h2>
    <p class="small muted">Fatura com vencimento em ${C.dateBR(fat.vencimento)} · falta pagar <b>${C.brl(fat.restante_cents)}</b></p>
    <form id="pf" novalidate>
      <div class="row">
        <div class="field"><label>Valor pago (R$)</label><input class="input num" name="valor" inputmode="decimal" value="${C.moneyInput(fat.restante_cents)}"></div>
        <div class="field"><label>Data</label><input class="input" type="date" name="data" value="${C.todayISO()}"></div></div>
      <div class="field"><label>Saiu da conta</label><select class="input" name="conta">${opts(contas.map((a) => [a.id, a.nome]), k.conta_pagamento_id)}</select></div>
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions"><button type="button" class="btn" id="pc">Cancelar</button><button class="btn primary">Registrar pagamento</button></div>
    </form>`, (m, close) => {
    const f = $("#pf", m);
    $("#pc", m).onclick = close;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = C.parseMoney(f.valor.value);
      if (!(v > 0)) return err(m, "Informe o valor pago.");
      try {
        const r = await C.api.rpc("app_pay_invoice", { cartao_id: k.id, vencimento: fat.vencimento, valor: v, conta_id: f.conta.value, data: f.data.value });
        if (r.status !== "paid") return err(m, r.status === "nothing_to_pay" ? "Esta fatura não tem valor em aberto." : "Não foi possível registrar o pagamento.");
        close(); C.state.boot = null; C.toast(r.fatura.restante_cents > 0 ? `Pagamento registrado. Ainda faltam ${C.brl(r.fatura.restante_cents)}.` : "Fatura paga ✅"); after();
      } catch (x) { err(m, x.message); }
    };
  });
}

// =====================================================================
// CONTAS FIXAS (recorrências)
// =====================================================================
export async function recurringView(page) {
  await C.loadBoot();
  const r = await C.api.rpc("app_recurrings");
  const item = (x) => `<div class="item click" data-id="${x.id}"><div class="emoji">${x.icone || (x.tipo === "receita" ? "💰" : "🔄")}</div>
    <div class="body"><div class="title">${C.esc(x.descricao)}</div>
    <div class="sub">${C.esc(x.quando)} · ${C.esc(x.categoria || "")}${x.cartao ? ` · 💳 ${C.esc(x.cartao)}` : x.conta ? ` · ${C.esc(x.conta)}` : ""}${x.proxima ? ` · próx. ${C.dateBR(x.proxima)}` : ""}${x.fim ? ` · até ${C.dateBR(x.fim)}` : ""}</div></div>
    <div class="amount num ${x.tipo === "receita" ? "income" : "expense"}">${C.brl(x.valor_cents)}</div></div>`;
  const rec = r.itens.filter((x) => x.tipo === "receita"), desp = r.itens.filter((x) => x.tipo === "despesa");
  page.innerHTML = `
    <div class="page-head"><h1>Contas fixas</h1><button class="btn primary" id="newRec">${icon("plus", 17)} Nova conta fixa</button></div>
    <div class="grid kpis" style="margin-bottom:14px">
      <div class="card kpi"><div class="label">Receitas fixas / mês</div><div class="value num income">${C.brl(r.receitas_mes_cents)}</div></div>
      <div class="card kpi"><div class="label">Despesas fixas / mês</div><div class="value num expense">${C.brl(r.despesas_mes_cents)}</div></div>
      <div class="card kpi"><div class="label">Sobra das fixas</div><div class="value num">${C.brl(r.receitas_mes_cents - r.despesas_mes_cents)}</div><div class="hint">receitas − despesas fixas</div></div></div>
    <div class="card" id="recList">
      ${rec.length ? `<h2>💰 Receitas</h2><div class="list">${rec.map(item).join("")}</div>` : ""}
      ${desp.length ? `<h2 ${rec.length ? 'style="margin-top:16px"' : ""}>🔄 Despesas</h2><div class="list">${desp.map(item).join("")}</div>` : ""}
      ${!r.itens.length ? `<div class="empty"><div class="big">${icon("repeat", 34)}</div><p><b>Nenhuma conta fixa.</b></p><p class="muted">Aluguel, internet, assinaturas, salário… Cadastre aqui ou diga ao assistente: “minha internet custa 120 todo dia 10”.</p></div>` : ""}
    </div>
    <p class="small muted" style="margin-top:12px">Os lançamentos são criados sozinhos até o fim do mês seguinte e aparecem como <b>previstos</b> até a data chegar.</p>`;
  const reload = () => recurringView(page);
  $("#newRec").onclick = () => recForm(null, reload);
  $("#recList").onclick = (e) => { const it = e.target.closest("[data-id]"); if (it) recForm(r.itens.find((x) => x.id === it.dataset.id), reload); };
  C.setRefresh(reload);
}

function recForm(x, after) {
  const b = C.state.boot;
  const tipo0 = x?.tipo || "despesa";
  const dias = Array.from({ length: 31 }, (_, i) => [String(i + 1), `dia ${i + 1}`]);
  const uteis = Array.from({ length: 10 }, (_, i) => [String(i + 1), `${i + 1}º dia útil`]);
  C.modal(`<h2>${x ? "Editar conta fixa" : "Nova conta fixa"}</h2>
    <form id="rf" novalidate>
      <div class="seg" id="rTipo" style="margin-bottom:12px"><button type="button" data-v="despesa" class="${tipo0 === "despesa" ? "on" : ""}">Despesa</button><button type="button" data-v="receita" class="${tipo0 === "receita" ? "on" : ""}">Receita</button></div>
      <div class="row">
        <div class="field"><label>Descrição</label><input class="input" name="descricao" maxlength="80" value="${C.esc(x?.descricao || "")}" placeholder="Ex.: Internet, Aluguel, Salário"></div>
        <div class="field"><label>Valor (R$)</label><input class="input num" name="valor" inputmode="decimal" value="${C.moneyInput(x?.valor_cents)}" placeholder="R$ 0,00"></div></div>
      <div class="row">
        <div class="field"><label>Categoria</label><select class="input" name="categoria_id"></select></div>
        <div class="field"><label>Subcategoria</label><select class="input" name="subcategoria_id"></select></div></div>
      <div class="row">
        <div class="field"><label>Repete</label><select class="input" name="frequencia">${opts([["mensal", "Todo mês"], ["semanal", "Toda semana"], ["anual", "Todo ano"]], x?.frequencia || "mensal")}</select></div>
        <div class="field f-mensal"><label>Quando</label><select class="input" name="quando">
          <optgroup label="Dia do mês">${opts(dias.map(([v, l]) => ["d" + v, l]), x?.dia_util ? null : "d" + (x?.dia || 10))}</optgroup>
          <optgroup label="Dia útil">${opts(uteis.map(([v, l]) => ["u" + v, l]), x?.dia_util ? "u" + x.dia_util : null)}</optgroup></select></div></div>
      <div class="row">
        <div class="field"><label class="f-ini-l">Começa em</label><input class="input" type="date" name="inicio" value="${x?.inicio || ""}"></div>
        <div class="field"><label>Termina em <span class="muted">opcional</span></label><input class="input" type="date" name="fim" value="${x?.fim || ""}"></div></div>
      <div class="field"><label class="f-onde-l">Pagar com</label><select class="input" name="onde"></select></div>
      ${C.family() ? `<div class="field"><label>De quem é?</label><select class="input" name="membro">${b.familia.membros.map((mm) => `<option value="${mm.id}" ${(x ? x.membro_id === mm.id : mm.eu) ? "selected" : ""}>${mm.eu ? "Meu" : "De " + C.esc(mm.nome)}</option>`).join("")}<option value="familia" ${x && x.membro_id === null ? "selected" : ""}>Família (compartilhado)</option></select></div>` : ""}
      ${x ? `<p class="small muted">Ao salvar, os lançamentos futuros já previstos são refeitos com os novos dados. Os que já aconteceram não mudam.</p>` : ""}
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions">${x ? `<button type="button" class="btn danger" id="rDel">Encerrar</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn" id="rc">Cancelar</button><button class="btn primary">Salvar</button></div>
    </form>`, (m, close) => {
    const f = $("#rf", m);
    let tipo = tipo0;
    const sync = () => {
      catSelects(m, f, tipo, x?.tipo === tipo ? x.categoria_id : null, x?.tipo === tipo ? x.subcategoria_id : null);
      f.onde.innerHTML = payOptions(tipo === "despesa", x ? (x.cartao_id ? `k:${x.cartao_id}` : `c:${x.conta_id}`) : undefined);
      $(".f-onde-l", m).textContent = tipo === "despesa" ? "Pagar com" : "Receber na conta";
      const mensal = f.frequencia.value === "mensal";
      $(".f-mensal", m).classList.toggle("hidden", !mensal);
      $(".f-ini-l", m).textContent = mensal ? "Começa em (opcional)" : "Primeira data";
    };
    $("#rTipo", m).onclick = (e) => { const bt = e.target.closest("button"); if (!bt) return; tipo = bt.dataset.v; $$("#rTipo button", m).forEach((z) => z.classList.toggle("on", z === bt)); sync(); };
    f.frequencia.onchange = sync;
    sync();
    $("#rc", m).onclick = close;
    $("#rDel", m)?.addEventListener("click", async () => {
      if (!(await C.confirmBox(`Encerrar “${x.descricao}”? Ela para de ser lançada e os lançamentos futuros previstos são removidos.`, "Encerrar", true))) return;
      try { await C.api.rpc("app_cancel_recurring", { id: x.id }); close(); C.state.boot = null; C.toast("Conta fixa encerrada"); after(); } catch (y) { C.toast(y.message); }
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = C.parseMoney(f.valor.value);
      if (!f.descricao.value.trim()) return err(m, "Informe a descrição.");
      if (!(v > 0)) return err(m, "Informe um valor válido.");
      if (!f.categoria_id.value) return err(m, "Escolha a categoria.");
      const freq = f.frequencia.value;
      if (freq !== "mensal" && !f.inicio.value) return err(m, "Informe a primeira data.");
      const p = { id: x?.id, tipo, descricao: f.descricao.value.trim(), valor: v, categoria_id: f.categoria_id.value, subcategoria_id: f.subcategoria_id.value || null,
        frequencia: freq, inicio: f.inicio.value || null, fim: f.fim.value || null };
      if (freq === "mensal") { const q = f.quando.value; if (q[0] === "u") p.dia_util = Number(q.slice(1)); else p.dia = Number(q.slice(1)); }
      const [kind, id] = f.onde.value.split(":");
      if (kind === "k") p.cartao_id = id; else p.conta_id = id;
      if (f.membro) p.membro = f.membro.value;
      try {
        const r = await C.api.rpc("app_save_recurring", p);
        if (r.status !== "saved") return err(m, "Confira os dados (categoria, conta ou cartão).");
        close(); C.state.boot = null;
        C.toast(`Conta fixa salva ✅${r.primeira ? ` Próximo lançamento: ${C.dateBR(r.primeira)}` : ""}`);
        if (r.data_mes_atual && (await C.confirmBox(`A deste mês (${C.dateBR(r.data_mes_atual)}) já passou. Registrar também?`, "Registrar"))) {
          const t = { tipo, valor: v, data: r.data_mes_atual, descricao: p.descricao, categoria_id: p.categoria_id, subcategoria_id: p.subcategoria_id, recorrencia_id: r.recorrencia.id, forcar: true };
          if (p.cartao_id) t.cartao_id = p.cartao_id; else t.conta_id = p.conta_id;
          if (p.membro) t.membro = p.membro;
          await C.api.rpc("app_save_transaction", t); C.toast("Lançamento do mês registrado ✅");
        }
        after();
      } catch (y) { err(m, y.message); }
    };
  });
}

// =====================================================================
// METAS
// =====================================================================
const TIPOS_META = {
  reserva: { t: "Reserva de emergência", ico: "🛟", d: "Dinheiro para imprevistos (perda de renda, saúde, consertos). Você escolhe quantos meses de gastos quer cobrir." },
  poupanca: { t: "Metas de poupança", ico: "🎯", d: "Objetivos com valor e prazo: viagem, carro, reforma, estudos…" },
  investimento: { t: "Investimentos", ico: "📈", d: "Quanto você planeja aplicar por mês e o valor que quer acumular. Simule rendimentos na tela Mercado." },
};

export async function goalsView(page) {
  await C.loadBoot();
  const pl = await C.api.rpc("app_planning");
  const goals = pl.metas || [];
  const ativas = goals.filter((g) => g.status === "ativa"), outras = goals.filter((g) => g.status !== "ativa");
  const sobra = Number(pl.sobra_media_cents), plan = Number(pl.planejado_mensal_cents);
  const card = (g) => `<div class="card goal" data-id="${g.id}">
    <div class="row" style="justify-content:space-between;align-items:flex-start"><h2 style="margin:0">${C.esc(g.icone || TIPOS_META[g.tipo]?.ico || "🎯")} ${C.esc(g.nome)}</h2>
      ${g.status === "concluida" ? `<span class="tag ok">Concluída 🎉</span>` : g.status !== "ativa" ? `<span class="tag">Arquivada</span>` : g.atrasada ? `<span class="tag warn">Fora do ritmo</span>` : ""}</div>
    <div class="kv" style="margin-top:10px"><span class="num"><b>${C.brl(g.atual_cents)}</b> de ${C.brl(g.objetivo_cents)}</span><b>${Math.round(g.progresso)}%</b></div>
    ${bar(g.progresso, g.status === "concluida" ? "ok" : "")}
    <div class="small muted" style="margin-top:8px;line-height:1.6">
      ${g.tipo === "reserva" && g.gasto_medio_cents ? `Cobre <b>${String(g.cobertura_meses ?? 0).replace(".", ",")} ${g.cobertura_meses === 1 ? "mês" : "meses"}</b> dos seus gastos (média ${C.brl(g.gasto_medio_cents)}/mês)${g.meses_reserva ? ` · objetivo: ${g.meses_reserva} meses` : ""}<br>` : ""}
      ${g.status === "concluida" ? "Objetivo atingido." : `Faltam <b class="num">${C.brl(g.falta_cents)}</b>`}
      ${g.prazo ? ` · prazo ${C.dateBR(g.prazo)}` : ""}
      ${g.plano_mensal_cents && g.status === "ativa" ? `<br>Seu plano: <b class="num">${C.brl(g.plano_mensal_cents)}/mês</b>${g.previsao_plano ? ` → conclui em <b>${C.dateBR(g.previsao_plano)}</b>` : ""}` : ""}
      ${g.por_mes_cents && g.status === "ativa" ? `<br>Para chegar no prazo: <b class="num">${C.brl(g.por_mes_cents)}/mês</b>` : ""}
      ${g.ritmo_mensal_cents ? `<br>Ritmo real (últimos meses): ${C.brl(g.ritmo_mensal_cents)}/mês` : ""}</div>
    ${g.status === "ativa" ? `<div class="row" style="margin-top:12px"><button class="btn small primary" data-act="add">+ Guardar</button><button class="btn small" data-act="sub">− Retirar</button><span class="spacer"></span><button class="btn small ghost" data-act="hist">Histórico</button><button class="btn small ghost" data-act="edit">${icon("edit", 16)}</button></div>`
      : `<div class="row" style="margin-top:12px"><button class="btn small ghost" data-act="hist">Histórico</button><button class="btn small ghost" data-act="edit">${icon("edit", 16)}</button></div>`}
  </div>`;
  const section = (tipo) => {
    const list = ativas.filter((g) => (g.tipo || "poupanca") === tipo), T = TIPOS_META[tipo];
    return `<section class="plan-sec"><div class="plan-sec-h"><h2>${T.ico} ${T.t}</h2><button class="btn small" data-new="${tipo}">${icon("plus", 15)} ${tipo === "reserva" && list.length ? "Outra" : "Nova"}</button></div>
      ${list.length ? `<div class="grid two">${list.map(card).join("")}</div>` : `<div class="card plan-empty"><p class="small muted">${T.d}</p><button class="btn small primary" data-new="${tipo}">${tipo === "reserva" ? "Criar reserva de emergência" : tipo === "investimento" ? "Criar plano de investimento" : "Criar meta"}</button></div>`}
      ${tipo === "investimento" ? `<p class="small muted" style="margin-top:8px">Para ver quanto um valor renderia, use o simulador em <a href="#/mercado">Mercado</a>. O app não indica onde investir — a decisão é sua.</p>` : ""}</section>`;
  };
  page.innerHTML = `
    <div class="page-head"><h1>Metas e planejamento</h1></div>
    <div class="card plan-sum">
      <h2>Seu mês em média <span class="small muted">(últimos 3 meses completos)</span></h2>
      <div class="plan-nums">
        <div><span class="small muted">Renda</span><b class="num income">${C.brl(pl.renda_media_cents)}</b></div>
        <div><span class="small muted">Gastos</span><b class="num expense">${C.brl(pl.gasto_medio_cents)}</b></div>
        <div><span class="small muted">Sobra</span><b class="num ${sobra < 0 ? "expense" : ""}">${C.brl(sobra)}</b></div>
        <div><span class="small muted">Planejado p/ metas</span><b class="num">${C.brl(plan)}/mês</b></div>
      </div>
      ${sobra > 0 && plan > 0 ? `${bar(Math.min(100, (plan / sobra) * 100), plan > sobra ? "bad" : "ok")}<p class="small muted" style="margin:4px 0 0">${plan > sobra ? `Seu plano mensal passa a sobra média em <b>${C.brl(plan - sobra)}</b>.` : `Seu plano usa <b>${Math.round((plan / sobra) * 100)}%</b> da sobra média.`}</p>` : `<p class="small muted" style="margin:6px 0 0">${Number(pl.renda_media_cents) ? "Defina um <b>valor por mês</b> nas metas para ver quanto da sua sobra está planejado." : "Lance receitas e despesas por alguns meses para ver a média aqui."}</p>`}
    </div>
    ${section("reserva")}${section("poupanca")}${section("investimento")}
    ${outras.length ? `<details style="margin-top:16px"><summary class="small" style="cursor:pointer;font-weight:600">Concluídas e arquivadas (${outras.length})</summary><div class="grid two" style="margin-top:10px">${outras.map(card).join("")}</div></details>` : ""}
    <p class="small muted" style="margin-top:14px">O patrimônio (soma das contas mês a mês) aparece no gráfico do Início. Pelo assistente: “guardei 500 na reserva”, “como estão minhas metas?”.</p>`;
  const reload = () => goalsView(page);
  page.onclick = (e) => {
    const nw = e.target.closest("[data-new]");
    if (nw) return goalForm(null, reload, nw.dataset.new, pl);
    const box = e.target.closest(".goal[data-id]"), act = e.target.closest("[data-act]")?.dataset.act;
    if (!box || !act) return;
    const g = goals.find((x) => x.id === box.dataset.id);
    if (act === "edit") goalForm(g, reload, g.tipo, pl);
    if (act === "add" || act === "sub") contribDialog(g, act === "sub", reload);
    if (act === "hist") goalHistory(g, reload);
  };
  C.setRefresh(reload);
}

function goalForm(g, after, tipo = "poupanca", pl = {}) {
  const T = TIPOS_META[tipo] || TIPOS_META.poupanca, gasto = Number(pl.gasto_medio_cents || 0);
  const reserva = tipo === "reserva";
  C.modal(`<h2>${g ? "Editar" : "Nova"}: ${T.t.replace(/^Metas de /, "meta de ").replace(/^Investimentos$/, "plano de investimento")}</h2>
    <form id="gf" novalidate>
      <div class="row"><div class="field" style="flex:0 0 80px"><label>Ícone</label><input class="input" name="icone" maxlength="4" value="${C.esc(g?.icone || T.ico)}" style="text-align:center"></div>
        <div class="field"><label>Nome</label><input class="input" name="nome" maxlength="60" value="${C.esc(g?.nome || (reserva ? "Reserva de emergência" : ""))}" placeholder="${tipo === "investimento" ? "Ex.: Aposentadoria, Renda fixa" : "Ex.: Viagem, Carro novo"}"></div></div>
      ${reserva ? `<div class="field"><label>Quantos meses de gastos quer cobrir?</label><select class="input" name="meses">${[3, 4, 6, 9, 12].map((n) => `<option value="${n}" ${(g?.meses_reserva ?? 6) === n ? "selected" : ""}>${n} meses${gasto ? ` — ${C.brl(gasto * n)}` : ""}</option>`).join("")}</select>
        <span class="small muted">${gasto ? `Seu gasto médio é ${C.brl(gasto)}/mês (últimos 3 meses). A escolha de quantos meses é sua.` : "Ainda não há gastos suficientes para calcular a média — informe o valor abaixo."}</span></div>` : ""}
      <div class="row"><div class="field"><label>${reserva ? "Valor da reserva (R$)" : tipo === "investimento" ? "Quanto quer acumular (R$)" : "Quanto quer juntar (R$)"}</label><input class="input num" name="valor" inputmode="decimal" value="${C.moneyInput(g?.objetivo_cents ?? (reserva && gasto ? gasto * 6 : null))}" placeholder="R$ 0,00"></div>
        <div class="field"><label>Até quando <span class="muted">opcional</span></label><input class="input" type="date" name="prazo" value="${g?.prazo || ""}"></div></div>
      <div class="field"><label>${tipo === "investimento" ? "Quanto pretende aplicar por mês (R$)" : "Quanto pretende guardar por mês (R$)"} <span class="muted">opcional</span></label><input class="input num" name="plano" inputmode="decimal" value="${C.moneyInput(g?.plano_mensal_cents)}" placeholder="R$ 0,00">
        <span class="small muted" id="planHint"></span></div>
      ${g ? "" : `<div class="field"><label>Já tenho guardado (R$) <span class="muted">opcional</span></label><input class="input num" name="inicial" inputmode="decimal" placeholder="R$ 0,00"></div>`}
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions">${g ? `<button type="button" class="btn" id="gArch">${g.status === "ativa" ? "Arquivar" : "Reativar"}</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn" id="gc">Cancelar</button><button class="btn primary">Salvar</button></div>
    </form>`, (m, close) => {
    const f = $("#gf", m);
    $("#gc", m).onclick = close;
    if (reserva && gasto) f.meses.onchange = () => { f.valor.value = C.moneyInput(gasto * Number(f.meses.value)); hint(); };
    const hint = () => {
      const v = C.parseMoney(f.valor.value) || 0, pm = C.parseMoney(f.plano.value) || 0, ini = g ? g.atual_cents / 100 : (C.parseMoney(f.inicial?.value) || 0);
      const rest = Math.max(0, v - ini);
      $("#planHint", m).textContent = pm > 0 && rest > 0 ? `Guardando isso por mês, você chega lá em cerca de ${Math.ceil(rest / pm)} ${Math.ceil(rest / pm) === 1 ? "mês" : "meses"} (sem contar rendimentos).` : "";
    };
    f.addEventListener("input", hint); hint();
    $("#gArch", m)?.addEventListener("click", async () => {
      try { await C.api.rpc("app_archive_goal", { id: g.id, status: g.status === "ativa" ? "cancelada" : "ativa" }); close(); C.state.boot = null; after(); } catch (y) { C.toast(y.message); }
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = C.parseMoney(f.valor.value);
      if (!f.nome.value.trim()) return err(m, "Dê um nome.");
      if (!(v > 0)) return err(m, "Informe o valor.");
      const p = { id: g?.id, tipo, nome: f.nome.value.trim(), icone: f.icone.value.trim() || T.ico, valor: v, prazo: f.prazo.value || "",
        plano_mensal: f.plano.value.trim() ? String(C.parseMoney(f.plano.value) || "") : "", meses_reserva: reserva ? f.meses.value : "" };
      if (f.inicial?.value.trim()) { const i = C.parseMoney(f.inicial.value); if (!(i >= 0)) return err(m, "Valor guardado inválido."); p.valor_inicial = i; }
      try { await C.api.rpc("app_save_goal", p); close(); C.state.boot = null; C.toast("Salvo ✅"); after(); } catch (y) { err(m, y.message); }
    };
  });
}

function contribDialog(g, retirada, after) {
  C.modal(`<h2>${retirada ? "Retirar da" : "Guardar na"} meta ${C.esc(g.nome)}</h2>
    <form id="cf" novalidate><div class="row">
      <div class="field"><label>Valor (R$)</label><input class="input num" name="valor" inputmode="decimal" placeholder="R$ 0,00"></div>
      <div class="field"><label>Data</label><input class="input" type="date" name="data" value="${C.todayISO()}"></div></div>
      <p class="small muted">Isto registra o progresso da meta. Se o dinheiro foi para outra conta (poupança, investimento), registre também a transferência ou aplicação.</p>
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions"><button type="button" class="btn" id="cc">Cancelar</button><button class="btn primary">${retirada ? "Retirar" : "Guardar"}</button></div></form>`, (m, close) => {
    const f = $("#cf", m);
    $("#cc", m).onclick = close;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = C.parseMoney(f.valor.value);
      if (!(v > 0)) return err(m, "Informe o valor.");
      try {
        const r = await C.api.rpc("app_goal_contribute", { meta_id: g.id, valor: retirada ? -v : v, data: f.data.value });
        close(); C.toast(r.meta?.status === "concluida" ? "Meta concluída! 🎉" : "Registrado ✅"); after();
      } catch (y) { err(m, y.message); }
    };
  });
}

function goalHistory(g, after) {
  C.modal(`<h2>Histórico — ${C.esc(g.nome)}</h2>
    <div class="list" id="hl">${(g.aportes || []).map((a) => `<div class="item"><div class="emoji">${a.valor_cents > 0 ? "💰" : "↩️"}</div>
      <div class="body"><div class="title">${a.valor_cents > 0 ? "Guardado" : "Retirado"}</div><div class="sub">${C.dateBR(a.data)}${a.obs ? " · " + C.esc(a.obs) : ""}</div></div>
      <div class="amount num ${a.valor_cents > 0 ? "income" : "expense"}">${C.brl(Math.abs(a.valor_cents))}</div><button class="btn ghost small" data-rm="${a.id}" title="Remover">${icon("trash", 16)}</button></div>`).join("") || `<div class="empty">Nenhum valor registrado ainda.</div>`}</div>
    <div class="modal-actions"><button class="btn" id="hc">Fechar</button></div>`, (m, close) => {
    $("#hc", m).onclick = close;
    $("#hl", m).onclick = async (e) => {
      const b = e.target.closest("[data-rm]"); if (!b) return;
      if (!(await C.confirmBox("Remover este registro da meta?", "Remover", true))) return;
      try { await C.api.rpc("app_remove_contribution", { id: b.dataset.rm }); close(); after(); } catch (y) { C.toast(y.message); }
    };
  });
}

// =====================================================================
// ORÇAMENTOS
// =====================================================================
export async function budgetsView(page) {
  await C.loadBoot();
  const r = await C.api.rpc("app_budgets", { mes: C.state.month, membro_id: C.state.membro });
  const SITC = { ok: "", atencao: "warn", estourado: "bad" };
  const current = r.mes === String(C.state.boot.hoje).slice(0, 7);
  page.innerHTML = `
    <div class="page-head"><h1>Orçamentos</h1><div class="row">${C.memberSeg(() => budgetsView(page))}<span id="mnav"></span></div></div>
    <div class="grid kpis" style="margin-bottom:14px">
      <div class="card kpi"><div class="label">Orçado</div><div class="value num">${C.brl(r.total_limite_cents)}</div></div>
      <div class="card kpi"><div class="label">Gasto (categorias com orçamento)</div><div class="value num expense">${C.brl(r.total_gasto_cents)}</div><div class="hint">${pct(r.total_gasto_cents, r.total_limite_cents)}% do orçado</div></div>
      <div class="card kpi"><div class="label">Ainda pode gastar</div><div class="value num">${C.brl(Math.max(0, r.total_limite_cents - r.total_gasto_cents))}</div></div></div>
    <div class="card" id="bList"><h2>Por categoria</h2>
      ${r.itens.map((x) => `<div class="budget click" data-id="${x.categoria_id}">
        <div class="kv"><span><b>${x.icone || "•"} ${C.esc(x.categoria)}</b> ${x.situacao !== "ok" ? `<span class="tag ${SITC[x.situacao]}">${x.situacao === "estourado" ? "Estourou" : "Atenção"}</span>` : ""}</span>
          <span class="num"><b>${C.brl(x.gasto_cents)}</b> de ${C.brl(x.limite_cents)}</span></div>
        <div class="pbar-wrap">${bar(x.percentual, SITC[x.situacao])}${current ? `<i class="pace" style="left:${Math.min(100, x.esperado_percentual)}%" title="Onde deveria estar hoje"></i>` : ""}</div>
        <div class="small muted">${Math.round(x.percentual)}% usado · ${x.restante_cents >= 0 ? `restam ${C.brl(x.restante_cents)}` : `passou ${C.brl(-x.restante_cents)}`}</div></div>`).join("")
        || `<div class="empty"><div class="big">${icon("budget", 34)}</div><p class="muted">Nenhum orçamento definido. Escolha uma categoria abaixo e defina um limite por mês — eu aviso quando chegar a 80% e quando passar.</p></div>`}
    </div>
    ${r.sem_orcamento.length ? `<div class="card" style="margin-top:14px" id="bFree"><h2>Sem orçamento</h2><div class="list">${r.sem_orcamento.map((x) => `
      <div class="item click" data-id="${x.categoria_id}"><div class="emoji">${x.icone || "•"}</div><div class="body"><div class="title">${C.esc(x.categoria)}</div><div class="sub">gasto no mês: ${C.brl(x.gasto_cents)}</div></div><span class="btn small">Definir</span></div>`).join("")}</div></div>` : ""}
    <p class="small muted" style="margin-top:12px">O orçamento vale deste mês em diante, até você mudar. ${current ? "A marquinha na barra mostra onde o gasto deveria estar hoje, se fosse distribuído por igual no mês." : ""}</p>`;
  const nav = C.monthNav(() => budgetsView(page));
  $("#mnav").appendChild(nav);
  const reload = () => budgetsView(page);
  const open = (id) => {
    const x = r.itens.find((i) => i.categoria_id === id) || r.sem_orcamento.find((i) => i.categoria_id === id);
    if (x) budgetForm(x, r.mes, reload);
  };
  $("#bList").onclick = (e) => { const it = e.target.closest("[data-id]"); if (it) open(it.dataset.id); };
  $("#bFree")?.addEventListener("click", (e) => { const it = e.target.closest("[data-id]"); if (it) open(it.dataset.id); });
  C.setRefresh(reload);
}

function budgetForm(x, mes, after) {
  C.modal(`<h2>Orçamento — ${x.icone || ""} ${C.esc(x.categoria)}</h2>
    <form id="bf" novalidate>
      <div class="field"><label>Limite por mês (R$)</label><input class="input num" name="valor" inputmode="decimal" value="${C.moneyInput(x.limite_cents)}" placeholder="R$ 0,00"></div>
      <p class="small muted">Vale a partir de ${C.monthTitle(mes)}. Gasto neste mês até agora: <b>${C.brl(x.gasto_cents)}</b>.</p>
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions">${x.limite_cents ? `<button type="button" class="btn danger" id="bRm">Remover orçamento</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn" id="bc">Cancelar</button><button class="btn primary">Salvar</button></div></form>`, (m, close) => {
    const f = $("#bf", m);
    const save = async (v) => {
      try { await C.api.rpc("app_set_budget", { categoria_id: x.categoria_id, valor: v, mes }); close(); C.toast(v ? "Orçamento salvo ✅" : "Orçamento removido"); after(); }
      catch (y) { err(m, y.message); }
    };
    $("#bc", m).onclick = close;
    $("#bRm", m)?.addEventListener("click", () => save(0));
    f.onsubmit = (e) => { e.preventDefault(); const v = C.parseMoney(f.valor.value); if (!(v > 0)) return err(m, "Informe o limite."); save(v); };
  });
}

// =====================================================================
// RELATÓRIOS
// =====================================================================
const rep = { modo: "mes", ano: null, ini: "", fim: "" };

function period() {
  const hoje = String(C.state.boot.hoje);
  if (rep.modo === "ano") { const y = rep.ano || hoje.slice(0, 4); return { inicio: `${y}-01-01`, fim: `${y}-12-31`, label: `Ano de ${y}`, file: y }; }
  if (rep.modo === "periodo" && rep.ini && rep.fim) return { inicio: rep.ini, fim: rep.fim, label: `${C.dateBR(rep.ini)} a ${C.dateBR(rep.fim)}`, file: `${rep.ini}_${rep.fim}` };
  const ym = C.state.month, y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  return { inicio: `${ym}-01`, fim: `${ym}-${String(lastDay(y, m)).padStart(2, "0")}`, label: C.monthTitle(ym), file: ym };
}

export async function reportsView(page) {
  await C.loadBoot();
  const P = period();
  const r = await C.api.rpc("app_report", { inicio: P.inicio, fim: P.fim, membro_id: C.state.membro });
  const s = r.resumo;
  const desp = r.por_categoria.filter((c) => c.tipo === "despesa"), rec = r.por_categoria.filter((c) => c.tipo === "receita");
  const totD = Number(s.despesas_cents) || 1;
  const mesUnico = r.inicio.slice(0, 7) === r.fim.slice(0, 7);
  const anoAtual = rep.ano || String(C.state.boot.hoje).slice(0, 4);
  const membros = C.family() ? C.state.boot.familia.membros : [];
  const membroNome = (x) => x.membro === "Família" ? "Família (compartilhado)" : x.membro;
  void membros;
  page.innerHTML = `
    <div class="page-head no-print"><h1>Relatórios</h1><div class="row">
      <button class="btn" id="xCsv">${icon("download", 17)} CSV</button><button class="btn" id="xXls">${icon("download", 17)} Excel</button><button class="btn" id="xPdf">${icon("download", 17)} PDF</button></div></div>
    <div class="card no-print" style="margin-bottom:14px"><div class="row">
      <div class="seg" id="modo"><button data-v="mes" class="${rep.modo === "mes" ? "on" : ""}">Mês</button><button data-v="ano" class="${rep.modo === "ano" ? "on" : ""}">Ano</button><button data-v="periodo" class="${rep.modo === "periodo" ? "on" : ""}">Período</button></div>
      <span id="pnav"></span>
      ${rep.modo === "periodo" ? `<input class="input" type="date" id="pIni" value="${r.inicio}" style="max-width:170px"><span class="muted">até</span><input class="input" type="date" id="pFim" value="${r.fim}" style="max-width:170px">` : ""}
      ${C.memberSeg(() => reportsView(page))}</div></div>
    <div class="print-only"><h1>Relatório financeiro — ${C.esc(P.label)}</h1><p class="muted">Gerado em ${C.dateBR(r.hoje)} · Assistente Financeiro</p></div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Receitas</div><div class="value num income">${C.brl(s.receitas_cents)}</div></div>
      <div class="card kpi"><div class="label">Despesas</div><div class="value num expense">${C.brl(s.despesas_cents)}</div><div class="hint">${s.lancamentos} lançamentos (inclui previstos)</div></div>
      <div class="card kpi hero"><div class="label">Resultado</div><div class="value num">${C.brl(s.receitas_cents - s.despesas_cents)}</div><div class="hint">${s.receitas_cents ? `${pct(s.receitas_cents - s.despesas_cents, s.receitas_cents)}% da receita` : ""}</div></div>
      <div class="card kpi"><div class="label">Patrimônio atual</div><div class="value num">${C.brl(r.patrimonio_atual_cents)}</div><div class="hint">saldo das contas hoje</div></div>
      ${s.investimentos_cents ? `<div class="card kpi"><div class="label">Investido no período</div><div class="value num">${C.brl(s.investimentos_cents)}</div></div>` : ""}
      ${r.faturas_em_aberto_cents ? `<div class="card kpi"><div class="label">A pagar nos cartões</div><div class="value num">${C.brl(r.faturas_em_aberto_cents)}</div><div class="hint">faturas abertas e parcelas futuras</div></div>` : ""}
    </div>
    <div class="grid two" style="margin-top:14px">
      ${r.evolucao.length > 1 ? `<div class="card"><h2>Receitas × despesas por mês</h2><div class="chart" id="r1"></div></div>
        <div class="card"><h2>Evolução do patrimônio</h2><div class="chart" id="r2"></div></div>` : ""}
      <div class="card"><h2>Despesas por categoria</h2><div id="r3"></div>
        ${desp.some((c) => c.subcategorias.length > 1 || c.subcategorias[0]?.nome !== "(sem subcategoria)") ? `<details style="margin-top:8px"><summary class="small" style="cursor:pointer;font-weight:700">Ver subcategorias</summary>
          ${desp.map((c) => `<div class="small" style="margin-top:8px"><b>${c.icone || ""} ${C.esc(c.categoria)}</b>${c.subcategorias.map((sc) => `<div class="kv"><span class="muted">${C.esc(sc.nome)}</span><span class="num">${C.brl(sc.total_cents)}</span></div>`).join("")}</div>`).join("")}</details>` : ""}</div>
      <div class="card"><h2>Receitas por categoria</h2><div class="list">${rec.map((c) => `<div class="kv"><span>${c.icone || ""} ${C.esc(c.categoria)}</span><b class="num income">${C.brl(c.total_cents)}</b></div>`).join("") || `<div class="empty">Nenhuma receita no período.</div>`}</div></div>
      <div class="card"><h2>Por conta e cartão</h2><table class="tbl"><thead><tr><th></th><th>Entradas</th><th>Saídas</th></tr></thead><tbody>
        ${r.por_conta.map((a) => `<tr><td>${a.tipo === "cartao" ? "💳" : "🏦"} ${C.esc(a.conta)}</td><td class="num income">${C.brl(a.receitas_cents)}</td><td class="num expense">${C.brl(a.despesas_cents)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Sem movimentação.</td></tr>`}</tbody></table>
        ${s.faturas_pagas_cents ? `<p class="small muted">Faturas pagas no período: ${C.brl(s.faturas_pagas_cents)} (não somam nas despesas para não contar duas vezes).</p>` : ""}</div>
      <div class="card"><h2>Onde você mais gastou</h2><table class="tbl"><thead><tr><th>Estabelecimento</th><th>Vezes</th><th>Total</th></tr></thead><tbody>
        ${r.por_estabelecimento.slice(0, 12).map((e) => `<tr><td>${C.esc(e.estabelecimento)}</td><td class="num">${e.quantidade}</td><td class="num">${C.brl(e.total_cents)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Sem estabelecimentos identificados.</td></tr>`}</tbody></table></div>
      <div class="card"><h2>Maiores despesas</h2><div class="list">${r.maiores.map(C.txItem).join("") || `<div class="empty">Nenhuma despesa.</div>`}</div></div>
      ${C.family() && !C.state.membro ? `<div class="card"><h2>Por pessoa</h2><table class="tbl"><thead><tr><th></th><th>Receitas</th><th>Despesas</th></tr></thead><tbody>
        ${r.por_membro.map((x) => `<tr><td>${C.esc(membroNome(x))}</td><td class="num income">${C.brl(x.receitas_cents)}</td><td class="num expense">${C.brl(x.despesas_cents)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${mesUnico && r.orcamento?.itens?.length ? `<div class="card"><h2>Orçamento do mês</h2>${r.orcamento.itens.map((x) => `<div class="budget"><div class="kv"><span>${x.icone || ""} ${C.esc(x.categoria)}</span><span class="num">${C.brl(x.gasto_cents)} / ${C.brl(x.limite_cents)}</span></div>${bar(x.percentual, x.situacao === "estourado" ? "bad" : x.situacao === "atencao" ? "warn" : "")}</div>`).join("")}</div>` : ""}
      ${r.metas?.length ? `<div class="card"><h2>Metas</h2>${r.metas.map((g) => `<div class="budget"><div class="kv"><span>${C.esc(g.icone || "🎯")} ${C.esc(g.nome)}</span><span class="num">${C.brl(g.atual_cents)} / ${C.brl(g.objetivo_cents)}</span></div>${bar(g.progresso, g.status === "concluida" ? "ok" : "")}</div>`).join("")}</div>` : ""}
    </div>`;
  // navegação do período
  const pnav = $("#pnav");
  if (rep.modo === "mes") pnav.appendChild(C.monthNav(() => reportsView(page)));
  if (rep.modo === "ano") {
    pnav.innerHTML = `<div class="month-nav"><button aria-label="Ano anterior">${icon("left", 18)}</button><span>${anoAtual}</span><button aria-label="Próximo ano">${icon("right", 18)}</button></div>`;
    const [a, b] = $$("button", pnav);
    a.onclick = () => { rep.ano = String(+anoAtual - 1); reportsView(page); };
    b.onclick = () => { rep.ano = String(+anoAtual + 1); reportsView(page); };
  }
  $("#modo").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    rep.modo = b.dataset.v;
    if (rep.modo === "periodo" && !rep.ini) { rep.ini = r.inicio; rep.fim = r.fim; }
    reportsView(page);
  };
  const onDates = () => { const a = $("#pIni").value, b = $("#pFim").value; if (a && b && a <= b) { rep.ini = a; rep.fim = b; reportsView(page); } };
  $("#pIni")?.addEventListener("change", onDates); $("#pFim")?.addEventListener("change", onDates);
  if (r.evolucao.length > 1) {
    incomeExpenseChart($("#r1"), r.evolucao);
    lineChart($("#r2"), r.evolucao.filter((e) => e.mes <= r.hoje.slice(0, 7)).map((e) => ({ label: `${C.MESES[+e.mes.slice(5, 7) - 1].slice(0, 3)}${r.evolucao.length > 12 ? "/" + e.mes.slice(2, 4) : ""}`, value: Number(e.patrimonio_cents) })));
  }
  if (desp.length) categoryBars($("#r3"), desp); else $("#r3").innerHTML = `<div class="empty">Nenhuma despesa no período.</div>`;

  // exportação
  const reais = (c) => Math.round(Number(c || 0)) / 100;
  const allTx = async () => {
    const out = [];
    let ym = r.inicio.slice(0, 7);
    for (let i = 0; i < 36 && ym <= r.fim.slice(0, 7); i++, ym = C.shiftMonth(ym, 1)) {
      const t = await C.api.rpc("app_transactions", { mes: ym, membro_id: C.state.membro, limite: 1000 });
      out.push(...t.itens.filter((x) => x.data >= r.inicio && x.data <= r.fim));
    }
    return out.sort((a, b) => a.data.localeCompare(b.data));
  };
  const TIPO = { ...C.TIPOS, pagamento_fatura: "Pagamento de fatura" };
  const txRows = (txs) => [["Data", "Tipo", "Descrição", "Categoria", "Subcategoria", "Conta", "Cartão", "De quem", "Situação", "Valor (R$)"],
    ...txs.map((t) => [C.dateBR(t.data), TIPO[t.tipo] || t.tipo, t.descricao, t.categoria || "", t.subcategoria || "", t.conta || "", t.cartao || "", C.family() ? C.memberLabel(t) : "", t.data > r.hoje ? "Previsto" : "Efetivado",
      (t.tipo === "receita" || t.tipo === "resgate" ? 1 : -1) * reais(t.valor_cents)])];
  const busy = async (btn, fn) => { const o = btn.textContent; btn.disabled = true; btn.textContent = "Gerando…"; try { await fn(); } catch (y) { C.toast(y.message); } finally { btn.disabled = false; btn.textContent = o; } };
  $("#xCsv").onclick = (e) => busy(e.target, async () => ex.csv(txRows(await allTx()), `lancamentos-${P.file}.csv`));
  $("#xXls").onclick = (e) => busy(e.target, async () => {
    const txs = await allTx();
    ex.xlsx([
      { name: "Resumo", money: [1], rows: [["Relatório", P.label], ["Receitas", reais(s.receitas_cents)], ["Despesas", reais(s.despesas_cents)], ["Resultado", reais(s.receitas_cents - s.despesas_cents)],
        ["Investimentos", reais(s.investimentos_cents)], ["Faturas pagas", reais(s.faturas_pagas_cents)], ["Patrimônio atual", reais(r.patrimonio_atual_cents)], ["Faturas em aberto", reais(r.faturas_em_aberto_cents)], ["Lançamentos", s.lancamentos]] },
      { name: "Categorias", money: [3], rows: [["Tipo", "Categoria", "Subcategoria", "Total (R$)", "% das despesas"],
        ...r.por_categoria.flatMap((c) => c.subcategorias.map((sc) => [c.tipo === "receita" ? "Receita" : "Despesa", c.categoria, sc.nome, reais(sc.total_cents), c.tipo === "despesa" ? Math.round((sc.total_cents / totD) * 1000) / 10 : ""]))] },
      { name: "Contas e cartões", money: [2, 3], rows: [["Conta/cartão", "Tipo", "Entradas (R$)", "Saídas (R$)"], ...r.por_conta.map((a) => [a.conta, a.tipo === "cartao" ? "Cartão" : "Conta", reais(a.receitas_cents), reais(a.despesas_cents)])] },
      { name: "Estabelecimentos", money: [2], rows: [["Estabelecimento", "Vezes", "Total (R$)"], ...r.por_estabelecimento.map((e2) => [e2.estabelecimento, e2.quantidade, reais(e2.total_cents)])] },
      { name: "Evolução mensal", money: [1, 2, 3, 4], rows: [["Mês", "Receitas (R$)", "Despesas (R$)", "Resultado (R$)", "Patrimônio (R$)"], ...r.evolucao.map((e2) => [e2.mes, reais(e2.receitas_cents), reais(e2.despesas_cents), reais(e2.receitas_cents - e2.despesas_cents), reais(e2.patrimonio_cents)])] },
      ...(r.metas?.length ? [{ name: "Metas", money: [1, 2], rows: [["Meta", "Objetivo (R$)", "Guardado (R$)", "Progresso (%)", "Prazo", "Previsão (estimativa)"], ...r.metas.map((g) => [g.nome, reais(g.objetivo_cents), reais(g.atual_cents), g.progresso, g.prazo ? C.dateBR(g.prazo) : "", g.previsao ? C.dateBR(g.previsao) : ""])] }] : []),
      { name: "Lançamentos", money: [9], rows: txRows(txs) },
    ], `relatorio-${P.file}.xlsx`);
  });
  $("#xPdf").onclick = () => ex.pdf(`Relatório financeiro ${P.label}`);
  C.setRefresh(() => reportsView(page));
}

// =====================================================================
// IMPORTAÇÃO DE EXTRATO (OFX / CSV)
// =====================================================================
export async function importDialog(pref = {}, after) {
  await C.loadBoot();
  const b = C.state.boot;
  C.modal(`<h2>Importar extrato</h2>
    <form id="if" novalidate>
      <div class="field"><label>Arquivo do banco (OFX, CSV, PDF ou foto da fatura)</label><input class="input" type="file" name="arq" accept=".ofx,.qfx,.csv,.txt,text/csv,.pdf,application/pdf,image/jpeg,image/png"></div>
      <div class="field"><label>Os lançamentos são de</label><select class="input" name="destino">${payOptions(true, pref.cartao && b.cartoes?.length ? `k:${b.cartoes[0].id}` : undefined)}</select></div>
      <label class="row small" style="margin-bottom:8px"><input type="checkbox" name="inverter"> Inverter sinais (use se as compras aparecerem como entradas)</label>
      <p class="small muted">O mais preciso é o arquivo <b>OFX</b> (no app ou site do banco: Extrato → Exportar). <b>PDF ou foto</b> da fatura também funcionam: a IA lê os lançamentos (pode levar até 1 minuto) e você confere antes. Nada é salvo antes da sua confirmação, e o que já existe não entra de novo.</p>
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions"><button type="button" class="btn" id="ic">Cancelar</button><button class="btn primary">Ver prévia</button></div>
    </form>`, (m, close) => {
    const f = $("#if", m);
    $("#ic", m).onclick = close;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const file = f.arq.files[0];
      if (!file) return err(m, "Escolha o arquivo.");
      const isDoc = /\.(pdf|jpe?g|png)$/i.test(file.name) || /^(application\/pdf|image\/)/.test(file.type);
      if (isDoc) return readDocument(file, f, m, close, after);
      let parsed;
      try {
        const buf = await file.arrayBuffer();
        let text = new TextDecoder("utf-8").decode(buf);
        if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
        parsed = /<OFX>|OFXHEADER/i.test(text) ? { ...ex.parseOFX(text), ofx: true } : ex.parseCSV(text);
      } catch (y) { return err(m, y.message || "Não consegui ler o arquivo."); }
      if (!parsed.itens.length) return err(m, "Não encontrei lançamentos no arquivo.");
      const [kind, id] = f.destino.value.split(":");
      // No cartão, o motor espera compras com valor positivo. Em OFX de cartão as compras vêm negativas.
      let sign = kind === "k" && parsed.ofx ? -1 : 1;
      if (f.inverter.checked) sign = -sign;
      const itens = parsed.itens.map((i) => ({ ...i, valor: Number.isFinite(i.valor) ? i.valor * sign : null }));
      const dest = kind === "k" ? { cartao_id: id } : { conta_id: id };
      try {
        const prev = await C.api.rpc("app_import", { ...dest, itens });
        close();
        importPreview(prev, itens, dest, f.destino.selectedOptions[0].textContent, after);
      } catch (y) { err(m, y.message); }
    };
  });
}

async function readDocument(file, f, m, close, after) {
  if (file.size > 15_000_000) return err(m, "Arquivo grande demais (máximo 15 MB).");
  const btn = $("button.primary", m);
  btn.disabled = true; btn.textContent = "Lendo a fatura…";
  try {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
    const mime = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "image/jpeg");
    const st = await C.api.ask({ acao: "ler_extrato", arquivo_base64: b64, mime });
    const b = C.state.boot;
    let [kind, id] = f.destino.value.split(":");
    if (st.cartao) { const k = (b.cartoes || []).find((x) => x.nome === st.cartao); if (k) { kind = "k"; id = k.id; } }
    else if (st.conta) { const a = b.contas.contas.find((x) => x.nome === st.conta); if (a) { kind = "c"; id = a.id; } }
    if (st.tipo === "fatura_cartao" && kind !== "k") {
      if (!(b.cartoes || []).length) return err(m, "Isso é uma fatura de cartão. Cadastre o cartão em Cartões antes de importar.");
      if (!f.destino.value.startsWith("k:")) return err(m, "Isso parece uma fatura de cartão: escolha o cartão em “Os lançamentos são de” e tente de novo.");
    }
    const dest = kind === "k" ? { cartao_id: id, vencimento: st.vencimento || null } : { conta_id: id };
    const label = kind === "k" ? `💳 ${(b.cartoes || []).find((x) => x.id === id)?.nome}${st.vencimento ? ` · fatura com vencimento em ${C.dateBR(st.vencimento)}` : ""}` : `🏦 ${b.contas.contas.find((x) => x.id === id)?.nome}`;
    const prev = await C.api.rpc("app_import", { ...dest, itens: st.itens });
    close();
    importPreview(prev, st.itens, dest, label, after, st.total);
  } catch (y) { err(m, y.message); }
  finally { btn.disabled = false; btn.textContent = "Ver prévia"; }
}

function importPreview(prev, itens, dest, destLabel, after, totalDoc) {
  const rows = prev.itens;
  const novas = rows.filter((x) => x.situacao === "nova");
  const cats = (tipo) => C.state.boot.categorias.filter((c) => c.tipo === tipo);
  const SITL = { nova: ["Nova", "ok"], duplicada: ["Já existe", ""], pagamento: ["Pagamento da fatura", ""], invalida: ["Linha inválida", "bad"] };
  C.modal(`<h2>Conferir importação</h2>
    <p class="small muted">${C.esc(destLabel)} · ${rows.length} linhas · <b>${novas.length} novas</b> · ${rows.length - novas.length} serão ignoradas</p>
    ${totalDoc != null ? (() => {
      const soma = rows.filter((x) => x.situacao === "nova" || x.situacao === "duplicada").reduce((t, x) => t + (x.tipo === "despesa" ? x.valor_cents : -x.valor_cents), 0);
      const tot = Math.round(totalDoc * 100);
      return Math.abs(soma - tot) <= 5 ? `<p class="notice" style="background:var(--brand-soft)">✅ A soma confere com o total da fatura (${C.brl(tot)}).</p>`
        : `<p class="notice">⚠️ A soma lida (${C.brl(soma)}) é diferente do total da fatura (${C.brl(tot)}). Pode ser saldo anterior, juros ou uma linha que a IA não leu — confira.</p>`;
    })() : ""}
    <div class="imp-wrap"><table class="tbl imp"><thead><tr><th></th><th>Data</th><th>Descrição</th><th>Categoria</th><th>Valor</th><th></th></tr></thead><tbody>
      ${rows.map((x) => `<tr data-l="${x.linha}" class="${x.situacao !== "nova" ? "off" : ""}">
        <td>${x.situacao === "nova" ? `<input type="checkbox" checked data-ok>` : ""}</td>
        <td class="num">${x.data ? C.dateBR(x.data) : "—"}</td>
        <td>${C.esc(x.descricao || "")}${x.situacao === "duplicada" && x.duplicada_de ? `<div class="small muted">igual a “${C.esc(x.duplicada_de.descricao)}” de ${C.dateBR(x.duplicada_de.data)}</div>` : ""}</td>
        <td>${x.situacao === "nova" ? `<select class="input small" data-cat>${opts(cats(x.tipo).map((c) => [c.id, `${c.icone || ""} ${c.nome}`]), x.categoria_id)}</select>` : ""}</td>
        <td class="num ${x.tipo === "receita" ? "income" : "expense"}">${x.valor_cents ? (x.tipo === "receita" ? "+ " : "− ") + C.brl(x.valor_cents) : ""}</td>
        <td><span class="tag ${SITL[x.situacao]?.[1] || ""}">${SITL[x.situacao]?.[0] || x.situacao}</span></td></tr>`).join("")}
    </tbody></table></div>
    <p class="small muted">Revise as categorias (o assistente sugere pelo nome do estabelecimento). Desmarque o que não quiser importar.</p>
    <div class="modal-actions"><button class="btn" id="pc">Cancelar</button><button class="btn primary" id="pok" ${novas.length ? "" : "disabled"}>Importar ${novas.length}</button></div>`, (m, close) => {
    m.querySelector(".modal").classList.add("wide");
    $("#pc", m).onclick = close;
    const count = () => { const n = $$("[data-ok]:checked", m).length; $("#pok", m).textContent = `Importar ${n}`; $("#pok", m).disabled = !n; };
    m.addEventListener("change", (e) => { if (e.target.matches("[data-ok]")) { e.target.closest("tr").classList.toggle("off", !e.target.checked); count(); } });
    $("#pok", m).onclick = async () => {
      const send = itens.map((it, i) => {
        const tr = $(`tr[data-l="${i + 1}"]`, m);
        const ok = tr?.querySelector("[data-ok]");
        return { ...it, ignorar: ok ? !ok.checked : true, categoria_id: tr?.querySelector("[data-cat]")?.value || null };
      });
      $("#pok", m).disabled = true; $("#pok", m).textContent = "Importando…";
      try {
        const r = await C.api.rpc("app_import", { ...dest, itens: send, confirmar: true });
        close(); C.state.boot = null; C.toast(`${r.importados} lançamento(s) importado(s) ✅`); after?.();
      } catch (y) { C.toast(y.message); $("#pok", m).disabled = false; count(); }
    };
  });
}

// =====================================================================
// Painel: alertas e cartões no dashboard
// =====================================================================
export function alertsHtml(alertas) {
  alertas = (alertas || []).filter((a) => a.tipo !== "acerto" && a.tipo !== "pendente");   // acertos e contas pendentes têm quadro próprio
  if (!alertas.length) return "";
  const cls = { alto: "bad", medio: "warn", bom: "ok" };
  return `<div class="card alerts" style="margin-bottom:14px"><h2 class="h-ico">${icon("bell", 18)} Alertas</h2>${alertas.map((a) => `<div class="alert ${cls[a.nivel] || ""}"><span>${a.icone}</span><span>${C.esc(a.texto)}</span></div>`).join("")}</div>`;
}

// =====================================================================
// Painéis do Início: ao tocar, mostra o que compõe o valor
// =====================================================================
const KPI_TITLES = { resultado: "Resultado do mês", receitas: "Receitas", despesas: "Despesas", saldo: "Saldo em contas", compromissos: "Compromissos futuros",
  faturas: "Faturas do mês", projetado: "Saldo projetado", investimentos: "Investimentos", acertos: "Acertos do mês" };

export async function kpiDialog(k, d, extra, after) {
  await C.loadBoot();
  const base = { mes: C.state.month, membro_id: C.state.membro };
  const sum = (arr) => arr.reduce((t, x) => t + Number(x.valor_cents || 0), 0);
  const txList = (arr, empty) => arr.length ? `<div class="list">${arr.map(C.txItem).join("")}</div>` : `<div class="empty">${empty}</div>`;
  const fatList = (arr) => arr.map((f) => `<div class="item click" data-card="${f.cartao_id}" data-due="${f.vencimento}"><div class="emoji" style="color:${C.esc(f.cor || "inherit")}">💳</div>
    <div class="body"><div class="title">Fatura ${C.esc(f.cartao)}</div><div class="sub">vence ${C.dateBR(f.vencimento)} · ${f.situacao === "fechada" ? "fechada" : f.situacao === "vencida" ? "vencida" : "aberta"}${f.pago_cents ? ` · pago ${C.brl(f.pago_cents)}` : ""}</div></div>
    <div class="amount num">${C.brl(f.restante_cents)}</div></div>`).join("");
  const row = (l, v, cls = "") => `<div class="kv"><span>${l}</span><b class="num ${cls}">${C.brl(v)}</b></div>`;
  let html = "", txs = [], m;
  const close = C.modal(`<h2>${KPI_TITLES[k] || ""}</h2><div id="kd"><div class="empty">Carregando…</div></div>
    <div class="modal-actions"><button class="btn" id="kdc">Fechar</button></div>`, (mm, cl) => { m = mm; $("#kdc", mm).onclick = cl; });
  m.querySelector(".modal").classList.add("wide");
  try {
    if (k === "resultado") {
      const [r, dsp] = await Promise.all([C.api.rpc("app_kpi_detail", { ...base, painel: "receitas" }), C.api.rpc("app_kpi_detail", { ...base, painel: "despesas" })]);
      txs = [...r.lancamentos, ...dsp.lancamentos];
      html = `<div class="card" style="margin-bottom:12px">${row("Receitas", sum(r.lancamentos), "income")}${row("− Despesas", sum(dsp.lancamentos), "expense")}<hr style="border:0;border-top:1px solid var(--line)">${row("= Resultado", sum(r.lancamentos) - sum(dsp.lancamentos))}</div>
        <h3 class="small">Receitas</h3>${txList(r.lancamentos, "Nenhuma receita até hoje.")}<h3 class="small" style="margin-top:14px">Despesas</h3>${txList(dsp.lancamentos, "Nenhuma despesa até hoje.")}`;
    } else if (k === "receitas") {
      const [r, prev] = await Promise.all([C.api.rpc("app_kpi_detail", { ...base, painel: "receitas" }), C.api.rpc("app_kpi_detail", { ...base, painel: "previstas" })]);
      txs = [...r.lancamentos, ...prev.lancamentos];
      html = txList(r.lancamentos, "Nenhuma receita até hoje.") + (prev.lancamentos.length ? `<h3 class="small" style="margin-top:14px">Previstas (ainda vão entrar) — ${C.brl(sum(prev.lancamentos))}</h3>${txList(prev.lancamentos, "")}` : "");
    } else if (k === "despesas" || k === "investimentos") {
      const r = await C.api.rpc("app_kpi_detail", { ...base, painel: k });
      txs = r.lancamentos;
      const byCat = new Map();
      if (k === "despesas") for (const t of txs) byCat.set(t.categoria || "Outros", (byCat.get(t.categoria || "Outros") || 0) + t.valor_cents);
      html = (byCat.size > 1 ? `<div class="card" style="margin-bottom:12px">${[...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => row(C.esc(c), v)).join("")}</div>` : "") +
        txList(txs, "Nada lançado até hoje.");
    } else if (k === "saldo") {
      const r = await C.api.rpc("app_kpi_detail", { ...base, painel: "saldo" });
      html = `<div class="list">${(r.contas || []).filter((a) => a.status === "ativa").map((a) => `<div class="item"><div class="emoji">${a.tipo === "dinheiro" ? "💵" : a.tipo === "poupanca" ? "🐷" : a.tipo === "investimento" ? "📈" : "🏦"}</div>
        <div class="body"><div class="title">${C.esc(a.nome)}</div><div class="sub">${C.family() ? (a.membro_id === null ? "Família" : C.esc(a.membro)) : ""}</div></div>
        <div class="amount num ${a.saldo_cents < 0 ? "expense" : ""}">${C.brl(a.saldo_cents)}</div></div>`).join("") || `<div class="empty">Nenhuma conta ${extra.quem}. Cadastre em <a href="#/contas">Contas</a>.</div>`}</div>
        <p class="small muted">Saldo inicial de cada conta + entradas − saídas até hoje. Compras no cartão só saem da conta quando a fatura é paga.</p>`;
    } else if (k === "compromissos" || k === "faturas") {
      const r = await C.api.rpc("app_kpi_detail", { ...base, painel: k });
      txs = r.lancamentos;
      html = (k === "compromissos" ? `<h3 class="small">Contas a pagar até o fim do mês — ${C.brl(sum(txs))}</h3>${txList(txs, "Nenhuma conta a pagar lançada.")}<h3 class="small" style="margin-top:14px">Faturas de cartão</h3>` : "") +
        (r.faturas.length ? `<div class="list">${fatList(r.faturas)}</div>` : `<div class="empty">Nenhuma fatura a pagar até o fim do mês.</div>`);
    } else if (k === "acertos") {
      html = `<div id="kdDebts"></div>`;
    } else if (k === "projetado") {
      html = `<div class="card">${row("Saldo em contas hoje", Number(d.saldo_contas_cents))}${row("+ Receitas previstas", Number(d.receitas_previstas_cents), "income")}
        ${row("− Compromissos (contas e faturas)", Number(d.compromissos_futuros_cents), "expense")}
        ${extra.aPagar ? row("− Acertos a pagar", extra.aPagar, "expense") : ""}${extra.aReceber ? row("+ Acertos a receber", extra.aReceber, "income") : ""}
        <hr style="border:0;border-top:1px solid var(--line)">${row("= Saldo projetado", extra.projetado)}</div>
        <p class="small muted">Estimativa feita só com o que está lançado no app. Toque nos outros painéis para ver cada parte.</p>`;
    }
    $("#kd", m).innerHTML = html;
    if (k === "acertos") debtsCard($("#kdDebts", m), () => { close(); after?.(); }, true);
    C.bindTxClicks($("#kd", m), { find: (fn) => txs.find(fn) }, () => { close(); after?.(); });
    $("#kd", m).addEventListener("click", (e) => {
      const f = e.target.closest("[data-card]"); if (!f) return;
      const card = (C.state.boot.cartoes || []).find((x) => x.id === f.dataset.card);
      if (card) { close(); invoiceDialog(card, f.dataset.due, after); }
    });
  } catch (y) { $("#kd", m).innerHTML = `<div class="empty">${C.esc(y.message)}</div>`; }
}

// =====================================================================
// Acertos da família (gastos divididos)
// =====================================================================
export async function debtsCard(host, after, inline = false) {
  if (!host) return;
  await C.loadBoot();
  let d;
  try { d = await C.api.rpc("app_debts"); } catch { return; }
  if (!d.devo.length && !d.recebo.length) { host.innerHTML = inline ? `<div class="empty">Nenhum acerto pendente. 👍</div>` : ""; return; }
  const first = (n) => C.esc(String(n || "").split(" ")[0]);
  const block = (x, devo) => `<div class="acerto ${devo ? "bad" : "ok"}">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div><b>${devo ? `Você deve ${C.brl(x.total_cents)} para ${first(x.pessoa)}` : `${first(x.pessoa)} deve ${C.brl(x.total_cents)} para você`}</b>
      <div class="small muted">${x.itens.length} gasto(s) dividido(s) até ${C.dateBR(d.ate)}</div></div>
      <div class="row"><button class="btn small primary" data-pay="${x.pessoa_id}" data-v="${x.total_cents}" data-devo="${devo ? 1 : 0}" data-nome="${C.esc(x.pessoa)}">${devo ? "Paguei" : "Recebi"}</button>
      <button class="btn small" data-ok="${x.pessoa_id}">OK</button></div></div>
    <details><summary class="small" style="cursor:pointer">Ver gastos</summary><div class="list">${x.itens.map((t) => `<div class="item"><div class="emoji">${t.icone || "•"}</div>
      <div class="body"><div class="title">${C.esc(t.descricao)}</div><div class="sub">${C.dateBR(t.data)}${t.cartao ? ` · 💳 ${C.esc(t.cartao)}` : t.conta ? ` · ${C.esc(t.conta)}` : ""}</div></div>
      <div class="amount num">${C.brl(t.valor_cents)}</div></div>`).join("")}</div></details></div>`;
  host.innerHTML = `<div class="${inline ? "" : "card "}alerts" style="${inline ? "" : "margin-bottom:14px"}">${inline ? "" : "<h2>🤝 Acertos do mês</h2>"}
    ${d.devo.map((x) => block(x, true)).join("")}${d.recebo.map((x) => block(x, false)).join("")}
    ${d.futuro_cents ? `<p class="small muted">+ ${C.brl(d.futuro_cents)} de parcelas divididas nos próximos meses.</p>` : ""}</div>`;
  host.onclick = async (e) => {
    const pay = e.target.closest("[data-pay]"), ok = e.target.closest("[data-ok]");
    if (ok) {
      if (!(await C.confirmBox("Dispensar este acerto? Os gastos continuam lançados, só não fica nada a pagar (nenhum lançamento é feito).", "Dispensar"))) return;
      try { await C.api.rpc("app_settle", { pessoa_id: ok.dataset.ok, acao: "dispensar" }); C.toast("Acerto dispensado"); after?.(); } catch (y) { C.toast(y.message); }
    }
    if (pay) settleDialog(pay.dataset.pay, Number(pay.dataset.v), pay.dataset.devo === "1", pay.dataset.nome, after);
  };
}

async function settleDialog(pessoaId, valor, devo, nome, after) {
  const b = await C.loadBoot(), me = b.perfil.id;
  const contas = b.contas.contas.filter((a) => a.status === "ativa");
  const debtor = devo ? me : pessoaId, creditor = devo ? pessoaId : me;
  const accOpts = (owner) => {
    const own = contas.filter((a) => a.membro_id === owner), rest = contas.filter((a) => a.membro_id !== owner);
    return opts([...own, ...rest].map((a) => [a.id, `${a.nome}${a.membro_id === null ? " (família)" : a.membro_id !== owner ? ` (de ${(a.membro || "").split(" ")[0]})` : ""}`]), own[0]?.id);
  };
  const first = String(nome || "").split(" ")[0];
  C.modal(`<h2>${devo ? `Pagar ${C.brl(valor)} para ${C.esc(first)}` : `Receber ${C.brl(valor)} de ${C.esc(first)}`}</h2>
    <form id="sf" novalidate>
      <div class="row">
        <div class="field"><label>Data</label><input class="input" type="date" name="data" value="${C.todayISO()}"></div>
        <div class="field"><label>Forma de pagamento</label><select class="input" name="forma">${opts([["pix", "Pix"], ["transferencia", "Transferência"], ["dinheiro", "Dinheiro"], ["outro", "Outro"]], "pix")}</select></div></div>
      <div class="row">
        <div class="field"><label>Saiu da conta (de quem pagou)</label><select class="input" name="origem">${accOpts(debtor)}</select></div>
        <div class="field"><label>Entrou na conta (de quem recebeu)</label><select class="input" name="destino">${accOpts(creditor)}</select></div></div>
      <p class="small muted">Lanço uma <b>transferência</b> entre as contas — não conta como despesa nova, porque cada um já tem a sua parte lançada.</p>
      <p class="small expense hidden form-err"></p>
      <div class="modal-actions"><button type="button" class="btn" id="sc">Cancelar</button><button class="btn primary">Registrar pagamento</button></div>
    </form>`, (m, close) => {
    const f = $("#sf", m);
    $("#sc", m).onclick = close;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (f.origem.value && f.origem.value === f.destino.value) return err(m, "Escolha contas diferentes.");
      try {
        const r = await C.api.rpc("app_settle", { pessoa_id: pessoaId, acao: "pago", data: f.data.value, forma: f.forma.value, conta_origem_id: f.origem.value || null, conta_destino_id: f.destino.value || null });
        if (r.status === "nothing") return err(m, "Não há nada pendente.");
        close(); C.state.boot = null; C.toast(`Acerto de ${C.brl(r.valor_cents)} registrado ✅`); after?.();
      } catch (y) { err(m, y.message); }
    };
  });
}

// =====================================================================
// Formulário de lançamento: dividir a compra
// =====================================================================
/** Monta a área "Dividir" dentro do formulário; devolve { show(bool), partes(total) } */
export function splitArea(host, payDefault) {
  const b = C.state.boot, membros = b.familia.membros;
  const contas = b.contas.contas.filter((a) => a.status === "ativa");
  const payOpts = (sel) => opts([...contas.map((a) => [`c:${a.id}`, `🏦 ${a.nome}`]), ...(b.cartoes || []).map((k) => [`k:${k.id}`, `💳 ${k.nome}`])], sel);
  host.innerHTML = `<div class="split-box"><div class="small muted" style="margin-bottom:6px">Cada um com a sua parte. Se a parte de alguém for paga com cartão/conta de outra pessoa, vira <b>acerto</b> entre vocês.</div>
    ${membros.map((mm) => `<div class="row split-row" data-m="${mm.id}">
      <span class="split-name">${mm.eu ? "Eu" : C.esc(mm.nome.split(" ")[0])}</span>
      <input class="input num" data-v inputmode="decimal" placeholder="R$ 0,00" style="max-width:110px">
      <select class="input" data-p>${payOpts(payDefault())}</select></div>`).join("")}
    <p class="small muted" data-sum></p></div>`;
  let manual = false;
  const rows = () => [...host.querySelectorAll(".split-row")];
  host.addEventListener("input", (e) => { if (e.target.matches("[data-v]")) manual = true; });
  return {
    fill(total) {
      if (manual || !(total > 0)) return;
      const cents = Math.round(total * 100), n = rows().length;
      rows().forEach((r, i) => { r.querySelector("[data-v]").value = C.moneyInput(Math.floor(cents / n) + (i === 0 ? cents % n : 0)); });
    },
    syncPay(v) { rows().forEach((r) => { r.querySelector("[data-p]").value = v; }); },
    partes() {
      return rows().map((r) => {
        const [kind, id] = r.querySelector("[data-p]").value.split(":");
        return { membro_id: r.dataset.m, valor: C.parseMoney(r.querySelector("[data-v]").value), ...(kind === "k" ? { cartao_id: id } : { conta_id: id }) };
      });
    },
  };
}

// ---------------------------------------------------------------- PENDÊNCIAS (início)
const diasEntre = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
function quando(t, hoje) {
  const n = diasEntre(t.data, hoje);
  const verbo = t.tipo === "receita" ? "previsto" : "vence";
  if (n > 1) return `${t.tipo === "receita" ? "atrasado" : "venceu"} há ${n} dias (${C.dateBR(t.data)})`;
  if (n === 1) return `${t.tipo === "receita" ? "era para" : "venceu"} ontem`;
  if (n === 0) return `${verbo} hoje`;
  if (n === -1) return `${verbo} amanhã`;
  return `${verbo} em ${C.dateBR(t.data)}`;
}

let pendOpen = false;   // a lista fica aberta enquanto a pessoa estiver usando o app
/** Pendências: botão-resumo no início; ao tocar, abre a lista (contas com 👎/👍 e acertos da família). */
export async function pendingCard(host, membro, after) {
  if (!host) return;
  let d;
  try { d = await C.api.rpc("app_pending", { membro_id: membro || "" }); } catch { host.innerHTML = ""; return; }
  const all = [...d.atrasados, ...d.proximos];
  const fam = (d.acertos_devo.length + d.acertos_recebo.length) > 0;
  const atrasadoPagar = d.atrasados.filter((t) => t.tipo === "despesa").reduce((s, t) => s + Number(t.valor_cents), 0);
  const atrasadoReceber = d.atrasados.filter((t) => t.tipo === "receita").reduce((s, t) => s + Number(t.valor_cents), 0);
  if (!all.length && !fam) {
    host.innerHTML = `<div class="pend-ok" role="status">${icon("check", 16)} Nada atrasado. Contas em dia.</div>`;
    return;
  }
  const nA = d.atrasados.length, nP = d.proximos.length;
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const deve = d.acertos_recebo.reduce((s2, x) => s2 + Number(x.total_cents), 0), devo = d.acertos_devo.reduce((s2, x) => s2 + Number(x.total_cents), 0);
  const titulo = nA ? `${plural(nA, "pendência em atraso", "pendências em atraso")}${nP ? ` · ${nP} vencendo` : ""}`
    : nP ? `${plural(nP, "conta vencendo", "contas vencendo")} nos próximos 7 dias` : "Acertos da família pendentes";
  const detalhe = [atrasadoPagar && `${C.brl(atrasadoPagar)} a pagar`, atrasadoReceber && `${C.brl(atrasadoReceber)} a receber`,
    !nA && nP && C.brl(d.proximos.reduce((s2, t) => s2 + Number(t.valor_cents), 0)),
    deve && `te devem ${C.brl(deve)}`, devo && `você deve ${C.brl(devo)}`].filter(Boolean).join(" · ");
  const row = (t) => {
    const late = t.data < d.hoje;
    return `<div class="pend-item ${late ? "late" : ""}" data-id="${t.id}">
      <div class="emoji">${t.icone || (t.tipo === "receita" ? "💰" : "🧾")}</div>
      <div class="body"><div class="title">${C.esc(t.descricao || t.categoria || "Lançamento")}</div>
        <div class="sub">${t.tipo === "receita" ? "A receber" : "A pagar"} · ${quando(t, d.hoje)}${t.conta ? ` · ${C.esc(t.conta)}` : ""}</div></div>
      <div class="amount num ${t.tipo === "receita" ? "income" : "expense"}">${C.brl(t.valor_cents)}</div>
      <button class="thumb" data-pay="${t.id}" aria-label="${t.tipo === "receita" ? "Marcar como recebido" : "Marcar como pago"}" title="${t.tipo === "receita" ? "Ainda não recebido — toque quando receber" : "Ainda não pago — toque quando pagar"}">${icon("down", 20)}</button>
    </div>`;
  };
  const resumo = [atrasadoPagar && `<span class="expense">${C.brl(atrasadoPagar)} a pagar em atraso</span>`,
    atrasadoReceber && `<span class="income">${C.brl(atrasadoReceber)} a receber em atraso</span>`].filter(Boolean).join(" · ");
  host.innerHTML = `<button type="button" class="pend-btn ${nA ? "late" : "soon"}" aria-expanded="${pendOpen}" aria-controls="pendList">
      <span class="pend-btn-ico">${icon(nA ? "bell" : "clock", 18)}</span>
      <span class="pend-btn-txt"><b>${titulo}</b>${detalhe ? `<span>${detalhe}</span>` : ""}</span>
      <span class="pend-btn-cta">${pendOpen ? "Ocultar" : "Ver"} ${icon("right", 16, pendOpen ? "rot90" : "")}</span>
    </button>
    <section class="card pend ${pendOpen ? "" : "hidden"}" id="pendList" aria-label="Pendências">
    ${d.atrasados.length ? `<div class="pend-label late">Em atraso</div>${d.atrasados.map(row).join("")}` : ""}
    ${d.proximos.length ? `<div class="pend-label">Próximos 7 dias</div>${d.proximos.map(row).join("")}` : ""}
    ${fam ? `<div class="pend-label">Acertos da família</div><div id="pendAcertos"></div>` : ""}
    ${all.length ? `<p class="small muted pend-tip">Pagou ou recebeu? Toque no ${icon("down", 15)} — ele vira ${icon("up", 15)} e o item sai da lista.</p>` : ""}
  </section>`;
  if (fam) debtsCard($("#pendAcertos", host), after, true);
  host.querySelector(".pend-btn").onclick = () => { pendOpen = !pendOpen; pendingCard(host, membro, after); };
  host.querySelector(".pend").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pay]");
    if (!b || b.disabled) return;
    const it = b.closest(".pend-item");
    b.disabled = true; b.classList.add("done"); b.innerHTML = icon("up", 20);
    navigator.vibrate?.(20);
    try {
      await C.api.rpc("app_set_paid", { id: b.dataset.pay, pago: true });
      const t = all.find((x) => x.id === b.dataset.pay);
      C.toast(t?.tipo === "receita" ? "Recebido 👍" : "Pago 👍");
      setTimeout(() => { it.classList.add("gone"); setTimeout(() => { it.remove(); after?.(); }, 350); }, 700);
    } catch (y) {
      b.disabled = false; b.classList.remove("done"); b.innerHTML = icon("down", 20); C.toast(y.message);
    }
  });
}

/** Botão "+": escolher o que lançar. */
export function newEntryMenu(after) {
  const opt = (k, ic, t, s) => `<button class="pick" data-k="${k}"><span class="pick-ico ${k}">${icon(ic, 20)}</span><span><b>${t}</b><span class="small muted">${s}</span></span></button>`;
  C.modal(`<h2>Novo lançamento</h2><div class="picks">
      ${opt("despesa", "wallet", "Despesa", "Algo que você já pagou")}
      ${opt("receita", "download", "Receita", "Dinheiro que entrou")}
      ${opt("apagar", "calendar", "Conta a pagar", "Vence numa data; eu lembro você")}
      ${opt("areceber", "clock", "A receber", "Valor que ainda vai entrar")}
      ${opt("transferencia", "repeat", "Transferência", "Entre suas contas")}
    </div>`, (m, close) => {
    m.querySelector(".picks").onclick = (e) => {
      const k = e.target.closest("[data-k]")?.dataset.k;
      if (!k) return;
      close();
      const preset = { despesa: { tipo: "despesa" }, receita: { tipo: "receita" }, apagar: { tipo: "despesa", pendente: true },
        areceber: { tipo: "receita", pendente: true }, transferencia: { tipo: "transferencia" } }[k];
      C.txForm(null, after, preset);
    };
  });
}
