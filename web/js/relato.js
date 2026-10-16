// Configurações → Reportar um erro: a pessoa descreve o problema, junta imagens (prints) e envia.
// O relato vai por e-mail para o responsável pelo app, junto com informações do aparelho
// que ajudam a encontrar o problema (tela, navegador, últimos erros que o app registrou).

export const VERSAO = "2026.10.16";
const MAX_FOTOS = 5;
const LADO = 1600;            // reduz imagens grandes para o envio ficar rápido

// ---- guarda os últimos erros do app (ajudam a descobrir o que aconteceu)
const erros = [];
const anota = (t) => { erros.push(`${new Date().toLocaleTimeString("pt-BR")} ${String(t).slice(0, 300)}`); if (erros.length > 8) erros.shift(); };
window.addEventListener("error", (e) => anota(e.message || "erro"));
window.addEventListener("unhandledrejection", (e) => anota(e.reason?.message || e.reason || "falha"));

// ---- última tela visitada (antes de abrir as Configurações)
let ultimaTela = "";
export function noteRoute(route) { if (!route.startsWith("configuracoes")) ultimaTela = "#/" + route; }

const $ = (s, el = document) => el.querySelector(s);

export function reportCard() {
  return `<div class="card" id="reportCard"><h2>🐞 Reportar um erro</h2>
    <p class="small muted">Algo não funcionou como deveria? Conte o que aconteceu e, se puder, junte um print da tela. O relato vai direto para o responsável pelo app.</p>
    <button type="button" class="btn primary" id="reportBtn">Reportar um erro</button></div>`;
}

function reduzir(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, LADO / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL("image/jpeg", 0.82);
      resolve({ nome: (file.name || "print").replace(/\.[^.]+$/, "").slice(0, 50) + ".jpg", tipo: "image/jpeg", base64: data.split(",")[1], preview: data });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("formato")); };
    img.src = url;
  });
}

function contexto(state) {
  return {
    tela: ultimaTela || "#/",
    versao: VERSAO,
    navegador: navigator.userAgent,
    tela_tamanho: `${window.innerWidth}×${window.innerHeight}`,
    instalado: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true ? "sim" : "não",
    tema: document.documentElement.dataset.theme || "automático",
    fuso: Intl.DateTimeFormat().resolvedOptions().timeZone,
    quando: new Date().toLocaleString("pt-BR"),
    online: navigator.onLine ? "sim" : "não",
    mes_aberto: state?.month || undefined,
    erros_recentes: erros.length ? [...erros] : undefined,
  };
}

/** Abre a janela do relato. deps: { api, modal, toast, esc, state } */
export function openReport(deps) {
  const fotos = [];
  deps.modal(`<h2>🐞 Reportar um erro</h2>
    <form id="repForm" novalidate>
      <div class="field"><label for="repTxt">O que aconteceu?</label>
        <textarea class="input" id="repTxt" maxlength="5000" placeholder="Ex.: Fui em Lançamentos, toquei em uma despesa do cartão para editar e apareceu “erro ao salvar”. Aconteceu duas vezes hoje."></textarea>
        <span class="small muted">Diga em qual tela estava, o que fez e o que apareceu. Quanto mais detalhes, mais rápido dá para corrigir.</span></div>
      <div class="field"><label>Imagens <span class="muted">(opcional, até ${MAX_FOTOS})</span></label>
        <div class="rep-fotos" id="repFotos"></div>
        <input type="file" id="repFile" accept="image/*" multiple class="hidden">
        <span class="small muted">Dica: tire um print da tela com o erro. No computador, também dá para colar (Ctrl+V) uma imagem no texto.</span></div>
      <p class="small muted">Junto vão informações do aparelho (tela, navegador, versão do app) para ajudar a encontrar o problema. Nenhuma senha é enviada.</p>
      <p class="small expense hidden form-err" id="repErr"></p>
      <div class="modal-actions"><button type="button" class="btn" id="repCancel">Cancelar</button><button class="btn primary" id="repSend">Enviar</button></div>
    </form>`, (m, close) => {
    const err = (t) => { const e = $("#repErr", m); e.textContent = t; e.classList.toggle("hidden", !t); };
    const pintar = () => {
      $("#repFotos", m).innerHTML = fotos.map((f, i) => `<div class="rep-foto"><img src="${f.preview}" alt="Imagem ${i + 1}"><button type="button" data-rm="${i}" aria-label="Remover imagem">×</button></div>`).join("")
        + (fotos.length < MAX_FOTOS ? `<button type="button" class="rep-add" id="repAdd">＋<br>Adicionar imagem</button>` : "");
    };
    const adicionar = async (files) => {
      err("");
      for (const file of files) {
        if (fotos.length >= MAX_FOTOS) { err(`No máximo ${MAX_FOTOS} imagens.`); break; }
        if (!file.type.startsWith("image/")) { err("Só dá para anexar imagens."); continue; }
        try { fotos.push(await reduzir(file)); }
        catch { err("Não consegui abrir uma das imagens. Tente um print em JPG ou PNG."); }
      }
      pintar();
    };
    pintar();
    $("#repFotos", m).onclick = (e) => {
      const rm = e.target.closest("[data-rm]");
      if (rm) { fotos.splice(Number(rm.dataset.rm), 1); pintar(); return; }
      if (e.target.closest("#repAdd")) $("#repFile", m).click();
    };
    $("#repFile", m).onchange = (e) => { adicionar([...e.target.files]); e.target.value = ""; };
    $("#repTxt", m).addEventListener("paste", (e) => {
      const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (imgs.length) { e.preventDefault(); adicionar(imgs); }
    });
    $("#repCancel", m).onclick = close;
    $("#repTxt", m).focus();
    $("#repForm", m).onsubmit = async (e) => {
      e.preventDefault();
      const texto = $("#repTxt", m).value.trim();
      if (texto.length < 5) return err("Descreva o erro com um pouco mais de detalhe.");
      const btn = $("#repSend", m);
      btn.disabled = true; btn.textContent = "Enviando…"; err("");
      try {
        const r = await deps.api.ask({ acao: "reportar_erro", texto, imagens: fotos.map(({ nome, tipo, base64 }) => ({ nome, tipo, base64 })), contexto: contexto(deps.state) });
        close();
        if (r.status === "enviado") deps.toast(`Relato enviado ✅ Protocolo ${r.protocolo}. Obrigado!`);
        else deps.toast(r.aviso || "Relato guardado.");
      } catch (y) {
        err(y.message || "Não consegui enviar. Confira a internet e tente de novo.");
        btn.disabled = false; btn.textContent = "Enviar";
      }
    };
  });
}
