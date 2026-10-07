// Comunicação com o Supabase (login, funções app_* e o assistente) — sem bibliotecas externas.
const cfg = window.APP_CONFIG || {};
const BASE = (cfg.SUPABASE_URL || location.origin).replace(/\/$/, "");
const KEY = cfg.SUPABASE_ANON_KEY || "local";
const STORE = "af.session";

function load() { try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch { return null; } }
function save(s) { try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch { /* modo privado */ } }

let session = load();
const listeners = new Set();
export const onAuth = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(session));

function setSession(d) {
  session = d ? { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, user: d.user } : null;
  save(session); emit();
}
export const getSession = () => session;

async function call(path, { method = "POST", body, auth = true } = {}) {
  const headers = { apikey: KEY, "content-type": "application/json" };
  if (auth) {
    await ensureFresh();
    if (!session) throw new Error("Sessão expirada. Entre novamente.");
    headers.authorization = `Bearer ${session.access_token}`;
  }
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Sem conexão com o servidor. Verifique sua internet.");
  }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 401 && auth) { setSession(null); throw new Error("Sessão expirada. Entre novamente."); }
  if (!res.ok) throw new Error(translate(data?.message || data?.msg || data?.error_description || data?.error || `Erro ${res.status}`));
  return data;
}

function translate(m) {
  const map = {
    "Invalid login credentials": "E-mail ou senha incorretos.",
    "User already registered": "Este e-mail já tem cadastro. Use “Entrar”.",
    "Email not confirmed": "Confirme seu e-mail pelo link que enviamos antes de entrar.",
    "Password should be at least 6 characters.": "A senha precisa ter pelo menos 6 caracteres.",
  };
  return map[m] || m;
}

let refreshing = null;
async function ensureFresh() {
  if (!session || Date.now() < session.expires_at - 60_000) return;
  refreshing ??= call("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token }, auth: false })
    .then(setSession).catch(() => setSession(null)).finally(() => { refreshing = null; });
  await refreshing;
}

export async function signIn(email, password) {
  setSession(await call("/auth/v1/token?grant_type=password", { body: { email, password }, auth: false }));
}
export async function signUp(name, email, password) {
  const d = await call("/auth/v1/signup", { body: { email, password, data: { name } }, auth: false });
  if (d?.access_token) { setSession(d); return { confirm: false }; }
  return { confirm: true };
}
export async function signOut() {
  try { await call("/auth/v1/logout", {}); } catch { /* ignora */ }
  setSession(null);
}
export const rpc = (fn, p = {}) => call(`/rest/v1/rpc/${fn}`, { body: { p } });
export const ask = (payload) => call("/functions/v1/assistant", { body: payload });
export const configured = () => Boolean(cfg.SUPABASE_URL) || location.hostname === "localhost" || location.hostname === "127.0.0.1";
