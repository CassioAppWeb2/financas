// Assistente Financeiro — aplicativo Web/PWA (sem build, sem dependências).
import * as api from "./api.js";
import { brl, incomeExpenseChart, lineChart, categoryBars } from "./charts.js";
import * as F2 from "./fase2.js";
import { icon, logo } from "./icons.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = $("#root");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const TIPOS = { despesa: "Despesa", receita: "Receita", transferencia: "Transferência", investimento: "Investimento", resgate: "Resgate" };
const TIPO_LABEL = { ...TIPOS, pagamento_fatura: "Pagamento de fatura" };
const ACC_TYPES = { corrente: "Conta corrente", digital: "Conta digital", poupanca: "Poupança", dinheiro: "Dinheiro", investimento: "Investimentos", outro: "Outro" };

const state = { boot: null, month: null, membro: "" };
const family = () => (state.boot?.familia?.membros?.length ?? 0) > 1;
const meId = () => state.boot?.perfil?.id;
const memberLabel = (t) => t.membro_id === null ? "Família" : t.membro_id === meId() ? "Você" : (t.membro || "");

/** Seletor "de quem": Todos | cada pessoa | Compartilhado */
function memberSeg(onChange) {
  if (!family()) return "";
  const opts = [["", "Todos"], ...state.boot.familia.membros.map((m) => [m.id, m.eu ? "Eu" : m.nome.split(" ")[0]]), ["familia", "Compartilhado"]];
  setTimeout(() => {
    const el = $("#memberSeg");
    if (el) el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.membro = b.dataset.v; onChange(); };
  });
  return `<div class="seg" id="memberSeg">${opts.map(([v, l]) => `<button data-v="${v}" class="${state.membro === v ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
}

// ---------------------------------------------------------------- utilidades
const htmlEl = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
const dateBR = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
const monthTitle = (ym) => `${MESES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const shiftMonth = (ym, n) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

/** "1.500,00" -> 1500 ; "87,5" -> 87.5 ; "1500.50" -> 1500.5 */
function parseMoney(s) {
  let v = String(s ?? "").replace(/[R$\s]/g, "");
  if (!v) return NaN;
  if (v.includes(",")) v = v.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(v)) v = v.replace(/\./g, "");
  return Number(v);
}
const moneyInput = (cents) => (cents == null ? "" : (Number(cents) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Markdown leve das respostas do assistente, sempre escapado antes. */
function md(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*(\S[^*\n]*?)\*/g, "$1<strong>$2</strong>").replace(/(^|\s)_(\S[^_\n]*?)_/g, "$1<em>$2</em>");
}

async function loadBoot(force = false) {
  if (!state.boot || force) state.boot = await api.rpc("app_bootstrap");
  if (!state.month) state.month = String(state.boot.hoje).slice(0, 7);
  return state.boot;
}

function modal(html, onMount) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => back.remove();
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  onMount?.(back, close);
  $("input, select, textarea", back)?.focus();
  return close;
}

function confirmBox(text, okLabel = "Confirmar", danger = false) {
  return new Promise((resolve) => {
    modal(`<h2>${esc(text)}</h2><div class="modal-actions"><button class="btn" data-no>Cancelar</button><button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(okLabel)}</button></div>`,
      (m, close) => {
        $("[data-no]", m).onclick = () => { close(); resolve(false); };
        $("[data-ok]", m).onclick = () => { close(); resolve(true); };
      });
  });
}

// ---------------------------------------------------------------- navegação
const NAV = [
  { href: "#/", ico: "home", label: "Dashboard", short: "Início" },
  { href: "#/assistente", ico: "chat", label: "Assistente", short: "Assistente" },
  { href: "#/lancamentos", ico: "list", label: "Lançamentos", short: "Lançamentos" },
  { href: "#/contas", ico: "bank", label: "Contas", short: "Contas" },
  { href: "#/cartoes", ico: "card", label: "Cartões" },
  { href: "#/relatorios", ico: "chart", label: "Relatórios" },
  { href: "#/metas", ico: "target", label: "Metas" },
  { href: "#/orcamentos", ico: "budget", label: "Orçamentos" },
  { href: "#/fixas", ico: "repeat", label: "Contas fixas" },
  { href: "#/categorias", ico: "tag", label: "Categorias" },
  { href: "#/configuracoes", ico: "settings", label: "Configurações" },
];
const BOTTOM = [NAV[0], NAV[1], NAV[2], NAV[3], { href: "#/mais", ico: "more", short: "Mais" }];

function shell(route) {
  const active = (h) => (h === "#/" ? route === "" : route.startsWith(h.slice(2)) && h !== "#/") ? "active" : "";
  root.innerHTML = `
  <div class="app">
    <nav class="sidebar" aria-label="Menu">
      <div class="brand">${logo(34)}<div><div class="brand-name">Finanças</div><div class="brand-sub">Assistente da casa</div></div></div>
      ${NAV.map((n) => `<a class="nav-link ${active(n.href)}" href="${n.href}"><span class="ico">${icon(n.ico, 19)}</span>${n.label}</a>`).join("")}
    </nav>
    <main class="main" id="page"></main>
    <nav class="bottom-nav" aria-label="Menu">
      ${BOTTOM.map((n) => `<a class="${n.href === "#/mais" ? (["mais", "categorias", "configuracoes", "cartoes", "relatorios", "metas", "orcamentos", "fixas"].some((r) => route.startsWith(r)) ? "active" : "") : active(n.href)}" href="${n.href}"><span class="ico">${icon(n.ico, 22)}</span>${n.short}</a>`).join("")}
    </nav>
  </div>`;
  return $("#page");
}

async function router(opts) {
  if (!api.configured()) return setupView();
  if (!api.getSession()) return authView();
  const silent = opts?.silent === true && $("#page");
  const route = location.hash.replace(/^#\/?/, "");
  viewRefresh = null;
  const page = silent ? $("#page") : shell(route);
  const y = window.scrollY, py = page.scrollTop;
  if (!silent) page.innerHTML = `<div class="empty">Carregando…</div>`;
  try {
    await loadBoot();
    if (route === "") await dashboard(page);
    else if (route.startsWith("assistente")) await chat(page);
    else if (route.startsWith("lancamentos")) await transactions(page);
    else if (route.startsWith("contas")) await accounts(page);
    else if (route.startsWith("categorias")) await categories(page);
    else if (route.startsWith("configuracoes")) await settings(page);
    else if (route.startsWith("cartoes")) await F2.cardsView(page);
    else if (route.startsWith("relatorios")) await F2.reportsView(page);
    else if (route.startsWith("metas")) await F2.goalsView(page);
    else if (route.startsWith("orcamentos")) await F2.budgetsView(page);
    else if (route.startsWith("fixas")) await F2.recurringView(page);
    else if (route.startsWith("mais")) more(page);
    else if (route.startsWith("em-breve")) location.hash = "#/" + ({ recorrencias: "fixas" }[route.split("/")[1]] || route.split("/")[1] || "");
    else location.hash = "#/";
    if (silent && !route.startsWith("assistente")) { window.scrollTo(0, y); page.scrollTop = py; }
  } catch (e) {
    if (!silent) page.innerHTML = `<div class="empty"><div class="big">${icon("bell", 34)}</div><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Tentar de novo</button></div>`;
  }
}

// ---------------------------------------------------------------- atualização automática
// A cada 15 s (e sempre que o app volta para a tela) pergunta ao banco se algo mudou —
// por exemplo, um gasto registrado pelo Telegram — e atualiza a tela sozinho.
let viewRefresh = null, lastChanges = null, refreshing = false, chatSending = false;
async function markSeen() { try { lastChanges = await api.rpc("app_changes"); } catch { /* sem conexão */ } }
async function checkChanges() {
  if (refreshing || document.hidden || !api.configured() || !api.getSession()) return;
  let v;
  try { v = await api.rpc("app_changes"); } catch { return; }
  const prev = lastChanges;
  if (!prev) { lastChanges = v; return; }
  const dados = prev.lancamentos !== v.lancamentos || prev.cadastros !== v.cadastros;
  const conversa = prev.chat !== v.chat;
  if (!dados && !conversa) return;
  if (document.querySelector(".modal-back")) return; // espera fechar o formulário aberto
  const route = location.hash.replace(/^#\/?/, "");
  const noChat = route.startsWith("assistente");
  if (noChat && (chatSending || $("#txt")?.value)) return;
  lastChanges = v;
  if (prev.cadastros !== v.cadastros || prev.lancamentos !== v.lancamentos) state.boot = null;
  refreshing = true;
  try {
    if (noChat) { if (conversa) await router({ silent: true }); }
    else if (dados) { if (viewRefresh) { await loadBoot(); await viewRefresh(); } else await router({ silent: true }); }
  } finally { refreshing = false; }
}
setInterval(checkChanges, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkChanges(); });
window.addEventListener("focus", () => checkChanges());

// ---------------------------------------------------------------- telas sem login
function setupView() {
  root.innerHTML = `<div class="auth"><div class="card">${logo(48)}<h1>Quase pronto</h1>
  <p class="lead">Preencha <code>web/js/config.js</code> com a URL e a chave pública do seu projeto Supabase. As instruções estão no README.</p></div></div>`;
}

function authView(mode = "entrar") {
  const signup = mode === "criar";
  root.innerHTML = `
  <div class="auth"><form class="card" id="authForm" novalidate>
    ${logo(48)}
    <h1>${signup ? "Criar sua conta" : "Bem-vindo de volta"}</h1>
    <p class="lead">${signup ? "Controle suas finanças só conversando." : "Entre para falar com seu assistente financeiro."}</p>
    ${signup ? `<div class="field"><label for="name">Seu nome</label><input class="input" id="name" autocomplete="name" required></div>` : ""}
    <div class="field"><label for="email">E-mail</label><input class="input" id="email" type="email" autocomplete="email" required></div>
    <div class="field"><label for="pass">Senha</label><input class="input" id="pass" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="6" required></div>
    <p class="small expense hidden" id="authErr"></p>
    <button class="btn primary" style="width:100%;justify-content:center;padding:12px" id="authBtn">${signup ? "Criar conta" : "Entrar"}</button>
    <p class="small muted" style="text-align:center;margin-top:16px">${signup ? "Já tem conta?" : "Ainda não tem conta?"}
      <a href="#" id="swap">${signup ? "Entrar" : "Criar conta"}</a></p>
  </form></div>`;
  $("#swap").onclick = (e) => { e.preventDefault(); authView(signup ? "entrar" : "criar"); };
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#authErr"), btn = $("#authBtn");
    err.classList.add("hidden");
    const email = $("#email").value.trim(), pass = $("#pass").value;
    if (!email || pass.length < 6) { err.textContent = "Informe e-mail e uma senha com pelo menos 6 caracteres."; err.classList.remove("hidden"); return; }
    btn.disabled = true;
    try {
      if (signup) {
        const r = await api.signUp($("#name").value.trim(), email, pass);
        if (r.confirm) {
          root.innerHTML = `<div class="auth"><div class="card"><div class="brand-mark">${icon("chat", 24)}</div><h1>Confirme seu e-mail</h1>
          <p class="lead">Enviamos um link para <b>${esc(email)}</b>. Depois de confirmar, volte aqui e entre.</p>
          <button class="btn primary" onclick="location.reload()">Ir para o login</button></div></div>`;
          return;
        }
      } else await api.signIn(email, pass);
      state.boot = null; state.month = null;
      location.hash = signup ? "#/assistente" : "#/";
      router();
    } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); }
    finally { btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- DASHBOARD
function monthNav(onChange) {
  const wrap = document.createElement("div");
  wrap.className = "month-nav";
  wrap.innerHTML = `<button aria-label="Mês anterior">${icon("left", 18)}</button><span>${monthTitle(state.month)}</span><button aria-label="Próximo mês">${icon("right", 18)}</button>`;
  const [prev, next] = $$("button", wrap);
  prev.onclick = () => { state.month = shiftMonth(state.month, -1); onChange(); };
  next.onclick = () => { state.month = shiftMonth(state.month, 1); onChange(); };
  return wrap;
}

async function dashboard(page) {
  await loadBoot();
  const d = await api.rpc("app_dashboard", { mes: state.month, membro_id: state.membro });
  const current = d.mes === String(d.hoje).slice(0, 7);
  const resultado = d.receitas_cents - d.despesas_cents;
  const aPagar = Number(d.acertos_a_pagar_cents || 0), aReceber = Number(d.acertos_a_receber_cents || 0);
  const projetado = Number(d.saldo_contas_cents) + Number(d.receitas_previstas_cents) - Number(d.compromissos_futuros_cents) - aPagar + aReceber;
  const nome = state.boot.perfil?.nome;
  const mSel = family() && state.membro ? (state.membro === "familia" ? null : state.boot.familia.membros.find((m) => m.id === state.membro)) : undefined;
  const quem = !family() || !state.membro ? "" : state.membro === "familia" ? "da família (conjuntas)" : mSel?.eu ? "suas" : `de ${mSel?.nome?.split(" ")[0] ?? ""}`;
  page.innerHTML = `
    <div class="page-head"><h1>${current ? `Olá${nome ? `, ${esc(nome)}` : ""} ` : "Dashboard"}</h1><div class="row">${memberSeg(() => dashboard(page))}<span id="mnav"></span></div></div>
    ${current ? F2.alertsHtml(d.alertas) : ""}
    <div id="acertos"></div>
    <div class="grid kpis" id="kpis">
      <button class="card kpi hero click" data-k="resultado"><div class="label">Resultado do mês</div><div class="value num">${brl(resultado)}</div><div class="hint">receitas − despesas ${current ? "até hoje" : ""}</div></button>
      <button class="card kpi click" data-k="receitas"><div class="label">Receitas</div><div class="value num income">${brl(d.receitas_cents)}</div>${d.receitas_previstas_cents ? `<div class="hint">+ ${brl(d.receitas_previstas_cents)} previstas</div>` : ""}</button>
      <button class="card kpi click" data-k="despesas"><div class="label">Despesas</div><div class="value num expense">${brl(d.despesas_cents)}</div></button>
      <button class="card kpi click" data-k="saldo"><div class="label">Saldo em contas</div><div class="value num">${brl(d.saldo_contas_cents)}</div><div class="hint">${quem ? `contas ${quem}, hoje` : "hoje"}</div></button>
      <button class="card kpi click" data-k="compromissos"><div class="label">Compromissos futuros</div><div class="value num">${brl(d.compromissos_futuros_cents)}</div><div class="hint">contas a pagar e faturas até o fim do mês</div></button>
      ${d.faturas_mes_cents ? `<button class="card kpi click" data-k="faturas"><div class="label">Faturas do mês</div><div class="value num">${brl(d.faturas_mes_cents)}</div><div class="hint">${quem ? `cartões ${quem}` : "todos os cartões"}</div></button>` : ""}
      ${aPagar || aReceber ? `<button class="card kpi click" data-k="acertos"><div class="label">Acertos (gastos divididos)</div><div class="value num ${aPagar > aReceber ? "expense" : "income"}">${brl(Math.abs(aPagar - aReceber))}</div><div class="hint">${aPagar > aReceber ? "a pagar" : "a receber"} no mês</div></button>` : ""}
      ${current ? `<button class="card kpi click" data-k="projetado"><div class="label">Saldo projetado</div><div class="value num">${brl(projetado)}</div><div class="hint">estimativa p/ fim do mês</div></button>` : ""}
      ${d.investimentos_cents ? `<button class="card kpi click" data-k="investimentos"><div class="label">Investimentos</div><div class="value num">${brl(d.investimentos_cents)}</div><div class="hint">aportes − resgates</div></button>` : ""}
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card"><h2>Receitas × despesas</h2><div class="chart" id="c1"></div></div>
      <div class="card"><h2>Despesas por categoria</h2><div id="c2"></div></div>
      <div class="card"><h2>Evolução do patrimônio</h2><p class="small muted" style="margin:-6px 0 8px">Soma dos saldos das contas no fim de cada mês</p><div class="chart" id="c3"></div></div>
      ${family() && !state.membro ? `<div class="card"><h2>Gastos por pessoa</h2><div class="list">${(d.despesas_por_membro || []).map((x) => `
        <div class="item"><div class="emoji">${x.membro_id === null ? "👨‍👩‍👧" : "👤"}</div>
        <div class="body"><div class="title">${x.membro_id === meId() ? "Você" : esc(x.membro)}</div><div class="sub">${x.membro_id === null ? "gastos compartilhados" : "individual"}</div></div>
        <div class="amount num expense">${brl(x.total_cents)}</div></div>`).join("") || `<div class="empty">Nenhuma despesa neste mês.</div>`}</div></div>` : ""}
      ${(d.por_cartao || []).length ? `<div class="card"><h2>Gastos no cartão</h2><div class="list">${d.por_cartao.map((k) => `
        <div class="item"><div class="emoji" style="color:${esc(k.cor || "inherit")}">💳</div><div class="body"><div class="title">${esc(k.cartao)}</div><div class="sub">compras em ${monthTitle(d.mes)}</div></div>
        <div class="amount num expense">${brl(k.total_cents)}</div></div>`).join("")}</div></div>` : ""}
      <div class="card"><h2>Saldo por conta</h2><div class="list">${(d.por_conta || []).filter((a) => a.status === "ativa").map((a) => `
        <div class="item"><div class="emoji">${a.tipo === "dinheiro" ? "💵" : a.tipo === "poupanca" ? "🐷" : a.tipo === "investimento" ? "📈" : "🏦"}</div>
        <div class="body"><div class="title">${esc(a.nome)}</div><div class="sub">${esc(ACC_TYPES[a.tipo] || a.tipo)}${a.instituicao ? " · " + esc(a.instituicao) : ""}</div></div>
        <div class="amount num ${a.saldo_cents < 0 ? "expense" : ""}">${brl(a.saldo_cents)}</div></div>`).join("")}</div></div>
    </div>
    <div class="card" style="margin-top:14px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Últimos lançamentos</h2><a href="#/lancamentos" class="small">Ver todos →</a></div>
      <div class="list" id="recent"></div></div>`;
  $("#mnav").appendChild(monthNav(() => dashboard(page)));
  $("#kpis").onclick = (e) => { const b = e.target.closest("[data-k]"); if (b) F2.kpiDialog(b.dataset.k, d, { projetado, aPagar, aReceber, quem }, () => dashboard(page)); };
  if (current && family()) F2.debtsCard($("#acertos"), () => dashboard(page));
  incomeExpenseChart($("#c1"), d.evolucao);
  if (d.por_categoria.length) categoryBars($("#c2"), d.por_categoria);
  else $("#c2").innerHTML = `<div class="empty">Nenhuma despesa neste mês.</div>`;
  lineChart($("#c3"), d.evolucao.map((e) => ({ label: MESES[+e.mes.slice(5, 7) - 1].slice(0, 3), value: Number(e.patrimonio_cents) })));
  $("#recent").innerHTML = d.recentes.length ? d.recentes.map(txItem).join("") :
    `<div class="empty"><div class="big">${icon("chat", 34)}</div>Nada lançado ainda. Vá ao <a href="#/assistente">Assistente</a> e diga, por exemplo, “gastei 50 na padaria”.</div>`;
  bindTxClicks($("#recent"), d.recentes, () => dashboard(page));
}

function txItem(t) {
  const sign = t.tipo === "receita" || t.tipo === "resgate" ? "+" : t.tipo === "transferencia" ? "" : "−";
  const cls = t.tipo === "receita" || t.tipo === "resgate" ? "income" : t.tipo === "despesa" ? "expense" : "";
  const onde = t.cartao ? `💳 ${esc(t.cartao)}` : esc(t.conta);
  const sub = t.tipo === "transferencia" ? `${esc(t.conta)} → ${esc(t.conta_destino)}` :
    t.tipo === "pagamento_fatura" ? `${esc(t.conta)} → fatura ${esc(t.cartao)} · ${dateBR(t.data)}` :
    [family() && esc(memberLabel(t)), t.categoria && `${esc(t.categoria)}${t.subcategoria ? " › " + esc(t.subcategoria) : ""}`, onde, dateBR(t.data)].filter(Boolean).join(" · ");
  const icon = t.tipo === "transferencia" ? "🔁" : t.tipo === "investimento" ? "📈" : t.tipo === "resgate" ? "📥" : t.tipo === "pagamento_fatura" ? "💳" : t.icone || "•";
  const prev = (t.data > todayISO() ? ' <span class="tag">previsto</span>' : "") +
    (t.acerto === "pendente" ? ` <span class="tag warn">a acertar${t.deve_para ? " c/ " + esc(t.deve_para.split(" ")[0]) : ""}</span>` : t.divisao_id ? ' <span class="tag">dividido</span>' : "");
  return `<div class="item click" data-id="${t.id}"><div class="emoji">${icon}</div>
    <div class="body"><div class="title">${esc(t.descricao)}${prev} ${t.origem === "whatsapp" ? '<span class="tag wa">WhatsApp</span>' : t.origem === "telegram" ? '<span class="tag tg">Telegram</span>' : t.origem === "recorrencia" ? '<span class="tag">fixa</span>' : t.origem === "importacao" ? '<span class="tag">importado</span>' : ""}</div><div class="sub">${sub}</div></div>
    <div class="amount num ${cls}">${sign} ${brl(Math.abs(t.valor_cents))}</div></div>`;
}
function bindTxClicks(host, list, after) {
  host.onclick = (e) => {
    const it = e.target.closest("[data-id]");
    if (!it) return;
    const t = list.find((x) => x.id === it.dataset.id);
    if (t) txForm(t, after);
  };
}

// ---------------------------------------------------------------- formulário de lançamento
/** Conta sugerida: a padrão, se for da família ou minha; senão a minha primeira conta. */
function defaultAccount(contas) {
  const pad = contas.find((a) => a.padrao && a.status === "ativa");
  if (!family() || !pad || pad.membro_id === null || pad.membro_id === meId()) return pad || contas[0];
  return contas.find((a) => a.status === "ativa" && a.membro_id === meId() && a.tipo !== "investimento") || pad;
}
function txForm(t, after) {
  const b = state.boot, edit = Boolean(t?.id);
  const tipo0 = t?.tipo || "despesa";
  const contas = b.contas.contas.filter((a) => a.status === "ativa" || a.id === t?.conta_id);
  const opts = (arr, sel) => arr.map(([v, l]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
  modal(`
    <h2>${edit ? "Editar lançamento" : "Novo lançamento"}</h2>
    <form id="txf" novalidate>
      <div class="field"><label>Tipo</label><select class="input" name="tipo" ${edit ? "disabled" : ""}>${opts(Object.entries(TIPOS), tipo0)}</select></div>
      <div class="row">
        <div class="field"><label>Valor (R$)</label><input class="input num" name="valor" inputmode="decimal" placeholder="0,00" value="${moneyInput(t?.valor_cents)}" ${edit && t.parcelas > 1 ? "disabled" : ""}></div>
        <div class="field"><label>Data</label><input class="input" type="date" name="data" value="${t?.data || todayISO()}" ${edit && t.parcelas > 1 ? "disabled" : ""}></div>
      </div>
      <div class="field"><label>Descrição</label><input class="input" name="descricao" maxlength="120" value="${esc((t?.descricao || "").replace(/ \(\d+\/\d+\)$/, ""))}" placeholder="Ex.: Supermercado"></div>
      <div class="row cat-row">
        <div class="field"><label>Categoria</label><select class="input" name="categoria_id"></select></div>
        <div class="field"><label>Subcategoria</label><select class="input" name="subcategoria_id"></select></div>
      </div>
      <div class="row">
        <div class="field"><label class="lbl-conta">Conta</label><select class="input" name="conta_id" ${edit && t.cartao_id ? "disabled" : ""}>${opts([...contas.map((a) => [a.id, a.nome]), ...(edit && !t.cartao_id ? [] : (b.cartoes || []).map((k) => ["k:" + k.id, "💳 " + k.nome]))], t?.cartao_id ? "k:" + t.cartao_id : t?.conta_id || defaultAccount(contas)?.id)}</select></div>
        <div class="field dest-row"><label>Conta de destino</label><select class="input" name="conta_destino_id" ${edit ? "disabled" : ""}>${opts(contas.map((a) => [a.id, a.nome]), t?.conta_destino_id || contas.find((a) => !a.padrao)?.id)}</select></div>
        ${edit ? "" : `<div class="field parc-row"><label>Parcelas</label><input class="input num" name="parcelas" type="number" min="1" max="72" value="1"></div>`}
      </div>
      ${family() ? `<div class="field memb-row"><label>De quem é?</label><select class="input" name="membro">
        ${b.familia.membros.map((m) => `<option value="${m.id}" ${(edit ? t.membro_id === m.id : m.eu) ? "selected" : ""}>${m.eu ? "Meu" : "De " + esc(m.nome)}</option>`).join("")}
        <option value="familia" ${edit && t.membro_id === null ? "selected" : ""}>Família (compartilhado)</option>
        ${edit ? "" : `<option value="dividir">Dividir entre nós…</option>`}</select></div><div class="split-host hidden"></div>` : ""}
      ${edit && t.parcelas > 1 ? `<p class="small muted">Compra parcelada (${t.parcela}/${t.parcelas}): a categoria e a descrição mudam em todas as parcelas.</p>` : ""}
      ${edit && t.cartao_id ? `<p class="small muted">Compra no cartão ${esc(t.cartao)} — fatura de ${dateBR(t.fatura_vencimento)}.</p>` : ""}
      ${edit && !["app_form", "importacao", "recorrencia"].includes(t.origem) ? `<p class="small muted">Registrado pelo ${t.origem === "whatsapp" ? "WhatsApp" : t.origem === "telegram" ? "Telegram" : "assistente"}.</p>` : ""}
      ${edit && t.origem === "recorrencia" ? `<p class="small muted">Lançado automaticamente por uma <a href="#/fixas">conta fixa</a>.</p>` : ""}
      <p class="small expense hidden" id="txErr"></p>
      <div class="modal-actions">
        ${edit ? `<button type="button" class="btn danger" id="txDel">Excluir</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn" id="txCancel">Cancelar</button>
        <button class="btn primary" id="txSave">Salvar</button>
      </div>
    </form>`, (m, close) => {
    const f = $("#txf", m);
    let forcar = false;
    const fillCats = () => {
      const tp = f.tipo.value;
      const isCat = tp === "despesa" || tp === "receita";
      $(".cat-row", m).classList.toggle("hidden", !isCat);
      $(".dest-row", m).classList.toggle("hidden", tp !== "transferencia");
      $(".parc-row", m)?.classList.toggle("hidden", !isCat);
      $(".memb-row", m)?.classList.toggle("hidden", !isCat);
      $(".lbl-conta", m).textContent = tp === "transferencia" ? "Conta de origem" : tp === "despesa" ? "Pagar com" : "Conta";
      $$("option[value^='k:']", f.conta_id).forEach((o) => { o.hidden = o.disabled = tp !== "despesa"; });
      if (f.conta_id.value.startsWith("k:") && tp !== "despesa") f.conta_id.value = contas.find((a) => a.padrao)?.id || contas[0]?.id;
      if (!isCat) return;
      const cats = b.categorias.filter((c) => c.tipo === tp);
      f.categoria_id.innerHTML = `<option value="">Escolha…</option>` + opts(cats.map((c) => [c.id, `${c.icone || ""} ${c.nome}`]), t?.categoria_id);
      fillSubs();
    };
    const fillSubs = () => {
      const c = b.categorias.find((x) => x.id === f.categoria_id.value);
      f.subcategoria_id.innerHTML = `<option value="">—</option>` + opts((c?.subcategorias || []).map((s) => [s.id, s.nome]), t?.subcategoria_id);
    };
    f.tipo.onchange = () => { fillCats(); toggleSplit(); }; f.categoria_id.onchange = fillSubs;
    fillCats();
    // dividir a compra entre as pessoas
    const payDefault = () => f.conta_id.value.startsWith("k:") ? f.conta_id.value : "c:" + f.conta_id.value;
    const split = f.membro && !edit ? F2.splitArea($(".split-host", m), payDefault) : null;
    const isSplit = () => split && f.membro.value === "dividir" && f.tipo.value === "despesa";
    const toggleSplit = () => { if (!split) return; $(".split-host", m).classList.toggle("hidden", !isSplit()); if (isSplit()) split.fill(parseMoney(f.valor.value)); };
    if (split) {
      f.membro.addEventListener("change", toggleSplit);
      f.valor.addEventListener("input", () => isSplit() && split.fill(parseMoney(f.valor.value)));
      f.conta_id.addEventListener("change", () => split.syncPay(payDefault()));
    }
    $("#txCancel", m).onclick = close;
    if (edit) $("#txDel", m).onclick = async () => {
      if (!(await confirmBox(t.parcelas > 1 ? `Excluir as ${t.parcelas} parcelas desta compra?` : "Excluir este lançamento?", "Excluir", true))) return;
      try { await api.rpc("app_delete_transaction", { id: t.id }); close(); toast("Lançamento excluído"); state.boot = null; after?.(); }
      catch (e) { toast(e.message); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = $("#txErr", m);
      err.classList.add("hidden");
      const tp = f.tipo.value;
      const p = { descricao: f.descricao.value.trim() };
      if (!(edit && t.cartao_id)) { if (f.conta_id.value.startsWith("k:")) p.cartao_id = f.conta_id.value.slice(2); else p.conta_id = f.conta_id.value; }
      if (edit) p.id = t.id; else p.tipo = tp;
      if (!(edit && t.parcelas > 1)) {
        const v = parseMoney(f.valor.value);
        if (!(v > 0)) { err.textContent = "Informe um valor válido."; err.classList.remove("hidden"); return; }
        p.valor = v; p.data = f.data.value;
      }
      if (tp === "despesa" || tp === "receita") {
        if (!f.categoria_id.value) { err.textContent = "Escolha a categoria."; err.classList.remove("hidden"); return; }
        p.categoria_id = f.categoria_id.value; p.subcategoria_id = f.subcategoria_id.value || null;
        if (!edit) p.parcelas = Number(f.parcelas.value || 1);
      }
      if (tp === "transferencia" && !edit) p.conta_destino_id = f.conta_destino_id.value;
      if (f.membro && (tp === "despesa" || tp === "receita")) p.membro = f.membro.value;
      if (forcar) p.forcar = true;
      if (isSplit()) {
        const partes = split.partes();
        if (partes.some((x) => !(x.valor >= 0) || Number.isNaN(x.valor))) { err.textContent = "Informe o valor de cada parte."; err.classList.remove("hidden"); return; }
        const soma = Math.round(partes.reduce((t, x) => t + x.valor, 0) * 100);
        if (soma !== Math.round(p.valor * 100)) { err.textContent = `As partes somam ${brl(soma)}, mas a compra é de ${brl(Math.round(p.valor * 100))}.`; err.classList.remove("hidden"); return; }
        delete p.membro; delete p.conta_id; delete p.cartao_id;
        try {
          const r = await api.rpc("app_save_split", { ...p, partes: partes.filter((x) => x.valor > 0) });
          if (r.status === "needs_member_card") throw new Error(`${r.membro} não tem cartão cadastrado.`);
          if (r.status !== "created") throw new Error("Não foi possível salvar a divisão. Confira os dados.");
          const dev = r.partes.filter((x) => x.deve_para);
          close(); toast(dev.length ? `Dividido ✅ ${dev.map((x) => `${x.membro.split(" ")[0]} fica devendo ${brl(x.valor_cents)}`).join(", ")}` : "Dividido ✅"); state.boot = null; after?.();
        } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); }
        return;
      }
      if (p.membro === "dividir") delete p.membro;
      try {
        const r = await api.rpc("app_save_transaction", p);
        if (r.status === "possible_duplicate") {
          forcar = true;
          err.textContent = "Já existe um lançamento igual feito há poucos minutos. Clique em Salvar de novo para confirmar.";
          err.classList.remove("hidden");
          return;
        }
        if (r.status !== "created" && r.status !== "updated") throw new Error("Não foi possível salvar. Confira os dados.");
        close(); toast(edit ? "Lançamento atualizado ✅" : r.lancamento?.fatura_vencimento ? `Registrado ✅ Entra na fatura de ${dateBR(r.lancamento.fatura_vencimento)}` : "Lançamento registrado ✅"); state.boot = null; after?.();
      } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); }
    };
  });
}

// ---------------------------------------------------------------- LANÇAMENTOS
async function transactions(page) {
  const filt = { tipo: "", categoria_id: "", busca: "" };
  const memberSel = family() ? `<select class="input" id="fMemb" style="max-width:190px"><option value="">Todas as pessoas</option>${state.boot.familia.membros.map((m) => `<option value="${m.id}">${m.eu ? "Eu" : esc(m.nome)}</option>`).join("")}<option value="familia">Compartilhado</option></select>` : "";
  page.innerHTML = `
    <div class="page-head"><h1>Lançamentos</h1><div class="row"><span id="mnav"></span><button class="btn" id="imp">${icon("upload", 17)} Importar</button><button class="btn" id="csv">${icon("download", 17)} CSV</button></div></div>
    <div class="card" style="margin-bottom:14px">
      <div class="row">
        <div class="seg" id="segTipo"><button data-v="" class="on">Todos</button><button data-v="despesa">Despesas</button><button data-v="receita">Receitas</button></div>
        <select class="input" id="fCat" style="max-width:220px"><option value="">Todas as categorias</option>${state.boot.categorias.map((c) => `<option value="${c.id}">${c.icone || ""} ${esc(c.nome)} (${c.tipo})</option>`).join("")}</select>
        ${memberSel}
        <input class="input" id="fBusca" placeholder="Buscar…" style="max-width:220px">
      </div>
      <p class="small muted" id="summary" style="margin:12px 0 0"></p>
    </div>
    <div class="card"><div class="list" id="txList"></div></div>
    <button class="fab" id="fab" aria-label="Novo lançamento">${icon("plus", 26)}</button>`;
  let data = [];
  const load = async (quiet = false) => {
    if (!quiet) $("#txList").innerHTML = `<div class="empty">Carregando…</div>`;
    const r = await api.rpc("app_transactions", { mes: state.month, ...filt, membro_id: $("#fMemb")?.value || "" });
    data = r.itens;
    const rec = data.filter((t) => t.tipo === "receita").reduce((s, t) => s + t.valor_cents, 0);
    const desp = data.filter((t) => t.tipo === "despesa").reduce((s, t) => s + t.valor_cents, 0);
    $("#summary").innerHTML = `${data.length} lançamentos · Receitas <b class="income num">${brl(rec)}</b> · Despesas <b class="expense num">${brl(desp)}</b>`;
    if (!data.length) { $("#txList").innerHTML = `<div class="empty"><div class="big">${icon("list", 34)}</div>Nenhum lançamento em ${monthTitle(state.month)}.</div>`; return; }
    let html = "", day = "";
    for (const t of data) {
      if (t.data !== day) { day = t.data; html += `<div class="day-label">${new Date(day + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}</div>`; }
      html += txItem(t);
    }
    $("#txList").innerHTML = html;
  };
  const mountNav = () => { $("#mnav").innerHTML = ""; $("#mnav").appendChild(monthNav(() => { mountNav(); load(); })); };
  mountNav();
  $("#segTipo").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("#segTipo button").forEach((x) => x.classList.toggle("on", x === b));
    filt.tipo = b.dataset.v; load();
  };
  $("#fCat").onchange = (e) => { filt.categoria_id = e.target.value; load(); };
  if ($("#fMemb")) $("#fMemb").onchange = () => load();
  let tm; $("#fBusca").oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => { filt.busca = e.target.value; load(); }, 300); };
  bindTxClicks($("#txList"), { find: (fn) => data.find(fn) }, async () => { await loadBoot(true); load(); });
  $("#fab").onclick = () => txForm(null, async () => { await loadBoot(true); load(); });
  $("#imp").onclick = () => F2.importDialog({}, async () => { await loadBoot(true); load(); });
  $("#csv").onclick = () => {
    const rows = [["Data", "Tipo", "Descrição", "Categoria", "Subcategoria", "Conta", "Cartão", "De quem", "Valor"]].concat(
      data.map((t) => [dateBR(t.data), TIPO_LABEL[t.tipo] || t.tipo, t.descricao, t.categoria || "", t.subcategoria || "", t.conta || "", t.cartao || "", t.membro || "", (t.valor_cents / 100).toFixed(2).replace(".", ",")]));
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `lancamentos-${state.month}.csv`; a.click();
  };
  viewRefresh = () => load(true);
  await load();
}

// ---------------------------------------------------------------- ASSISTENTE (chat)
const SUGGESTIONS = ["Quanto gastei este mês?", "Quanto posso gastar até o fim do mês?", "Quanto está a fatura?", "Como estão minhas metas?", "Tenho algum alerta?", "Ajuda"];

function bubble(m) {
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  const cards = (m.cards || []).map(cardHtml).join("");
  const play = m.audio_path ? `<button type="button" class="audio-btn" data-audio="${esc(m.audio_path)}">${icon("play", 14)} Ouvir áudio</button>` : "";
  return `<div class="msg ${m.role}"${m.pid ? ` id="${m.pid}"` : ""}><div class="txt">${md(m.content)}</div>${play}${cards}<div class="meta">${m.channel === "whatsapp" ? '<span class="tag wa">WhatsApp</span>' : m.channel === "telegram" ? '<span class="tag tg">Telegram</span>' : ""}${m.message_type === "audio" && m.role === "user" ? icon("mic", 13) : ""}<span>${time}</span></div></div>`;
}
function cardHtml(c) {
  if (c.type === "transaction" && c.data) {
    const t = c.data;
    return `<div class="msg-card"><div class="ct">${esc(TIPO_LABEL[t.tipo] || "Lançamento")}</div>
      <div class="kv"><span>${esc(String(t.descricao).replace(/ \(\d+\/\d+\)$/, ""))}${t.parcelas > 1 ? ` <span class="muted small">em ${t.parcelas}x</span>` : ""}</span><b class="num">${brl(t.valor_total_cents ?? t.valor_cents)}</b></div>
      <div class="kv small muted"><span>${esc([t.categoria, t.subcategoria].filter(Boolean).join(" › ") || t.conta || "")}${t.cartao ? ` · 💳 ${esc(t.cartao)}` : ""}</span><span>${dateBR(t.data)}</span></div></div>`;
  }
  if ((c.type === "summary" || c.type === "list") && c.items) {
    return `<div class="msg-card">${c.title ? `<div class="ct">${esc(c.title)}</div>` : ""}${c.items.map((i) => `<div class="kv"><span>${esc(i.label)}${i.hint ? ` <span class="muted small">(${esc(i.hint)})</span>` : ""}</span><b class="num">${brl(i.value_cents)}</b></div>`).join("")}</div>`;
  }
  if (c.type === "bars" && c.items) {
    return `<div class="msg-card">${c.title ? `<div class="ct">${esc(c.title)}</div>` : ""}${c.items.map((i) => `<div class="kv"><span>${i.icon || ""} ${esc(i.label)}</span><b class="num">${brl(i.value_cents)}</b></div><div class="bar" style="width:${Math.max(2, i.pct)}%"></div>`).join("")}</div>`;
  }
  return "";
}

async function chat(page) {
  page.innerHTML = `
  <div class="chat-wrap">
    <div class="chat-head"><div class="avatar">${logo(42)}</div><div><div class="name" id="assName">${esc(state.boot.perfil?.assistente || "Assistente")}</div><div class="small muted">${state.boot.perfil?.assistente ? "Seu assistente financeiro — por texto ou voz" : "Registre gastos e tire dúvidas — por texto ou voz"}</div></div></div>
    <div class="messages" id="msgs" aria-live="polite"></div>
    <div class="chips" id="chips">${SUGGESTIONS.map((s) => `<button>${esc(s)}</button>`).join("")}</div>
    <form class="composer" id="composer">
      <button type="button" class="round mic" id="mic" aria-label="Gravar áudio" title="Gravar áudio">${icon("mic", 21)}</button>
      <textarea class="input" id="txt" rows="1" placeholder="${state.boot.perfil?.assistente ? `Fale com ${esc(state.boot.perfil.assistente)}…` : "Escreva ou fale…"}" maxlength="2000"></textarea>
      <button class="round send" id="sendBtn" aria-label="Enviar">${icon("send", 20)}</button>
      <div class="recbar hidden" id="recbar" role="status">
        <button type="button" class="round" id="recCancel" aria-label="Cancelar gravação" title="Cancelar">${icon("close", 20)}</button>
        <span class="rec-dot"></span><span class="num" id="recTime">0:00</span><span class="small muted rec-hint">Gravando… fale o gasto ou a pergunta</span>
        <button type="button" class="round send" id="recSend" aria-label="Enviar áudio" title="Enviar">${icon("send", 20)}</button>
      </div>
    </form>
  </div>`;
  const box = $("#msgs"), txt = $("#txt");
  const scroll = () => { box.scrollTop = box.scrollHeight; };
  const hist = await api.rpc("app_chat_history", { limite: 80 });
  box.innerHTML = hist.length ? hist.map(bubble).join("") :
    bubble({ role: "assistant", content: `Olá${state.boot.perfil?.nome ? `, ${state.boot.perfil.nome}` : ""}! 👋 Sou ${state.boot.perfil?.assistente ? `${state.boot.perfil.assistente}, ` : ""}seu assistente financeiro.\n\nMe conte seus gastos e receitas do jeito que você falaria, por exemplo:\n• “gastei 87,50 no supermercado”\n• “recebi 3 mil de salário”\n\nOu pergunte: “quanto gastei este mês?”` });
  scroll();

  let busy = false;
  async function send(text, type = "text", extra = {}) {
    if (busy || (!text.trim() && !extra.audio_base64)) return;
    busy = true; chatSending = true;
    const pid = extra.label ? "p" + Date.now() : undefined;
    if (text.trim() || extra.label) box.insertAdjacentHTML("beforeend", bubble({ role: "user", content: text.trim() || extra.label, channel: "app", message_type: type, created_at: new Date().toISOString(), pid }));
    delete extra.label;
    box.insertAdjacentHTML("beforeend", `<div class="typing" id="typing"><i></i><i></i><i></i></div>`);
    scroll();
    try {
      const r = await api.ask({ text, type, ...extra });
      $("#typing")?.remove();
      // áudio: troca o "transcrevendo…" pelo que foi entendido, com o botão para ouvir
      if (pid && r.transcricao) $("#" + pid)?.replaceWith(htmlEl(bubble({ role: "user", content: r.transcricao, channel: "app", message_type: "audio", audio_path: r.audio_path, created_at: new Date().toISOString() })));
      box.insertAdjacentHTML("beforeend", bubble({ role: "assistant", content: r.reply, cards: r.cards, created_at: new Date().toISOString() }));
      const novoNome = /meu nome é \*([^*]+)\*/.exec(r.reply)?.[1] ?? (/voltei a ser só o \*Assistente\*/.test(r.reply) ? "" : null);
      if (novoNome !== null) {
        if (state.boot?.perfil) state.boot.perfil.assistente = novoNome || null;
        $("#assName").textContent = novoNome || "Assistente";
        txt.placeholder = novoNome ? `Fale com ${novoNome}…` : "Escreva ou fale…";
      }
      if (/^CREATE|EDIT|DELETE|CORRECT|PAY|GOAL|CANCEL/.test(r.intent || "") || /Registrei|Apaguei|Pronto|criada|Guardei|Tirei/.test(r.reply)) state.boot = null;
    } catch (e) {
      $("#typing")?.remove();
      box.insertAdjacentHTML("beforeend", bubble({ role: "assistant", content: `⚠️ ${e.message}` }));
    }
    busy = false; chatSending = false; scroll();
    markSeen();
  }
  $("#composer").onsubmit = (e) => { e.preventDefault(); const v = txt.value; txt.value = ""; txt.style.height = ""; send(v); };
  txt.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
  txt.addEventListener("input", () => { txt.style.height = "auto"; txt.style.height = Math.min(txt.scrollHeight, 120) + "px"; });
  $("#chips").onclick = (e) => { const b = e.target.closest("button"); if (b) send(b.textContent); };
  // ouvir o áudio enviado (fica guardado por 7 dias)
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-audio]"); if (!b) return;
    b.disabled = true; b.textContent = "Carregando…";
    try {
      const url = await api.audioUrl(b.dataset.audio);
      const el = document.createElement("audio");
      el.controls = true; el.autoplay = true; el.src = url; el.className = "audio-player";
      el.onerror = () => toast("Não foi possível tocar este áudio neste aparelho.");
      b.replaceWith(el);
    } catch (x) { b.disabled = false; b.innerHTML = `${icon("play", 14)} Ouvir áudio`; toast(x.message.includes("not_found") || x.message.includes("404") ? "Este áudio não está mais disponível (guardamos por 7 dias)." : x.message); }
  });
  setupMic(send);
}

/**
 * Microfone: grava o áudio no celular/computador e envia ao servidor, que transcreve (Groq/Gemini) —
 * o mesmo caminho dos áudios do Telegram. Toque para gravar; enviar ou cancelar. Máximo de 2 minutos.
 */
function setupMic(send) {
  const btn = $("#mic"), bar = $("#recbar"), timeEl = $("#recTime");
  const hideWhileRec = [$("#mic"), $("#txt"), $("#sendBtn")];
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    btn.onclick = () => toast("Este navegador não permite gravar áudio. Atualize o navegador ou use o Telegram.");
    return;
  }
  const pickMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
  let mr = null, stream = null, chunks = [], started = 0, tick = null, cancelled = false;
  const fmt = (ms) => { const s2 = Math.floor(ms / 1000); return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, "0")}`; };
  const ui = (rec) => { bar.classList.toggle("hidden", !rec); hideWhileRec.forEach((e) => e.classList.toggle("hidden", rec)); };
  const stopAll = () => { clearInterval(tick); stream?.getTracks().forEach((t) => t.stop()); stream = null; ui(false); };
  btn.onclick = async () => {
    if (mr) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      toast(e?.name === "NotAllowedError" ? "Permita o uso do microfone nas configurações do navegador para gravar áudio." : "Não foi possível acessar o microfone.");
      return;
    }
    const mime = pickMime();
    mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = []; cancelled = false; started = Date.now();
    mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    mr.onstop = async () => {
      const dur = Date.now() - started, type = (mr.mimeType || mime || "audio/webm").split(";")[0];
      mr = null; stopAll();
      if (cancelled) return;
      if (dur < 700 || !chunks.length) { toast("Áudio muito curto. Toque no microfone, fale e depois toque em enviar."); return; }
      const blob = new Blob(chunks, { type });
      const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
      send("", "audio", { audio_base64: b64, mime: type, label: `🎙️ Áudio (${fmt(dur)}) — transcrevendo…` });
    };
    mr.start(250);
    ui(true); timeEl.textContent = "0:00";
    tick = setInterval(() => {
      const el = Date.now() - started;
      timeEl.textContent = fmt(el);
      if (el >= 120_000 && mr?.state === "recording") mr.stop();
    }, 250);
    navigator.vibrate?.(30);
  };
  $("#recSend").onclick = () => { if (mr?.state === "recording") mr.stop(); };
  $("#recCancel").onclick = () => { cancelled = true; if (mr?.state === "recording") mr.stop(); else stopAll(); };
}

// ---------------------------------------------------------------- CONTAS
async function accounts(page) {
  const b = await loadBoot(true);
  const list = b.contas.contas;
  page.innerHTML = `
    <div class="page-head"><h1>Contas</h1><div class="row"><button class="btn" id="impAcc">${icon("upload", 17)} Importar extrato</button><button class="btn primary" id="newAcc">${icon("plus", 17)} Nova conta</button></div></div>
    <div class="card kpi" style="margin-bottom:14px"><div class="label">Saldo total (contas ativas)</div><div class="value num">${brl(b.contas.total_cents)}</div><div class="hint">Calculado pelos lançamentos até hoje</div></div>
    <div class="card"><div class="list" id="accList">${list.map((a) => `
      <div class="item click" data-id="${a.id}" style="${a.status === "arquivada" ? "opacity:.55" : ""}">
        <div class="emoji">${a.tipo === "dinheiro" ? "💵" : a.tipo === "poupanca" ? "🐷" : a.tipo === "investimento" ? "📈" : "🏦"}</div>
        <div class="body"><div class="title">${esc(a.nome)} ${a.padrao ? '<span class="tag">padrão</span>' : ""} ${a.status === "arquivada" ? '<span class="tag">arquivada</span>' : ""}</div>
        <div class="sub">${esc(ACC_TYPES[a.tipo] || a.tipo)}${a.instituicao ? " · " + esc(a.instituicao) : ""}${family() ? ` · ${a.membro_id === null ? "👨‍👩‍👧 Família" : a.membro_id === meId() ? "👤 Minha" : "👤 " + esc(a.membro)}` : ""}</div></div>
        <div class="amount num ${a.saldo_cents < 0 ? "expense" : ""}">${brl(a.saldo_cents)}</div></div>`).join("")}</div></div>
    <p class="small muted" style="margin-top:12px">A conta <b>padrão</b> é usada quando você não diz onde foi o gasto. Para usar outra, diga no chat: “paguei 50 no mercado com o Nubank”.</p>`;
  const reload = () => accounts(page);
  $("#newAcc").onclick = () => accForm(null, reload);
  $("#impAcc").onclick = () => F2.importDialog({}, reload);
  $("#accList").onclick = (e) => { const it = e.target.closest("[data-id]"); if (it) accForm(list.find((a) => a.id === it.dataset.id), reload); };
}

function accForm(a, after) {
  modal(`<h2>${a ? "Editar conta" : "Nova conta"}</h2>
    <form id="af" novalidate>
      <div class="field"><label>Nome</label><input class="input" name="nome" maxlength="60" value="${esc(a?.nome || "")}" placeholder="Ex.: Nubank"></div>
      <div class="row">
        <div class="field"><label>Tipo</label><select class="input" name="tipo">${Object.entries(ACC_TYPES).map(([v, l]) => `<option value="${v}" ${v === (a?.tipo || "corrente") ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label>Instituição</label><input class="input" name="instituicao" value="${esc(a?.instituicao || "")}" placeholder="Ex.: Nu Pagamentos"></div>
      </div>
      <div class="field"><label>Saldo inicial (R$)</label><input class="input num" name="saldo" inputmode="decimal" placeholder="0,00" value="${a ? "" : ""}">
        <span class="small muted">${a ? "Deixe em branco para manter o saldo inicial atual." : "Quanto havia na conta antes de começar a usar o app."}</span></div>
      ${family() ? `<div class="field"><label>De quem é a conta?</label><select class="input" name="membro">
        ${state.boot.familia.membros.map((m) => `<option value="${m.id}" ${(a ? a.membro_id === m.id : m.eu) ? "selected" : ""}>${m.eu ? "Minha" : "De " + esc(m.nome)}</option>`).join("")}
        <option value="familia" ${a && a.membro_id === null ? "selected" : ""}>Da família (conjunta)</option></select>
        <span class="small muted">No Início, ao escolher uma pessoa, o saldo mostra só as contas dela.</span></div>` : ""}
      <label class="row small" style="margin-bottom:12px"><input type="checkbox" name="padrao" ${a?.padrao ? "checked" : ""}> Usar como conta padrão</label>
      <p class="small expense hidden" id="aErr"></p>
      <div class="modal-actions">${a ? `<button type="button" class="btn" id="arch">${a.status === "ativa" ? "Arquivar" : "Reativar"}</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn" id="aCancel">Cancelar</button><button class="btn primary">Salvar</button></div>
    </form>`, (m, close) => {
    const f = $("#af", m);
    $("#aCancel", m).onclick = close;
    if (a) $("#arch", m).onclick = async () => {
      try { await api.rpc("app_archive_account", { id: a.id }); close(); state.boot = null; after(); } catch (e) { toast(e.message); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const p = { id: a?.id, nome: f.nome.value.trim(), tipo: f.tipo.value, instituicao: f.instituicao.value.trim(), padrao: f.padrao.checked };
      if (f.membro) p.membro = f.membro.value;
      if (f.saldo.value.trim()) {
        const v = parseMoney(f.saldo.value.replace(/^-/, ""));
        if (Number.isNaN(v)) { $("#aErr", m).textContent = "Saldo inválido."; $("#aErr", m).classList.remove("hidden"); return; }
        p.saldo_inicial = f.saldo.value.trim().startsWith("-") ? -v : v;
      }
      try { await api.rpc("app_save_account", p); close(); toast("Conta salva ✅"); state.boot = null; after(); }
      catch (ex) { $("#aErr", m).textContent = ex.message; $("#aErr", m).classList.remove("hidden"); }
    };
  });
}

// ---------------------------------------------------------------- CATEGORIAS
async function categories(page, kind = "despesa") {
  const b = await loadBoot(true);
  const cats = b.categorias.filter((c) => c.tipo === kind);
  page.innerHTML = `
    <div class="page-head"><h1>Categorias</h1><button class="btn primary" id="newCat">${icon("plus", 17)} Nova categoria</button></div>
    <div class="seg" id="kind" style="margin-bottom:14px"><button data-v="despesa" class="${kind === "despesa" ? "on" : ""}">Despesas</button><button data-v="receita" class="${kind === "receita" ? "on" : ""}">Receitas</button></div>
    <div class="card">${cats.map((c) => `
      <div class="cat-block" data-id="${c.id}">
        <div class="cat-head"><div class="emoji" style="width:36px;height:36px;border-radius:10px;background:var(--surface-2);display:grid;place-items:center">${c.icone || "🏷️"}</div>
          <span class="t">${esc(c.nome)}</span>
          <button class="btn ghost icon small" data-act="edit" title="Renomear">${icon("edit", 17)}</button>
          ${c.sistema ? "" : `<button class="btn ghost icon small" data-act="del" title="Excluir">${icon("trash", 17)}</button>`}</div>
        <div class="subs">${c.subcategorias.map((s) => `<span class="sub-chip">${esc(s.nome)}<button data-sub="${s.id}" title="Remover">×</button></span>`).join("")}
          <button class="btn ghost small" data-act="addsub" style="padding:4px 8px">+ subcategoria</button></div>
      </div>`).join("")}</div>
    <p class="small muted" style="margin-top:12px">O assistente aprende: quando você corrige a categoria de um estabelecimento, ele usa a nova categoria nas próximas vezes.</p>`;
  const reload = () => categories(page, kind);
  $("#kind").onclick = (e) => { const x = e.target.closest("button"); if (x) categories(page, x.dataset.v); };
  $("#newCat").onclick = () => catForm(null, kind, reload);
  page.querySelector(".card").onclick = async (e) => {
    const blk = e.target.closest("[data-id]"); if (!blk) return;
    const c = cats.find((x) => x.id === blk.dataset.id);
    const sub = e.target.closest("[data-sub]");
    const act = e.target.closest("[data-act]")?.dataset.act;
    try {
      if (sub) { if (await confirmBox("Remover esta subcategoria?", "Remover", true)) { await api.rpc("app_delete_subcategory", { id: sub.dataset.sub }); reload(); } }
      else if (act === "edit") catForm(c, kind, reload);
      else if (act === "del") { if (await confirmBox(`Excluir a categoria “${c.nome}”?`, "Excluir", true)) { await api.rpc("app_delete_category", { id: c.id }); reload(); } }
      else if (act === "addsub") {
        modal(`<h2>Nova subcategoria em ${esc(c.nome)}</h2><form id="sf"><div class="field"><label>Nome</label><input class="input" name="nome" maxlength="40"></div>
          <div class="modal-actions"><button type="button" class="btn" id="sc">Cancelar</button><button class="btn primary">Salvar</button></div></form>`, (m, close) => {
          $("#sc", m).onclick = close;
          $("#sf", m).onsubmit = async (ev) => {
            ev.preventDefault();
            try { await api.rpc("app_save_subcategory", { categoria_id: c.id, nome: ev.target.nome.value }); close(); reload(); } catch (ex) { toast(ex.message); }
          };
        });
      }
    } catch (ex) { toast(ex.message); }
  };
}

function catForm(c, kind, after) {
  modal(`<h2>${c ? "Editar categoria" : "Nova categoria"}</h2>
    <form id="cf"><div class="row">
      <div class="field" style="flex:0 0 80px"><label>Ícone</label><input class="input" name="icone" maxlength="4" value="${esc(c?.icone || "")}" placeholder="🏷️" style="text-align:center"></div>
      <div class="field"><label>Nome</label><input class="input" name="nome" maxlength="40" value="${esc(c?.nome || "")}"></div></div>
      <div class="modal-actions"><button type="button" class="btn" id="cc">Cancelar</button><button class="btn primary">Salvar</button></div></form>`, (m, close) => {
    $("#cc", m).onclick = close;
    $("#cf", m).onsubmit = async (e) => {
      e.preventDefault();
      try { await api.rpc("app_save_category", { id: c?.id, tipo: kind, nome: e.target.nome.value, icone: e.target.icone.value }); close(); toast("Categoria salva ✅"); after(); }
      catch (ex) { toast(ex.message); }
    };
  });
}

// ---------------------------------------------------------------- CONFIGURAÇÕES
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });

async function settings(page) {
  const b = await loadBoot(true);
  const cfg = window.APP_CONFIG || {};
  const wa = b.whatsapp, tg = b.telegram, fam = b.familia;
  const waOn = wa?.status === "ativo";
  page.innerHTML = `
    <div class="page-head"><h1>Configurações</h1></div>
    <div class="grid two">
      <form class="card" id="pf"><h2>Perfil e meta</h2>
        <div class="field"><label>Seu nome</label><input class="input" name="nome" value="${esc(b.perfil?.nome || "")}"></div>
        <div class="field"><label>Nome do assistente</label><input class="input" name="assistente" maxlength="30" placeholder="Ex.: Jarbas" value="${esc(b.perfil?.assistente || "")}">
          <span class="small muted">Dê um nome ao seu assistente e chame por ele: “Jarbas, gastei 50 no mercado”. Também dá para pedir no chat: “seu nome agora é Jarbas”.</span></div>
        <div class="field"><label>Meta de economia ${family() ? "da família " : ""}por mês (R$)</label><input class="input num" name="meta" inputmode="decimal" placeholder="Ex.: 1.500,00" value="${moneyInput(b.perfil?.meta_economia_cents)}">
          <span class="small muted">Usada no cálculo de “quanto posso gastar”. Deixe vazio se não tiver meta.</span></div>
        <button class="btn primary">Salvar</button></form>

      <div class="card"><h2>💬 Conectar WhatsApp e Telegram</h2>
        <div class="list">
          <div class="item"><div class="emoji">🟢</div><div class="body"><div class="title">WhatsApp</div>
            <div class="sub">${waOn ? `Conectado ao número final ${esc(wa.telefone_final)}` : "Não conectado"}</div></div>
            ${waOn ? `<button class="btn small" data-unlink="whatsapp">Desconectar</button>` : ""}</div>
          <div class="item"><div class="emoji">✈️</div><div class="body"><div class="title">Telegram</div>
            <div class="sub">${tg ? `Conectado${tg.usuario ? " como @" + esc(tg.usuario) : ""}` : "Não conectado"}</div></div>
            ${tg ? `<button class="btn small" data-unlink="telegram">Desconectar</button>` : ""}</div>
        </div>
        <p class="small muted">Cada pessoa conecta o próprio celular, a partir da própria conta no app. Não é preciso digitar número: o código identifica você.</p>
        <div id="codeArea"></div>
        <button class="btn primary" id="gen">Gerar código de conexão</button>
      </div>

      <div class="card"><h2>👨‍👩‍👧 Família</h2>
        <div class="list">${fam.membros.map((m) => `
          <div class="item"><div class="emoji">${m.papel === "titular" ? "⭐" : "👤"}</div>
            <div class="body"><div class="title">${esc(m.nome)}${m.eu ? " (você)" : ""}</div><div class="sub">${m.papel === "titular" ? "Titular" : "Membro"}</div></div>
            ${fam.titular && !m.eu ? `<button class="btn small danger" data-remove="${m.id}">Remover</button>` : ""}
            ${!fam.titular && m.eu ? `<button class="btn small" data-remove="${m.id}">Sair</button>` : ""}</div>`).join("")}</div>
        ${fam.titular ? `<p class="small muted">Convide sua esposa (ou outra pessoa): vocês passam a ver e registrar no mesmo controle, com visão da família e de cada um.</p>
          <div id="inviteArea"></div><button class="btn primary" id="invite">Convidar pessoa</button>` : ""}
        ${fam.titular && fam.membros.length === 1 ? `<details style="margin-top:14px"><summary class="small" style="cursor:pointer;font-weight:700">Recebi um convite</summary>
          <form id="joinForm" class="row" style="margin-top:10px"><input class="input" name="codigo" placeholder="Código do convite" maxlength="8" style="text-transform:uppercase;max-width:200px"><button class="btn">Entrar na família</button></form>
          <p class="small muted">Só funciona numa conta nova, ainda sem lançamentos.</p></details>` : ""}
      </div>

      <div class="card"><h2>📱 Instalar no celular</h2>
        <p class="small muted">No Android (Chrome): menu ⋮ → <b>Instalar app</b>. No iPhone (Safari): botão Compartilhar → <b>Adicionar à Tela de Início</b>.</p>
        <button class="btn ${installPrompt ? "" : "hidden"}" id="inst">Instalar agora</button></div>
      <div class="card"><h2>Conta</h2><p class="small muted">${esc(api.getSession()?.user?.email || "")}</p><button class="btn" id="out">Sair</button></div>
    </div>`;

  $("#pf").onsubmit = async (e) => {
    e.preventDefault();
    const meta = e.target.meta.value.trim();
    const v = meta ? parseMoney(meta) : "";
    if (meta && Number.isNaN(v)) return toast("Meta inválida");
    try { await api.rpc("app_update_profile", { nome: e.target.nome.value, assistente: e.target.assistente.value, meta_economia: v === "" ? "" : String(v) }); toast("Salvo ✅"); state.boot = null; }
    catch (ex) { toast(ex.message); }
  };
  $("#gen").onclick = async () => {
    try {
      const r = await api.rpc("app_link_code");
      const waLink = cfg.WHATSAPP_NUMBER ? `https://wa.me/${encodeURIComponent(cfg.WHATSAPP_NUMBER.replace(/\D/g, ""))}?text=${encodeURIComponent(r.codigo)}` : "";
      const tgLink = cfg.TELEGRAM_BOT ? `https://t.me/${encodeURIComponent(cfg.TELEGRAM_BOT.replace(/^@/, ""))}?start=${encodeURIComponent(r.codigo)}` : "";
      $("#codeArea").innerHTML = `<p class="small">Seu código (válido por ${r.expira_em_minutos} min). Abra o canal e envie:</p>
        <div class="code-box num">${esc(r.codigo)}</div>
        <div class="row">
          ${waLink ? `<a class="btn primary" target="_blank" rel="noopener" href="${waLink}">Abrir WhatsApp</a>` : ""}
          ${tgLink ? `<a class="btn primary" target="_blank" rel="noopener" href="${tgLink}">Abrir Telegram</a>` : ""}
        </div>
        ${!waLink && !tgLink ? `<p class="notice">Os canais ainda não foram configurados no servidor (veja o guia de configuração).</p>` : ""}`;
      $("#gen").textContent = "Gerar novo código";
    } catch (ex) { toast(ex.message); }
  };
  page.onclick = async (e) => {
    const un = e.target.closest("[data-unlink]");
    const rm = e.target.closest("[data-remove]");
    try {
      if (un && (await confirmBox(`Desconectar o ${un.dataset.unlink === "whatsapp" ? "WhatsApp" : "Telegram"}?`, "Desconectar", true))) {
        await api.rpc("app_unlink_channel", { canal: un.dataset.unlink }); settings(page);
      }
      if (rm) {
        const self = rm.dataset.remove === meId();
        if (await confirmBox(self ? "Sair da família? Você deixará de ver os dados dela." : "Remover esta pessoa da família? Os lançamentos que ela já fez continuam aqui.", self ? "Sair" : "Remover", true)) {
          await api.rpc("app_family_remove", { membro_id: rm.dataset.remove }); state.boot = null; state.membro = ""; settings(page);
        }
      }
    } catch (ex) { toast(ex.message); }
  };
  $("#invite")?.addEventListener("click", async () => {
    try {
      const r = await api.rpc("app_family_invite");
      $("#inviteArea").innerHTML = `<p class="small">Peça para a pessoa criar a conta dela neste app e, em <b>Configurações → Família → Recebi um convite</b>, digitar (válido por ${r.expira_em_horas} h):</p>
        <div class="code-box num">${esc(r.codigo)}</div>`;
    } catch (ex) { toast(ex.message); }
  });
  $("#joinForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api.rpc("app_family_join", { codigo: e.target.codigo.value });
      toast(`Você entrou na família de ${r.titular} ✅`); state.boot = null; state.membro = ""; location.hash = "#/";
    } catch (ex) { toast(ex.message); }
  });
  $("#inst").onclick = async () => { await installPrompt?.prompt(); installPrompt = null; $("#inst").classList.add("hidden"); };
  $("#out").onclick = async () => { await api.signOut(); state.boot = null; state.month = null; state.membro = ""; location.hash = "#/"; router(); };
}

// ---------------------------------------------------------------- MAIS
function more(page) {
  page.innerHTML = `<div class="page-head"><h1>Mais</h1></div><div class="card"><div class="list">
    ${NAV.slice(4).map((n) => `<a class="item click" href="${n.href}" style="text-decoration:none;color:inherit"><div class="emoji nav-ico">${icon(n.ico, 20)}</div><div class="body"><div class="title">${n.label}</div></div>›</a>`).join("")}
  </div></div>`;
}

// ---------------------------------------------------------------- início
F2.init({ api, state, loadBoot, modal, toast, confirmBox, esc, brl, dateBR, parseMoney, moneyInput, monthTitle, shiftMonth, monthNav, txItem, bindTxClicks,
  family, memberSeg, memberLabel, todayISO, MESES, TIPOS, setRefresh: (fn) => { viewRefresh = fn; } });
api.onAuth((s) => { if (!s) { state.boot = null; } });
window.addEventListener("hashchange", router);
router();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
