-- =====================================================================
-- FASE 2 — estrutura: cartões/faturas, recorrências, metas, orçamentos, importação
-- (somente acréscimos; nenhum dado existente é apagado)
-- =====================================================================

-- Lançamentos: pagamento de fatura, origem "recorrência", vencimento da fatura e id externo (importação)
alter table public.transactions drop constraint if exists transactions_type_check;
alter table public.transactions add constraint transactions_type_check
  check (type in ('receita','despesa','transferencia','investimento','resgate','ajuste','pagamento_fatura'));
alter table public.transactions drop constraint if exists transactions_origin_check;
alter table public.transactions add constraint transactions_origin_check
  check (origin in ('app_chat','app_form','whatsapp','telegram','importacao','recorrencia'));
alter table public.transactions add column if not exists invoice_due date;        -- vencimento da fatura (compras no cartão)
alter table public.transactions add column if not exists external_id text;       -- id do extrato importado (evita duplicar)
alter table public.transactions add constraint invoice_payment_valid
  check (type <> 'pagamento_fatura' or (card_id is not null and account_id is not null and invoice_due is not null));
create index if not exists transactions_card_invoice_idx on public.transactions(user_id, card_id, invoice_due) where deleted_at is null;
create index if not exists transactions_recurring_idx on public.transactions(recurring_id) where deleted_at is null;
create index if not exists transactions_external_idx on public.transactions(user_id, external_id) where external_id is not null;

-- Cartões: cor para a tela
alter table public.credit_cards add column if not exists color text;

-- Recorrências: de quem é, quem criou, início/fim
alter table public.recurring_transactions add column if not exists member_id uuid references auth.users(id) on delete set null;
alter table public.recurring_transactions add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.recurring_transactions add column if not exists start_date date;
alter table public.recurring_transactions add column if not exists end_date date;
alter table public.recurring_transactions add column if not exists updated_at timestamptz not null default now();

-- Metas: ícone e aportes (cada aporte fica registrado)
alter table public.financial_goals add column if not exists icon text;
alter table public.financial_goals add column if not exists updated_at timestamptz not null default now();
create table if not exists public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,     -- titular da família
  goal_id uuid not null references public.financial_goals(id) on delete cascade,
  amount_cents bigint not null check (amount_cents <> 0),               -- negativo = retirada
  date date not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  origin text not null default 'app_form',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists goal_contrib_idx on public.goal_contributions(goal_id) where deleted_at is null;

-- Orçamentos: valor vale a partir do mês informado; 0 = "sem orçamento a partir daqui"
alter table public.budgets drop constraint if exists budgets_amount_cents_check;
alter table public.budgets add constraint budgets_amount_cents_check check (amount_cents >= 0);
alter table public.budgets add column if not exists updated_at timestamptz not null default now();

-- Segurança: aportes seguem a mesma regra de família das demais tabelas financeiras
alter table public.goal_contributions enable row level security;
drop policy if exists "family rows" on public.goal_contributions;
create policy "family rows" on public.goal_contributions for select to authenticated
  using (user_id = (select public.my_owner()));
revoke all on public.goal_contributions from anon, authenticated;
grant select on public.goal_contributions to authenticated;
