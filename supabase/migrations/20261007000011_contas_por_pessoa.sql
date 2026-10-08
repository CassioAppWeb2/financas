-- =====================================================================
-- Contas por pessoa: cada conta é de alguém (ou da família).
-- Com o filtro "Eu / Bruna / Compartilhado", saldos, patrimônio e faturas
-- mostram só o que é daquela pessoa.
-- =====================================================================

alter table public.accounts add column if not exists member_id uuid references auth.users(id) on delete set null;
-- contas que já existiam eram do titular
update public.accounts set member_id = user_id where member_id is null;

-- a "Carteira" criada no cadastro é da própria pessoa
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.fe_handle_new_user()'::regprocedure) into v_src;
  v_src := replace(v_src, 'insert into accounts(user_id, name, type, is_default) values (new.id, ''Carteira'', ''dinheiro'', true);',
                          'insert into accounts(user_id, name, type, is_default, member_id) values (new.id, ''Carteira'', ''dinheiro'', true, new.id);');
  if v_src not like '%true, new.id)%' then raise exception 'fe_handle_new_user com formato inesperado'; end if;
  execute v_src;
end $$;

-- Saldos (filtro opcional: membro_id = id da pessoa | 'familia' | vazio = todas)
create or replace function public.fe_balances(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with today as (select coalesce(nullif(p->>'ate','')::date, fe_today(p_user)) d),
  o as (select fe_owner(p_user) id),
  bal as (
    select a.id, a.name, a.type, a.institution, a.is_default, a.status, a.member_id,
      a.initial_balance_cents + coalesce((
        select sum(case
          when t.account_id = a.id and t.type in ('receita','resgate','ajuste') then t.amount_cents
          when t.account_id = a.id and t.type in ('despesa','investimento','transferencia','pagamento_fatura') then -t.amount_cents
          when t.transfer_account_id = a.id and t.type = 'transferencia' then t.amount_cents
          else 0 end)
        from transactions t
        where t.user_id = (select id from o) and t.deleted_at is null and (t.card_id is null or t.type = 'pagamento_fatura')
          and t.date <= (select d from today)
          and (t.account_id = a.id or t.transfer_account_id = a.id)), 0) as balance_cents
    from accounts a where a.user_id = (select id from o) and fe_member_match(a.member_id, p->>'membro_id')
  )
  select jsonb_build_object(
    'contas', coalesce(jsonb_agg(jsonb_build_object('id',id,'nome',name,'tipo',type,'instituicao',institution,
              'padrao',is_default,'status',status,'saldo_cents',balance_cents,
              'membro_id', member_id,
              'membro', case when member_id is null then 'Família' else (select coalesce(name,'Membro') from profiles where id = member_id) end)
              order by is_default desc, name), '[]'),
    'total_cents', coalesce(sum(balance_cents) filter (where status = 'ativa'), 0))
  from bal
$$;

-- Faturas a pagar entre duas datas, só a parte de uma pessoa (proporcional às compras dela em cada fatura)
create or replace function public.fe_invoices_due_between(p_owner uuid, p_from date, p_to date, p_member text) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select case when nullif(p_member,'') is null then fe_invoices_due_between(p_owner, p_from, p_to) else
    coalesce(sum(case when tot > 0 then round(greatest(tot - pago, 0)::numeric * greatest(tot_m, 0) / tot) else 0 end), 0)::bigint end
  from (
    select card_id, invoice_due,
      coalesce(sum(amount_cents) filter (where type in ('despesa','ajuste')), 0)
        - coalesce(sum(amount_cents) filter (where type = 'receita'), 0) tot,
      coalesce(sum(amount_cents) filter (where type in ('despesa','ajuste') and fe_member_match(member_id, p_member)), 0)
        - coalesce(sum(amount_cents) filter (where type = 'receita' and fe_member_match(member_id, p_member)), 0) tot_m,
      coalesce(sum(amount_cents) filter (where type = 'pagamento_fatura'), 0) pago
    from transactions
    where user_id = p_owner and deleted_at is null and card_id is not null and invoice_due between p_from and p_to
    group by card_id, invoice_due) f
$$;

-- Painel e relatório passam o filtro de pessoa para saldos e faturas
do $$
declare v_src text; fn text;
begin
  foreach fn in array array['public.fe_month_overview(uuid,jsonb)', 'public.fe_report(uuid,jsonb)'] loop
    select pg_get_functiondef(fn::regprocedure) into v_src;
    v_src := replace(v_src, 'fe_invoices_due_between(p_user, greatest(v_ini, v_today), v_fim)', 'fe_invoices_due_between(p_user, greatest(v_ini, v_today), v_fim, v_f)');
    v_src := replace(v_src, '''por_conta'', (fe_balances(p_user)->''contas''),', '''por_conta'', (fe_balances(p_user, jsonb_build_object(''membro_id'', v_f))->''contas''),');
    v_src := replace(v_src, '''saldo_contas_cents'', (fe_balances(p_user)->''total_cents''),', '''saldo_contas_cents'', (fe_balances(p_user, jsonb_build_object(''membro_id'', v_f))->''total_cents''),');
    v_src := replace(v_src, 'jsonb_build_object(''ate'', least((mi + interval ''1 month'' - interval ''1 day'')::date, v_today))',
                            'jsonb_build_object(''ate'', least((mi + interval ''1 month'' - interval ''1 day'')::date, v_today), ''membro_id'', v_f)');
    v_src := replace(v_src, '''patrimonio_atual_cents'', (fe_balances(o)->>''total_cents'')::bigint', '''patrimonio_atual_cents'', (fe_balances(o, jsonb_build_object(''membro_id'', v_f))->>''total_cents'')::bigint');
    v_src := replace(v_src, 'fe_invoices_due_between(o, date ''2000-01-01'', date ''2100-01-01'')', 'fe_invoices_due_between(o, date ''2000-01-01'', date ''2100-01-01'', v_f)');
    if v_src not like '%''membro_id'', v_f)%' then raise exception 'formato inesperado em %', fn; end if;
    execute v_src;
  end loop;
end $$;

-- Cadastro de conta: "de quem é" (membro = id da pessoa | 'familia'); nova conta é de quem cadastrou
create or replace function public.app_save_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v accounts; v_before jsonb; v_member uuid; v_set_member boolean := p ? 'membro';
begin
  if fe_norm(p->>'nome') is null then perform fe_err('Informe o nome da conta.'); end if;
  if p->>'membro' = 'familia' then v_member := null;
  elsif nullif(p->>'membro','') is not null then
    select member_id into v_member from household_members where member_id = (p->>'membro')::uuid and owner_id = u;
    if v_member is null then perform fe_err('Pessoa não faz parte da família.'); end if;
  else v_member := app_uid(); end if;
  if coalesce((p->>'padrao')::boolean, false) then
    update accounts set is_default = false where user_id = u and is_default
      and (nullif(p->>'id','') is null or id <> (p->>'id')::uuid);
  end if;
  if nullif(p->>'id','') is null then
    insert into accounts(user_id, name, institution, type, initial_balance_cents, is_default, member_id)
      values (u, trim(p->>'nome'), nullif(trim(p->>'instituicao'),''), coalesce(nullif(p->>'tipo',''),'corrente'),
              coalesce(round((p->>'saldo_inicial')::numeric * 100)::bigint, 0),
              coalesce((p->>'padrao')::boolean, false) or not exists (select 1 from accounts where user_id = u and is_default),
              v_member)
      returning * into v;
  else
    select to_jsonb(a) into v_before from accounts a where id = (p->>'id')::uuid and user_id = u;
    if v_before is null then perform fe_err('Conta não encontrada.'); end if;
    update accounts set name = trim(p->>'nome'), institution = nullif(trim(p->>'instituicao'),''),
      type = coalesce(nullif(p->>'tipo',''), type),
      initial_balance_cents = coalesce(round((p->>'saldo_inicial')::numeric * 100)::bigint, initial_balance_cents),
      is_default = coalesce((p->>'padrao')::boolean, is_default),
      member_id = case when v_set_member then v_member else member_id end
      where id = (p->>'id')::uuid and user_id = u returning * into v;
  end if;
  insert into audit_logs(user_id, entity, entity_id, action, before, after, source)
    values (u, 'account', v.id, case when v_before is null then 'create' else 'update' end, v_before, to_jsonb(v), 'app_form');
  return jsonb_build_object('status','ok','id', v.id);
exception when unique_violation then
  perform fe_err('Já existe uma conta padrão.');
end $$;

revoke all on function public.fe_invoices_due_between(uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.fe_invoices_due_between(uuid, date, date, text) to service_role;
revoke all on function public.app_save_account(jsonb) from public, anon;
grant execute on function public.app_save_account(jsonb) to authenticated;

-- a impressão digital de "algo mudou" também acompanha o dono da conta
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.app_changes(jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src, 'concat(id, name, status, initial_balance_cents)', 'concat(id, name, status, initial_balance_cents, member_id)');
  execute v_src;
end $$;

-- Sem conta informada: usa a conta padrão se ela for da família ou de quem registra;
-- se a padrão for de outra pessoa, usa a conta da própria pessoa (ex.: a Bruna não gasta da Carteira do Cássio)
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.fe_create_transaction(uuid,jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src,
    '  else
    v_acc := fe_resolve_account(p_user, p->>''conta'');
    if v_acc is null then',
    '  else
    if fe_norm(p->>''conta'') is null then
      select id into v_acc from accounts where user_id = p_user and status = ''ativa'' and is_default and (member_id is null or member_id = v_actor);
      if v_acc is null then
        select id into v_acc from accounts where user_id = p_user and status = ''ativa'' and member_id = v_actor
          order by (type <> ''investimento'') desc, created_at limit 1;
      end if;
    end if;
    v_acc := coalesce(v_acc, fe_resolve_account(p_user, p->>''conta''));
    if v_acc is null then');
  if v_src not like '%member_id = v_actor%' then raise exception 'fe_create_transaction com formato inesperado'; end if;
  execute v_src;
end $$;
