-- =====================================================================
-- FASE 2 — motor financeiro atualizado (cartões no lançamento, saldos, disponível)
-- =====================================================================


create or replace function public.fe_tx_json(t public.transactions) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', t.id, 'tipo', t.type, 'valor_cents', t.amount_cents, 'data', t.date,
    'descricao', t.description,
    'estabelecimento', (select name from establishments where id = t.establishment_id),
    'categoria_id', t.category_id, 'subcategoria_id', t.subcategory_id,
    'categoria', (select name from categories where id = t.category_id),
    'icone', (select icon from categories where id = t.category_id),
    'subcategoria', (select name from subcategories where id = t.subcategory_id),
    'conta_id', t.account_id, 'conta', (select name from accounts where id = t.account_id),
    'conta_destino_id', t.transfer_account_id, 'conta_destino', (select name from accounts where id = t.transfer_account_id),
    'parcela', t.installment_number, 'parcelas', t.installment_total, 'grupo', t.installment_group,
    'membro_id', t.member_id,
    'membro', case when t.member_id is null then 'Família' else (select coalesce(name,'Membro') from profiles where id = t.member_id) end,
    'registrado_por', (select name from profiles where id = t.created_by),
    'cartao_id', t.card_id, 'cartao', (select name from credit_cards where id = t.card_id), 'fatura_vencimento', t.invoice_due,
    'recorrencia_id', t.recurring_id,
    'origem', t.origin, 'criado_em', t.created_at)
$$;

create or replace function public.fe_create_transaction(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := p_user;
  v_member uuid;
  v_type text := lower(coalesce(p->>'tipo', ''));
  v_total bigint;
  v_date date;
  v_today date := fe_today(p_user);
  v_n int := coalesce(nullif(p->>'parcelas','')::int, 1);
  v_estab_name text := nullif(trim(p->>'estabelecimento'), '');
  v_estab uuid;
  v_desc text;
  v_cat uuid; v_sub uuid; v_src text;
  v_acc uuid; v_acc2 uuid;
  v_card uuid; v_ncards int;
  v_origin text := coalesce(nullif(p->>'origem',''), 'app_form');
  v_group uuid;
  v_part bigint; v_first bigint;
  v_ids uuid[] := '{}';
  v_tx transactions;
  v_dup transactions;
  i int;
begin
  if p_user is null then perform fe_err('Usuário não identificado.'); end if;
  p_user := fe_owner(v_actor);   -- os dados pertencem à família
  -- de quem é o lançamento: da pessoa que registrou, da Família (compartilhado) ou de outro membro
  if coalesce((p->>'familia')::boolean, false) then v_member := null;
  elsif nullif(p->>'membro_id','') is not null then
    select member_id into v_member from household_members where member_id = (p->>'membro_id')::uuid and owner_id = p_user;
    if v_member is null then perform fe_err('Pessoa não faz parte da família.'); end if;
  else v_member := v_actor;
  end if;
  if v_type not in ('receita','despesa','transferencia','investimento','resgate','ajuste') then
    perform fe_err('Tipo de lançamento inválido.');
  end if;

  -- Valor
  if p ? 'valor_cents' then v_total := (p->>'valor_cents')::bigint;
  elsif p ? 'valor' then v_total := round((p->>'valor')::numeric * 100);
  else return jsonb_build_object('status','needs_value'); end if;
  if v_total is null or (v_total <= 0 and v_type <> 'ajuste') or v_total = 0 then
    perform fe_err('O valor precisa ser maior que zero.');
  end if;
  if abs(v_total) > 100000000000 then perform fe_err('Valor muito alto. Confira o número.'); end if;

  -- Data
  begin
    v_date := coalesce(nullif(p->>'data','')::date, v_today);
  exception when others then perform fe_err('Data inválida.');
  end;
  if v_date < date '2000-01-01' or v_date > v_today + interval '10 years' then
    perform fe_err('Data fora do intervalo permitido.');
  end if;

  if v_n < 1 or v_n > 72 then perform fe_err('Número de parcelas deve ser entre 1 e 72.'); end if;
  if v_n > 1 and v_type not in ('despesa','receita') then perform fe_err('Parcelamento só vale para despesas e receitas.'); end if;

  -- Cartão de crédito (só despesas): pelo nome, pelo id ou "no cartão" quando há um único cartão
  if v_type = 'despesa' then
    if nullif(p->>'cartao_id','') is not null then
      v_card := fe_resolve_card(p_user, null, (p->>'cartao_id')::uuid);
    elsif fe_norm(p->>'cartao') is not null then
      v_card := fe_resolve_card(p_user, p->>'cartao');
      if v_card is null then
        select count(*) into v_ncards from credit_cards where user_id = p_user and status = 'ativo';
        if v_ncards = 1 and fe_norm(p->>'cartao') ~ '^(cartao|credito|cartao de credito)$' then
          select id into v_card from credit_cards where user_id = p_user and status = 'ativo';
        else
          return jsonb_build_object('status', case when v_ncards = 0 then 'no_cards' else 'unknown_card' end, 'cartao', p->>'cartao',
            'cartoes', (select coalesce(jsonb_agg(name order by name), '[]') from credit_cards where user_id = p_user and status = 'ativo'));
        end if;
      end if;
    elsif p->>'forma_pagamento' = 'credito' and nullif(p->>'conta','') is null and nullif(p->>'conta_id','') is null then
      select count(*) into v_ncards from credit_cards where user_id = p_user and status = 'ativo';
      if v_ncards = 1 then select id into v_card from credit_cards where user_id = p_user and status = 'ativo';
      elsif v_ncards > 1 then
        return jsonb_build_object('status','needs_card','tipo',v_type,'valor_cents',v_total,
          'cartoes', (select coalesce(jsonb_agg(name order by name), '[]') from credit_cards where user_id = p_user and status = 'ativo'));
      end if;
    end if;
  end if;

  -- Conta (compras no cartão não saem da conta: entram na fatura)
  if v_card is not null then
    v_acc := null;
  elsif p ? 'conta_id' and nullif(p->>'conta_id','') is not null then
    v_acc := fe_resolve_account(p_user, null, (p->>'conta_id')::uuid);
  else
    v_acc := fe_resolve_account(p_user, p->>'conta');
    if v_acc is null then
      return jsonb_build_object('status','unknown_account','conta', p->>'conta');
    end if;
  end if;
  if v_type = 'transferencia' then
    if nullif(p->>'conta_destino_id','') is not null then
      v_acc2 := fe_resolve_account(p_user, null, (p->>'conta_destino_id')::uuid);
    elsif fe_norm(p->>'conta_destino') is not null then
      v_acc2 := fe_resolve_account(p_user, p->>'conta_destino');
    end if;
    if v_acc2 is null then return jsonb_build_object('status','needs_destination_account','conta_destino', p->>'conta_destino'); end if;
    if v_acc2 = v_acc then perform fe_err('A conta de origem e a de destino são iguais.'); end if;
  end if;

  -- Categoria (somente receitas e despesas)
  if v_type in ('receita','despesa') then
    if nullif(p->>'categoria_id','') is not null then
      select id into v_cat from categories where id = (p->>'categoria_id')::uuid and user_id = p_user
        and kind = v_type and archived_at is null;
      if v_cat is null then perform fe_err('Categoria não encontrada.'); end if;
      if nullif(p->>'subcategoria_id','') is not null then
        select id into v_sub from subcategories where id = (p->>'subcategoria_id')::uuid and category_id = v_cat;
      end if;
      v_src := 'informada';
    else
      select r.category_id, r.subcategory_id, r.source into v_cat, v_sub, v_src
        from fe_resolve_category(p_user, v_type, p->>'categoria', p->>'subcategoria', v_estab_name) r;
    end if;
    if v_cat is null then
      if coalesce((p->>'permitir_sem_categoria')::boolean, false) then
        select id into v_cat from categories where user_id = p_user and kind = v_type and fe_norm(name) = 'outros';
      else
        return jsonb_build_object('status','needs_category','tipo',v_type,'valor_cents',v_total);
      end if;
    end if;
  end if;

  -- Estabelecimento
  if v_estab_name is not null then
    insert into establishments(user_id, name, normalized_name)
      values (p_user, left(v_estab_name, 80), fe_norm(v_estab_name))
      on conflict (user_id, normalized_name) do update set name = establishments.name
      returning id into v_estab;
  end if;

  v_desc := left(coalesce(nullif(trim(p->>'descricao'),''), v_estab_name,
            (select name from subcategories where id = v_sub),
            (select name from categories where id = v_cat), initcap(v_type)), 120);

  -- Duplicidade: mesmo valor/tipo/data/descrição nos últimos 10 minutos
  if not coalesce((p->>'forcar')::boolean, false) then
    select * into v_dup from transactions t
      where t.user_id = p_user and t.deleted_at is null and t.type = v_type and t.date = v_date
        and t.created_at > now() - interval '10 minutes'
        and coalesce(t.installment_number,1) = 1
        and (case when t.installment_total > 1
                  then (select sum(amount_cents) from transactions x where x.installment_group = t.installment_group and x.deleted_at is null)
                  else t.amount_cents end) = v_total
        and (fe_norm(t.description) = fe_norm(v_desc) or (v_estab is not null and t.establishment_id = v_estab))
      order by t.created_at desc limit 1;
    if found then
      return jsonb_build_object('status','possible_duplicate','existente', fe_tx_json(v_dup));
    end if;
  end if;

  -- Gravação (com parcelas, se houver)
  if v_n > 1 then v_group := gen_random_uuid(); end if;
  v_part := (v_total / v_n);
  v_first := v_total - v_part * (v_n - 1);   -- centavos que sobram ficam na 1ª parcela
  for i in 1..v_n loop
    insert into transactions(user_id, member_id, created_by, type, amount_cents, date, description, establishment_id,
      category_id, subcategory_id, account_id, transfer_account_id, card_id, invoice_due, payment_method,
      installment_number, installment_total, installment_group, status, origin,
      original_message, transcript, interpretation_id, recurring_id, external_id)
    values (p_user, v_member, v_actor, v_type, case when i = 1 then v_first else v_part end,
      (v_date + make_interval(months => i - 1))::date,
      case when v_n > 1 then left(v_desc, 110) || ' (' || i || '/' || v_n || ')' else v_desc end,
      v_estab, v_cat, v_sub, v_acc, v_acc2, v_card,
      case when v_card is not null then (fe_invoice_due(v_card, v_date) + make_interval(months => i - 1))::date end,
      coalesce(nullif(p->>'forma_pagamento',''), case when v_card is not null then 'credito' end),
      case when v_n > 1 then i end, case when v_n > 1 then v_n end, v_group,
      case when (v_date + make_interval(months => i - 1))::date > v_today then 'previsto' else 'efetivado' end,
      v_origin, left(p->>'mensagem_original', 2000), left(p->>'transcricao', 4000),
      nullif(p->>'interpretation_id','')::uuid, nullif(p->>'recorrencia_id','')::uuid, nullif(p->>'id_externo',''))
    returning * into v_tx;
    v_ids := v_ids || v_tx.id;
    if i = 1 then
      insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
        values (p_user, v_actor, 'transaction', v_tx.id, 'create',
                fe_tx_json(v_tx) || jsonb_build_object('categoria_origem', v_src), v_origin);
    end if;
  end loop;

  perform fe_learn(p_user, v_estab, v_cat, v_sub);

  select * into v_tx from transactions where id = v_ids[1];
  return jsonb_build_object(
    'status', 'created',
    'categoria_origem', v_src,
    'valor_total_cents', v_total,
    'valor_parcela_cents', case when v_n > 1 then v_part end,
    'parcelas', v_n,
    'ids', to_jsonb(v_ids),
    'cartao', (select name from credit_cards where id = v_card),
    'fatura', case when v_card is not null then fe_invoice_json(p_user, v_card, fe_invoice_due(v_card, v_date)) end,
    'limite_disponivel_cents', case when v_card is not null then
       (select (x->>'disponivel_cents')::bigint from jsonb_array_elements(fe_cards(p_user)) x where (x->>'id')::uuid = v_card) end,
    'orcamento', case when v_type = 'despesa' then fe_budget_status(p_user, v_cat, v_date) end,
    'lancamento', fe_tx_json(v_tx));
end $$;

create or replace function public.fe_update_transaction(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v transactions; v_after transactions;
  v_cat uuid; v_sub uuid; v_acc uuid;
  v_before jsonb;
  v_group_filter boolean;
  v_actor uuid := p_user;
  v_member uuid;
begin
  v := fe_target(v_actor, p);
  p_user := fe_owner(v_actor);
  if v.id is null then return jsonb_build_object('status','not_found'); end if;
  v_before := fe_tx_json(v);
  v_cat := v.category_id; v_sub := v.subcategory_id; v_acc := v.account_id; v_member := v.member_id;
  if coalesce((p->>'familia')::boolean, false) then v_member := null;
  elsif nullif(p->>'membro_id','') is not null then
    select member_id into v_member from household_members where member_id = (p->>'membro_id')::uuid and owner_id = p_user;
    if v_member is null then perform fe_err('Pessoa não faz parte da família.'); end if;
  end if;
  v_group_filter := v.installment_group is not null;

  if nullif(p->>'categoria_id','') is not null then
    select id into v_cat from categories where id = (p->>'categoria_id')::uuid and user_id = p_user and kind = v.type;
    if v_cat is null then perform fe_err('Categoria não encontrada.'); end if;
    v_sub := null;
    if nullif(p->>'subcategoria_id','') is not null then
      select id into v_sub from subcategories where id = (p->>'subcategoria_id')::uuid and category_id = v_cat;
    end if;
  elsif fe_norm(p->>'categoria') is not null or fe_norm(p->>'subcategoria') is not null then
    select r.category_id, r.subcategory_id into v_cat, v_sub
      from fe_resolve_category(p_user, v.type, p->>'categoria', p->>'subcategoria', null) r;
    if v_cat is null then
      return jsonb_build_object('status','unknown_category','categoria', coalesce(p->>'categoria', p->>'subcategoria'));
    end if;
  end if;

  if nullif(p->>'conta_id','') is not null then v_acc := fe_resolve_account(p_user, null, (p->>'conta_id')::uuid);
  elsif fe_norm(p->>'conta') is not null then
    v_acc := fe_resolve_account(p_user, p->>'conta');
    if v_acc is null then return jsonb_build_object('status','unknown_account','conta',p->>'conta'); end if;
  end if;

  if (p ? 'valor' or p ? 'valor_cents' or p ? 'data') and v_group_filter then
    perform fe_err('Para mudar valor ou data de uma compra parcelada, apague e lance novamente.');
  end if;

  update transactions t set
    category_id = v_cat,
    subcategory_id = v_sub,
    member_id = v_member,
    account_id = v_acc,
    amount_cents = coalesce((p->>'valor_cents')::bigint, round((p->>'valor')::numeric * 100)::bigint, t.amount_cents),
    date = coalesce(nullif(p->>'data','')::date, t.date),
    invoice_due = case when t.card_id is not null and t.type <> 'pagamento_fatura' and nullif(p->>'data','') is not null
                       then fe_invoice_due(t.card_id, (p->>'data')::date) else t.invoice_due end,
    description = case when nullif(trim(p->>'descricao'),'') is null then t.description
                       when t.installment_total > 1 then left(trim(p->>'descricao'),110) || ' (' || t.installment_number || '/' || t.installment_total || ')'
                       else left(trim(p->>'descricao'),120) end,
    updated_at = now()
  where t.user_id = p_user and t.deleted_at is null
    and (t.id = v.id or (v_group_filter and t.installment_group = v.installment_group));

  select * into v_after from transactions where id = v.id;
  if v_after.amount_cents <= 0 and v_after.type <> 'ajuste' then perform fe_err('O valor precisa ser maior que zero.'); end if;

  if v_after.category_id is distinct from v.category_id or v_after.subcategory_id is distinct from v.subcategory_id then
    perform fe_learn(p_user, v.establishment_id, v_after.category_id, v_after.subcategory_id);
  end if;

  insert into audit_logs(user_id, actor_id, entity, entity_id, action, before, after, source)
    values (p_user, v_actor, 'transaction', v.id, 'update', v_before, fe_tx_json(v_after), coalesce(p->>'origem','app_form'));

  return jsonb_build_object('status','updated','antes', v_before, 'lancamento', fe_tx_json(v_after));
end $$;

create or replace function public.fe_balances(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with today as (select coalesce(nullif(p->>'ate','')::date, fe_today(p_user)) d),
  o as (select fe_owner(p_user) id),
  bal as (
    select a.id, a.name, a.type, a.institution, a.is_default, a.status,
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
    from accounts a where a.user_id = (select id from o)
  )
  select jsonb_build_object(
    'contas', coalesce(jsonb_agg(jsonb_build_object('id',id,'nome',name,'tipo',type,'instituicao',institution,
              'padrao',is_default,'status',status,'saldo_cents',balance_cents) order by is_default desc, name), '[]'),
    'total_cents', coalesce(sum(balance_cents) filter (where status = 'ativa'), 0))
  from bal
$$;

create or replace function public.fe_month_overview(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ini date; v_fim date; v_today date := fe_today(p_user);
  v_res jsonb;
  v_f text := p->>'membro_id';
begin
  p_user := fe_owner(p_user);
  select inicio, fim into v_ini, v_fim from fe_month_bounds(p->>'mes', p_user);

  with m as (
    select * from transactions
    where user_id = p_user and deleted_at is null and date between v_ini and v_fim and fe_member_match(member_id, v_f)
  ),
  months as (
    select generate_series(date_trunc('month', v_ini) - interval '5 months', date_trunc('month', v_ini), interval '1 month')::date as mi
  )
  select jsonb_build_object(
    'mes', to_char(v_ini, 'YYYY-MM'), 'inicio', v_ini, 'fim', v_fim, 'hoje', v_today,
    'receitas_cents',  coalesce((select sum(amount_cents) from m where type='receita' and date <= v_today), 0),
    'despesas_cents',  coalesce((select sum(amount_cents) from m where type='despesa' and date <= v_today), 0),
    'investimentos_cents', coalesce((select sum(amount_cents) from m where type='investimento' and date <= v_today), 0)
                         - coalesce((select sum(amount_cents) from m where type='resgate' and date <= v_today), 0),
    'receitas_previstas_cents', coalesce((select sum(amount_cents) from m where type='receita' and date > v_today), 0),
    'compromissos_futuros_cents', coalesce((select sum(amount_cents) from m where type='despesa' and date > v_today and card_id is null), 0)
                                  + case when v_fim >= v_today then fe_invoices_due_between(p_user, greatest(v_ini, v_today), v_fim) else 0 end,
    'faturas_mes_cents', case when v_fim >= v_today then fe_invoices_due_between(p_user, greatest(v_ini, v_today), v_fim) else 0 end,
    'por_cartao', coalesce((select jsonb_agg(jsonb_build_object('cartao', c.name, 'cor', c.color, 'total_cents', z.tot) order by z.tot desc)
        from (select card_id, sum(amount_cents) tot from m where type='despesa' and card_id is not null group by card_id) z
        join credit_cards c on c.id = z.card_id), '[]'),
    'gastos_por_conta', coalesce((select jsonb_agg(jsonb_build_object('conta', nome, 'total_cents', tot) order by tot desc) from (
        select coalesce(a.name, cc.name) nome, sum(m.amount_cents) tot from m
          left join accounts a on a.id = m.account_id left join credit_cards cc on cc.id = m.card_id
          where m.type = 'despesa' group by coalesce(a.name, cc.name)) g), '[]'),
    'alertas', fe_alerts(p_user),
    'receitas_mes_total_cents', coalesce((select sum(amount_cents) from m where type='receita'), 0),
    'despesas_mes_total_cents', coalesce((select sum(amount_cents) from m where type='despesa'), 0),
    'por_categoria', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('categoria_id', c.id, 'categoria', coalesce(c.name,'Sem categoria'), 'icone', c.icon,
          'total_cents', sum(m.amount_cents),
          'orcamento_cents', fe_budget_amount(p_user, c.id, v_ini)) x
        from m left join categories c on c.id = m.category_id
        where m.type = 'despesa' group by c.id, c.name, c.icon order by sum(m.amount_cents) desc) q), '[]'),
    'por_conta', (fe_balances(p_user)->'contas'),
    'saldo_contas_cents', (fe_balances(p_user)->'total_cents'),
    'evolucao', (select jsonb_agg(jsonb_build_object(
        'mes', to_char(mi,'YYYY-MM'),
        'receitas_cents', coalesce((select sum(amount_cents) from transactions t where t.user_id=p_user and t.deleted_at is null and fe_member_match(t.member_id, v_f) and t.type='receita' and t.date between mi and (mi + interval '1 month' - interval '1 day')::date), 0),
        'despesas_cents', coalesce((select sum(amount_cents) from transactions t where t.user_id=p_user and t.deleted_at is null and fe_member_match(t.member_id, v_f) and t.type='despesa' and t.date between mi and (mi + interval '1 month' - interval '1 day')::date), 0),
        'patrimonio_cents', (fe_balances(p_user, jsonb_build_object('ate', least((mi + interval '1 month' - interval '1 day')::date, v_today)))->>'total_cents')::bigint
      ) order by mi) from months),
    'recentes', coalesce((select jsonb_agg(fe_tx_json(t) order by t.date desc, t.created_at desc) from (
        select * from transactions where user_id = p_user and deleted_at is null and date <= v_today
          and fe_member_match(member_id, v_f)
        order by date desc, created_at desc limit 8) t), '[]'),
    'despesas_por_membro', fe_member_split(p_user, 'despesa', v_ini, least(v_fim, v_today)),
    'receitas_por_membro', fe_member_split(p_user, 'receita', v_ini, least(v_fim, v_today)),
    'meta_economia_cents', (select monthly_savings_goal_cents from profiles where id = p_user)
  ) into v_res;
  return v_res;
end $$;

create or replace function public.fe_available(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date := fe_today(p_user);
  v_fim date := (date_trunc('month', v_today) + interval '1 month' - interval '1 day')::date;
  v_saldo bigint; v_rp bigint; v_dp bigint; v_meta bigint; v_disp bigint; v_dias int; v_fat bigint;
  v_gasto bigint;
begin
  p_user := fe_owner(p_user);
  v_saldo := (fe_balances(p_user)->>'total_cents')::bigint;
  select coalesce(sum(amount_cents) filter (where type='receita'),0),
         coalesce(sum(amount_cents) filter (where type='despesa'),0)
    into v_rp, v_dp
    from transactions where user_id = p_user and deleted_at is null and date > v_today and date <= v_fim and card_id is null;
  v_fat := fe_invoices_due_between(p_user, date '2000-01-01', v_fim);
  select coalesce(sum(amount_cents),0) into v_gasto from transactions
    where user_id = p_user and deleted_at is null and type='despesa' and date between date_trunc('month', v_today)::date and v_today;
  v_meta := coalesce((select monthly_savings_goal_cents from profiles where id = p_user), 0);
  v_disp := v_saldo + v_rp - v_dp - v_fat - v_meta;
  v_dias := v_fim - v_today + 1;
  return jsonb_build_object(
    'hoje', v_today, 'fim_mes', v_fim, 'dias_restantes', v_dias,
    'saldo_atual_cents', v_saldo,
    'receitas_previstas_cents', v_rp,
    'despesas_previstas_cents', v_dp,
    'faturas_cents', v_fat,
    'meta_economia_cents', v_meta,
    'gasto_mes_cents', v_gasto,
    'disponivel_cents', v_disp,
    'diario_cents', case when v_disp > 0 then v_disp / v_dias else 0 end,
    'compra_cents', nullif(p->>'valor_cents','')::bigint);
end $$;

create or replace function public.fe_context_data(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with o as (select fe_owner(p_user) id)
  select jsonb_build_object(
    'hoje', fe_today(p_user),
    'eu', p_user,
    'nome', (select name from profiles where id = p_user),
    'membros', coalesce((select jsonb_agg(jsonb_build_object('id', hm.member_id, 'nome', coalesce(pr.name,'Membro'),
        'eu', hm.member_id = p_user) order by hm.joined_at)
        from household_members hm left join profiles pr on pr.id = hm.member_id where hm.owner_id = (select id from o)), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('tipo', c.kind, 'nome', c.name, 'icone', c.icon,
        'subcategorias', coalesce((select jsonb_agg(s.name order by s.name) from subcategories s where s.category_id = c.id and s.archived_at is null), '[]'))
        order by c.kind, c.name) from categories c where c.user_id = (select id from o) and c.archived_at is null), '[]'),
    'contas', coalesce((select jsonb_agg(name order by is_default desc, name) from accounts where user_id = (select id from o) and status = 'ativa'), '[]'),
    'cartoes', coalesce((select jsonb_agg(name order by name) from credit_cards where user_id = (select id from o) and status = 'ativo'), '[]'),
    'metas', coalesce((select jsonb_agg(name order by created_at) from financial_goals where user_id = (select id from o) and status = 'ativa'), '[]'))
$$;

create or replace function public.fe_context(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform fe_run_recurring(fe_owner(p_user));
  return fe_context_data(p_user);
end $$;