// AGENTE: o assistente entende pedidos livres ("cadastre para a Bruna o cartão Nubank que vence dia 10")
// e executa CADASTROS por meio de ferramentas. A IA (Gemini) só escolhe a ferramenta e os dados;
// quem valida e grava é sempre o Motor Financeiro (funções fe_*). Ações que apagam/arquivam pedem confirmação.

import type { EngineDb, UserContext } from "./types.ts";
import { geminiCall, type AiConfig } from "./ai.ts";
import { brl, dateBR, norm } from "./text.ts";
import { searchManual, TOPICS } from "./manual.ts";

export type GeminiContent = { role: "user" | "model"; parts: any[] };
export interface AgentCall { name: string; args: Record<string, any> }
export interface AgentResult {
  reply: string;
  history?: GeminiContent[];       // conversa em andamento (faltam dados)
  confirm?: { call: AgentCall; history: GeminiContent[] };  // ação que precisa de "sim"
  done?: boolean;
}

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: "STRING", description, ...extra });
const N = (description: string) => ({ type: "NUMBER", description });
const I = (description: string) => ({ type: "INTEGER", description });
const B = (description: string) => ({ type: "BOOLEAN", description });
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ name, description, parameters: { type: "OBJECT", properties, required } });
const DONO = S("De quem é: nome da pessoa da família, 'eu' para quem está falando, ou 'familia' para conjunto/compartilhado");

export const TOOLS = [
  fn("cadastrar_cartao", "Cadastra um cartão de crédito.", {
    nome: S("Nome do cartão, ex.: Nubank, Itaú Visa"), dia_fechamento: I("Dia do mês em que a fatura fecha (1-31)"),
    dia_vencimento: I("Dia do mês em que a fatura vence (1-31)"), limite: N("Limite em reais (opcional)"), dono: DONO,
    conta_pagamento: S("Conta de onde a fatura é paga (opcional)"),
  }, ["nome", "dia_fechamento", "dia_vencimento"]),
  fn("editar_cartao", "Altera dados de um cartão já cadastrado.", {
    cartao: S("Nome do cartão a alterar"), novo_nome: S("Novo nome"), dia_fechamento: I("Novo dia de fechamento"),
    dia_vencimento: I("Novo dia de vencimento"), limite: N("Novo limite em reais"), dono: DONO, conta_pagamento: S("Conta de pagamento da fatura"),
  }, ["cartao"]),
  fn("arquivar_cartao", "Arquiva (desativa) um cartão. O histórico continua.", { cartao: S("Nome do cartão") }, ["cartao"]),
  fn("cadastrar_conta", "Cadastra uma conta bancária, carteira ou poupança.", {
    nome: S("Nome da conta, ex.: Itaú, Carteira"), tipo: S("Tipo", { enum: ["corrente", "digital", "poupanca", "dinheiro", "investimento", "outro"] }),
    saldo_inicial: N("Saldo atual em reais (opcional, pode ser negativo)"), instituicao: S("Banco (opcional)"), dono: DONO,
    padrao: B("Se deve ser a conta padrão"),
  }, ["nome"]),
  fn("editar_conta", "Altera uma conta já cadastrada.", {
    conta: S("Nome da conta a alterar"), novo_nome: S("Novo nome"), tipo: S("Tipo", { enum: ["corrente", "digital", "poupanca", "dinheiro", "investimento", "outro"] }),
    saldo_inicial: N("Novo saldo inicial em reais"), instituicao: S("Banco"), dono: DONO, padrao: B("Tornar a conta padrão"),
  }, ["conta"]),
  fn("arquivar_conta", "Arquiva (desativa) uma conta.", { conta: S("Nome da conta") }, ["conta"]),
  fn("criar_categoria", "Cria uma categoria.", {
    nome: S("Nome da categoria"), tipo: S("despesa ou receita", { enum: ["despesa", "receita"] }), icone: S("Um emoji (opcional)"),
  }, ["nome", "tipo"]),
  fn("renomear_categoria", "Renomeia uma categoria ou troca o ícone.", {
    categoria: S("Nome atual"), novo_nome: S("Novo nome"), icone: S("Novo emoji (opcional)"),
  }, ["categoria", "novo_nome"]),
  fn("excluir_categoria", "Exclui uma categoria sem lançamentos.", { categoria: S("Nome da categoria") }, ["categoria"]),
  fn("criar_subcategoria", "Cria uma subcategoria dentro de uma categoria.", { categoria: S("Categoria"), nome: S("Nome da subcategoria") }, ["categoria", "nome"]),
  fn("criar_meta", "Cria uma meta financeira (juntar dinheiro).", {
    nome: S("Nome da meta, ex.: Viagem"), valor: N("Quanto quer juntar, em reais"), prazo: S("Data limite AAAA-MM-DD (opcional)"),
  }, ["nome", "valor"]),
  fn("editar_meta", "Altera uma meta financeira.", {
    meta: S("Nome da meta"), novo_nome: S("Novo nome"), valor: N("Novo valor objetivo em reais"), prazo: S("Novo prazo AAAA-MM-DD"),
  }, ["meta"]),
  fn("definir_orcamento", "Define o orçamento mensal de uma categoria de despesa (0 remove).", { categoria: S("Categoria"), valor: N("Valor por mês em reais") }, ["categoria", "valor"]),
  fn("definir_meta_economia_mensal", "Define quanto a família quer economizar por mês (0 remove).", { valor: N("Valor em reais") }, ["valor"]),
  fn("manual_do_app", "Consulta o manual do aplicativo (como instalar, atualizar, microfone, Telegram, família, cartões, faturas, importar, contas a pagar, relatórios etc.). Use SEMPRE que a pessoa tiver dúvida de como usar o app ou algo não funcionar.", {
    pergunta: S("A dúvida da pessoa, com as palavras dela"),
  }, ["pergunta"]),
  fn("consultar_cadastros", "Lista contas (com saldo), cartões (fechamento, vencimento, limite, dono) e categorias.", {}),
  fn("resumo_do_mes", "Números do mês: receitas, despesas, saldo, faturas, gastos por categoria. Use para responder perguntas sobre as finanças com dados reais.", {
    mes: S("Mês AAAA-MM (opcional, padrão: atual)"),
  }),
];
const DESTRUCTIVE = new Set(["arquivar_cartao", "arquivar_conta", "excluir_categoria"]);

function systemPrompt(uc: UserContext): string {
  const membros = (uc.membros ?? []).map((m) => `${m.nome}${m.eu ? " (é quem está falando)" : ""}`).join(", ") || uc.nome || "só a pessoa";
  return `Você é ${uc.assistente ? `o ${uc.assistente}, ` : "o "}assistente de um app de finanças pessoais brasileiro${uc.assistente ? ` (a pessoa te deu esse nome; se ela te chamar assim, é com você)` : ""}. Hoje é ${uc.hoje}. Fale português do Brasil, de forma curta e simpática.
Você pode EXECUTAR cadastros chamando as ferramentas: cartões, contas, categorias, subcategorias, metas, orçamentos e meta de economia.
Regras:
- Se faltar um dado obrigatório para a ferramenta, PERGUNTE (uma pergunta curta, pode juntar 2 dados numa mesma pergunta). Não invente valores, dias ou nomes.
- Para cartão, se a pessoa disser só o vencimento, pergunte o dia de fechamento (pode sugerir: costuma ser uns 7 dias antes do vencimento) — só cadastre depois que ela confirmar.
- Use o resultado da ferramenta para responder. Se a ferramenta devolver "erro", explique e peça o que falta.
- Se a pessoa pedir várias coisas, faça uma de cada vez.
- Pessoas da família: ${membros}.
- Contas: ${uc.contas.join(", ") || "nenhuma"}. Cartões: ${(uc.cartoes ?? []).join(", ") || "nenhum"}.
- Lançar gastos/receitas e consultas comuns o app já faz sozinho; se a pessoa pedir isso, diga para escrever naturalmente, ex.: "gastei 50 no mercado", "quanto gastei este mês?".
- Perguntas gerais sobre finanças (o que é CDI, como economizar...) responda em até 5 linhas, sem inventar números da pessoa; para números dela, use resumo_do_mes.
- Dúvidas de como usar o app (telas, botões, instalar, microfone, Telegram, família, erros): chame manual_do_app e explique em passos curtos, usando só o que o manual diz. Não invente telas ou botões; se o manual não cobrir, diga que não sabe e sugira falar com quem administra o app.
- Nunca diga que fez algo que não fez. Ao concluir um cadastro, confirme em 1–2 linhas com os dados gravados.`;
}

// ---------------------------------------------------------------------------
// Execução das ferramentas (sempre pelo Motor Financeiro)
// ---------------------------------------------------------------------------
interface Ctx { db: EngineDb; user: string; uc: UserContext; origem: string }

function person(c: Ctx, dono?: string): string | undefined {
  if (dono === undefined || dono === null || dono === "") return undefined;
  const n = norm(String(dono));
  if (/^(eu|meu|minha|mim|para mim|pra mim)$/.test(n)) return (c.uc.membros ?? []).find((m) => m.eu)?.id ?? c.user;
  if (/(familia|conjunt|compartilhad|nosso|nossa|casa)/.test(n)) return "familia";
  const m = (c.uc.membros ?? []).find((x) => norm(x.nome) === n || norm(x.nome).split(" ")[0] === n.split(" ")[0]);
  if (!m) throw new Error(`Não encontrei a pessoa “${dono}”. Pessoas da família: ${(c.uc.membros ?? []).map((x) => x.nome).join(", ")}.`);
  return m.id;
}
const find = (list: any[], name: string, what: string): any => {
  const n = norm(name);
  const hit = list.find((x) => norm(x.nome) === n) ?? list.find((x) => norm(x.nome).includes(n) || n.includes(norm(x.nome)));
  if (!hit) throw new Error(`Não encontrei ${what} “${name}”. Existentes: ${list.map((x) => x.nome).join(", ") || "nenhum"}.`);
  return hit;
};
const day = (v: unknown, label: string) => {
  const d = Number(v);
  if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error(`O ${label} precisa ser um dia entre 1 e 31.`);
  return d;
};

async function cadastros(c: Ctx) { return c.db.rpc<any>("fe_admin", c.user, { acao: "cadastros" }); }

export async function execTool(call: AgentCall, c: Ctx): Promise<Record<string, unknown>> {
  const a = call.args ?? {};
  const rpc = (f: string, p: Record<string, unknown>) => c.db.rpc<any>(f, c.user, p);
  const admin = (acao: string, dados: Record<string, unknown>) => rpc("fe_admin", { acao, dados });
  switch (call.name) {
    case "cadastrar_cartao": {
      const membro = person(c, a.dono);
      const r = await rpc("fe_save_card", { nome: a.nome, fechamento: day(a.dia_fechamento, "dia de fechamento"), vencimento: day(a.dia_vencimento, "dia de vencimento"),
        limite: a.limite ?? "", conta_pagamento: a.conta_pagamento, origem: c.origem, ...(membro ? { membro } : {}) });
      return { ok: true, id: r.id, cartao: a.nome, fechamento: a.dia_fechamento, vencimento: a.dia_vencimento, limite: a.limite ?? null, dono: a.dono ?? "eu" };
    }
    case "editar_cartao": {
      const cards = await rpc("fe_cards", {});
      const k = find(cards, String(a.cartao), "o cartão");
      const membro = person(c, a.dono);
      await rpc("fe_save_card", {
        id: k.id, nome: a.novo_nome ?? k.nome,
        fechamento: a.dia_fechamento != null ? day(a.dia_fechamento, "dia de fechamento") : k.fechamento,
        vencimento: a.dia_vencimento != null ? day(a.dia_vencimento, "dia de vencimento") : k.vencimento,
        limite: a.limite != null ? a.limite : k.limite_cents != null ? k.limite_cents / 100 : "", cor: k.cor,
        ...(a.conta_pagamento ? { conta_pagamento: a.conta_pagamento } : { conta_pagamento_id: k.conta_pagamento_id }),
        ...(membro ? { membro } : {}), origem: c.origem,
      });
      return { ok: true, cartao: a.novo_nome ?? k.nome, alterado: Object.keys(a).filter((x) => x !== "cartao") };
    }
    case "arquivar_cartao": {
      const k = find(await rpc("fe_cards", {}), String(a.cartao), "o cartão");
      await rpc("fe_archive_card", { id: k.id });
      return { ok: true, arquivado: k.nome };
    }
    case "cadastrar_conta": {
      const membro = person(c, a.dono);
      await admin("salvar_conta", { nome: a.nome, tipo: a.tipo ?? "corrente", instituicao: a.instituicao, saldo_inicial: a.saldo_inicial, padrao: a.padrao ?? false, ...(membro ? { membro } : {}) });
      return { ok: true, conta: a.nome, saldo_inicial: a.saldo_inicial ?? 0, dono: a.dono ?? "eu" };
    }
    case "editar_conta": {
      const k = find((await cadastros(c)).contas, String(a.conta), "a conta");
      const membro = person(c, a.dono);
      await admin("salvar_conta", { id: k.id, nome: a.novo_nome ?? k.nome, tipo: a.tipo ?? k.tipo, instituicao: a.instituicao ?? k.instituicao,
        ...(a.saldo_inicial != null ? { saldo_inicial: a.saldo_inicial } : {}), ...(a.padrao != null ? { padrao: a.padrao } : {}), ...(membro ? { membro } : {}) });
      return { ok: true, conta: a.novo_nome ?? k.nome, alterado: Object.keys(a).filter((x) => x !== "conta") };
    }
    case "arquivar_conta": {
      const k = find((await cadastros(c)).contas.filter((x: any) => x.status === "ativa"), String(a.conta), "a conta");
      await admin("arquivar_conta", { id: k.id });
      return { ok: true, arquivada: k.nome };
    }
    case "criar_categoria":
      await admin("salvar_categoria", { nome: a.nome, tipo: a.tipo, icone: a.icone });
      return { ok: true, categoria: a.nome, tipo: a.tipo };
    case "renomear_categoria": {
      const k = find((await cadastros(c)).categorias, String(a.categoria), "a categoria");
      await admin("salvar_categoria", { id: k.id, nome: a.novo_nome, icone: a.icone });
      return { ok: true, de: k.nome, para: a.novo_nome };
    }
    case "excluir_categoria": {
      const k = find((await cadastros(c)).categorias, String(a.categoria), "a categoria");
      await admin("excluir_categoria", { id: k.id });
      return { ok: true, excluida: k.nome };
    }
    case "criar_subcategoria": {
      const k = find((await cadastros(c)).categorias, String(a.categoria), "a categoria");
      await admin("salvar_subcategoria", { categoria_id: k.id, nome: a.nome });
      return { ok: true, categoria: k.nome, subcategoria: a.nome };
    }
    case "criar_meta": {
      const r = await rpc("fe_save_goal", { nome: a.nome, valor: a.valor, prazo: a.prazo, origem: c.origem });
      return { ok: true, meta: r.meta?.nome, objetivo: brl(r.meta?.objetivo_cents), prazo: r.meta?.prazo ? dateBR(r.meta.prazo) : null, guardar_por_mes: r.meta?.por_mes_cents ? brl(r.meta.por_mes_cents) : null };
    }
    case "editar_meta": {
      const g = find(await rpc("fe_goals", {}), String(a.meta), "a meta");
      const r = await rpc("fe_save_goal", { id: g.id, nome: a.novo_nome ?? g.nome, valor: a.valor ?? g.objetivo_cents / 100, prazo: a.prazo ?? g.prazo ?? "", origem: c.origem });
      return { ok: true, meta: r.meta?.nome, objetivo: brl(r.meta?.objetivo_cents), prazo: r.meta?.prazo ? dateBR(r.meta.prazo) : null };
    }
    case "definir_orcamento": {
      const r = await rpc("fe_set_budget", { categoria: a.categoria, valor: a.valor, origem: c.origem });
      if (r.status !== "saved") throw new Error(`Não encontrei a categoria de despesa “${a.categoria}”.`);
      return { ok: true, categoria: r.categoria, valor_mensal: brl(r.valor_cents), gasto_no_mes: r.situacao ? brl(r.situacao.gasto_cents) : null };
    }
    case "definir_meta_economia_mensal":
      await admin("perfil", { meta_economia: String(a.valor ?? 0) });
      return { ok: true, meta_economia_mensal: brl(Math.round(Number(a.valor ?? 0) * 100)) };
    case "manual_do_app": {
      const r = searchManual(String(a.pergunta ?? ""), 3);
      return r.length ? { topicos: r.map((x) => ({ titulo: x.topic.titulo, texto: x.topic.texto })) }
        : { topicos: [], assuntos_disponiveis: TOPICS.map((t) => t.titulo) };
    }
    case "consultar_cadastros": {
      const d = await cadastros(c);
      return {
        contas: d.contas.filter((x: any) => x.status === "ativa").map((x: any) => ({ nome: x.nome, saldo: brl(x.saldo_cents), dono: x.membro })),
        cartoes: d.cartoes.map((k: any) => ({ nome: k.nome, fecha_dia: k.fechamento, vence_dia: k.vencimento, limite: k.limite_cents != null ? brl(k.limite_cents) : null, dono: k.membro, fatura_atual: brl(k.fatura_atual.total_cents) })),
        categorias: d.categorias.map((x: any) => `${x.nome} (${x.tipo})${x.subcategorias.length ? ": " + x.subcategorias.map((s: any) => s.nome).join(", ") : ""}`),
        meta_economia_mensal: d.meta_economia_cents ? brl(d.meta_economia_cents) : null,
      };
    }
    case "resumo_do_mes": {
      const o = await rpc("fe_month_overview", { mes: a.mes });
      return {
        mes: o.mes, receitas: brl(o.receitas_cents), despesas: brl(o.despesas_cents), saldo_em_contas: brl(o.saldo_contas_cents),
        receitas_previstas: brl(o.receitas_previstas_cents), compromissos_ate_fim_do_mes: brl(o.compromissos_futuros_cents), faturas_do_mes: brl(o.faturas_mes_cents),
        despesas_por_categoria: (o.por_categoria ?? []).slice(0, 8).map((x: any) => `${x.categoria}: ${brl(x.total_cents)}`),
        alertas: (o.alertas ?? []).map((x: any) => x.texto),
      };
    }
  }
  throw new Error("Ferramenta desconhecida.");
}

// ---------------------------------------------------------------------------
// Conversa com a IA (até 4 passos de ferramenta por mensagem)
// ---------------------------------------------------------------------------
const AGENT_MODELS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];

/** Um modelo por vez (o agente faz várias chamadas; correr modelos em paralelo gastaria a cota à toa). */
// Modelo que respondeu por último (os próximos pedidos começam por ele) e se aceita "pensar pouco".
let preferred: string | undefined;
const noThinking = new Set<string>();

async function askModel(cfg: AiConfig, body: any): Promise<any> {
  const models = [...new Set([preferred, cfg.geminiModel, ...AGENT_MODELS].filter(Boolean) as string[])];
  let last: unknown;
  for (const m of models) {
    // "pensar pouco" deixa a resposta bem mais rápida; se o modelo não aceitar a opção, tenta sem ela
    if (!noThinking.has(m)) {
      try {
        const fast = { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: "minimal" } } };
        const r = (await geminiCall(cfg, fast, 20000, [m])).data; preferred = m; return r;
      } catch (e) {
        last = e;
        if (!/\b400\b/.test(String((e as Error).message))) continue;
        noThinking.add(m);
      }
    }
    try { const r = (await geminiCall(cfg, body, 20000, [m])).data; preferred = m; return r; } catch (e) { last = e; }
  }
  throw last ?? new Error("IA indisponível");
}

// Confirmação pronta (sem segunda ida à IA) para os cadastros que deram certo
function memberName(c: Ctx, dono: unknown): string | undefined {
  if (dono == null || dono === "") return undefined;
  const n = norm(String(dono));
  if (/^(eu|meu|minha|mim)/.test(n)) return undefined;
  if (/(familia|conjunt|compartilhad|nosso|nossa|casa)/.test(n)) return "a família";
  return (c.uc.membros ?? []).find((m) => norm(m.nome).split(" ")[0] === n.split(" ")[0])?.nome.split(" ")[0] ?? String(dono);
}
function confirmText(call: AgentCall, r: any, c: Ctx): string | null {
  const a = call.args ?? {};
  const quem = memberName(c, a.dono);
  const alt = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k} ${v}`).join(", ");
  switch (call.name) {
    case "cadastrar_cartao":
      return `✅ Cartão **${a.nome}**${quem ? ` ${quem === "a família" ? "da família" : `de ${quem}`}` : ""} cadastrado: fecha dia ${a.dia_fechamento} e vence dia ${a.dia_vencimento}${a.limite ? `, limite ${brl(Math.round(Number(a.limite) * 100))}` : ""}.`;
    case "editar_cartao":
      return `✅ Cartão **${r.cartao}** atualizado: ${alt({ "novo nome": a.novo_nome, fechamento: a.dia_fechamento != null ? `dia ${a.dia_fechamento}` : null,
        vencimento: a.dia_vencimento != null ? `dia ${a.dia_vencimento}` : null, limite: a.limite != null ? brl(Math.round(Number(a.limite) * 100)) : null,
        dono: quem, "conta de pagamento": a.conta_pagamento })}.`;
    case "cadastrar_conta":
      return `✅ Conta **${a.nome}**${quem ? ` ${quem === "a família" ? "da família" : `de ${quem}`}` : ""} criada${a.saldo_inicial != null ? ` com saldo de ${brl(Math.round(Number(a.saldo_inicial) * 100))}` : ""}${a.padrao ? " (padrão)" : ""}.`;
    case "editar_conta":
      return `✅ Conta **${r.conta}** atualizada: ${alt({ "novo nome": a.novo_nome, tipo: a.tipo, "saldo inicial": a.saldo_inicial != null ? brl(Math.round(Number(a.saldo_inicial) * 100)) : null,
        dono: quem, banco: a.instituicao, padrão: a.padrao ? "sim" : null })}.`;
    case "criar_categoria": return `✅ Categoria **${a.nome}** criada (${a.tipo}).`;
    case "renomear_categoria": return `✅ Categoria renomeada: ${r.de} → **${r.para}**.`;
    case "criar_subcategoria": return `✅ Subcategoria **${r.subcategoria}** criada em **${r.categoria}**.`;
    case "criar_meta": return `🎯 Meta **${r.meta}** criada: ${r.objetivo}${r.prazo ? ` até ${r.prazo}` : ""}${r.guardar_por_mes ? ` — guarde cerca de ${r.guardar_por_mes} por mês` : ""}.`;
    case "editar_meta": return `🎯 Meta **${r.meta}** atualizada: ${r.objetivo}${r.prazo ? ` até ${r.prazo}` : ""}.`;
    case "definir_orcamento": return `💵 Orçamento de **${r.categoria}**: ${r.valor_mensal} por mês${r.gasto_no_mes ? ` (gasto até agora: ${r.gasto_no_mes})` : ""}.`;
    case "definir_meta_economia_mensal": return `✅ Meta de economia: **${r.meta_economia_mensal}** por mês.`;
  }
  return null;   // consultas: a IA monta a resposta com os dados
}

export async function runAgent(text: string, history: GeminiContent[], c: Ctx, cfg: AiConfig): Promise<AgentResult> {
  const contents: GeminiContent[] = [...history.slice(-14), { role: "user", parts: [{ text }] }];
  for (let step = 0; step < 5; step++) {
    const data = await askModel(cfg, {
      systemInstruction: { parts: [{ text: systemPrompt(c.uc) }] },
      contents,
      tools: [{ functionDeclarations: TOOLS }],
      generationConfig: { temperature: 0.2 },
    });
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall).map((p) => ({ name: String(p.functionCall.name), args: p.functionCall.args ?? {} }));
    const said = parts.map((p) => p.text).filter(Boolean).join("\n").trim();
    if (!calls.length) {
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: said || "…" }] });
      const asking = /\?\s*$/.test(said) || /\b(qual|quais|me (diga|informe|passe)|preciso saber|confirma)\b/i.test(said);
      return { reply: said || "Não consegui concluir. Pode explicar de outro jeito?", history: asking ? contents : undefined, done: !asking };
    }
    // devolve as partes como vieram (o Gemini 3 exige a "assinatura" do raciocínio de volta)
    contents.push({ role: "model", parts });
    const call = calls[0];
    if (DESTRUCTIVE.has(call.name)) {
      const alvo = call.args.cartao ?? call.args.conta ?? call.args.categoria;
      const what = call.name === "arquivar_cartao" ? `arquivar o cartão “${alvo}”` : call.name === "arquivar_conta" ? `arquivar a conta “${alvo}”` : `excluir a categoria “${alvo}”`;
      return { reply: `Confirma ${what}? (*sim* / *não*)`, confirm: { call, history: contents } };
    }
    const responses = [];
    const ready: (string | null)[] = [];
    for (const k of calls.slice(0, 3)) {
      if (DESTRUCTIVE.has(k.name)) { responses.push({ functionResponse: { name: k.name, response: { erro: "Faça esta ação separadamente, com confirmação." } } }); ready.push(null); continue; }
      let result: Record<string, unknown>;
      try { result = await execTool(k, c); } catch (e) { result = { erro: (e as Error).message }; }
      responses.push({ functionResponse: { name: k.name, response: result } });
      ready.push(result.erro ? null : confirmText(k, result, c));
    }
    contents.push({ role: "user", parts: responses });
    // tudo gravado com sucesso: responde na hora, sem esperar outra resposta da IA
    if (ready.length && ready.every(Boolean)) return { reply: ready.join("\n"), done: true };
  }
  return { reply: "Fiz o que consegui. Confira em *Cadastros* no app. 🙂", done: true };
}

/** "sim" numa ação que precisava de confirmação: executa e responde direto. */
export async function confirmAgent(call: AgentCall, c: Ctx): Promise<string> {
  try {
    const r = await execTool(call, c) as any;
    if (r.arquivado) return `✅ Cartão **${r.arquivado}** arquivado. O histórico continua no app.`;
    if (r.arquivada) return `✅ Conta **${r.arquivada}** arquivada.`;
    if (r.excluida) return `✅ Categoria **${r.excluida}** excluída.`;
    return "✅ Feito.";
  } catch (e) {
    return `⚠️ Não consegui: ${(e as Error).message}`;
  }
}
