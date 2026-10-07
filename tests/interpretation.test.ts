// Testes da interpretação (não precisam de banco).  Rodar: bun test
import { describe, expect, test } from "bun:test";
import { extractAmount, parseBRNumber } from "../supabase/functions/_shared/money.ts";
import { resolveDate, resolvePeriod, nthBusinessDay } from "../supabase/functions/_shared/dates.ts";
import { interpretRules } from "../supabase/functions/_shared/interpreter_rules.ts";
import { sanitize } from "../supabase/functions/_shared/ai.ts";
import type { UserContext } from "../supabase/functions/_shared/types.ts";

const HOJE = "2026-10-06"; // terça-feira
const ctx: UserContext = {
  hoje: HOJE,
  contas: ["Carteira", "Nubank", "Poupança"],
  categorias: [
    { tipo: "despesa", nome: "Alimentação", subcategorias: ["Supermercado", "Padaria", "Restaurante", "Delivery", "Lanches"] },
    { tipo: "despesa", nome: "Transporte", subcategorias: ["Combustível", "Uber", "Manutenção"] },
    { tipo: "despesa", nome: "Moradia", subcategorias: ["Energia", "Internet", "Manutenção"] },
    { tipo: "despesa", nome: "Vestuário", subcategorias: ["Roupas"] },
    { tipo: "despesa", nome: "Lazer", subcategorias: ["Cinema"] },
    { tipo: "despesa", nome: "Outros", subcategorias: [] },
    { tipo: "receita", nome: "Salário", subcategorias: [] },
    { tipo: "receita", nome: "Vendas", subcategorias: [] },
    { tipo: "receita", nome: "Outros", subcategorias: [] },
  ],
};
const I = (s: string) => interpretRules(s, ctx);

describe("valores brasileiros", () => {
  test.each([
    ["R$ 50", 50], ["R$ 50,00", 50], ["50 reais", 50], ["cinquenta reais", 50], ["R$ 1.500,00", 1500],
    ["mil e quinhentos reais", 1500], ["1,5 mil", 1500], ["3 mil", 3000], ["cento e cinquenta reais", 150],
    ["2 mil e 500 reais", 2500], ["dois mil e trezentos", 2300], ["87,50", 87.5], ["R$ 1.234.567,89", 1234567.89],
  ])("%s = %d", (s, v) => expect(extractAmount(s as string).valor).toBe(v as number));

  test("R$ 1.500,00 nunca vira 1,50", () => expect(parseBRNumber("1.500,00")!.value).toBe(1500));
  test("'1,500' é ambíguo", () => expect(extractAmount("paguei 1,500").alternativas).toEqual([1.5, 1500]));
  test("parcelas não são confundidas com valor", () => {
    expect(extractAmount("comprei uma TV de 3 mil em 10 vezes")).toEqual({ valor: 3000, parcelas: 10 });
    expect(extractAmount("TV de 2400 em 10x")).toEqual({ valor: 2400, parcelas: 10 });
  });
  test("dia do mês não é valor", () => expect(extractAmount("dia 10 paguei 200 de luz").valor).toBe(200));
  test("artigo 'uma' não é valor", () => expect(extractAmount("comprei uma roupa de 150").valor).toBe(150));
});

describe("datas", () => {
  test("relativas", () => {
    expect(resolveDate("hoje", HOJE).data).toBe("2026-10-06");
    expect(resolveDate("ontem", HOJE).data).toBe("2026-10-05");
    expect(resolveDate("anteontem", HOJE).data).toBe("2026-10-04");
    expect(resolveDate("semana passada", HOJE).data).toBe("2026-09-29");
    expect(resolveDate("dia 10", HOJE).data).toBe("2026-09-10"); // dia 10 ainda não chegou -> mês passado
    expect(resolveDate("dia 3", HOJE).data).toBe("2026-10-03");
    expect(resolveDate("no sábado", HOJE).data).toBe("2026-10-03");
    expect(resolveDate("próximo sábado", HOJE, false).data).toBe("2026-10-10");
    expect(resolveDate("05/09", HOJE).data).toBe("2026-09-05");
  });
  test("quinto dia útil", () => {
    expect(nthBusinessDay("2026-10-01", 5)).toBe("2026-10-07");
    expect(resolveDate("todo quinto dia útil", HOJE, false).data).toBe("2026-10-07");
  });
  test("períodos", () => {
    expect(resolvePeriod("quanto gastei esse mês", HOJE)).toMatchObject({ inicio: "2026-10-01", fim: "2026-10-31" });
    expect(resolvePeriod("mês passado", HOJE)).toMatchObject({ inicio: "2026-09-01", fim: "2026-09-30" });
    expect(resolvePeriod("próximo mês", HOJE)).toMatchObject({ inicio: "2026-11-01", fim: "2026-11-30" });
    expect(resolvePeriod("semana passada", HOJE)).toMatchObject({ inicio: "2026-09-28", fim: "2026-10-04" });
    expect(resolvePeriod("em agosto", HOJE)).toMatchObject({ inicio: "2026-08-01", fim: "2026-08-31" });
  });
});

describe("frases obrigatórias (item 41)", () => {
  test("gastei 50 reais na padaria", () =>
    expect(I("gastei 50 reais na padaria")).toMatchObject({ intent: "CREATE_EXPENSE", tipo: "despesa", valor: 50, categoria: "Alimentação", subcategoria: "Padaria", data: HOJE }));
  test("recebi 1000 reais de salário", () =>
    expect(I("recebi 1000 reais de salário")).toMatchObject({ intent: "CREATE_INCOME", tipo: "receita", valor: 1000, categoria: "Salário" }));
  test("paguei 200 de gasolina", () =>
    expect(I("paguei 200 de gasolina")).toMatchObject({ intent: "CREATE_EXPENSE", valor: 200, categoria: "Transporte", subcategoria: "Combustível" }));
  test("comprei uma TV de 2400 em 10 vezes", () =>
    expect(I("comprei uma TV de 2400 em 10 vezes")).toMatchObject({ intent: "CREATE_EXPENSE", valor: 2400, parcelas: 10, descricao: "TV" }));
  test("gastei 80 no restaurante ontem", () =>
    expect(I("gastei 80 no restaurante ontem")).toMatchObject({ intent: "CREATE_EXPENSE", valor: 80, subcategoria: "Restaurante", data: "2026-10-05" }));
  test("quanto gastei esse mês?", () =>
    expect(I("quanto gastei esse mês?")).toMatchObject({ intent: "QUERY_EXPENSES", consulta: "total", periodo: { inicio: "2026-10-01" } }));
  test("quanto tenho disponível?", () => expect(I("quanto tenho disponível?")).toMatchObject({ intent: "FINANCIAL_ANALYSIS", consulta: "disponivel" }));
  test("qual minha maior despesa?", () => expect(I("qual minha maior despesa?")).toMatchObject({ intent: "QUERY_EXPENSES", consulta: "maior" }));
  test("corrija minha última despesa", () => expect(I("corrija minha última despesa")).toMatchObject({ intent: "EDIT_TRANSACTION", tipo: "despesa" }));
  test("apague o último lançamento", () => expect(I("apague o último lançamento")).toMatchObject({ intent: "DELETE_TRANSACTION" }));
  test("quanto posso gastar até o final do mês?", () =>
    expect(I("quanto posso gastar até o final do mês?")).toMatchObject({ intent: "FINANCIAL_ANALYSIS", consulta: "disponivel" }));
});

describe("outras frases do documento", () => {
  test.each([
    ["Assistente, gastei R$ 50,00 na padaria.", { intent: "CREATE_EXPENSE", valor: 50, subcategoria: "Padaria" }],
    ["Gastei R$ 87,50 no supermercado.", { valor: 87.5, subcategoria: "Supermercado" }],
    ["Ontem fui ao posto e gastei cento e cinquenta reais de gasolina.", { valor: 150, data: "2026-10-05", subcategoria: "Combustível" }],
    ["entrou 3 mil da empresa", { intent: "CREATE_INCOME", valor: 3000 }],
    ["ontem comprei uma roupa de 150 reais", { valor: 150, data: "2026-10-05", subcategoria: "Roupas", descricao: "Roupa" }],
    ["recebi 500 reais daquele cliente", { intent: "CREATE_INCOME", valor: 500 }],
    ["paguei minha conta de luz", { intent: "CREATE_EXPENSE", subcategoria: "Energia", descricao: "Conta de luz" }],
    ["Gastei 100 no Posto ABC.", { valor: 100, estabelecimento: "Posto ABC" }],
    ["Minha internet custa R$ 120 todo mês.", { intent: "CREATE_RECURRING", valor: 120, subcategoria: "Internet" }],
    ["Recebo R$ 7.000 de salário todo quinto dia útil.", { intent: "CREATE_RECURRING", tipo: "receita", valor: 7000 }],
    ["Quanto gastei com alimentação?", { intent: "QUERY_CATEGORY", categoria: "Alimentação" }],
    ["Quanto gastei no supermercado?", { intent: "QUERY_CATEGORY", subcategoria: "Supermercado" }],
    ["Quanto recebi este mês?", { intent: "QUERY_INCOME" }],
    ["Quanto tenho na conta?", { intent: "QUERY_BALANCE" }],
    ["Quanto devo pagar no cartão?", { intent: "QUERY_CARD" }],
    ["Quanto vou gastar com parcelas no próximo mês?", { consulta: "parcelas", periodo: { inicio: "2026-11-01" } }],
    ["Quanto posso gastar hoje?", { consulta: "disponivel" }],
    ["Estou gastando demais?", { consulta: "gastando_demais" }],
    ["Como estão minhas finanças?", { consulta: "resumo" }],
    ["Compare este mês com o mês passado.", { intent: "QUERY_REPORT", consulta: "comparar" }],
    ["Bom dia. Recebi meu salário de R$ 7.000.", { intent: "CREATE_INCOME", valor: 7000, saudacao: "Bom dia" }],
    ["Posso comprar um celular de R$ 1.800?", { consulta: "posso_comprar", valor: 1800 }],
    ["na verdade era lazer", { intent: "CORRECT_CATEGORY", categoria: "Lazer" }],
    ["transferi 500 do nubank para a poupança", { intent: "CREATE_TRANSFER", conta: "Nubank", conta_destino: "Poupança" }],
    ["recebi meu salário", { intent: "CREATE_INCOME", valor: undefined, categoria: "Salário" }],
  ])("%s", (s, exp) => expect(I(s as string)).toMatchObject(exp as object));
});

describe("validação da resposta da IA", () => {
  test("descarta valor inventado e categoria inexistente", () => {
    const r = sanitize({ intent: "CREATE_EXPENSE", tipo: "despesa", valor: 999, categoria: "Pets" }, "paguei a conta", ctx)!;
    expect(r.valor).toBeUndefined();
    expect(r.categoria).toBeUndefined();
  });
  test("aceita dados válidos", () => {
    const r = sanitize({ intent: "CREATE_EXPENSE", tipo: "despesa", valor: 45, categoria: "alimentação", subcategoria: "Lanches", confidence: 0.9 }, "lanchei 45 conto", ctx)!;
    expect(r).toMatchObject({ valor: 45, categoria: "Alimentação", subcategoria: "Lanches" });
  });
  test("intent desconhecido vira OTHER", () => expect(sanitize({ intent: "HACK" }, "x", ctx)!.intent).toBe("OTHER"));
});
