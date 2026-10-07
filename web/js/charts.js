// Gráficos em SVG puro (sem bibliotecas). Marcas finas, eixo único, legenda e tooltip ao passar o dedo/mouse.
const NS = "http://www.w3.org/2000/svg";
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const brl = (c) => (Number(c || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const short = (c) => {
  const v = Math.abs(c / 100);
  const s = v >= 1e6 ? (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi" : v >= 1000 ? (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  return (c < 0 ? "−" : "") + s;
};
const monthLabel = (ym) => MESES[Number(ym.slice(5, 7)) - 1];

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function niceMax(v) {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function tooltip(host) {
  const t = document.createElement("div");
  t.className = "tip hidden";
  host.appendChild(t);
  return {
    show(x, y, html) { t.innerHTML = html; t.style.left = x + "px"; t.style.top = y + "px"; t.classList.remove("hidden"); },
    hide() { t.classList.add("hidden"); },
  };
}

/** Receitas x despesas por mês: barras agrupadas. */
export function incomeExpenseChart(host, data) {
  host.innerHTML = `<div class="legend"><span><i style="background:var(--series-1)"></i>Receitas</span><span><i style="background:var(--series-2)"></i>Despesas</span></div>`;
  const W = Math.max(300, host.clientWidth || 600), H = 220, L = 44, B = 24, T = 8;
  const max = niceMax(Math.max(...data.flatMap((d) => [d.receitas_cents, d.despesas_cents]), 0));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Receitas e despesas dos últimos meses" }, host);
  const tip = tooltip(host);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    el("line", { x1: L, x2: W, y1: y(v), y2: y(v), class: "grid-line" }, svg);
    el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, svg).textContent = short(v);
  }
  const slot = (W - L) / data.length, bw = Math.min(22, slot / 3.2);
  data.forEach((d, i) => {
    const cx = L + slot * i + slot / 2;
    const bars = [[d.receitas_cents, "var(--series-1)", cx - bw - 1], [d.despesas_cents, "var(--series-2)", cx + 1]];
    for (const [v, color, x] of bars) {
      const h = Math.max((H - T - B) * (v / max), v > 0 ? 2 : 0);
      // retângulo com cantos superiores arredondados (4px), ancorado na base
      const r = Math.min(4, h, bw / 2), top = H - B - h;
      el("path", { d: `M${x},${H - B} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - B} Z`, fill: color }, svg);
    }
    el("text", { x: cx, y: H - 6, "text-anchor": "middle", class: "axis" }, svg).textContent = monthLabel(d.mes);
    const hit = el("rect", { x: cx - slot / 2, y: T, width: slot, height: H - T - B, fill: "transparent", style: "cursor:pointer" }, svg);
    const show = () => {
      const box = svg.getBoundingClientRect(), hb = host.getBoundingClientRect();
      const px = (cx / W) * box.width + (box.left - hb.left);
      const py = (y(Math.max(d.receitas_cents, d.despesas_cents)) / H) * box.height + (box.top - hb.top);
      tip.show(px, py, `<b>${monthLabel(d.mes)}/${d.mes.slice(2, 4)}</b><br>Receitas ${brl(d.receitas_cents)}<br>Despesas ${brl(d.despesas_cents)}`);
    };
    hit.addEventListener("mouseenter", show); hit.addEventListener("click", show); hit.addEventListener("mouseleave", tip.hide);
  });
}

/** Evolução do patrimônio (saldo das contas no fim de cada mês): linha única com crosshair. */
export function lineChart(host, data, label = "Patrimônio") {
  host.innerHTML = "";
  const W = Math.max(300, host.clientWidth || 600), H = 200, L = 54, B = 24, T = 12, R = 12;
  const vals = data.map((d) => d.value);
  let min = Math.min(0, ...vals), max = niceMax(Math.max(...vals, 1));
  if (min < 0) min = -niceMax(-min);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label }, host);
  const tip = tooltip(host);
  const x = (i) => L + ((W - L - R) * i) / Math.max(data.length - 1, 1);
  const y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) / 4) * i;
    el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid-line" }, svg);
    el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, svg).textContent = short(v);
  }
  data.forEach((d, i) => { el("text", { x: x(i), y: H - 6, "text-anchor": "middle", class: "axis" }, svg).textContent = d.label; });
  el("path", { d: data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.value)}`).join(" "), fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round" }, svg);
  const last = data.length - 1;
  el("circle", { cx: x(last), cy: y(data[last].value), r: 4.5, fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2 }, svg);
  const cross = el("line", { y1: T, y2: H - B, stroke: "var(--ink-3)", "stroke-width": 1, "stroke-dasharray": "3 3", class: "hidden" }, svg);
  const dot = el("circle", { r: 4.5, fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2, class: "hidden" }, svg);
  const overlay = el("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }, svg);
  const move = (ev) => {
    const box = svg.getBoundingClientRect(), hb = host.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(last, Math.round(((sx - L) / (W - L - R)) * last)));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.classList.remove("hidden");
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(data[i].value)); dot.classList.remove("hidden");
    tip.show((x(i) / W) * box.width + (box.left - hb.left), (y(data[i].value) / H) * box.height + (box.top - hb.top), `<b>${data[i].label}</b><br>${label}: ${brl(data[i].value)}`);
  };
  overlay.addEventListener("pointermove", move); overlay.addEventListener("pointerdown", move);
  overlay.addEventListener("pointerleave", () => { tip.hide(); cross.classList.add("hidden"); dot.classList.add("hidden"); });
}

/** Despesas por categoria: barras horizontais com valor e % sempre visíveis (identidade pelo rótulo, não pela cor). */
export function categoryBars(host, rows) {
  const total = rows.reduce((s, r) => s + Number(r.total_cents), 0) || 1;
  const max = Math.max(...rows.map((r) => Number(r.total_cents)), 1);
  host.innerHTML = rows.map((r) => {
    const budget = r.orcamento_cents ? Number(r.orcamento_cents) : null;
    const w = budget ? Math.min(100, (r.total_cents / budget) * 100) : (r.total_cents / max) * 100;
    const over = budget && r.total_cents > budget;
    return `<div class="catbar" title="${r.categoria}: ${brl(r.total_cents)}">
      <span>${r.icone ?? "•"}</span><span class="name">${r.categoria}</span>
      <span class="val num">${brl(r.total_cents)}<span class="pct">${Math.round((r.total_cents / total) * 100)}%</span></span>
      <div class="track"><div class="fill ${over ? "over" : ""}" style="width:${w}%"></div></div>
      ${budget ? `<span></span><span class="small muted" style="grid-column:2/4">${over ? "⚠️ " : ""}${Math.round((r.total_cents / budget) * 100)}% do orçamento de ${brl(budget)}</span>` : ""}
    </div>`;
  }).join("");
}
