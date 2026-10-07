-- =====================================================================
-- FASE 2 — RECORRÊNCIAS, METAS, ORÇAMENTOS, ALERTAS E RELATÓRIOS
-- =====================================================================

-- Faturas (restante a pagar) com vencimento entre duas datas
create or replace function public.fe_invoices_due_between(p_owner uuid, p_from date, p_to date) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(greatest(tot - pago, 0)), 0)::bigint from (
    select card_id, invoice_due,
      coalesce(sum(amount_cents) filter (where type in ('despesa','ajuste')), 0)
        - coalesce(sum(amount_cents) filter (where type = 'receita'), 0) tot,
      coalesce(sum(amount_cents) filter (where type = 'pagamento_fatura'), 0) pago
    from transactions
    where user_id = p_owner and deleted_at is null and card_id is not null and invoice_due between p_from and p_to
    group by card_id, invoice_due) f
$$;

-- ---------------------------------------------------------------------
-- RECORRÊNCIAS
-- ---------------------------------------------------------------------
-- Próxima ocorrência estritamente depois de p_after
create or replace function public.fe_next_occurrence(r public.recurring_transactions, p_after date) returns date
language plpgsql immutable as $$
declare d date; m date := date_trunc('month', p_after)::date;
begin
  if r.frequency = 'semanal' then
    d := coalesce(r.next_date, r.start_date, p_after);
    while d <= p_after loop d := d + 7; end loop;
    return d;
  end if;
  if r.frequency = 'anual' then
    d := coalesce(r.start_date, r.next_date, p_after);
    while d <= p_after loop d := (d + interval '1 year')::date; end loop;
    return d;
  end if;
  for i in 0..2 loop   -- mensal: dia fixo ou n-ésimo dia útil
    d := case when r.business_day is not null then fe_business_day((m + make_interval(months => i))::date, r.business_day)
              else fe_day_in_month((m + make_interval(months => i))::date, coalesce(r.day_of_month, 1)) end;
    if d > p_after then return d; end if;
  end loop;
  return d;
end $$;

-- Gera os lançamentos das recorrências até o fim do PRÓXIMO mês (os futuros ficam "previstos")
create or replace function public.fe_run_recurring(p_owner uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r recurring_transactions; v_today date := fe_today(p_owner);
  v_horizon date := (date_trunc('month', fe_today(p_owner)) + interval '2 months' - interval '1 day')::date;
  v_n int := 0; v_guard int; v_desc text;
begin
  for r in select * from recurring_transactions
           where user_id = p_owner and active and next_date is not null and next_date <= v_horizon
           for update skip locked loop
    v_guard := 0;
    while r.next_date is not null and r.next_date <= v_horizon and (r.end_date is null or r.next_date <= r.end_date) and v_guard < 24 loop
      v_desc := r.description;
      if not exists (select 1 from transactions where recurring_id = r.id and date = r.next_date and deleted_at is null) then
        insert into transactions(user_id, member_id, created_by, type, amount_cents, date, description, category_id, subcategory_id,
            account_id, card_id, invoice_due, payment_method, recurring_id, status, origin)
          values (p_owner, r.member_id, r.created_by, r.type, r.amount_cents, r.next_date, v_desc, r.category_id, r.subcategory_id,
            case when r.card_id is null then coalesce(r.account_id, fe_resolve_account(p_owner, null)) end,
            r.card_id, case when r.card_id is not null then fe_invoice_due(r.card_id, r.next_date) end,
            case when r.card_id is not null then 'credito' end, r.id,
            case when r.next_date > v_today then 'previsto' else 'efetivado' end, 'recorrencia');
        v_n := v_n + 1;
      end if;
      r.next_date := fe_next_occurrence(r, r.next_date);
      v_guard := v_guard + 1;
    end loop;
    update recurring_transactions set next_date = case when r.end_date is not null and r.next_date > r.end_date then null else r.next_date end,
      active = not (r.end_date is not null and r.next_date > r.end_date)
      where id = r.id;
  end loop;
  return v_n;
end $$;

create or replace function public.fe_recurring_json(r public.recurring_transactions) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', r.id, 'tipo', r.type, 'valor_cents', r.amount_cents, 'descricao', r.description,
    'categoria_id', r.category_id, 'categoria', (select name from categories where id = r.category_id),
    'icone', (select icon from categories where id = r.category_id),
    'subcategoria_id', r.subcategory_id, 'subcategoria', (select name from subcategories where id = r.subcategory_id),
    'conta_id', r.account_id, 'conta', (select name from accounts where id = r.account_id),
    'cartao_id', r.card_id, 'cartao', (select name from credit_cards where id = r.card_id),
    'frequencia', r.frequency, 'dia', r.day_of_month, 'dia_util', r.business_day,
    'inicio', r.start_date, 'fim', r.end_date, 'proxima', case when r.active then coalesce((select min(t.date) from transactions t where t.recurring_id = r.id and t.deleted_at is null and t.date >= fe_today(r.user_id)), r.next_date) end, 'ativa', r.active,
    'membro_id', r.member_id,
    'membro', case when r.member_id is null then 'Família' else (select coalesce(name,'Membro') from profiles where id = r.member_id) end,
    'quando', case when r.frequency = 'semanal' then 'toda semana'
                   when r.frequency = 'anual' then 'todo ano em ' || to_char(r.start_date, 'DD/MM')
                   when r.business_day is not null then 'todo ' || r.business_day || 'º dia útil'
                   else 'todo dia ' || r.day_of_month end)
$$;

-- Criar/editar recorrência
-- p: id, tipo, valor, descricao, categoria|categoria_id, subcategoria|subcategoria_id, conta|conta_id, cartao|cartao_id,
--    frequencia (mensal|semanal|anual), dia, dia_util, inicio (data da 1ª ocorrência), fim, familia, membro_id, origem
create or replace function public.fe_save_recurring(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_today date := fe_today(p_user); r recurring_transactions; v_old recurring_transactions;
  v_type text := lower(coalesce(p->>'tipo','despesa')); v_val bigint; v_cat uuid; v_sub uuid; v_acc uuid; v_card uuid;
  v_freq text := coalesce(nullif(p->>'frequencia',''), 'mensal'); v_day int; v_bday int; v_start date; v_member uuid; v_desc text;
  v_first date; v_this date;
begin
  if v_type not in ('receita','despesa') then perform fe_err('Recorrência deve ser receita ou despesa.'); end if;
  if v_freq not in ('mensal','semanal','anual') then perform fe_err('Frequência inválida.'); end if;
  if p ? 'valor_cents' then v_val := (p->>'valor_cents')::bigint; else v_val := round(nullif(p->>'valor','')::numeric * 100); end if;
  if v_val is null or v_val <= 0 then return jsonb_build_object('status','needs_value'); end if;
  if nullif(p->>'id','') is not null then
    select * into v_old from recurring_transactions where id = (p->>'id')::uuid and user_id = o;
    if v_old.id is null then perform fe_err('Recorrência não encontrada.'); end if;
  end if;
  -- categoria
  if nullif(p->>'categoria_id','') is not null then
    select id into v_cat from categories where id = (p->>'categoria_id')::uuid and user_id = o and kind = v_type;
    if nullif(p->>'subcategoria_id','') is not null then
      select id into v_sub from subcategories where id = (p->>'subcategoria_id')::uuid and category_id = v_cat;
    end if;
  else
    select r2.category_id, r2.subcategory_id into v_cat, v_sub
      from fe_resolve_category(o, v_type, p->>'categoria', p->>'subcategoria', p->>'descricao') r2;
  end if;
  if v_cat is null then
    if coalesce((p->>'permitir_sem_categoria')::boolean, false) then
      select id into v_cat from categories where user_id = o and kind = v_type and fe_norm(name) = 'outros';
    else return jsonb_build_object('status','needs_category','tipo', v_type, 'valor_cents', v_val); end if;
  end if;
  -- cartão ou conta
  if v_type = 'despesa' and (nullif(p->>'cartao_id','') is not null or fe_norm(p->>'cartao') is not null) then
    v_card := fe_resolve_card(o, p->>'cartao', nullif(p->>'cartao_id','')::uuid);
    if v_card is null and (select count(*) from credit_cards where user_id = o and status='ativo') = 1 then
      select id into v_card from credit_cards where user_id = o and status = 'ativo';
    end if;
    if v_card is null then return jsonb_build_object('status','unknown_card','cartao', p->>'cartao'); end if;
  else
    if nullif(p->>'conta_id','') is not null then v_acc := fe_resolve_account(o, null, (p->>'conta_id')::uuid);
    else
      v_acc := fe_resolve_account(o, p->>'conta');
      if v_acc is null then return jsonb_build_object('status','unknown_account','conta', p->>'conta'); end if;
    end if;
  end if;
  -- de quem é
  if coalesce((p->>'familia')::boolean, false) then v_member := null;
  elsif nullif(p->>'membro_id','') is not null then
    select member_id into v_member from household_members where member_id = (p->>'membro_id')::uuid and owner_id = o;
  elsif v_old.id is not null then v_member := v_old.member_id;
  else v_member := p_user; end if;
  -- quando
  v_start := nullif(p->>'inicio','')::date;
  v_bday := nullif(p->>'dia_util','')::int;
  v_day := coalesce(nullif(p->>'dia','')::int, extract(day from coalesce(v_start, v_today))::int);
  if v_bday is not null and v_bday not between 1 and 23 then perform fe_err('Dia útil deve ser entre 1 e 23.'); end if;
  if v_day not between 1 and 31 then perform fe_err('Dia deve ser entre 1 e 31.'); end if;
  v_desc := left(coalesce(nullif(trim(p->>'descricao'),''), (select name from subcategories where id = v_sub), (select name from categories where id = v_cat)), 120);

  r.frequency := v_freq; r.day_of_month := case when v_bday is null then v_day end; r.business_day := v_bday;
  r.start_date := coalesce(v_start, v_today); r.next_date := null;
  -- primeira ocorrência: a data de início, se informada; senão a próxima a partir de hoje
  v_first := coalesce(v_start, case when v_freq = 'mensal' then fe_next_occurrence(r, v_today - 1) else v_today end);

  if v_old.id is not null then
    -- remove do futuro o que foi gerado com os dados antigos (o passado fica como está)
    update transactions set deleted_at = now(), updated_at = now()
      where recurring_id = v_old.id and deleted_at is null and date > v_today;
    update recurring_transactions set type = v_type, amount_cents = v_val, description = v_desc, category_id = v_cat, subcategory_id = v_sub,
      account_id = v_acc, card_id = v_card, frequency = v_freq, day_of_month = r.day_of_month, business_day = v_bday,
      start_date = coalesce(v_start, v_old.start_date), end_date = nullif(p->>'fim','')::date, member_id = v_member,
      next_date = greatest(v_first, v_today + 1), active = true, updated_at = now()
      where id = v_old.id returning * into r;
  else
    insert into recurring_transactions(user_id, type, amount_cents, description, category_id, subcategory_id, account_id, card_id,
        frequency, day_of_month, business_day, start_date, end_date, next_date, member_id, created_by)
      values (o, v_type, v_val, v_desc, v_cat, v_sub, v_acc, v_card, v_freq, r.day_of_month, v_bday, coalesce(v_start, v_first),
        nullif(p->>'fim','')::date, v_first, v_member, p_user)
      returning * into r;
  end if;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'recurring', r.id, case when v_old.id is null then 'create' else 'update' end, fe_recurring_json(r), coalesce(p->>'origem','app_form'));
  perform fe_run_recurring(o);
  select * into r from recurring_transactions where id = r.id;
  -- mensal criada depois do dia deste mês: avisa para o assistente oferecer lançar o mês atual
  v_this := case when v_freq = 'mensal' and v_start is null and v_old.id is null then
              case when v_bday is not null then fe_business_day(v_today, v_bday) else fe_day_in_month(v_today, v_day) end end;
  return jsonb_build_object('status','saved', 'recorrencia', fe_recurring_json(r), 'primeira', v_first,
    'data_mes_atual', case when v_this is not null and v_this < v_today then v_this end);
end $$;

-- Encerrar recorrência (apaga só as ocorrências futuras)
create or replace function public.fe_cancel_recurring(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); r recurring_transactions; v_n int;
begin
  if nullif(p->>'id','') is not null then
    select * into r from recurring_transactions where id = (p->>'id')::uuid and user_id = o;
  else
    select * into r from recurring_transactions where user_id = o and active
      and fe_norm(description) like '%' || coalesce(fe_norm(p->>'descricao'), '') || '%'
      order by (fe_norm(description) = fe_norm(p->>'descricao')) desc, created_at desc limit 1;
  end if;
  if r.id is null then return jsonb_build_object('status','not_found'); end if;
  update recurring_transactions set active = false, next_date = null, updated_at = now() where id = r.id;
  update transactions set deleted_at = now(), updated_at = now()
    where recurring_id = r.id and deleted_at is null and date > fe_today(p_user);
  get diagnostics v_n = row_count;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, before, source)
    values (o, p_user, 'recurring', r.id, 'cancel', fe_recurring_json(r), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','cancelled', 'recorrencia', fe_recurring_json(r), 'futuros_removidos', v_n);
end $$;

create or replace function public.fe_recurrings(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'itens', coalesce(jsonb_agg(fe_recurring_json(r) order by r.active desc, r.type desc, r.next_date nulls last), '[]'),
    'receitas_mes_cents', coalesce(sum(case when r.active and r.type='receita' then
        case r.frequency when 'semanal' then r.amount_cents * 52 / 12 when 'anual' then r.amount_cents / 12 else r.amount_cents end end), 0),
    'despesas_mes_cents', coalesce(sum(case when r.active and r.type='despesa' then
        case r.frequency when 'semanal' then r.amount_cents * 52 / 12 when 'anual' then r.amount_cents / 12 else r.amount_cents end end), 0))
  from recurring_transactions r where r.user_id = fe_owner(p_user) and (r.active or coalesce((p->>'todas')::boolean, false))
$$;

-- ---------------------------------------------------------------------
-- METAS
-- ---------------------------------------------------------------------
create or replace function public.fe_goal_json(g public.financial_goals) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_today date := fe_today(g.user_id); v_cur bigint; v_rest bigint; v_months numeric; v_weeks numeric;
  v_rate numeric; v_since date; v_prev date; v_last3 bigint;
begin
  v_cur := g.current_cents + coalesce((select sum(amount_cents) from goal_contributions where goal_id = g.id and deleted_at is null), 0);
  v_rest := greatest(g.target_cents - v_cur, 0);
  if g.deadline is not null and g.deadline > v_today then
    v_months := greatest((g.deadline - v_today) / 30.4375, 0.0001);
    v_weeks := greatest((g.deadline - v_today) / 7.0, 0.0001);
  end if;
  -- ritmo: média mensal de aportes nos últimos 3 meses (ou desde a criação, se mais recente)
  v_since := greatest(g.created_at::date, (v_today - interval '3 months')::date);
  select coalesce(sum(amount_cents), 0) into v_last3 from goal_contributions
    where goal_id = g.id and deleted_at is null and date > v_since - 1;
  v_rate := case when v_last3 > 0 then v_last3 / greatest((v_today - v_since + 1) / 30.4375, 1) end;
  return jsonb_build_object('id', g.id, 'nome', g.name, 'icone', g.icon, 'objetivo_cents', g.target_cents,
    'atual_cents', v_cur, 'falta_cents', v_rest,
    'progresso', case when g.target_cents > 0 then round(least(v_cur::numeric / g.target_cents * 100, 100), 1) else 0 end,
    'prazo', g.deadline, 'status', case when g.status = 'ativa' and v_cur >= g.target_cents then 'concluida' else g.status end,
    'por_mes_cents', case when v_months is not null and v_rest > 0 then ceil(v_rest / v_months)::bigint end,
    'por_semana_cents', case when v_weeks is not null and v_rest > 0 then ceil(v_rest / v_weeks)::bigint end,
    'meses_restantes', case when v_months is not null then round(v_months, 1) end,
    'ritmo_mensal_cents', case when v_rate is not null then round(v_rate)::bigint end,
    'previsao', case when v_rest = 0 then v_today
                     when v_rate is not null and v_rate > 0 then (v_today + make_interval(days => ceil(v_rest / v_rate * 30.4375)::int))::date end,
    'atrasada', g.deadline is not null and v_rest > 0 and (g.deadline < v_today or (v_rate is not null and
                 (v_today + make_interval(days => ceil(v_rest / v_rate * 30.4375)::int))::date > g.deadline)),
    'aportes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'valor_cents', c.amount_cents, 'data', c.date, 'obs', c.note)
        order by c.date desc, c.created_at desc) from (select * from goal_contributions where goal_id = g.id and deleted_at is null
        order by date desc, created_at desc limit 12) c), '[]'),
    'criada_em', g.created_at);
end $$;

create or replace function public.fe_resolve_goal(p_owner uuid, p_name text, p_id uuid default null) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid; n text := fe_norm(regexp_replace(coalesce(p_name,''), '(?i)^(a |da |na |para a |pra )?(minha )?meta( de| da| do| para| pra)?\s*', ''));
begin
  if p_id is not null then select id into v from financial_goals where id = p_id and user_id = p_owner; return v; end if;
  if n is not null then
    select id into v from financial_goals where user_id = p_owner and status = 'ativa'
      and (fe_norm(name) = n or fe_norm(name) like '%' || n || '%' or n like '%' || fe_norm(name) || '%')
      order by (fe_norm(name) = n) desc, created_at limit 1;
    if v is not null then return v; end if;
  end if;
  if (select count(*) from financial_goals where user_id = p_owner and status = 'ativa') = 1 and n is null then
    select id into v from financial_goals where user_id = p_owner and status = 'ativa';
  end if;
  return v;
end $$;

-- Criar/editar meta. p: id, nome, valor (objetivo), prazo, valor_inicial, icone
create or replace function public.fe_save_goal(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); g financial_goals; v_target bigint; v_new boolean := nullif(p->>'id','') is null;
begin
  v_target := coalesce((p->>'valor_cents')::bigint, round(nullif(p->>'valor','')::numeric * 100));
  if v_target is null or v_target <= 0 then return jsonb_build_object('status','needs_value'); end if;
  if fe_norm(p->>'nome') is null then perform fe_err('Dê um nome para a meta.'); end if;
  if v_new then
    insert into financial_goals(user_id, name, target_cents, current_cents, deadline, icon)
      values (o, left(trim(p->>'nome'), 60), v_target, coalesce(round(nullif(p->>'valor_inicial','')::numeric * 100), 0),
        nullif(p->>'prazo','')::date, coalesce(nullif(p->>'icone',''), '🎯'))
      returning * into g;
  else
    update financial_goals set name = left(trim(p->>'nome'), 60), target_cents = v_target, deadline = nullif(p->>'prazo','')::date,
      icon = coalesce(nullif(p->>'icone',''), icon),
      current_cents = coalesce(round(nullif(p->>'valor_inicial','')::numeric * 100), current_cents), updated_at = now()
      where id = (p->>'id')::uuid and user_id = o returning * into g;
    if g.id is null then perform fe_err('Meta não encontrada.'); end if;
  end if;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'goal', g.id, case when v_new then 'create' else 'update' end, p, coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','saved', 'meta', fe_goal_json(g));
end $$;

-- Aporte (positivo) ou retirada (negativo). p: meta | meta_id, valor, data, obs
create or replace function public.fe_goal_contribute(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_goal uuid; v_val bigint; g financial_goals; v_before jsonb;
begin
  v_goal := fe_resolve_goal(o, p->>'meta', nullif(p->>'meta_id','')::uuid);
  if v_goal is null then
    return jsonb_build_object('status', case when (select count(*) from financial_goals where user_id = o and status='ativa') = 0 then 'no_goals' else 'needs_goal' end,
      'metas', (select coalesce(jsonb_agg(name order by created_at), '[]') from financial_goals where user_id = o and status = 'ativa'));
  end if;
  v_val := coalesce((p->>'valor_cents')::bigint, round(nullif(p->>'valor','')::numeric * 100));
  if v_val is null or v_val = 0 then return jsonb_build_object('status','needs_value'); end if;
  select * into g from financial_goals where id = v_goal;
  v_before := fe_goal_json(g);
  insert into goal_contributions(user_id, goal_id, amount_cents, date, note, created_by, origin)
    values (o, v_goal, v_val, coalesce(nullif(p->>'data','')::date, fe_today(p_user)), left(p->>'obs', 200), p_user, coalesce(p->>'origem','app_form'));
  update financial_goals set updated_at = now(),
    status = case when status = 'ativa' and (fe_goal_json(g)->>'atual_cents')::bigint >= target_cents then 'concluida'
                  when status = 'concluida' and (fe_goal_json(g)->>'atual_cents')::bigint < target_cents then 'ativa' else status end
    where id = v_goal returning * into g;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, before, after, source)
    values (o, p_user, 'goal', v_goal, 'contribution', v_before, fe_goal_json(g), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','ok', 'valor_cents', v_val, 'meta', fe_goal_json(g));
end $$;

create or replace function public.fe_goals(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(fe_goal_json(g) order by (g.status = 'ativa') desc, g.deadline nulls last, g.created_at), '[]')
  from financial_goals g where g.user_id = fe_owner(p_user) and (g.status <> 'cancelada' or coalesce((p->>'todas')::boolean,false))
$$;

create or replace function public.fe_archive_goal(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update financial_goals set status = coalesce(nullif(p->>'status',''), 'cancelada'), updated_at = now()
    where id = (p->>'id')::uuid and user_id = fe_owner(p_user);
  if not found then perform fe_err('Meta não encontrada.'); end if;
  return jsonb_build_object('status','ok');
end $$;

-- ---------------------------------------------------------------------
-- ORÇAMENTOS (valem do mês informado em diante, até serem alterados)
-- ---------------------------------------------------------------------
create or replace function public.fe_budget_amount(p_owner uuid, p_cat uuid, p_month date) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select nullif(amount_cents, 0) from budgets
  where user_id = p_owner and category_id = p_cat and month <= date_trunc('month', p_month)::date
  order by month desc limit 1
$$;

create or replace function public.fe_budgets(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_ini date; v_fim date; v_today date := fe_today(p_user); v_dias numeric; v_passados numeric;
begin
  select inicio, fim into v_ini, v_fim from fe_month_bounds(p->>'mes', o);
  v_dias := v_fim - v_ini + 1;
  v_passados := case when v_today < v_ini then 0 when v_today > v_fim then v_dias else v_today - v_ini + 1 end;
  return (with b as (
      select c.id, c.name, c.icon, fe_budget_amount(o, c.id, v_ini) lim,
        coalesce((select sum(amount_cents) from transactions t where t.user_id = o and t.deleted_at is null and t.type = 'despesa'
                  and t.category_id = c.id and t.date between v_ini and v_fim and fe_member_match(t.member_id, p->>'membro_id')), 0) gasto
      from categories c where c.user_id = o and c.kind = 'despesa' and c.archived_at is null)
    select jsonb_build_object('mes', to_char(v_ini, 'YYYY-MM'),
      'itens', coalesce(jsonb_agg(jsonb_build_object('categoria_id', id, 'categoria', name, 'icone', icon,
          'limite_cents', lim, 'gasto_cents', gasto, 'restante_cents', lim - gasto,
          'percentual', round(gasto::numeric / lim * 100, 1),
          'esperado_percentual', round(v_passados / v_dias * 100, 1),
          'situacao', case when gasto >= lim then 'estourado' when gasto >= lim * 0.8 then 'atencao' else 'ok' end)
          order by gasto::numeric / lim desc) filter (where lim is not null), '[]'),
      'sem_orcamento', coalesce(jsonb_agg(jsonb_build_object('categoria_id', id, 'categoria', name, 'icone', icon, 'gasto_cents', gasto)
          order by gasto desc) filter (where lim is null), '[]'),
      'total_limite_cents', coalesce(sum(lim), 0),
      'total_gasto_cents', coalesce(sum(gasto) filter (where lim is not null), 0))
    from b);
end $$;

-- Situação do orçamento de UMA categoria (usada logo após registrar um gasto)
create or replace function public.fe_budget_status(p_owner uuid, p_cat uuid, p_date date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with x as (select fe_budget_amount(p_owner, p_cat, p_date) lim,
      coalesce((select sum(amount_cents) from transactions where user_id = p_owner and deleted_at is null and type = 'despesa'
        and category_id = p_cat and date between date_trunc('month', p_date)::date
        and (date_trunc('month', p_date) + interval '1 month' - interval '1 day')::date), 0) gasto)
  select case when lim is null then null else jsonb_build_object('categoria', (select name from categories where id = p_cat),
    'limite_cents', lim, 'gasto_cents', gasto, 'percentual', round(gasto::numeric / lim * 100, 1)) end from x
$$;

-- Definir orçamento. p: categoria | categoria_id, valor (0 = remover), mes (padrão: atual)
create or replace function public.fe_set_budget(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_cat uuid; v_sub uuid; v_val bigint; v_mes date;
begin
  if nullif(p->>'categoria_id','') is not null then
    select id into v_cat from categories where id = (p->>'categoria_id')::uuid and user_id = o and kind = 'despesa';
  else
    select r.category_id, r.subcategory_id into v_cat, v_sub from fe_resolve_category(o, 'despesa', p->>'categoria', null, null) r;
  end if;
  if v_cat is null then return jsonb_build_object('status','unknown_category','categoria', p->>'categoria'); end if;
  v_val := coalesce((p->>'valor_cents')::bigint, round(nullif(p->>'valor','')::numeric * 100));
  if v_val is null or v_val < 0 then return jsonb_build_object('status','needs_value'); end if;
  select inicio into v_mes from fe_month_bounds(p->>'mes', o);
  insert into budgets(user_id, category_id, month, amount_cents) values (o, v_cat, v_mes, v_val)
    on conflict (user_id, category_id, month) do update set amount_cents = excluded.amount_cents, updated_at = now();
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'budget', v_cat, 'set', jsonb_build_object('mes', v_mes, 'valor_cents', v_val), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','saved', 'categoria', (select name from categories where id = v_cat),
    'subcategoria_ignorada', (select name from subcategories where id = v_sub),
    'valor_cents', v_val, 'mes', v_mes, 'situacao', fe_budget_status(o, v_cat, fe_today(p_user)));
end $$;

-- ---------------------------------------------------------------------
-- ALERTAS INTELIGENTES (calculados na hora, a partir dos dados)
-- ---------------------------------------------------------------------
create or replace function public.fe_alerts(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_today date := fe_today(p_user); v jsonb := '[]'; r record; b jsonb; a jsonb;
  v_proj numeric; v_med numeric;
begin
  -- orçamentos
  b := fe_budgets(p_user, '{}');
  for r in select e.value as x from jsonb_array_elements(b->'itens') e loop
    if r.x->>'situacao' = 'estourado' then
      v := v || jsonb_build_object('tipo','orcamento','nivel','alto','icone','🚨',
        'texto', format('%s passou do orçamento: %s%% (R$ %s de R$ %s).', r.x->>'categoria', round((r.x->>'percentual')::numeric),
          to_char((r.x->>'gasto_cents')::numeric/100, 'FM999G999G990D00'), to_char((r.x->>'limite_cents')::numeric/100, 'FM999G999G990D00')));
    elsif r.x->>'situacao' = 'atencao' then
      v := v || jsonb_build_object('tipo','orcamento','nivel','medio','icone','⚠️',
        'texto', format('%s já atingiu %s%% do orçamento.', r.x->>'categoria', round((r.x->>'percentual')::numeric)));
    end if;
  end loop;
  -- faturas
  for r in select c.name, x as inv from credit_cards c,
             lateral (select fe_invoice_json(o, c.id, d) x from (select distinct invoice_due d from transactions
               where user_id = o and card_id = c.id and deleted_at is null and invoice_due <= v_today + 7) z) q
           where c.user_id = o and c.status = 'ativo' loop
    if (r.inv->>'restante_cents')::bigint > 0 and (r.inv->>'vencimento')::date < v_today then
      v := v || jsonb_build_object('tipo','fatura','nivel','alto','icone','💳',
        'texto', format('A fatura do %s venceu em %s e ainda tem R$ %s em aberto.', r.name, to_char((r.inv->>'vencimento')::date, 'DD/MM'),
          to_char((r.inv->>'restante_cents')::numeric/100, 'FM999G999G990D00')));
    elsif (r.inv->>'restante_cents')::bigint > 0 then
      v := v || jsonb_build_object('tipo','fatura','nivel','medio','icone','💳',
        'texto', format('A fatura do %s (R$ %s) vence %s.', r.name, to_char((r.inv->>'restante_cents')::numeric/100, 'FM999G999G990D00'),
          case when (r.inv->>'vencimento')::date = v_today then 'hoje' when (r.inv->>'vencimento')::date = v_today + 1 then 'amanhã'
               else 'em ' || ((r.inv->>'vencimento')::date - v_today) || ' dias' end));
    end if;
  end loop;
  -- limite do cartão
  for r in select e.value as x from jsonb_array_elements(fe_cards(p_user)) e loop
    if (r.x->>'limite_cents') is not null and (r.x->>'limite_cents')::bigint > 0
       and (r.x->>'usado_cents')::numeric >= (r.x->>'limite_cents')::numeric * 0.9 then
      v := v || jsonb_build_object('tipo','limite','nivel','medio','icone','💳',
        'texto', format('O cartão %s está com %s%% do limite usado.', r.x->>'nome',
          round((r.x->>'usado_cents')::numeric / (r.x->>'limite_cents')::numeric * 100)));
    end if;
  end loop;
  -- metas
  for r in select fe_goal_json(g) x from financial_goals g where g.user_id = o and g.status = 'ativa' loop
    if (r.x->>'progresso')::numeric >= 100 then
      v := v || jsonb_build_object('tipo','meta','nivel','bom','icone','🎉', 'texto', format('Meta “%s” atingida!', r.x->>'nome'));
    elsif (r.x->>'progresso')::numeric >= 90 then
      v := v || jsonb_build_object('tipo','meta','nivel','bom','icone','🎯',
        'texto', format('Você está perto da meta “%s”: %s%%.', r.x->>'nome', round((r.x->>'progresso')::numeric)));
    elsif coalesce((r.x->>'atrasada')::boolean, false) then
      v := v || jsonb_build_object('tipo','meta','nivel','medio','icone','🎯',
        'texto', format('No ritmo atual, a meta “%s” não fica pronta até o prazo (%s).', r.x->>'nome', to_char((r.x->>'prazo')::date, 'DD/MM/YYYY')));
    end if;
  end loop;
  -- ritmo de gastos x média
  a := fe_analysis(p_user);
  if (a->>'meses_com_historico')::int > 0 and (a->>'dia')::int >= 5 then
    v_proj := (a->>'despesas_atual_cents')::numeric / (a->>'dia')::int * (a->>'dias_no_mes')::int;
    v_med := (a->>'media_despesas_3m_cents')::numeric * 3 / (a->>'meses_com_historico')::int;
    if v_med > 0 and v_proj > v_med * 1.1 then
      v := v || jsonb_build_object('tipo','ritmo','nivel','medio','icone','📈',
        'texto', format('Nesse ritmo, as despesas do mês devem ficar %s%% acima da sua média (estimativa).', round((v_proj / v_med - 1) * 100)));
    end if;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- RELATÓRIOS
-- p: inicio, fim (padrão: mês atual), membro_id
-- ---------------------------------------------------------------------
create or replace function public.fe_report(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_ini date; v_fim date; v_today date := fe_today(p_user); v_res jsonb; v_f text := p->>'membro_id';
begin
  select inicio, fim into v_ini, v_fim from fe_month_bounds(null, o);
  v_ini := coalesce(nullif(p->>'inicio','')::date, v_ini);
  v_fim := coalesce(nullif(p->>'fim','')::date, v_fim);
  if v_fim < v_ini then perform fe_err('Período inválido.'); end if;
  if v_fim - v_ini > 1100 then perform fe_err('Escolha um período de até 3 anos.'); end if;
  with t as (
    select t.*, c.name cat, c.icon icone, s.name sub, a.name conta, cc.name cartao, e.name estab
    from transactions t
    left join categories c on c.id = t.category_id left join subcategories s on s.id = t.subcategory_id
    left join accounts a on a.id = t.account_id left join credit_cards cc on cc.id = t.card_id
    left join establishments e on e.id = t.establishment_id
    where t.user_id = o and t.deleted_at is null and t.date between v_ini and v_fim and fe_member_match(t.member_id, v_f)
  ),
  months as (select generate_series(date_trunc('month', v_ini), date_trunc('month', v_fim), interval '1 month')::date mi)
  select jsonb_build_object(
    'inicio', v_ini, 'fim', v_fim, 'hoje', v_today,
    'resumo', jsonb_build_object(
      'receitas_cents', coalesce((select sum(amount_cents) from t where type='receita'), 0),
      'despesas_cents', coalesce((select sum(amount_cents) from t where type='despesa'), 0),
      'investimentos_cents', coalesce((select sum(amount_cents) from t where type='investimento'), 0) - coalesce((select sum(amount_cents) from t where type='resgate'), 0),
      'faturas_pagas_cents', coalesce((select sum(amount_cents) from t where type='pagamento_fatura'), 0),
      'lancamentos', (select count(*) from t where type in ('receita','despesa'))),
    'por_categoria', coalesce((select jsonb_agg(x order by (x->>'total_cents')::bigint desc) from (
        select jsonb_build_object('tipo', type, 'categoria', coalesce(cat,'Sem categoria'), 'icone', icone, 'total_cents', sum(amount_cents),
          'quantidade', count(*),
          'subcategorias', (select coalesce(jsonb_agg(jsonb_build_object('nome', coalesce(s2.sub,'(sem subcategoria)'), 'total_cents', s2.tot) order by s2.tot desc), '[]')
              from (select sub, sum(amount_cents) tot from t t2 where t2.type = t.type and coalesce(t2.cat,'') = coalesce(t.cat,'') group by sub) s2)) x
        from t where type in ('receita','despesa') group by type, cat, icone) q), '[]'),
    'por_conta', coalesce((select jsonb_agg(jsonb_build_object('conta', nome, 'tipo', tipo, 'despesas_cents', d, 'receitas_cents', r) order by d desc) from (
        select coalesce(conta, cartao, 'Sem conta') nome, case when cartao is not null then 'cartao' else 'conta' end tipo,
          coalesce(sum(amount_cents) filter (where type='despesa'),0) d, coalesce(sum(amount_cents) filter (where type='receita'),0) r
        from t where type in ('receita','despesa') group by 1, 2) z), '[]'),
    'por_cartao', coalesce((select jsonb_agg(jsonb_build_object('cartao', cartao, 'total_cents', tot, 'quantidade', n) order by tot desc) from (
        select cartao, sum(amount_cents) tot, count(*) n from t where type='despesa' and cartao is not null group by cartao) z), '[]'),
    'por_estabelecimento', coalesce((select jsonb_agg(jsonb_build_object('estabelecimento', estab, 'total_cents', tot, 'quantidade', n) order by tot desc) from (
        select estab, sum(amount_cents) tot, count(*) n from t where type='despesa' and estab is not null group by estab order by 2 desc limit 20) z), '[]'),
    'por_membro', coalesce((select jsonb_agg(jsonb_build_object('membro', case when member_id is null then 'Família' else (select coalesce(name,'Membro') from profiles where id = member_id) end,
        'despesas_cents', d, 'receitas_cents', r) order by d desc) from (
        select member_id, coalesce(sum(amount_cents) filter (where type='despesa'),0) d, coalesce(sum(amount_cents) filter (where type='receita'),0) r
        from t group by member_id) z), '[]'),
    'evolucao', (select jsonb_agg(jsonb_build_object('mes', to_char(mi, 'YYYY-MM'),
        'receitas_cents', coalesce((select sum(amount_cents) from t where type='receita' and date_trunc('month', date) = mi), 0),
        'despesas_cents', coalesce((select sum(amount_cents) from t where type='despesa' and date_trunc('month', date) = mi), 0),
        'patrimonio_cents', case when mi <= v_today then (fe_balances(o, jsonb_build_object('ate', least((mi + interval '1 month' - interval '1 day')::date, v_today)))->>'total_cents')::bigint end
      ) order by mi) from months),
    'maiores', coalesce((select jsonb_agg(fe_tx_json(x) order by x.amount_cents desc) from (
        select * from transactions tt where tt.id in (select id from t where type='despesa' order by amount_cents desc limit 10)) x), '[]'),
    'orcamento', case when date_trunc('month', v_ini) = date_trunc('month', v_fim) then fe_budgets(p_user, jsonb_build_object('mes', to_char(v_ini,'YYYY-MM'), 'membro_id', v_f)) end,
    'metas', fe_goals(p_user),
    'patrimonio_atual_cents', (fe_balances(o)->>'total_cents')::bigint,
    'faturas_em_aberto_cents', fe_invoices_due_between(o, date '2000-01-01', date '2100-01-01')
  ) into v_res;
  return v_res;
end $$;
