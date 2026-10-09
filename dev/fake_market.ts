// Banco Central "de mentira" para testes e para o servidor local (sem internet).
// Responde no mesmo formato do SGS: [{data:"dd/mm/aaaa", valor:"1.23", dataFim?}]
const VAL: Record<number, (i: number) => number> = {
  432: () => 15, 4389: () => 14.9, 13522: (i) => 5 + i * 0.01, 433: (i) => 0.3 + (i % 3) * 0.1, 189: (i) => 0.5 - (i % 4) * 0.2,
  195: () => 0.62, 226: () => 0.17, 1: (i) => 5.3 + Math.sin(i / 5) * 0.1, 21619: (i) => 6.1 + Math.cos(i / 6) * 0.1,
};
const MONTHLY = new Set([13522, 433, 189]);
const dmy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

export function fakeMarketFetch(opts: { fail?: number[]; calls?: string[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    opts.calls?.push(url);
    const sgs = Number(/bcdata\.sgs\.(\d+)/.exec(url)?.[1]);
    if (opts.fail?.includes(sgs) || !VAL[sgs]) return new Response("erro", { status: 500 });
    const out: any[] = [];
    const hoje = new Date();
    for (let i = 0; i < (MONTHLY.has(sgs) ? 13 : 60); i++) {
      const d = MONTHLY.has(sgs) ? new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 13 + i, 1)) : new Date(hoje.getTime() - (59 - i) * 86400_000);
      const row: any = { data: dmy(d), valor: VAL[sgs](i).toFixed(4) };
      if (sgs === 195 || sgs === 226) row.dataFim = dmy(new Date(d.getTime() + 30 * 86400_000));
      out.push(row);
    }
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
