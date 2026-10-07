-- =====================================================================
-- Assistente Financeiro Pessoal — esquema do banco (PostgreSQL / Supabase)
-- Valores monetários são guardados em CENTAVOS (bigint) para evitar erros
-- de arredondamento. Ex.: R$ 1.500,00 = 150000.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Perfis (complementa auth.users, que é a tabela "users" do Supabase)
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  timezone text not null default 'America/Sao_Paulo',
  monthly_savings_goal_cents bigint check (monthly_savings_goal_cents is null or monthly_savings_goal_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Família (domicílio): várias pessoas compartilham os MESMOS dados.
-- Os dados financeiros pertencem ao "titular" (user_id = titular);
-- cada lançamento guarda também QUEM registrou e DE QUEM é.
-- ---------------------------------------------------------------------
create table public.household_members (
  member_id uuid primary key references auth.users(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'membro' check (role in ('titular','membro')),
  joined_at timestamptz not null default now()
);
create index household_members_owner_idx on public.household_members(owner_id);

create table public.household_invites (
  code text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Titular da família da pessoa (ela mesma, se não participa de outra família)
create or replace function public.fe_owner(p_user uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select owner_id from public.household_members where member_id = p_user), p_user)
$$;

-- Usada pelas regras de segurança (RLS): titular da família de QUEM está logado
create or replace function public.my_owner() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select public.fe_owner(auth.uid())
$$;
revoke all on function public.my_owner() from public, anon;
grant execute on function public.my_owner() to authenticated;

-- ---------------------------------------------------------------------
-- Contas
-- ---------------------------------------------------------------------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  institution text,
  type text not null default 'corrente'
    check (type in ('corrente','digital','poupanca','dinheiro','investimento','outro')),
  initial_balance_cents bigint not null default 0,
  is_default boolean not null default false,
  status text not null default 'ativa' check (status in ('ativa','arquivada')),
  created_at timestamptz not null default now()
);
create index accounts_user_idx on public.accounts(user_id);
create unique index accounts_one_default on public.accounts(user_id) where is_default;

-- ---------------------------------------------------------------------
-- Cartões (estrutura pronta; regras completas na Fase 2)
-- ---------------------------------------------------------------------
create table public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  bank text,
  brand text,
  limit_cents bigint check (limit_cents is null or limit_cents >= 0),
  closing_day smallint check (closing_day between 1 and 31),
  due_day smallint check (due_day between 1 and 31),
  payment_account_id uuid references public.accounts(id) on delete set null,
  status text not null default 'ativo' check (status in ('ativo','arquivado')),
  created_at timestamptz not null default now()
);
create index credit_cards_user_idx on public.credit_cards(user_id);

-- ---------------------------------------------------------------------
-- Categorias e subcategorias (cada usuário tem sua cópia editável)
-- ---------------------------------------------------------------------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('despesa','receita')),
  name text not null check (length(trim(name)) between 1 and 40),
  icon text,
  is_system boolean not null default false,
  archived_at timestamptz,            -- "excluída" pelo usuário (fica no histórico)
  created_at timestamptz not null default now()
);
create unique index categories_unique_name on public.categories(user_id, kind, lower(name));

create table public.subcategories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index subcategories_unique_name on public.subcategories(category_id, lower(name));
create index subcategories_user_idx on public.subcategories(user_id);

-- ---------------------------------------------------------------------
-- Estabelecimentos e aprendizado (usuário + estabelecimento -> categoria)
-- ---------------------------------------------------------------------
create table public.establishments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  normalized_name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, normalized_name)
);

create table public.establishment_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  subcategory_id uuid references public.subcategories(id) on delete set null,
  hits integer not null default 1,
  updated_at timestamptz not null default now(),
  unique (user_id, establishment_id)
);

-- ---------------------------------------------------------------------
-- Recorrências (estrutura pronta; geração automática na Fase 2)
-- ---------------------------------------------------------------------
create table public.recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('receita','despesa')),
  amount_cents bigint not null check (amount_cents > 0),
  description text not null,
  category_id uuid references public.categories(id) on delete set null,
  subcategory_id uuid references public.subcategories(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  card_id uuid references public.credit_cards(id) on delete set null,
  frequency text not null default 'mensal' check (frequency in ('mensal','semanal','anual')),
  day_of_month smallint check (day_of_month between 1 and 31),
  business_day smallint check (business_day between 1 and 23),
  next_date date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index recurring_user_idx on public.recurring_transactions(user_id);

-- ---------------------------------------------------------------------
-- Lançamentos
-- ---------------------------------------------------------------------
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,      -- titular da família
  member_id uuid references auth.users(id) on delete set null,           -- de quem é (NULL = Família/compartilhado)
  created_by uuid references auth.users(id) on delete set null,          -- quem registrou
  type text not null check (type in ('receita','despesa','transferencia','investimento','resgate','ajuste')),
  amount_cents bigint not null,
  date date not null,
  description text not null,
  establishment_id uuid references public.establishments(id) on delete set null,
  category_id uuid references public.categories(id) on delete set null,
  subcategory_id uuid references public.subcategories(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  transfer_account_id uuid references public.accounts(id) on delete set null,
  card_id uuid references public.credit_cards(id) on delete set null,
  payment_method text,
  installment_number smallint,
  installment_total smallint,
  installment_group uuid,
  recurring_id uuid references public.recurring_transactions(id) on delete set null,
  status text not null default 'efetivado' check (status in ('efetivado','previsto')),
  origin text not null default 'app_form' check (origin in ('app_chat','app_form','whatsapp','telegram','importacao')),
  original_message text,
  transcript text,
  interpretation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint amount_valid check (amount_cents > 0 or (type = 'ajuste' and amount_cents <> 0)),
  constraint transfer_valid check (type <> 'transferencia' or transfer_account_id is not null)
);
create index transactions_user_date_idx on public.transactions(user_id, date) where deleted_at is null;
create index transactions_user_cat_idx on public.transactions(user_id, category_id) where deleted_at is null;
create index transactions_user_created_idx on public.transactions(user_id, created_at desc);
create index transactions_group_idx on public.transactions(installment_group);
create index transactions_member_idx on public.transactions(user_id, member_id) where deleted_at is null;

-- ---------------------------------------------------------------------
-- Metas e orçamentos (estrutura pronta; telas na Fase 2)
-- ---------------------------------------------------------------------
create table public.financial_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_cents bigint not null check (target_cents > 0),
  current_cents bigint not null default 0,
  deadline date,
  status text not null default 'ativa' check (status in ('ativa','concluida','cancelada')),
  created_at timestamptz not null default now()
);
create index goals_user_idx on public.financial_goals(user_id);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  unique (user_id, category_id, month)
);

-- ---------------------------------------------------------------------
-- Conversa unificada (app + WhatsApp no MESMO histórico)
-- ---------------------------------------------------------------------
create table public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  pending jsonb,               -- pergunta em aberto do assistente (ex.: "qual categoria?")
  updated_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  channel text not null check (channel in ('app','whatsapp','telegram')),
  message_type text not null default 'text' check (message_type in ('text','audio')),
  content text not null,
  cards jsonb,
  created_at timestamptz not null default now()
);
create index chat_messages_user_idx on public.chat_messages(user_id, created_at desc);

create table public.audio_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_message_id uuid references public.chat_messages(id) on delete cascade,
  storage_path text,
  provider text,
  transcript text,
  duration_seconds numeric,
  created_at timestamptz not null default now()
);

create table public.ai_interpretations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_message_id uuid references public.chat_messages(id) on delete set null,
  provider text not null,
  model text,
  input text not null,
  output jsonb not null,
  confidence numeric,
  created_at timestamptz not null default now()
);
create index ai_interpretations_user_idx on public.ai_interpretations(user_id, created_at desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  entity text not null,
  entity_id uuid,
  action text not null,
  before jsonb,
  after jsonb,
  source text,
  created_at timestamptz not null default now()
);
create index audit_logs_user_idx on public.audit_logs(user_id, created_at desc);

-- Código de conexão (vale para WhatsApp e Telegram)
create table public.link_codes (
  code text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  phone_number text unique,
  status text not null default 'pendente' check (status in ('pendente','ativo')),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.telegram_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  chat_id text not null unique,
  username text,
  verified_at timestamptz not null default now()
);

-- Contador de mensagens enviadas por canal/mês (trava do limite gratuito do WhatsApp)
create table public.messaging_usage (
  channel text not null,
  month text not null,
  sent integer not null default 0,
  primary key (channel, month)
);

-- ---------------------------------------------------------------------
-- Segurança: RLS em TODAS as tabelas. O app só LÊ; toda gravação passa
-- pelas funções do Motor Financeiro.
--  * dados financeiros: visíveis para todos da MESMA família
--  * conversa, conexões e perfil: somente da própria pessoa
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['accounts','credit_cards','categories','subcategories','establishments',
    'establishment_categories','recurring_transactions','transactions','financial_goals','budgets',
    'notifications','audit_logs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy "family rows" on public.%I for select to authenticated
      using (user_id = (select public.my_owner()))$p$, t);
  end loop;
  foreach t in array array['profiles','chat_conversations','chat_messages','audio_messages','ai_interpretations',
    'whatsapp_connections','telegram_connections','link_codes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format($p$create policy "own rows" on public.%I for select to authenticated using (%s = (select auth.uid()))$p$,
      t, case when t = 'profiles' then 'id' else 'user_id' end);
  end loop;
  foreach t in array array['household_members','household_invites','messaging_usage']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Membros da família podem ver os nomes uns dos outros
create policy "family profiles" on public.profiles for select to authenticated
  using (exists (select 1 from public.household_members hm where hm.member_id = profiles.id and hm.owner_id = (select public.my_owner())));
grant select on public.household_members to authenticated;
create policy "family members" on public.household_members for select to authenticated
  using (owner_id = (select public.my_owner()));
