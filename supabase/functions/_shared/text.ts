// Utilitários de texto e dinheiro em português do Brasil.

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** minúsculas, sem acentos, espaços simples */
export function norm(s: string): string {
  return stripAccents(s.toLowerCase()).replace(/\s+/g, " ").trim();
}

export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function brl(cents: number | string | null | undefined): string {
  const v = Number(cents ?? 0) / 100;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(v)
    .replace(/\u00a0/g, " ");
}

/** formata reais (number) */
export function brlReais(v: number): string {
  return brl(Math.round(v * 100));
}

export function pct(n: number): string {
  return `${Math.round(n)}%`;
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function monthName(iso: string): string {
  const m = Number(iso.slice(5, 7));
  return MESES[m - 1] ?? iso;
}

export function dateBR(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
