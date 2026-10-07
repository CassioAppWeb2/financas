-- =====================================================================
-- FASE 2 — CARTÕES DE CRÉDITO
--  * compra no cartão NÃO mexe no saldo da conta; entra na fatura
--  * fatura é identificada pela data de VENCIMENTO
--  * compra até o dia anterior ao fechamento cai na fatura que fecha naquele mês;
--    no dia do fechamento ou depois, na fatura seguinte
--  * pagamento de fatura sai da conta (tipo pagamento_fatura) e não conta como despesa
-- =====================================================================

-- Data segura: dia d do mês de "ref" (limitado ao último dia do mês)
create or replace function public.fe_day_in_month(p_ref date, p_day int) returns date
language sql immutable as $$
  select (date_trunc('month', p_ref) + make_interval(days => least(p_day,
    extract(day from (date_trunc('month', p_ref) + interval '1 month' - interval '1 day'))::int) - 1))::date
$$;

-- n-ésimo dia útil (segunda a sexta) do mês de p_ref
create or replace function public.fe_business_day(p_ref date, p_n int) returns date
language plpgsql immutable as $$
declare d date := date_trunc('month', p_ref)::date; c int := 0;
begin
  for i in 1..40 loop
    if extract(isodow from d) < 6 then c := c + 1; if c >= p_n then return d; end if; end if;
    d := d + 1;
  end loop;
  return d;
end $$;

-- Vencimento da fatura em que cai uma compra feita em p_date
create or replace function public.fe_invoice_due(p_card uuid, p_date date) returns date
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c credit_cards; v_close date;
begin
  select * into c from credit_cards where id = p_card;
  if c.id is null then return null; end if;
  v_close := fe_day_in_month(p_date, coalesce(c.closing_day, 1));
  if p_date >= v_close then v_close := fe_day_in_month((p_date + interval '1 month')::date, coalesce(c.closing_day, 1)); end if;
  if coalesce(c.due_day, 10) > coalesce(c.closing_day, 1) then
    return fe_day_in_month(v_close, coalesce(c.due_day, 10));
  end if;
  return fe_day_in_month((v_close + interval '1 month')::date, coalesce(c.due_day, 10));
end $$;

-- Data de fechamento de uma fatura (a partir do vencimento)
create or replace function public.fe_invoice_closing(p_card uuid, p_due date) returns date
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c credit_cards;
begin
  select * into c from credit_cards where id = p_card;
  if coalesce(c.due_day, 10) > coalesce(c.closing_day, 1) then return fe_day_in_month(p_due, coalesce(c.closing_day, 1)); end if;
  return fe_day_in_month((p_due - interval '1 month')::date, coalesce(c.closing_day, 1));
end $$;

-- Localiza um cartão por id ou nome (aceita "nubank", "cartão do itaú"...)
create or replace function public.fe_resolve_card(p_owner uuid, p_name text, p_id uuid default null) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid; n text := fe_norm(regexp_replace(coalesce(p_name,''), '(?i)^(o |a )?(meu |minha )?(cart[aã]o|credito|crédito)( de credito| de crédito)?( do| da| de)?\s*', ''));
begin
  if p_id is not null then
    select id into v from credit_cards where id = p_id and user_id = p_owner and status = 'ativo';
    if v is null then perform fe_err('Cartão não encontrado.'); end if;
    return v;
  end if;
  if n is null then return null; end if;
  select id into v from credit_cards
    where user_id = p_owner and status = 'ativo'
      and (fe_norm(name) = n or fe_norm(bank) = n or fe_norm(name) like '%' || n || '%' or n like '%' || fe_norm(name) || '%')
    order by (fe_norm(name) = n) desc, created_at limit 1;
  return v;
end $$;

-- Total, pago e situação de uma fatura
create or replace function public.fe_invoice_json(p_owner uuid, p_card uuid, p_due date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with x as (
    select coalesce(sum(amount_cents) filter (where type in ('despesa','ajuste')), 0)
         - coalesce(sum(amount_cents) filter (where type = 'receita'), 0) as total,
           coalesce(sum(amount_cents) filter (where type = 'pagamento_fatura'), 0) as pago,
           count(*) filter (where type <> 'pagamento_fatura') as itens
    from transactions where user_id = p_owner and card_id = p_card and invoice_due = p_due and deleted_at is null
  )
  select jsonb_build_object(
    'cartao_id', p_card, 'vencimento', p_due, 'fechamento', fe_invoice_closing(p_card, p_due),
    'total_cents', x.total, 'pago_cents', x.pago, 'restante_cents', greatest(x.total - x.pago, 0), 'itens', x.itens,
    'situacao', case
      when x.total <= 0 and x.pago = 0 then 'vazia'
      when x.pago >= x.total then 'paga'
      when fe_today(p_owner) >= fe_invoice_closing(p_card, p_due) and fe_today(p_owner) > p_due then 'vencida'
      when fe_today(p_owner) >= fe_invoice_closing(p_card, p_due) then 'fechada'
      else 'aberta' end)
  from x
$$;

-- Lista de cartões com limite, fatura atual e próximas faturas
create or replace function public.fe_cards(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_today date := fe_today(p_user); r record; v_out jsonb := '[]';
  v_used bigint; v_cur date; v_prev date; v_next jsonb;
begin
  for r in select * from credit_cards where user_id = o and (status = 'ativo' or coalesce((p->>'todos')::boolean,false))
           order by status, created_at loop
    select coalesce(sum(amount_cents) filter (where type in ('despesa','ajuste')), 0)
         - coalesce(sum(amount_cents) filter (where type in ('receita','pagamento_fatura')), 0)
      into v_used from transactions where user_id = o and card_id = r.id and deleted_at is null;
    v_cur := fe_invoice_due(r.id, v_today);
    v_prev := fe_day_in_month((v_cur - interval '1 month')::date, coalesce(r.due_day, 10));
    select coalesce(jsonb_agg(fe_invoice_json(o, r.id, d) order by d), '[]') into v_next
      from (select distinct invoice_due d from transactions
             where user_id = o and card_id = r.id and deleted_at is null and invoice_due > v_cur
             order by 1 limit 12) z;
    v_out := v_out || jsonb_build_object(
      'id', r.id, 'nome', r.name, 'banco', r.bank, 'bandeira', r.brand, 'cor', r.color,
      'limite_cents', r.limit_cents, 'fechamento', r.closing_day, 'vencimento', r.due_day,
      'conta_pagamento_id', r.payment_account_id, 'conta_pagamento', (select name from accounts where id = r.payment_account_id),
      'status', r.status,
      'usado_cents', greatest(v_used, 0),
      'disponivel_cents', case when r.limit_cents is not null then r.limit_cents - greatest(v_used, 0) end,
      'fatura_atual', fe_invoice_json(o, r.id, v_cur),
      'fatura_anterior', fe_invoice_json(o, r.id, v_prev),
      'proximas', v_next);
  end loop;
  return v_out;
end $$;

-- Itens de uma fatura
create or replace function public.fe_card_invoice(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_card uuid; v_due date;
begin
  v_card := fe_resolve_card(o, p->>'cartao', nullif(p->>'cartao_id','')::uuid);
  if v_card is null then return jsonb_build_object('status','unknown_card'); end if;
  v_due := coalesce(nullif(p->>'vencimento','')::date, fe_invoice_due(v_card, fe_today(p_user)));
  return jsonb_build_object('status','ok', 'cartao', (select name from credit_cards where id = v_card),
    'fatura', fe_invoice_json(o, v_card, v_due),
    'itens', coalesce((select jsonb_agg(fe_tx_json(t) order by t.date, t.created_at) from transactions t
       where t.user_id = o and t.card_id = v_card and t.invoice_due = v_due and t.deleted_at is null), '[]'));
end $$;

-- Criar/editar cartão
create or replace function public.fe_save_card(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_id uuid; v_acc uuid; v_old credit_cards;
begin
  if fe_norm(p->>'nome') is null then perform fe_err('Informe o nome do cartão.'); end if;
  if coalesce(nullif(p->>'fechamento','')::int, 0) not between 1 and 31 then perform fe_err('Dia de fechamento deve ser entre 1 e 31.'); end if;
  if coalesce(nullif(p->>'vencimento','')::int, 0) not between 1 and 31 then perform fe_err('Dia de vencimento deve ser entre 1 e 31.'); end if;
  if nullif(p->>'conta_pagamento_id','') is not null then v_acc := fe_resolve_account(o, null, (p->>'conta_pagamento_id')::uuid);
  else v_acc := fe_resolve_account(o, p->>'conta_pagamento'); end if;
  if nullif(p->>'id','') is not null then
    select * into v_old from credit_cards where id = (p->>'id')::uuid and user_id = o;
    if v_old.id is null then perform fe_err('Cartão não encontrado.'); end if;
    update credit_cards set name = left(trim(p->>'nome'), 40), bank = nullif(trim(p->>'banco'),''), brand = nullif(trim(p->>'bandeira'),''),
      limit_cents = case when nullif(p->>'limite','') is null then null else round((p->>'limite')::numeric * 100) end,
      closing_day = (p->>'fechamento')::int, due_day = (p->>'vencimento')::int, payment_account_id = v_acc,
      color = nullif(p->>'cor','')
      where id = v_old.id returning id into v_id;
    -- dias mudaram: recalcula as faturas das compras ainda não fechadas
    if v_old.closing_day is distinct from (p->>'fechamento')::int or v_old.due_day is distinct from (p->>'vencimento')::int then
      update transactions set invoice_due = fe_invoice_due(v_id, date), updated_at = now()
        where card_id = v_id and deleted_at is null and type <> 'pagamento_fatura' and date >= fe_today(p_user) - 40;
    end if;
  else
    insert into credit_cards(user_id, name, bank, brand, limit_cents, closing_day, due_day, payment_account_id, color)
      values (o, left(trim(p->>'nome'), 40), nullif(trim(p->>'banco'),''), nullif(trim(p->>'bandeira'),''),
        case when nullif(p->>'limite','') is null then null else round((p->>'limite')::numeric * 100) end,
        (p->>'fechamento')::int, (p->>'vencimento')::int, v_acc, nullif(p->>'cor',''))
      returning id into v_id;
  end if;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'credit_card', v_id, case when v_old.id is null then 'create' else 'update' end, p, coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','saved','id', v_id);
end $$;

-- Pagar fatura (total ou parcial)
-- p: cartao | cartao_id, vencimento (opcional), valor (opcional = restante), conta | conta_id, data
create or replace function public.fe_pay_invoice(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_card uuid; v_due date; v_inv jsonb; v_val bigint; v_acc uuid; v_tx transactions;
  v_today date := fe_today(p_user); c credit_cards;
begin
  v_card := fe_resolve_card(o, p->>'cartao', nullif(p->>'cartao_id','')::uuid);
  if v_card is null then
    if (select count(*) from credit_cards where user_id = o and status = 'ativo') = 1 and fe_norm(p->>'cartao') is null then
      select id into v_card from credit_cards where user_id = o and status = 'ativo';
    else
      return jsonb_build_object('status', case when fe_norm(p->>'cartao') is null then 'needs_card' else 'unknown_card' end,
        'cartoes', (select coalesce(jsonb_agg(name order by name), '[]') from credit_cards where user_id = o and status = 'ativo'));
    end if;
  end if;
  select * into c from credit_cards where id = v_card;
  if nullif(p->>'vencimento','') is not null then v_due := (p->>'vencimento')::date;
  else
    -- a fatura mais antiga ainda não paga (fechada); se não houver, a atual
    select d into v_due from (select distinct invoice_due d from transactions
       where user_id = o and card_id = v_card and deleted_at is null and type <> 'pagamento_fatura') z
      where (fe_invoice_json(o, v_card, d)->>'restante_cents')::bigint > 0
      order by d limit 1;
    v_due := coalesce(v_due, fe_invoice_due(v_card, v_today));
  end if;
  v_inv := fe_invoice_json(o, v_card, v_due);
  if p ? 'valor_cents' then v_val := (p->>'valor_cents')::bigint;
  elsif nullif(p->>'valor','') is not null then v_val := round((p->>'valor')::numeric * 100);
  else v_val := (v_inv->>'restante_cents')::bigint; end if;
  if v_val is null or v_val <= 0 then return jsonb_build_object('status','nothing_to_pay','fatura', v_inv, 'cartao', c.name); end if;
  if nullif(p->>'conta_id','') is not null then v_acc := fe_resolve_account(o, null, (p->>'conta_id')::uuid);
  elsif fe_norm(p->>'conta') is not null then
    v_acc := fe_resolve_account(o, p->>'conta');
    if v_acc is null then return jsonb_build_object('status','unknown_account','conta', p->>'conta'); end if;
  else v_acc := coalesce(c.payment_account_id, fe_resolve_account(o, null)); end if;
  insert into transactions(user_id, member_id, created_by, type, amount_cents, date, description, account_id, card_id,
      invoice_due, status, origin, original_message)
    values (o, null, p_user, 'pagamento_fatura', v_val, coalesce(nullif(p->>'data','')::date, v_today),
      'Pagamento fatura ' || c.name || ' (venc. ' || to_char(v_due, 'DD/MM') || ')', v_acc, v_card, v_due,
      'efetivado', coalesce(nullif(p->>'origem',''),'app_form'), left(p->>'mensagem_original', 2000))
    returning * into v_tx;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'transaction', v_tx.id, 'create', fe_tx_json(v_tx), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','paid', 'cartao', c.name, 'valor_cents', v_val,
    'conta', (select name from accounts where id = v_acc), 'fatura', fe_invoice_json(o, v_card, v_due), 'lancamento', fe_tx_json(v_tx));
end $$;

-- Arquivar cartão (o histórico continua)
create or replace function public.fe_archive_card(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user);
begin
  update credit_cards set status = case when coalesce((p->>'reativar')::boolean,false) then 'ativo' else 'arquivado' end
    where id = (p->>'id')::uuid and user_id = o;
  if not found then perform fe_err('Cartão não encontrado.'); end if;
  return jsonb_build_object('status','ok');
end $$;
