-- =====================================================================
-- Compras divididas com vencimento: a parte de cada pessoa vence JUNTO COM A FATURA do cartão
-- (parcela por parcela). Quem é dono do cartão vê a parcela inteira na fatura e "a receber" no
-- vencimento; quem ficou com a parte vê "a pagar" no vencimento, nos lembretes e nas notificações.
-- =====================================================================

-- O que quem está usando deve e tem a receber, pelo VENCIMENTO (fatura do cartão ou data do lançamento)
create or replace function public.fe_debts(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_fim date;
begin
  select fim into v_fim from fe_month_bounds(p->>'mes', o);
  return (with x as (
      select t.id, t.amount_cents, coalesce(t.invoice_due, t.date) venc, case when t.member_id = p_user then 'devo' else 'recebo' end lado,
             case when t.member_id = p_user then t.owed_to else t.member_id end outro
      from transactions t
      where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and coalesce(t.invoice_due, t.date) <= v_fim
        and (t.member_id = p_user or t.owed_to = p_user))
    select jsonb_build_object('ate', v_fim,
      'devo', coalesce((select jsonb_agg(g order by g->>'pessoa') from (
          select jsonb_build_object('pessoa_id', outro, 'pessoa', (select name from profiles where id = outro), 'total_cents', sum(amount_cents),
            'itens', jsonb_agg(fe_tx_json((select t2 from transactions t2 where t2.id = x.id)) || jsonb_build_object('vencimento', venc) order by venc)) g
          from x where lado = 'devo' group by outro) a), '[]'),
      'recebo', coalesce((select jsonb_agg(g order by g->>'pessoa') from (
          select jsonb_build_object('pessoa_id', outro, 'pessoa', (select name from profiles where id = outro), 'total_cents', sum(amount_cents),
            'itens', jsonb_agg(fe_tx_json((select t2 from transactions t2 where t2.id = x.id)) || jsonb_build_object('vencimento', venc) order by venc)) g
          from x where lado = 'recebo' group by outro) a), '[]'),
      'futuro_cents', (select coalesce(sum(amount_cents), 0) from transactions t where t.user_id = o and t.deleted_at is null
          and t.settle_status = 'pendente' and coalesce(t.invoice_due, t.date) > v_fim and (t.member_id = p_user or t.owed_to = p_user)),
      'proximo_vencimento', (select min(coalesce(t.invoice_due, t.date)) from transactions t where t.user_id = o and t.deleted_at is null
          and t.settle_status = 'pendente' and coalesce(t.invoice_due, t.date) > v_fim and (t.member_id = p_user or t.owed_to = p_user))));
end $$;

-- Acertar com uma pessoa (tudo o que venceu até o fim do mês) ou só alguns itens (p.ids: uma parcela, por exemplo)
create or replace function public.fe_settle(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_other uuid; v_debtor uuid; v_creditor uuid; v_fim date; v_total bigint; v_set family_settlements;
  v_from uuid; v_to uuid; v_tr jsonb; v_acao text := coalesce(nullif(p->>'acao',''), 'pago'); v_date date;
  v_ids uuid[] := case when jsonb_typeof(p->'ids') = 'array' then array(select (x)::uuid from jsonb_array_elements_text(p->'ids') x) end;
begin
  if v_ids is not null and nullif(p->>'pessoa_id','') is null then
    select case when member_id = p_user then owed_to else member_id end into v_other
      from transactions where id = v_ids[1] and user_id = o and settle_status = 'pendente' and (member_id = p_user or owed_to = p_user);
    if v_other is null then return jsonb_build_object('status','nothing'); end if;
  else
    v_other := fe_member_param(o, p_user, p->>'pessoa_id');
  end if;
  if v_other is null or v_other = p_user then perform fe_err('Informe com quem é o acerto.'); end if;
  select fim into v_fim from fe_month_bounds(p->>'mes', o);
  v_date := coalesce(nullif(p->>'data','')::date, fe_today(p_user));
  select coalesce(sum(case when member_id = p_user then amount_cents else -amount_cents end), 0) into v_total
    from transactions where user_id = o and deleted_at is null and settle_status = 'pendente'
      and (case when v_ids is null then coalesce(invoice_due, date) <= v_fim else id = any(v_ids) end)
      and ((member_id = p_user and owed_to = v_other) or (member_id = v_other and owed_to = p_user));
  if v_total = 0 then return jsonb_build_object('status','nothing'); end if;
  if v_total > 0 then v_debtor := p_user; v_creditor := v_other; else v_debtor := v_other; v_creditor := p_user; v_total := -v_total; end if;
  if v_acao not in ('pago','dispensar') then perform fe_err('Ação inválida.'); end if;
  insert into family_settlements(user_id, debtor_id, creditor_id, amount_cents, date, method, status, created_by)
    values (o, v_debtor, v_creditor, v_total, v_date, nullif(p->>'forma',''), case when v_acao = 'pago' then 'pago' else 'dispensado' end, p_user)
    returning * into v_set;
  update transactions set settle_status = v_set.status, settlement_id = v_set.id, updated_at = now()
    where user_id = o and deleted_at is null and settle_status = 'pendente'
      and (case when v_ids is null then coalesce(invoice_due, date) <= v_fim else id = any(v_ids) end)
      and ((member_id = v_debtor and owed_to = v_creditor) or (member_id = v_creditor and owed_to = v_debtor));
  if v_acao = 'pago' then
    v_from := coalesce(nullif(p->>'conta_origem_id','')::uuid,
      (select id from accounts where user_id = o and status = 'ativa' and member_id = v_debtor order by is_default desc, (type = 'dinheiro') = (p->>'forma' = 'dinheiro') desc, created_at limit 1));
    v_to := coalesce(nullif(p->>'conta_destino_id','')::uuid,
      (select id from accounts where user_id = o and status = 'ativa' and member_id = v_creditor order by is_default desc, (type = 'dinheiro') = (p->>'forma' = 'dinheiro') desc, created_at limit 1));
    if v_from is not null and v_to is not null and v_from <> v_to then
      v_tr := fe_create_transaction(p_user, jsonb_build_object('tipo','transferencia','valor_cents', v_total, 'data', v_date,
        'conta_id', v_from, 'conta_destino_id', v_to, 'forcar', true, 'membro_id', v_debtor,
        'forma_pagamento', nullif(p->>'forma',''),
        'descricao', 'Acerto: ' || (select name from profiles where id = v_debtor) || ' → ' || (select name from profiles where id = v_creditor),
        'origem', coalesce(nullif(p->>'origem',''),'app_form')));
      update family_settlements set transfer_id = (v_tr->'ids'->>0)::uuid where id = v_set.id;
    end if;
  end if;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'settlement', v_set.id, v_set.status, to_jsonb(v_set), coalesce(p->>'origem','app_form'));
  update notifications set read_at = coalesce(read_at, now())
    where user_id in (v_debtor, v_creditor) and type in ('acerto','acerto_vence','acerto_atraso')
      and (data->>'tx_id')::uuid in (select id from transactions where settlement_id = v_set.id);
  return jsonb_build_object('status', v_set.status, 'valor_cents', v_total,
    'devedor', (select name from profiles where id = v_debtor), 'credor', (select name from profiles where id = v_creditor),
    'eu_devia', v_debtor = p_user, 'transferencia', v_tr is not null,
    'conta_origem', (select name from accounts where id = v_from), 'conta_destino', (select name from accounts where id = v_to));
end $$;

-- Lembretes do início: além das contas a pagar/receber, cada parcela de acerto no vencimento
create or replace function public.fe_pending(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_today date := fe_today(p_user); v_f text := p->>'membro_id';
  v_dias int := coalesce(nullif(p->>'dias','')::int, 7); v_d jsonb;
  v_pessoa uuid := case when nullif(p->>'membro_id','') is null or p->>'membro_id' = 'familia' then p_user else (p->>'membro_id')::uuid end;
begin
  v_d := fe_debts(p_user, '{}');
  return jsonb_build_object('hoje', v_today,
    'atrasados', coalesce((select jsonb_agg(x order by x->>'data', (x->>'valor_cents')::bigint desc) from (
        select fe_tx_json(t) x from transactions t
          where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type)
            and t.date < v_today and fe_member_match(t.member_id, v_f)
        union all
        select fe_acerto_item(t, v_pessoa) from transactions t
          where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and (t.member_id = v_pessoa or t.owed_to = v_pessoa)
            and coalesce(t.invoice_due, t.date) < v_today) z), '[]'),
    'proximos', coalesce((select jsonb_agg(x order by x->>'data', (x->>'valor_cents')::bigint desc) from (
        select fe_tx_json(t) x from transactions t
          where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type)
            and t.date between v_today and v_today + v_dias and fe_member_match(t.member_id, v_f)
        union all
        select fe_acerto_item(t, v_pessoa) from transactions t
          where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and (t.member_id = v_pessoa or t.owed_to = v_pessoa)
            and coalesce(t.invoice_due, t.date) between v_today and v_today + v_dias) z), '[]'),
    'acertos_devo', coalesce((select jsonb_agg(jsonb_build_object('pessoa_id', x->>'pessoa_id', 'pessoa', x->>'pessoa', 'total_cents', (x->>'total_cents')::bigint,
        'desde', (select min((i->>'vencimento')::date) from jsonb_array_elements(x->'itens') i)))
        from jsonb_array_elements(v_d->'devo') x), '[]'),
    'acertos_recebo', coalesce((select jsonb_agg(jsonb_build_object('pessoa_id', x->>'pessoa_id', 'pessoa', x->>'pessoa', 'total_cents', (x->>'total_cents')::bigint,
        'desde', (select min((i->>'vencimento')::date) from jsonb_array_elements(x->'itens') i)))
        from jsonb_array_elements(v_d->'recebo') x), '[]'));
end $$;

-- uma parcela de acerto como item de lembrete ("a pagar para Cássio" / "a receber de Bruna")
create or replace function public.fe_acerto_item(t public.transactions, p_pessoa uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select fe_tx_json(t) || jsonb_build_object(
    'tipo', case when t.member_id = p_pessoa then 'despesa' else 'receita' end,
    'data', coalesce(t.invoice_due, t.date),
    'acerto', 'pendente', 'acerto_lado', case when t.member_id = p_pessoa then 'devo' else 'recebo' end,
    'pessoa_id', case when t.member_id = p_pessoa then t.owed_to else t.member_id end,
    'pessoa', (select name from profiles where id = case when t.member_id = p_pessoa then t.owed_to else t.member_id end))
$$;

-- painel e alertas: acertos pelo vencimento
do $$
declare v_src text; v_new text;
begin
  select pg_get_functiondef('public.fe_month_overview(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%coalesce(invoice_due, date) <= v_fim%' then
  v_new := replace(v_src, 'settle_status = ''pendente'' and member_id = v_f::uuid and date <= v_fim',
                          'settle_status = ''pendente'' and member_id = v_f::uuid and coalesce(invoice_due, date) <= v_fim');
  v_new := replace(v_new, 'settle_status = ''pendente'' and owed_to = v_f::uuid and date <= v_fim',
                          'settle_status = ''pendente'' and owed_to = v_f::uuid and coalesce(invoice_due, date) <= v_fim');
  if v_new not like '%member_id = v_f::uuid and coalesce(invoice_due, date) <= v_fim%' or v_new not like '%owed_to = v_f::uuid and coalesce(invoice_due, date) <= v_fim%' then
    raise exception 'fe_month_overview inesperado';
  end if;
  execute v_new;
  end if;

  select pg_get_functiondef('public.fe_alerts(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%coalesce(t.invoice_due, t.date) <= (date_trunc%' then
    v_new := replace(v_src, 'and t.date <= (date_trunc(''month'', v_today)', 'and coalesce(t.invoice_due, t.date) <= (date_trunc(''month'', v_today)');
    if v_new = v_src then raise exception 'fe_alerts inesperado'; end if;
    execute v_new;
  end if;
end $$;

create or replace function public.fe_notify_scan(p_user uuid, p jsonb default '{}') returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_today date := fe_today(p_user); v_n int := 0; v_k int; r record;
begin
  -- contas a pagar / a receber em atraso
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'pendente',
      case when t.type = 'despesa' then 'Conta em atraso' else 'Valor a receber em atraso' end,
      format('%s — R$ %s, %s em %s. Toque no 👎 em Pendências quando %s.', coalesce(t.description, 'Lançamento'), fe_fmt(t.amount_cents/100.0),
        case when t.type = 'despesa' then 'venceu' else 'era para entrar' end, to_char(t.date, 'DD/MM'),
        case when t.type = 'despesa' then 'pagar' else 'receber' end),
      '#/', jsonb_build_object('tx_id', t.id), 'atraso:' || t.id
    from transactions t
    where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type) and t.date < v_today
      and (t.member_id is null or t.member_id = p_user)
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- vence hoje / amanhã
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'vence',
      case when t.date = v_today then 'Vence hoje' else 'Vence amanhã' end,
      format('%s — R$ %s (%s).', coalesce(t.description, 'Lançamento'), fe_fmt(t.amount_cents/100.0), case when t.type = 'despesa' then 'a pagar' else 'a receber' end),
      '#/', jsonb_build_object('tx_id', t.id), 'vence:' || t.id || ':' || t.date
    from transactions t
    where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type) and t.date between v_today and v_today + 1
      and (t.member_id is null or t.member_id = p_user)
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- conta fixa chegando ao fim: pergunta reajuste e renovação
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'renovar', 'Conta fixa terminando',
      format('%s (R$ %s %s) está lançada até %s. Houve reajuste? Renove por mais 12 meses.', r2.description, fe_fmt(r2.amount_cents/100.0),
        case r2.frequency when 'semanal' then 'por semana' when 'anual' then 'por ano' else 'por mês' end, to_char(r2.end_date, 'MM/YYYY')),
      '#/fixas', jsonb_build_object('recorrencia_id', r2.id, 'valor_cents', r2.amount_cents, 'fim', r2.end_date, 'descricao', r2.description),
      'renovar:' || r2.id || ':' || r2.end_date
    from recurring_transactions r2
    where r2.user_id = o and r2.end_date is not null and r2.end_date between v_today - 60 and v_today + 35
      and r2.renew_dismissed_end is distinct from r2.end_date
      and (r2.member_id is null or r2.member_id = p_user or r2.created_by = p_user)
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- faturas do cartão: vencendo em até 3 dias ou vencidas com saldo
  for r in select c.id, c.name, z.due, (fe_invoice_json(o, c.id, z.due)->>'restante_cents')::bigint resto
           from credit_cards c
           join lateral (select distinct invoice_due due from transactions t
                         where t.user_id = o and t.card_id = c.id and t.deleted_at is null and t.invoice_due between v_today - 10 and v_today + 3) z on true
           where c.user_id = o and c.status = 'ativo' and (c.member_id is null or c.member_id = p_user) loop
    if r.resto > 0 then
      insert into notifications(user_id, type, title, body, link, data, dedupe)
        values (p_user, 'fatura', case when r.due < v_today then 'Fatura vencida' else 'Fatura vencendo' end,
          format('Fatura do %s: R$ %s, %s %s.', r.name, fe_fmt(r.resto/100.0), case when r.due < v_today then 'venceu em' else 'vence em' end, to_char(r.due, 'DD/MM')),
          '#/cartoes', jsonb_build_object('cartao_id', r.id, 'vencimento', r.due),
          case when r.due < v_today then 'fatura_atraso:' else 'fatura:' end || r.id || ':' || r.due)
      on conflict (user_id, dedupe) do nothing;
      get diagnostics v_k = row_count; v_n := v_n + v_k;
    end if;
  end loop;

  -- orçamentos: 80% e estourado (uma vez por mês por categoria)
  for r in select e.value x from jsonb_array_elements(coalesce(fe_budgets(p_user, '{}')->'itens', '[]')) e
           where e.value->>'situacao' in ('estourado','atencao') loop
    insert into notifications(user_id, type, title, body, link, data, dedupe)
      values (p_user, 'orcamento', case when r.x->>'situacao' = 'estourado' then 'Orçamento estourado' else 'Orçamento perto do limite' end,
        format('%s: R$ %s de R$ %s (%s%%).', r.x->>'categoria', fe_fmt((r.x->>'gasto_cents')::numeric/100), fe_fmt((r.x->>'limite_cents')::numeric/100), round((r.x->>'percentual')::numeric)),
        '#/orcamentos', jsonb_build_object('categoria_id', r.x->>'categoria_id'),
        'orc:' || coalesce(r.x->>'categoria_id', r.x->>'categoria') || ':' || to_char(v_today, 'YYYY-MM') || ':' || (r.x->>'situacao'))
    on conflict (user_id, dedupe) do nothing;
    get diagnostics v_k = row_count; v_n := v_n + v_k;
  end loop;

  -- gasto dividido com você por outra pessoa da família: um aviso por compra (não um por parcela)
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'acerto', 'Gasto dividido com você',
      format('%s dividiu “%s” com você: sua parte é R$ %s%s.', coalesce((select split_part(name, ' ', 1) from profiles where id = g.criador), 'Alguém da família'),
        g.descr, fe_fmt(g.tot/100.0),
        case when g.n > 1 then format(' em %sx de R$ %s — cada parcela vence junto com a fatura; eu aviso no dia', g.n, fe_fmt(g.parc/100.0)) else '' end),
      '#/', jsonb_build_object('tx_id', g.primeiro, 'grupo', g.k), 'acerto:' || g.k
    from (select coalesce(t.split_group, t.id) k, (array_agg(t.created_by))[1] criador,
            coalesce(regexp_replace((array_agg(t.description order by coalesce(t.invoice_due, t.date)))[1], ' \(\d+/\d+\)$', ''), 'compra') descr,
            sum(t.amount_cents) tot, count(*) n, (array_agg(t.amount_cents order by coalesce(t.invoice_due, t.date) desc))[1] parc,
            (array_agg(t.id order by coalesce(t.invoice_due, t.date)))[1] primeiro
          from transactions t
          where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and t.member_id = p_user
            and t.created_by is distinct from p_user and t.created_at > now() - interval '45 days'
          group by coalesce(t.split_group, t.id)) g
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- acertos vencendo hoje/amanhã (para quem paga e para quem recebe) — vence junto com a fatura do cartão
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'acerto_vence',
      case when t.member_id = p_user then case when coalesce(t.invoice_due, t.date) = v_today then 'Acerto vence hoje' else 'Acerto vence amanhã' end
           else case when coalesce(t.invoice_due, t.date) = v_today then 'A receber hoje' else 'A receber amanhã' end end,
      case when t.member_id = p_user
        then format('Sua parte de “%s”: R$ %s para %s.', coalesce(t.description, 'compra dividida'), fe_fmt(t.amount_cents/100.0), coalesce((select split_part(name, ' ', 1) from profiles where id = t.owed_to), 'a família'))
        else format('%s te paga R$ %s referente a “%s”.', coalesce((select split_part(name, ' ', 1) from profiles where id = t.member_id), 'Alguém'), fe_fmt(t.amount_cents/100.0), coalesce(t.description, 'compra dividida')) end,
      '#/', jsonb_build_object('tx_id', t.id), 'acerto_vence:' || t.id || ':' || coalesce(t.invoice_due, t.date)
    from transactions t
    where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and (t.member_id = p_user or t.owed_to = p_user)
      and coalesce(t.invoice_due, t.date) between v_today and v_today + 1
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- acertos em atraso
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'acerto_atraso', case when t.member_id = p_user then 'Acerto em atraso' else 'Acerto a receber em atraso' end,
      case when t.member_id = p_user
        then format('Sua parte de “%s” (R$ %s para %s) venceu em %s.', coalesce(t.description, 'compra dividida'), fe_fmt(t.amount_cents/100.0),
          coalesce((select split_part(name, ' ', 1) from profiles where id = t.owed_to), 'a família'), to_char(coalesce(t.invoice_due, t.date), 'DD/MM'))
        else format('%s ainda não pagou R$ %s de “%s” (venceu em %s).', coalesce((select split_part(name, ' ', 1) from profiles where id = t.member_id), 'Alguém'),
          fe_fmt(t.amount_cents/100.0), coalesce(t.description, 'compra dividida'), to_char(coalesce(t.invoice_due, t.date), 'DD/MM')) end,
      '#/', jsonb_build_object('tx_id', t.id), 'acerto_atraso:' || t.id
    from transactions t
    where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and (t.member_id = p_user or t.owed_to = p_user)
      and coalesce(t.invoice_due, t.date) < v_today and coalesce(t.invoice_due, t.date) >= v_today - 30
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- metas atingidas
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'meta', 'Meta atingida 🎉', format('Você chegou na meta “%s”.', g.name), '#/metas', jsonb_build_object('meta_id', g.id), 'meta:' || g.id
    from financial_goals g
    where g.user_id = o and g.status = 'ativa' and g.target_cents > 0 and g.current_cents >= g.target_cents
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  return v_n;
end $$;


create or replace function public.fe_notifications(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with n as (
    select x.*, case
        when x.type in ('pendente','vence') then exists (select 1 from transactions t where t.id = (x.data->>'tx_id')::uuid and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type))
        when x.type = 'renovar' then exists (select 1 from recurring_transactions r where r.id = (x.data->>'recorrencia_id')::uuid and r.end_date = (x.data->>'fim')::date and r.renew_dismissed_end is distinct from r.end_date)
        when x.type in ('acerto','acerto_vence','acerto_atraso') then exists (select 1 from transactions t where t.id = (x.data->>'tx_id')::uuid and t.deleted_at is null and t.settle_status = 'pendente')
        else true end as ativa
    from notifications x where x.user_id = p_user and x.created_at > now() - interval '90 days')
  select jsonb_build_object(
    'nao_lidas', (select count(*) from n where read_at is null and ativa),
    'itens', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'tipo', type, 'titulo', title, 'texto', body, 'link', link, 'dados', data,
        'criada_em', created_at, 'lida', read_at is not null, 'ativa', ativa) order by (read_at is null and ativa) desc, created_at desc)
      from (select * from n where ativa or created_at > now() - interval '7 days' order by created_at desc limit 40) z), '[]'))
$$;


revoke all on function public.fe_acerto_item(public.transactions, uuid) from public, anon, authenticated;
grant execute on function public.fe_acerto_item(public.transactions, uuid) to service_role;
