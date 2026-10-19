-- =====================================================================
-- Privacidade na família: a base é compartilhada, mas cada pessoa escolhe o que mostrar.
--  * sempre visível para todos: o que é da Família (compartilhado), compras divididas que envolvem a pessoa
--  * gastos/receitas individuais de alguém: só para essa pessoa, a não ser que ela libere ("share_expenses")
--  * contas e cartões individuais (saldos, limites, faturas): idem ("share_accounts")
-- Quem está vendo = quem está usando o app (auth.uid()) ou quem conversa com o assistente (app.actor).
-- =====================================================================
alter table public.profiles add column if not exists share_expenses boolean not null default false;
alter table public.profiles add column if not exists share_accounts boolean not null default false;

-- quem está vendo (null = processo do sistema, sem restrição)
create or replace function public.fe_viewer() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select a from (select fe_actor() a) x
  where a is not null and exists (select 1 from household_members h where h.member_id = a)
$$;

create or replace function public.fe_member_visible(p_member uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_member is null or v is null or p_member = v or coalesce((select share_expenses from profiles where id = p_member), false)
  from (select fe_viewer() v) x
$$;

create or replace function public.fe_holder_visible(p_member uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_member is null or v is null or p_member = v or coalesce((select share_accounts from profiles where id = p_member), false)
  from (select fe_viewer() v) x
$$;

-- filtro "de quem" (Todos / Eu / pessoa / Família), sem privacidade — usado para contas e cartões
create or replace function public.fe_member_filter(t_member uuid, f text) returns boolean
language sql immutable as $$
  select case when nullif(f,'') is null then true
              when f = 'familia' then t_member is null
              else t_member = f::uuid end
$$;

-- lançamentos: filtro + privacidade (todas as consultas de lançamentos passam por aqui)
create or replace function public.fe_member_match(t_member uuid, f text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select fe_member_filter(t_member, f) and fe_member_visible(t_member)
$$;

-- faturas: só de cartões visíveis
create or replace function public.fe_invoices_due_between(p_owner uuid, p_from date, p_to date, p_member text) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(greatest(tot - pago, 0)), 0)::bigint
  from (
    select t.card_id, t.invoice_due,
      coalesce(sum(t.amount_cents) filter (where t.type in ('despesa','ajuste')), 0)
        - coalesce(sum(t.amount_cents) filter (where t.type = 'receita'), 0) tot,
      coalesce(sum(t.amount_cents) filter (where t.type = 'pagamento_fatura'), 0) pago
    from transactions t join credit_cards c on c.id = t.card_id
    where t.user_id = p_owner and t.deleted_at is null and t.invoice_due between p_from and p_to
      and fe_member_filter(c.member_id, p_member) and fe_holder_visible(c.member_id)
    group by t.card_id, t.invoice_due) f
$$;

do $$
declare v_src text; v_new text;
begin
  -- contas: privacidade de contas (não de gastos)
  select pg_get_functiondef('public.fe_balances(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_holder_visible%' then
    v_new := replace(v_src, 'fe_member_match(a.member_id, p->>''membro_id'')', 'fe_member_filter(a.member_id, p->>''membro_id'') and fe_holder_visible(a.member_id)');
    if v_new = v_src then raise exception 'fe_balances inesperado'; end if;
    execute v_new;
  end if;

  select pg_get_functiondef('public.fe_kpi_detail(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_holder_visible%' then
    v_new := replace(v_src, '(nullif(v_f,'''') is null or fe_member_match(c.member_id, v_f))', '(fe_member_filter(c.member_id, v_f) and fe_holder_visible(c.member_id))');
    if v_new = v_src then raise exception 'fe_kpi_detail inesperado'; end if;
    execute v_new;
  end if;

  select pg_get_functiondef('public.fe_cards(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_holder_visible%' then
    v_new := replace(v_src, 'for r in select * from credit_cards where user_id = o and (status',
                            'for r in select * from credit_cards where user_id = o and fe_holder_visible(member_id) and (status');
    if v_new = v_src then raise exception 'fe_cards inesperado'; end if;
    execute v_new;
  end if;

  select pg_get_functiondef('public.app_bootstrap(jsonb)'::regprocedure) into v_src;
  if v_src not like '%compartilha_gastos%' then
    v_new := replace(v_src, '''papel'', hm.role, ''eu'', hm.member_id = u)',
      '''papel'', hm.role, ''eu'', hm.member_id = u, ''compartilha_gastos'', coalesce(pr.share_expenses, false), ''compartilha_contas'', coalesce(pr.share_accounts, false))');
    v_new := replace(v_new, 'from credit_cards where user_id = o and status = ''ativo''), ''[]''),',
                            'from credit_cards where user_id = o and status = ''ativo'' and fe_holder_visible(member_id)), ''[]''),');
    if v_new not like '%compartilha_gastos%' or v_new not like '%status = ''ativo'' and fe_holder_visible(member_id)), ''[]''),%' then raise exception 'app_bootstrap inesperado'; end if;
    execute v_new;
  end if;

  select pg_get_functiondef('public.fe_context_data(uuid)'::regprocedure) into v_src;
  if v_src not like '%compartilha_gastos%' then
    v_new := replace(v_src, '''eu'', hm.member_id = p_user)', '''eu'', hm.member_id = p_user, ''compartilha_gastos'', coalesce(pr.share_expenses, false))');
    v_new := replace(v_new, 'from accounts where user_id = (select id from o) and status = ''ativa''), ''[]'')',
                            'from accounts where user_id = (select id from o) and status = ''ativa'' and (member_id is null or member_id = p_user or coalesce((select share_accounts from profiles where id = member_id), false))), ''[]'')');
    v_new := replace(v_new, 'from credit_cards where user_id = (select id from o) and status = ''ativo''), ''[]'')',
                            'from credit_cards where user_id = (select id from o) and status = ''ativo'' and (member_id is null or member_id = p_user or coalesce((select share_accounts from profiles where id = member_id), false))), ''[]'')');
    if v_new not like '%compartilha_gastos%' or (length(v_new) - length(replace(v_new, 'share_accounts', ''))) / length('share_accounts') <> 2 then
      raise exception 'fe_context_data inesperado';
    end if;
    execute v_new;
  end if;

  -- outras consultas de lançamentos que não usavam o filtro "de quem"
  select pg_get_functiondef('public.fe_analysis(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_member_visible%' then
    v_new := replace(v_src, 'from transactions where user_id = p_user and deleted_at is null', 'from transactions where user_id = p_user and deleted_at is null and fe_member_visible(member_id)');
    if v_new = v_src then raise exception 'fe_analysis inesperado'; end if;
    execute v_new;
  end if;
  select pg_get_functiondef('public.fe_available(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_member_visible%' then
    v_new := replace(v_src, 'where user_id = p_user and deleted_at is null', 'where user_id = p_user and deleted_at is null and fe_member_visible(member_id)');
    if v_new = v_src then raise exception 'fe_available inesperado'; end if;
    execute v_new;
  end if;
  select pg_get_functiondef('public.fe_monthly_avg(uuid,text)'::regprocedure) into v_src;
  if v_src not like '%fe_member_visible%' then
    v_new := replace(v_src, 'where user_id = p_owner and deleted_at is null', 'where user_id = p_owner and deleted_at is null and fe_member_visible(member_id)');
    if v_new = v_src then raise exception 'fe_monthly_avg inesperado'; end if;
    execute v_new;
  end if;
  select pg_get_functiondef('public.fe_budget_status(uuid,uuid,date)'::regprocedure) into v_src;
  if v_src not like '%fe_member_visible%' then
    v_new := replace(v_src, 'where user_id = p_owner and deleted_at is null', 'where user_id = p_owner and deleted_at is null and fe_member_visible(member_id)');
    if v_new = v_src then raise exception 'fe_budget_status inesperado'; end if;
    execute v_new;
  end if;
  select pg_get_functiondef('public.fe_member_split(uuid,text,date,date)'::regprocedure) into v_src;
  if v_src not like '%fe_member_visible%' then
    v_new := replace(v_src, 'where user_id = p_owner and deleted_at is null', 'where user_id = p_owner and deleted_at is null and fe_member_visible(member_id)');
    if v_new = v_src then raise exception 'fe_member_split inesperado'; end if;
    execute v_new;
  end if;
  select pg_get_functiondef('public.fe_suggest(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_member_visible%' then
    v_new := replace(v_src, 't.deleted_at is null', 't.deleted_at is null and fe_member_visible(t.member_id)');
    if v_new = v_src then raise exception 'fe_suggest inesperado'; end if;
    execute v_new;
  end if;
end $$;

-- o assistente chama o motor pelo servidor: registra quem está conversando antes de cada consulta
create or replace function public.fe_call(p_user uuid, p_fn text, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if p_fn !~ '^fe_[a-z_]+$' or to_regprocedure('public.' || p_fn || '(uuid,jsonb)') is null then
    raise exception 'função inválida: %', p_fn;
  end if;
  perform set_config('app.actor', coalesce(p_user::text, ''), true);
  execute format('select to_jsonb(public.%I($1, $2))', p_fn) into r using p_user, p;
  return r;
end $$;

-- cada pessoa escolhe o que mostrar para a família
create or replace function public.app_family_share(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p ? 'gastos' then update profiles set share_expenses = (p->>'gastos')::boolean, updated_at = now() where id = app_uid(); end if;
  if p ? 'contas' then update profiles set share_accounts = (p->>'contas')::boolean, updated_at = now() where id = app_uid(); end if;
  return (select jsonb_build_object('gastos', share_expenses, 'contas', share_accounts) from profiles where id = app_uid());
end $$;

revoke all on function public.fe_call(uuid, text, jsonb), public.fe_viewer(), public.fe_member_visible(uuid), public.fe_holder_visible(uuid) from public, anon, authenticated;
grant execute on function public.fe_call(uuid, text, jsonb) to service_role;
grant execute on function public.fe_viewer(), public.fe_member_visible(uuid), public.fe_holder_visible(uuid), public.fe_member_match(uuid, text), public.fe_member_filter(uuid, text) to service_role, authenticated;
revoke all on function public.app_family_share(jsonb) from public, anon;
grant execute on function public.app_family_share(jsonb) to authenticated;
