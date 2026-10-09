// Preferências deste aparelho (tema, ordem dos lançamentos, bloqueio) e o bloqueio por Face ID / digital.
// O bloqueio usa a biometria do próprio aparelho (WebAuthn): a digital/rosto nunca sai do celular.

export function pref(k, d) { try { return localStorage.getItem("pref:" + k) ?? d; } catch { return d; } }
export function setPref(k, v) { try { if (v == null) localStorage.removeItem("pref:" + k); else localStorage.setItem("pref:" + k, v); } catch { /* sem armazenamento */ } }

/** Tema: "auto" (segue o celular), "claro" ou "escuro". */
export function applyTheme() {
  const t = pref("tema", "auto");
  const root = document.documentElement;
  if (t === "claro") root.dataset.theme = "light";
  else if (t === "escuro") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  const dark = t === "escuro" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#091113" : "#0f2f35");
}

// ---------------------------------------------------------------- bloqueio biométrico
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function biometricAvailable() {
  try { return Boolean(window.PublicKeyCredential) && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}
export const lockEnabled = () => pref("bloqueio", "") === "1" && Boolean(pref("bloqueio_cred", ""));

/** Ativa: o aparelho pede o Face ID / digital uma vez para registrar. */
export async function enableLock(email, name) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rnd(32),
    rp: { name: "Finanças" },
    user: { id: rnd(16), name: email || "usuario", displayName: name || email || "Usuário" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
    timeout: 60000, attestation: "none",
  } });
  if (!cred) throw new Error("Não foi possível ativar.");
  setPref("bloqueio_cred", b64(cred.rawId)); setPref("bloqueio", "1");
}
export function disableLock() { setPref("bloqueio", null); setPref("bloqueio_cred", null); }

/** Pede o Face ID / digital. Resolve true se a pessoa foi verificada. */
export async function unlock() {
  const id = pref("bloqueio_cred", "");
  const r = await navigator.credentials.get({ publicKey: {
    challenge: rnd(32), allowCredentials: [{ type: "public-key", id: unb64(id) }], userVerification: "required", timeout: 60000,
  } });
  return Boolean(r);
}

let hiddenAt = 0;
/** Mostra a tela de bloqueio ao abrir o app e ao voltar depois de 2 minutos fora. */
export function setupLock({ logo, onPassword }) {
  const show = () => {
    if (!lockEnabled() || document.getElementById("lockScreen")) return;
    const el = document.createElement("div");
    el.id = "lockScreen"; el.className = "lock";
    el.innerHTML = `<div class="lock-box">${logo}<h1>App bloqueado</h1><p class="muted">Use o Face ID ou a digital para entrar.</p>
      <button class="btn primary" id="lockGo">Desbloquear</button>
      <button class="btn ghost small" id="lockPwd">Entrar com e-mail e senha</button><p class="small expense" id="lockErr"></p></div>`;
    document.body.appendChild(el);
    const go = async () => {
      try { if (await unlock()) el.remove(); }
      catch (e) { el.querySelector("#lockErr").textContent = e?.name === "NotAllowedError" ? "Não foi confirmado. Toque em Desbloquear para tentar de novo." : "Não consegui usar a biometria neste aparelho."; }
    };
    el.querySelector("#lockGo").onclick = go;
    el.querySelector("#lockPwd").onclick = () => { disableLock(); el.remove(); onPassword(); };
    setTimeout(go, 250);   // tenta já ao abrir (em alguns aparelhos precisa tocar no botão)
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 120_000) show();
  });
  show();
}
