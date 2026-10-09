-- =====================================================================
-- Contas a pagar e a receber
--  * despesa/receita em CONTA com status 'previsto' = pendente (ainda não paga/recebida).
--    Não mexe no saldo até a pessoa confirmar (👍), mesmo depois do vencimento.
--  * contas fixas em conta geram ocorrências pendentes (lembrete com 👎/👍);
--    no cartão continuam automáticas (entram na fatura).
--  * lista de pendências: atrasados, próximos 7 dias e acertos entre a família.
--  * sugestões: últimos lançamentos parecidos com o que se está digitando.
-- =====================================================================

create or replace function public.fe_is_pending(p_status text, p_card uuid, p_type text) returns boolean
language sql immutable as $$
  select p_status = 'previsto' and p_card is null and p_type in ('despesa','receita')
$$;

alter table public.transactions add column if not exists paid_at timestamptz;
create index if not exists transactions_pending_idx on public.transactions(user_id, date)
  where status = 'previsto' and card_id is null and deleted_at is null;

-- o que já passou do vencimento continuava contando sozinho: mantém assim (nada muda no histórico)
update public.transactions set status = 'efetivado'
  where status = 'previsto' and card_id is null and type in ('despesa','receita') and deleted_at is null
    and date <= (now() at time zone 'America/Sao_Paulo')::date;

-- ---------- patches nas funções existentes ----------
do $$
declare v_src text; v_new text;
begin
  -- saldo das contas ignora pendentes
  select pg_get_functiondef('public.fe_balances(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_is_pending%' then
    v_new := replace(v_src, 'and t.date <= (select d from today)', 'and t.date <= (select d from today) and not fe_is_pending(t.status, t.card_id, t.type)');
    if v_new = v_src then raise exception 'fe_balances inesperado'; end if;
    execute v_new;
  end if;

  -- painel do mês
  select pg_get_functiondef('public.fe_month_overview(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_is_pending%' then
    v_new := replace(v_src, ' and date <= v_today), 0)', ' and date <= v_today and not fe_is_pending(status, card_id, type)), 0)');
    v_new := replace(v_new, 'type=''receita'' and date > v_today), 0)', 'type=''receita'' and (date > v_today or fe_is_pending(status, card_id, type))), 0)');
    v_new := replace(v_new, 'type=''despesa'' and date > v_today and card_id is null), 0)',
                            'type=''despesa'' and card_id is null and (date > v_today or fe_is_pending(status, card_id, type))), 0)');
    if (length(v_new) - length(replace(v_new, 'fe_is_pending', ''))) / length('fe_is_pending') <> 6 then raise exception 'fe_month_overview inesperado'; end if;
    execute v_new;
  end if;

  -- detalhe dos painéis
  select pg_get_functiondef('public.fe_kpi_detail(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_is_pending%' then
    v_new := replace(v_src, 'then t.type = ''receita'' and t.date <= v_today', 'then t.type = ''receita'' and t.date <= v_today and not fe_is_pending(t.status, t.card_id, t.type)');
    v_new := replace(v_new, 'then t.type = ''despesa'' and t.date <= v_today', 'then t.type = ''despesa'' and t.date <= v_today and not fe_is_pending(t.status, t.card_id, t.type)');
    v_new := replace(v_new, 'then t.type = ''receita'' and t.date > v_today', 'then t.type = ''receita'' and (t.date > v_today or fe_is_pending(t.status, t.card_id, t.type))');
    v_new := replace(v_new, 'then t.type = ''despesa'' and t.date > v_today and t.card_id is null end',
                            'then t.type = ''despesa'' and t.card_id is null and (t.date > v_today or fe_is_pending(t.status, t.card_id, t.type)) end');
    if (length(v_new) - length(replace(v_new, 'fe_is_pending', ''))) / length('fe_is_pending') <> 4 then raise exception 'fe_kpi_detail inesperado'; end if;
    execute v_new;
  end if;

  -- quanto posso gastar: pendentes (inclusive atrasados) são compromissos
  select pg_get_functiondef('public.fe_available(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_is_pending%' then
    v_new := replace(v_src, 'date > v_today and date <= v_fim and card_id is null',
                            'card_id is null and date <= v_fim and (date > v_today or fe_is_pending(status, card_id, type))');
    if v_new = v_src then raise exception 'fe_available inesperado'; end if;
    execute v_new;
  end if;

  -- contas fixas em conta nascem pendentes
  select pg_get_functiondef('public.fe_run_recurring(uuid)'::regprocedure) into v_src;
  if v_src not like '%fe_is_pending%' then
    v_new := replace(v_src, 'case when r.next_date > v_today then ''previsto'' else ''efetivado'' end, ''recorrencia'')',
      'case when fe_is_pending(''previsto'', r.card_id, r.type) or r.next_date > v_today then ''previsto'' else ''efetivado'' end, ''recorrencia'')');
    if v_new = v_src then raise exception 'fe_run_recurring inesperado'; end if;
    execute v_new;
  end if;

  -- JSON do lançamento: situação e forma de pagamento
  select pg_get_functiondef('public.fe_tx_json(transactions)'::regprocedure) into v_src;
  if v_src not like '%''pendente''%' then
    v_new := replace(v_src, '''origem'', t.origin, ''criado_em'', t.created_at)',
      '''origem'', t.origin, ''criado_em'', t.created_at,
    ''pendente'', fe_is_pending(t.status, t.card_id, t.type), ''forma_pagamento'', t.payment_method, ''pago_em'', t.paid_at)');
    if v_new = v_src then raise exception 'fe_tx_json inesperado'; end if;
    execute v_new;
  end if;

  -- alertas: contas atrasadas
  select pg_get_functiondef('public.fe_alerts(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_is_pending%' then
    v_new := replace(v_src, '  return v;
end',
'  for r in select type, count(*) n, sum(amount_cents) tot from transactions
           where user_id = o and deleted_at is null and fe_is_pending(status, card_id, type) and date < v_today
             and (member_id is null or member_id = p_user)
           group by type loop
    v := v || jsonb_build_object(''tipo'',''pendente'',''nivel'',''alto'',''icone'', case when r.type = ''despesa'' then ''⏰'' else ''💰'' end,
      ''texto'', format(''%s %s em atraso: R$ %s. Confirme no início do app.'', r.n,
        case when r.type = ''despesa'' then case when r.n = 1 then ''conta a pagar'' else ''contas a pagar'' end
             else case when r.n = 1 then ''valor a receber'' else ''valores a receber'' end end, fe_fmt(r.tot/100.0)));
  end loop;
  return v;
end');
    if v_new = v_src then raise exception 'fe_alerts inesperado'; end if;
    execute v_new;
  end if;
end $$;

-- ---------- pendências ----------
create or replace function public.fe_pending(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_today date := fe_today(p_user); v_f text := p->>'membro_id';
  v_dias int := coalesce(nullif(p->>'dias','')::int, 7); v_d jsonb;
begin
  v_d := fe_debts(p_user, '{}');
  return jsonb_build_object('hoje', v_today,
    'atrasados', coalesce((select jsonb_agg(fe_tx_json(t) order by t.date, t.amount_cents desc) from transactions t
        where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type)
          and t.date < v_today and fe_member_match(t.member_id, v_f)), '[]'),
    'proximos', coalesce((select jsonb_agg(fe_tx_json(t) order by t.date, t.amount_cents desc) from transactions t
        where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type)
          and t.date between v_today and v_today + v_dias and fe_member_match(t.member_id, v_f)), '[]'),
    'acertos_devo', coalesce((select jsonb_agg(jsonb_build_object('pessoa_id', x->>'pessoa_id', 'pessoa', x->>'pessoa', 'total_cents', (x->>'total_cents')::bigint,
        'desde', (select min((i->>'data')::date) from jsonb_array_elements(x->'itens') i)))
        from jsonb_array_elements(v_d->'devo') x), '[]'),
    'acertos_recebo', coalesce((select jsonb_agg(jsonb_build_object('pessoa_id', x->>'pessoa_id', 'pessoa', x->>'pessoa', 'total_cents', (x->>'total_cents')::bigint,
        'desde', (select min((i->>'data')::date) from jsonb_array_elements(x->'itens') i)))
        from jsonb_array_elements(v_d->'recebo') x), '[]'));
end $$;

-- marcar como pago/recebido (👍) ou voltar para pendente (👎)
create or replace function public.fe_set_paid(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v transactions; v_pago boolean := coalesce((p->>'pago')::boolean, true);
begin
  select * into v from transactions where id = nullif(p->>'id','')::uuid and user_id = o and deleted_at is null;
  if v.id is null then return jsonb_build_object('status','not_found'); end if;
  if v.card_id is not null or v.type not in ('despesa','receita') then perform fe_err('Só contas a pagar ou a receber podem ser confirmadas.'); end if;
  update transactions set status = case when v_pago then 'efetivado' else 'previsto' end,
      paid_at = case when v_pago then now() end,
      account_id = coalesce(nullif(p->>'conta_id','')::uuid, account_id),
      updated_at = now()
    where id = v.id returning * into v;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'transaction', v.id, case when v_pago then 'paid' else 'unpaid' end, fe_tx_json(v), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','ok','lancamento', fe_tx_json(v));
end $$;

-- sugestões enquanto se digita: últimos lançamentos parecidos (descrição, estabelecimento ou categoria)
create or replace function public.fe_suggest(p_user uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with o as (select fe_owner(p_user) id), q as (select '%' || fe_norm(coalesce(p->>'q','')) || '%' s),
  base as (
    select t.*, row_number() over (partition by fe_norm(coalesce(t.description,'')), t.category_id, t.account_id, t.card_id
                                   order by t.date desc, t.created_at desc) rn
    from transactions t
    left join categories c on c.id = t.category_id
    left join subcategories s on s.id = t.subcategory_id
    left join establishments e on e.id = t.establishment_id
    where t.user_id = (select id from o) and t.deleted_at is null and t.type in ('despesa','receita')
      and (nullif(p->>'tipo','') is null or t.type = p->>'tipo')
      and char_length(coalesce(p->>'q','')) >= 2
      and (fe_norm(coalesce(t.description,'')) like (select s from q) or fe_norm(coalesce(e.name,'')) like (select s from q)
           or fe_norm(coalesce(c.name,'')) like (select s from q) or fe_norm(coalesce(s.name,'')) like (select s from q))
  )
  select coalesce(jsonb_agg(fe_tx_json(t) order by t.date desc, t.created_at desc), '[]') from transactions t
  where t.id in (select id from base where rn = 1 order by date desc, created_at desc limit 6)
$$;

-- ---------- app ----------
create or replace function public.app_pending(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_pending(app_uid(), p) $$;
create or replace function public.app_set_paid(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_set_paid(app_uid(), p) $$;
create or replace function public.app_suggest(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_suggest(app_uid(), p) $$;

-- salvar pelo formulário: aceita "pendente" (a pagar / a receber)
create or replace function public.app_save_transaction(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); r jsonb; v_id uuid;
begin
  -- p.membro: 'familia' (compartilhado) | id de uma pessoa da família | vazio (quem está registrando)
  if p->>'membro' = 'familia' then p := p || '{"familia":true}';
  elsif nullif(p->>'membro','') is not null then p := p || jsonb_build_object('membro_id', p->>'membro');
  end if;
  p := p - 'membro';
  if nullif(p->>'id','') is not null then
    r := fe_update_transaction(u, p || '{"origem":"app_form"}');
  else
    r := fe_create_transaction(u, (p - 'id') || '{"origem":"app_form"}');
  end if;
  v_id := coalesce(nullif(r->'lancamento'->>'id','')::uuid, nullif(p->>'id','')::uuid);
  if r->>'status' in ('created','updated') and v_id is not null then
    if p ? 'pendente' then
      update transactions set status = case when (p->>'pendente')::boolean then 'previsto' else 'efetivado' end,
          paid_at = case when (p->>'pendente')::boolean then null else coalesce(paid_at, now()) end
        where id = v_id and card_id is null and type in ('despesa','receita');
    end if;
    if p ? 'forma_pagamento' and nullif(p->>'id','') is not null then
      update transactions set payment_method = nullif(p->>'forma_pagamento','') where id = v_id and card_id is null;
    end if;
    r := r || jsonb_build_object('lancamento', (select fe_tx_json(t) from transactions t where t.id = v_id));
  end if;
  return r;
end $$;

revoke all on function public.fe_pending(uuid, jsonb), public.fe_set_paid(uuid, jsonb), public.fe_suggest(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_pending(uuid, jsonb), public.fe_set_paid(uuid, jsonb), public.fe_suggest(uuid, jsonb) to service_role;
revoke all on function public.app_pending(jsonb), public.app_set_paid(jsonb), public.app_suggest(jsonb), public.app_save_transaction(jsonb) from public, anon;
grant execute on function public.app_pending(jsonb), public.app_set_paid(jsonb), public.app_suggest(jsonb), public.app_save_transaction(jsonb) to authenticated;

-- assistente: "paguei o aluguel" quando o aluguel já está a pagar -> confirma o pendente em vez de lançar de novo
create or replace function public.fe_match_pending(p_user uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with o as (select fe_owner(p_user) id),
  a as (select coalesce(nullif(p->>'data','')::date, fe_today(p_user)) d,
               round(nullif(p->>'valor','')::numeric * 100)::bigint v,
               nullif(fe_norm(coalesce(p->>'categoria','')),'') cat, nullif(fe_norm(coalesce(p->>'subcategoria','')),'') sub,
               nullif(fe_norm(coalesce(p->>'descricao','')),'') de, nullif(fe_norm(coalesce(p->>'estabelecimento','')),'') es)
  select fe_tx_json(t) from transactions t
    left join categories c on c.id = t.category_id left join subcategories s on s.id = t.subcategory_id
    left join establishments e on e.id = t.establishment_id, a
  where t.user_id = (select id from o) and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type)
    and t.type = coalesce(p->>'tipo','despesa') and t.date between a.d - 25 and a.d + 10
    and ((a.sub is not null and fe_norm(coalesce(s.name,'')) = a.sub)
      or (a.de is not null and (fe_norm(coalesce(t.description,'')) like '%' || a.de || '%' or a.de like '%' || fe_norm(coalesce(t.description,'')) || '%') and char_length(coalesce(t.description,'')) >= 3)
      or (a.es is not null and fe_norm(coalesce(e.name,'')) = a.es)
      or (a.sub is null and a.de is null and a.cat is not null and fe_norm(coalesce(c.name,'')) = a.cat))
  order by (t.amount_cents = a.v) desc, abs(t.date - a.d)
  limit 1
$$;
revoke all on function public.fe_match_pending(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_match_pending(uuid, jsonb) to service_role;

-- 👍 pelo assistente também pode corrigir o valor pago
create or replace function public.fe_set_paid(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v transactions; v_pago boolean := coalesce((p->>'pago')::boolean, true);
begin
  select * into v from transactions where id = nullif(p->>'id','')::uuid and user_id = o and deleted_at is null;
  if v.id is null then return jsonb_build_object('status','not_found'); end if;
  if v.card_id is not null or v.type not in ('despesa','receita') then perform fe_err('Só contas a pagar ou a receber podem ser confirmadas.'); end if;
  update transactions set status = case when v_pago then 'efetivado' else 'previsto' end,
      paid_at = case when v_pago then now() end,
      account_id = coalesce(nullif(p->>'conta_id','')::uuid, account_id),
      amount_cents = coalesce(nullif(round(nullif(p->>'valor','')::numeric * 100), 0)::bigint, amount_cents),
      -- pago antes do vencimento: o dinheiro saiu hoje
      date = case when v_pago and date > fe_today(p_user) then fe_today(p_user) else date end,
      updated_at = now()
    where id = v.id returning * into v;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'transaction', v.id, case when v_pago then 'paid' else 'unpaid' end, fe_tx_json(v), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','ok','lancamento', fe_tx_json(v));
end $$;
