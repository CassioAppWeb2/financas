-- =====================================================================
-- Contas: excluir conta, ajustar saldo manualmente
-- Configurações: zerar a conta (reiniciar lançamentos)
-- Metas: planejamento financeiro (reserva de emergência, poupança, investimentos)
-- =====================================================================

-- ---------- contas excluídas ficam fora de tudo (exclusão lógica) ----------
alter table public.accounts drop constraint if exists accounts_status_check;
alter table public.accounts add constraint accounts_status_check check (status in ('ativa','arquivada','excluida'));

do $$
declare v_src text; v_new text;
begin
  select pg_get_functiondef('public.fe_balances(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%excluida%' then
    v_new := replace(v_src, 'from accounts a where a.user_id = (select id from o) and fe_member_match(a.member_id, p->>''membro_id'')',
                            'from accounts a where a.user_id = (select id from o) and a.status <> ''excluida'' and fe_member_match(a.member_id, p->>''membro_id'')');
    if v_new = v_src then raise exception 'fe_balances inesperado'; end if;
    execute v_new;
  end if;
end $$;

-- excluir conta: sem lançamentos sai direto; com lançamentos, só se a pessoa confirmar apagar os lançamentos juntos
create or replace function public.app_delete_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v accounts; v_n int; v_outras int;
begin
  select * into v from accounts where id = (p->>'id')::uuid and user_id = u and status <> 'excluida';
  if v.id is null then perform fe_err('Conta não encontrada.'); end if;
  select count(*) into v_outras from accounts where user_id = u and status = 'ativa' and id <> v.id;
  if v_outras = 0 then perform fe_err('Esta é sua única conta. Crie outra antes de excluir esta.'); end if;
  select count(*) into v_n from transactions where user_id = u and deleted_at is null and (account_id = v.id or transfer_account_id = v.id);
  if v_n > 0 and not coalesce((p->>'apagar_lancamentos')::boolean, false) then
    return jsonb_build_object('status','has_transactions','quantidade', v_n);
  end if;
  update transactions set deleted_at = now(), updated_at = now()
    where user_id = u and deleted_at is null and (account_id = v.id or transfer_account_id = v.id);
  update recurring_transactions set active = false, next_date = null where user_id = u and account_id = v.id;
  update credit_cards set payment_account_id = null where payment_account_id = v.id;
  update accounts set status = 'excluida', is_default = false where id = v.id;
  if v.is_default then
    update accounts set is_default = true where id = (select id from accounts where user_id = u and status = 'ativa' order by created_at limit 1);
  end if;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, before, source)
    values (u, app_uid(), 'account', v.id, 'delete', to_jsonb(v), 'app_form');
  return jsonb_build_object('status','ok','lancamentos_apagados', v_n);
end $$;

-- ajustar saldo: grava um "ajuste" com a diferença para o saldo informado
create or replace function public.fe_adjust_balance(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v accounts; v_atual bigint; v_novo bigint; v_dif bigint; v_tx transactions;
begin
  select * into v from accounts where id = nullif(p->>'conta_id','')::uuid and user_id = o and status = 'ativa';
  if v.id is null then perform fe_err('Conta não encontrada.'); end if;
  v_novo := coalesce((p->>'saldo_cents')::bigint, round(nullif(p->>'saldo','')::numeric * 100));
  if v_novo is null then perform fe_err('Informe o saldo correto.'); end if;
  select (x->>'saldo_cents')::bigint into v_atual from jsonb_array_elements(fe_balances(o)->'contas') x where (x->>'id')::uuid = v.id;
  v_dif := v_novo - coalesce(v_atual, 0);
  if v_dif = 0 then return jsonb_build_object('status','sem_diferenca','saldo_cents', v_novo); end if;
  insert into transactions(user_id, member_id, created_by, type, amount_cents, date, description, account_id, status, origin)
    values (o, v.member_id, p_user, 'ajuste', v_dif, fe_today(p_user), 'Ajuste de saldo', v.id, 'efetivado', coalesce(p->>'origem','app_form'))
    returning * into v_tx;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'transaction', v_tx.id, 'adjust', jsonb_build_object('conta', v.name, 'antes', v_atual, 'depois', v_novo), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','ok','antes_cents', v_atual, 'saldo_cents', v_novo, 'diferenca_cents', v_dif);
end $$;
create or replace function public.app_adjust_balance(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_adjust_balance(app_uid(), p) $$;

-- ---------- zerar a conta ----------
create or replace function public.app_reset_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); o uuid := app_owner(); v_n int; v_def uuid;
begin
  if u <> o then perform fe_err('Só o titular da família pode zerar a conta.'); end if;
  if upper(trim(coalesce(p->>'confirmacao',''))) <> 'ZERAR' then perform fe_err('Digite ZERAR para confirmar.'); end if;
  update transactions set deleted_at = now(), updated_at = now() where user_id = o and deleted_at is null;
  get diagnostics v_n = row_count;
  update family_settlements set status = 'dispensado' where user_id = o and status = 'pago';
  update goal_contributions set deleted_at = now() where goal_id in (select id from financial_goals where user_id = o) and deleted_at is null;
  if coalesce((p->>'fixas')::boolean, false) then
    update recurring_transactions set active = false, next_date = null where user_id = o;
  end if;
  if coalesce((p->>'metas')::boolean, false) then
    update financial_goals set status = 'cancelada', updated_at = now() where user_id = o and status <> 'cancelada';
  else
    update financial_goals set current_cents = 0, updated_at = now() where user_id = o;
  end if;
  if coalesce((p->>'orcamentos')::boolean, false) then
    update budgets set amount_cents = 0, updated_at = now() where user_id = o;
  end if;
  if coalesce((p->>'cadastros')::boolean, false) then
    update credit_cards set status = 'arquivado' where user_id = o;
    select id into v_def from accounts where user_id = o and is_default and status = 'ativa';
    update accounts set status = 'excluida', is_default = false where user_id = o and id is distinct from v_def and status <> 'excluida';
  end if;
  update accounts set initial_balance_cents = 0 where user_id = o and coalesce((p->>'saldos')::boolean, true);
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, u, 'account', o, 'reset', p - 'confirmacao', 'app_form');
  return jsonb_build_object('status','ok','lancamentos', v_n);
end $$;

-- ---------- metas como planejamento ----------
alter table public.financial_goals add column if not exists kind text not null default 'poupanca';
alter table public.financial_goals drop constraint if exists financial_goals_kind_check;
alter table public.financial_goals add constraint financial_goals_kind_check check (kind in ('reserva','poupanca','investimento'));
alter table public.financial_goals add column if not exists monthly_plan_cents bigint;
alter table public.financial_goals add column if not exists reserve_months int;

-- média mensal dos últimos 3 meses completos
create or replace function public.fe_monthly_avg(p_owner uuid, p_type text) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(round(sum(amount_cents) / 3.0), 0)::bigint from transactions
  where user_id = p_owner and deleted_at is null and type = p_type and not fe_is_pending(status, card_id, type)
    and date >= (date_trunc('month', fe_today(p_owner)) - interval '3 months')::date
    and date < date_trunc('month', fe_today(p_owner))::date
$$;

do $$
declare v_src text; v_new text;
begin
  select pg_get_functiondef('public.fe_goal_json(financial_goals)'::regprocedure) into v_src;
  if v_src not like '%''tipo''%' then
    v_new := replace(v_src, '''criada_em'', g.created_at);',
'''criada_em'', g.created_at,
    ''tipo'', g.kind, ''plano_mensal_cents'', g.monthly_plan_cents, ''meses_reserva'', g.reserve_months,
    ''gasto_medio_cents'', case when g.kind = ''reserva'' then fe_monthly_avg(g.user_id, ''despesa'') end,
    ''cobertura_meses'', case when g.kind = ''reserva'' and fe_monthly_avg(g.user_id, ''despesa'') > 0 then round(v_cur::numeric / fe_monthly_avg(g.user_id, ''despesa''), 1) end,
    ''previsao_plano'', case when v_rest = 0 then v_today when coalesce(g.monthly_plan_cents, 0) > 0
                             then (v_today + make_interval(days => ceil(v_rest::numeric / g.monthly_plan_cents * 30.4375)::int))::date end);');
    if v_new = v_src then raise exception 'fe_goal_json inesperado'; end if;
    execute v_new;
  end if;

  select pg_get_functiondef('public.fe_save_goal(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%reserve_months%' then
    v_new := replace(v_src, '  v_target := coalesce((p->>''valor_cents'')::bigint, round(nullif(p->>''valor'','''')::numeric * 100));',
'  v_target := coalesce((p->>''valor_cents'')::bigint, round(nullif(p->>''valor'','''')::numeric * 100));
  -- reserva de emergência: se não informar o valor, usa os meses escolhidos x gasto médio mensal
  if v_target is null and p->>''tipo'' = ''reserva'' and nullif(p->>''meses_reserva'','''') is not null then
    v_target := fe_monthly_avg(o, ''despesa'') * (p->>''meses_reserva'')::int;
    if v_target <= 0 then perform fe_err(''Ainda não há gastos suficientes para calcular a reserva. Informe o valor desejado.''); end if;
  end if;');
    v_new := replace(v_new, '      returning * into g;
  else',
'      returning * into g;
    update financial_goals set kind = coalesce(nullif(p->>''tipo'',''''), kind),
        monthly_plan_cents = round(nullif(p->>''plano_mensal'','''')::numeric * 100),
        reserve_months = nullif(p->>''meses_reserva'','''')::int
      where id = g.id returning * into g;
  else');
    v_new := replace(v_new, '    if g.id is null then perform fe_err(''Meta não encontrada.''); end if;',
'    if g.id is null then perform fe_err(''Meta não encontrada.''); end if;
    update financial_goals set kind = coalesce(nullif(p->>''tipo'',''''), kind),
        monthly_plan_cents = case when p ? ''plano_mensal'' then round(nullif(p->>''plano_mensal'','''')::numeric * 100) else monthly_plan_cents end,
        reserve_months = case when p ? ''meses_reserva'' then nullif(p->>''meses_reserva'','''')::int else reserve_months end
      where id = g.id returning * into g;');
    if (length(v_new) - length(replace(v_new, 'reserve_months', ''))) / length('reserve_months') < 3 then raise exception 'fe_save_goal inesperado'; end if;
    execute v_new;
  end if;
end $$;

-- visão do planejamento: renda, gastos, sobra e quanto está planejado para as metas
create or replace function public.fe_planning(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with o as (select fe_owner(p_user) id),
  n as (select fe_monthly_avg((select id from o), 'receita') renda, fe_monthly_avg((select id from o), 'despesa') gasto)
  select jsonb_build_object(
    'renda_media_cents', n.renda, 'gasto_medio_cents', n.gasto, 'sobra_media_cents', n.renda - n.gasto,
    'planejado_mensal_cents', coalesce((select sum(monthly_plan_cents) from financial_goals where user_id = (select id from o) and status = 'ativa'), 0),
    'meta_economia_cents', (select monthly_savings_goal_cents from profiles where id = (select id from o)),
    'saldo_contas_cents', (fe_balances((select id from o))->>'total_cents')::bigint,
    'metas', fe_goals(p_user, '{}'))
  from n
$$;
create or replace function public.app_planning(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_planning(app_uid(), p) $$;

revoke all on function public.fe_adjust_balance(uuid, jsonb), public.fe_monthly_avg(uuid, text), public.fe_planning(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_adjust_balance(uuid, jsonb), public.fe_planning(uuid, jsonb) to service_role;
revoke all on function public.app_delete_account(jsonb), public.app_adjust_balance(jsonb), public.app_reset_account(jsonb), public.app_planning(jsonb) from public, anon;
grant execute on function public.app_delete_account(jsonb), public.app_adjust_balance(jsonb), public.app_reset_account(jsonb), public.app_planning(jsonb) to authenticated;
