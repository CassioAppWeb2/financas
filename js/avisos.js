// Avisos do app: sininho com as novidades, painel, notificações no celular/computador (Web Push)
// e a opção de receber também pelo Telegram.
import { icon } from "./icons.js";

let D = null;              // dependências vindas do app.js
let ultimo = null;         // última lista recebida
let avisadoNaAbertura = false;
let timer = null;

const $ = (s, el = document) => el.querySelector(s);

export function initAvisos(deps) {
  D = deps;
  if (!$("#bellBtn")) {
    const b = document.createElement("button");
    b.id = "bellBtn"; b.className = "bell hidden"; b.type = "button"; b.setAttribute("aria-label", "Avisos");
    b.innerHTML = `${icon("bell", 20)}<span class="bell-badge hidden"></span>`;
    b.onclick = () => openPanel();
    document.body.appendChild(b);
  }
  clearInterval(timer);
  timer = setInterval(() => refreshAvisos(), 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAvisos(); });
  // clique numa notificação do sistema com o app já aberto
  navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.tipo === "abrir-avisos") openPanel(); });
}

export async function refreshAvisos() {
  if (!D || document.hidden || !D.api.getSession()) { $("#bellBtn")?.classList.add("hidden"); return; }
  let r;
  try { r = await D.api.rpc("app_notifications"); } catch { return; }
  ultimo = r;
  const bell = $("#bellBtn"), badge = $("#bellBtn .bell-badge");
  bell?.classList.remove("hidden");
  const n = r.nao_lidas || 0;
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.classList.toggle("hidden", !n);
  bell.classList.toggle("has", n > 0);
  if (location.hash.includes("avisos=1")) {   // veio de um toque na notificação do celular
    history.replaceState(null, "", location.hash.replace(/[?&]avisos=1/, ""));
    avisadoNaAbertura = true; openPanel(); return;
  }
  if (!avisadoNaAbertura && n > 0) {
    avisadoNaAbertura = true;
    D.toast(n === 1 ? "Você tem 1 novidade — toque no sininho 🔔" : `Você tem ${n} novidades — toque no sininho 🔔`);
  }
}

const ICONES = { pendente: "⏰", vence: "📅", renovar: "🔄", fatura: "💳", orcamento: "📊", acerto: "🤝", meta: "🎯" };
const quando = (iso) => {
  const d = new Date(iso), agora = new Date();
  const min = Math.round((agora - d) / 60000);
  if (min < 60) return min <= 1 ? "agora" : `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

async function openPanel() {
  if (!D) return;
  await refreshAvisos();
  const r = ultimo || { itens: [] };
  const item = (x) => `<div class="aviso ${x.lida ? "" : "nova"} ${x.ativa ? "" : "feita"}" data-id="${x.id}">
      <div class="emoji">${ICONES[x.tipo] || "🔔"}</div>
      <div class="body"><div class="title">${D.esc(x.titulo)}</div><div class="sub">${D.esc(x.texto)}</div>
        <div class="aviso-meta">${quando(x.criada_em)}${x.ativa ? "" : " · resolvido"}</div>
        ${x.ativa ? acoes(x) : ""}</div></div>`;
  D.modal(`<h2>🔔 Avisos</h2>
    ${r.itens.length ? `<div class="avisos">${r.itens.map(item).join("")}</div>`
      : `<div class="empty"><p><b>Nada de novo por aqui.</b></p><p class="muted">Contas vencendo, atrasadas, contas fixas para renovar e outras novidades aparecem aqui.</p></div>`}
    <p class="small muted" style="margin-top:12px">Quer receber no celular mesmo com o app fechado? Ative em <a href="#/configuracoes">Configurações → Avisos</a>.</p>
    <div class="modal-actions"><button class="btn" data-close>Fechar</button></div>`, (m, close) => {
    $("[data-close]", m).onclick = close;
    m.addEventListener("click", async (e) => {
      if (e.target.closest("a[href]")) { close(); return; }
      const bt = e.target.closest("[data-acao]"); if (!bt) return;
      const box = bt.closest("[data-id]"); const x = r.itens.find((y) => y.id === box.dataset.id);
      const ac = bt.dataset.acao;
      if (ac === "ver") { close(); location.hash = x.link || "#/"; return; }
      const id = x.dados?.recorrencia_id;
      try {
        if (ac === "mesmo") {
          const s = await D.api.rpc("app_renew_recurring", { id });
          D.toast(`Renovada ✅ até ${D.dateBR(s.ate)}`);
        } else if (ac === "reajuste") {
          const f = box.querySelector(".reaj");
          if (f.classList.contains("hidden")) { f.classList.remove("hidden"); f.querySelector("input").focus(); return; }
          const v = D.parseMoney(f.querySelector("input").value);
          if (!(v > 0)) return D.toast("Informe o novo valor.");
          const s = await D.api.rpc("app_renew_recurring", { id, valor: v });
          D.toast(`Renovada com o novo valor ✅ até ${D.dateBR(s.ate)}`);
        } else if (ac === "encerrar") {
          if (!(await D.confirmBox(`Não renovar “${x.dados?.descricao || "esta conta"}”? Ela termina na data programada.`, "Não renovar"))) return;
          await D.api.rpc("app_renew_recurring", { id, encerrar: true });
          D.toast("Certo, não vou renovar.");
        }
        close(); D.state.boot = null; refreshAvisos(); D.reload?.();
      } catch (y) { D.toast(y.message); }
    });
  });
  if (r.nao_lidas) { try { await D.api.rpc("app_notifications_read", {}); } catch { /* tanto faz */ } refreshAvisos(); }
}

function acoes(x) {
  if (x.tipo === "renovar" && x.dados?.recorrencia_id) {
    return `<div class="aviso-acoes">
      <button class="btn small primary" data-acao="mesmo">Mesmo valor (+12 meses)</button>
      <button class="btn small" data-acao="reajuste">Teve reajuste</button>
      <button class="btn small" data-acao="encerrar">Não renovar</button></div>
      <div class="reaj hidden row" style="margin-top:8px"><input class="input num" inputmode="decimal" placeholder="Novo valor" style="max-width:160px"><button class="btn small primary" data-acao="reajuste">Renovar com esse valor</button></div>`;
  }
  return x.link ? `<div class="aviso-acoes"><button class="btn small" data-acao="ver">Ver</button></div>` : "";
}

// ---------------------------------------------------------------- Configurações → Avisos
const ehIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const instalado = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const suportaPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function settingsCard(b) {
  const tgOn = Boolean(b.telegram);
  return `<div class="card" id="notifCard"><h2>🔔 Avisos</h2>
    <p class="small muted">Eu aviso quando uma conta vence ou atrasa, quando uma conta fixa está no último mês (para conferir reajuste e renovar), fatura, orçamento estourando e acertos da família. Os avisos também aparecem no sininho ao abrir o app, no celular ou no computador.</p>
    <div class="field"><label>Notificações neste aparelho</label>
      <div class="row"><button type="button" class="btn primary" id="pushBtn">Ativar notificações neste aparelho</button></div>
      <span class="small muted" id="pushMsg"></span></div>
    <div class="field"><label>Avisos pelo Telegram</label>
      ${tgOn ? `<div class="seg" id="tgAviso"><button type="button" data-v="1">Receber</button><button type="button" data-v="0">Não receber</button></div>`
        : `<span class="small muted">Conecte o Telegram (acima) para receber os avisos lá também — funciona em qualquer celular.</span>`}</div>
    <span class="small muted">Os avisos chegam entre 8h e 21h.</span></div>`;
}

export async function bindSettings() {
  const btn = $("#pushBtn"), msg = $("#pushMsg");
  if (!btn) return;
  const setMsg = (t) => { msg.textContent = t; };
  let ativo = false;
  try {
    const reg = suportaPush() ? await navigator.serviceWorker.getRegistration() : null;
    ativo = Boolean(reg && Notification.permission === "granted" && (await reg.pushManager.getSubscription()));
  } catch { /* nada */ }
  const pintar = () => {
    btn.textContent = ativo ? "Desativar neste aparelho" : "Ativar notificações neste aparelho";
    btn.classList.toggle("primary", !ativo);
    if (ativo) setMsg("Ativadas neste aparelho ✅");
    else if (!suportaPush()) setMsg(ehIphone() && !instalado()
      ? "No iPhone: primeiro instale o app (Safari → Compartilhar → Adicionar à Tela de Início), abra por esse ícone e ative aqui."
      : "Este navegador não aceita notificações de sites. Use o Chrome, Edge, Firefox ou o app instalado.");
    else if (Notification.permission === "denied") setMsg("As notificações foram bloqueadas para este app. Libere nas configurações do navegador/celular e tente de novo.");
    else setMsg(ehIphone() && !instalado() ? "No iPhone, funciona só com o app instalado na Tela de Início (iOS 16.4 ou mais novo)." : "");
  };
  pintar();
  btn.onclick = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (ativo) {
        const s = await reg.pushManager.getSubscription();
        if (s) { await D.api.rpc("app_push_unsubscribe", { endpoint: s.endpoint }); await s.unsubscribe(); }
        ativo = false; pintar(); D.toast("Notificações desativadas neste aparelho"); return;
      }
      if (!suportaPush()) return pintar();
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { pintar(); return; }
      const { chave } = await D.api.ask({ acao: "push_chave" });
      const raw = Uint8Array.from(atob(chave.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((chave.length + 3) % 4)), (c) => c.charCodeAt(0));
      const s = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }));
      const j = s.toJSON();
      await D.api.rpc("app_push_subscribe", { endpoint: j.endpoint, keys: j.keys, ua: navigator.userAgent.slice(0, 200) });
      ativo = true; pintar(); D.toast("Notificações ativadas 🔔");
    } catch (e) { setMsg("Não foi possível ativar: " + (e?.message || e)); }
  };
  const seg = $("#tgAviso");
  if (seg) {
    try {
      const p = await D.api.rpc("app_notify_prefs", {});
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", (x.dataset.v === "1") === p.telegram));
    } catch { /* nada */ }
    seg.onclick = async (e) => {
      const bt = e.target.closest("[data-v]"); if (!bt) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === bt));
      try { await D.api.rpc("app_notify_prefs", { telegram: bt.dataset.v === "1" }); D.toast("Salvo ✅"); } catch (y) { D.toast(y.message); }
    };
  }
}
