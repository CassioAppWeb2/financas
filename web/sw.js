// Service worker: guarda a "casca" do app para abrir rápido e offline.
// Dados financeiros NUNCA são guardados em cache.
const CACHE = "financas-v21";
const SHELL = ["./", "index.html", "styles.css", "js/app.js", "js/api.js", "js/charts.js", "js/fase2.js", "js/export.js", "js/icons.js", "js/mercado.js", "js/simulador.js", "js/prefs.js", "js/avisos.js", "js/relato.js", "js/config.js", "manifest.webmanifest", "icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // API do Supabase: sempre rede
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});

// Notificações (avisos do app chegando com o app fechado)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Finanças", {
    body: d.body || "Você tem uma novidade no app.", icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: d.tag || "aviso", data: { url: d.url || "#/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const alvo = new URL("./" + (e.notification.data?.url || "#/"), self.registration.scope);
  if (!alvo.hash.includes("avisos=1")) alvo.hash = (alvo.hash || "#/") + (alvo.hash.includes("?") ? "&" : "?") + "avisos=1";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url.startsWith(self.registration.scope));
    if (c) { c.postMessage({ tipo: "abrir-avisos" }); return c.focus(); }
    return self.clients.openWindow(alvo.href);
  }));
});
