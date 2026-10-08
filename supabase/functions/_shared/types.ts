// Tipos compartilhados entre canais, interpretação e motor.

export const INTENTS = [
  "CREATE_EXPENSE", "CREATE_INCOME", "CREATE_TRANSFER", "CREATE_INVESTMENT", "CREATE_REDEMPTION", "CREATE_RECURRING",
  "QUERY_BALANCE", "QUERY_EXPENSES", "QUERY_INCOME", "QUERY_CATEGORY", "QUERY_REPORT", "QUERY_CARD", "QUERY_ACCOUNT",
  "QUERY_BUDGET", "QUERY_GOAL", "CREATE_GOAL", "CREATE_BUDGET", "EDIT_TRANSACTION", "DELETE_TRANSACTION",
  "CORRECT_CATEGORY", "FINANCIAL_ANALYSIS", "HELP", "GREETING", "OTHER",
  "PAY_INVOICE", "GOAL_CONTRIBUTE", "QUERY_RECURRING", "CANCEL_RECURRING", "QUERY_ALERTS",
  "QUERY_DEBTS", "SETTLE_DEBT", "ADMIN",
] as const;
export type Intent = typeof INTENTS[number];

export type Channel = "app" | "whatsapp" | "telegram";

/** Mensagem normalizada: o resto do sistema não sabe de onde ela veio. */
export interface IncomingMessage {
  user_id: string;
  channel: Channel;
  type: "text" | "audio";
  content: string;          // texto digitado ou transcrição do áudio
  timestamp: string;
  audio_provider?: string;
  media_ref?: string;
  document?: { bytes: Uint8Array; mime: string; name?: string };  // PDF/foto de fatura ou extrato
}

export type QueryKind =
  | "total" | "maior" | "parcelas" | "saldo" | "disponivel" | "resumo" | "comparar" | "gastando_demais" | "posso_comprar"
  | "fatura" | "limite" | "cartoes";

export interface Interpretation {
  intent: Intent;
  tipo?: "despesa" | "receita" | "transferencia" | "investimento" | "resgate";
  valor?: number;                 // em reais
  alternativas?: number[];        // valores possíveis quando ambíguo
  data?: string;                  // AAAA-MM-DD
  data_explicita?: boolean;
  descricao?: string;
  estabelecimento?: string;
  categoria?: string;
  subcategoria?: string;
  categoria_confianca?: number;
  conta?: string;
  conta_destino?: string;
  parcelas?: number;
  recorrente?: boolean;
  periodo?: { inicio: string; fim: string; label: string };
  consulta?: QueryKind;
  campo_correcao?: "categoria" | "valor" | "data" | "descricao" | "conta";
  forma_pagamento?: string;
  saudacao?: string;              // "Bom dia" quando a mensagem começa com cumprimento
  familia?: boolean;              // lançamento compartilhado da família ("gastamos", "da casa")
  membro_id?: string;             // filtro de consulta: id da pessoa | 'familia' (só compartilhados)
  cartao?: string;                // nome do cartão de crédito
  meta?: string;                  // nome da meta financeira
  prazo?: string;                 // AAAA-MM-DD (metas)
  frequencia?: "mensal" | "semanal" | "anual";
  dia?: number;                   // dia do mês (recorrência)
  dia_util?: number;              // n-ésimo dia útil (recorrência)
  pessoa_id?: string;             // acerto: a outra pessoa da família
  dividir?: boolean;              // compra dividida entre as pessoas da família
  partes?: { membro: string; cartao?: string; cartao_do_membro?: boolean; conta?: string }[];  // cada parte paga de um jeito
  confidence: number;
  provider?: string;
  model?: string;
}

export interface Member { id: string; nome: string; eu: boolean; }

export interface UserContext {
  hoje: string;
  eu?: string;
  nome?: string;
  membros?: Member[];
  categorias: { tipo: "despesa" | "receita"; nome: string; icone?: string; subcategorias: string[] }[];
  contas: string[];
  cartoes?: string[];
  metas?: string[];
}

export interface Card {
  type: "transaction" | "summary" | "list" | "bars";
  title?: string;
  data?: unknown;
  items?: { label: string; value_cents?: number; hint?: string; icon?: string; pct?: number }[];
}

export interface AssistantReply {
  reply: string;
  cards?: Card[];
  intent?: Intent;
}

/** Acesso ao Motor Financeiro (funções fe_* no banco). */
export interface EngineDb {
  rpc<T = any>(fn: string, userId: string | null, payload?: Record<string, unknown>): Promise<T>;
}
