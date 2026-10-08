-- =====================================================================
-- Gastos divididos entre a família e acertos ("quem deve para quem")
--  * cartão também tem dono (como as contas)
--  * uma compra pode ser dividida em partes, uma por pessoa; cada parte pode sair de um cartão/conta diferente
--  * a parte de alguém paga com cartão/conta de OUTRA pessoa vira "a acertar" (deve para o dono do cartão/conta)
--  * acerto: "paguei" (gera a transferência entre as contas) ou "ok" (dispensa)
-- =====================================================================

alter table public.credit_cards add column if not exists member_id uuid references auth.users(id) on delete set null;
update public.credit_cards set member_id = user_id where member_id is null;

create table if not exists public.family_settlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,      -- titular da família
  debtor_id uuid not null references auth.users(id) on delete cascade,
  creditor_id uuid not null references auth.users(id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  date date not null,
  method text,
  status text not null check (status in ('pago','dispensado')),
  transfer_id uuid references public.transactions(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists family_settlements_idx on public.family_settlements(user_id, debtor_id, creditor_id);
alter table public.family_settlements enable row level security;
create policy "family rows" on public.family_settlements for select to authenticated using (user_id = (select public.my_owner()));
revoke all on public.family_settlements from anon, authenticated;
grant select on public.family_settlements to authenticated;

alter table public.transactions add column if not exists split_group uuid;
alter table public.transactions add column if not exists owed_to uuid references auth.users(id) on delete set null;
alter table public.transactions add column if not exists settle_status text check (settle_status in ('pendente','pago','dispensado'));
alter table public.transactions add column if not exists settlement_id uuid references public.family_settlements(id) on delete set null;
create index if not exists transactions_owed_idx on public.transactions(user_id, member_id, owed_to) where settle_status = 'pendente' and deleted_at is null;

-- valor em reais no padrão brasileiro (1.234,56), independente do idioma do servidor
create or replace function public.fe_fmt(v numeric) returns text
language sql immutable as $$ select translate(to_char(v, 'FM999,999,999,990.00'), ',.', '.,') $$;

-- pessoa informada num parâmetro: id | 'familia' (null) | vazio (quem está usando)
create or replace function public.fe_member_param(p_owner uuid, p_actor uuid, p_val text) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  if p_val = 'familia' then return null; end if;
  if nullif(p_val,'') is null then return p_actor; end if;
  select member_id into v from household_members where owner_id = p_owner and member_id = p_val::uuid;
  if v is null then perform fe_err('Pessoa não faz parte da família.'); end if;
  return v;
end $$;

-- lançamento em JSON: divisão e acerto
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.fe_tx_json(public.transactions)'::regprocedure) into v_src;
  v_src := replace(v_src, '''recorrencia_id'', t.recurring_id,',
    '''recorrencia_id'', t.recurring_id, ''divisao_id'', t.split_group, ''deve_para_id'', t.owed_to,
    ''deve_para'', (select name from profiles where id = t.owed_to), ''acerto'', t.settle_status,');
  if v_src not like '%deve_para_id%' then raise exception 'fe_tx_json inesperado'; end if;
  execute v_src;

  -- cartão: dono
  select pg_get_functiondef('public.fe_save_card(uuid,jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src, 'color = nullif(p->>''cor'','''')
      where id = v_old.id',
    'color = nullif(p->>''cor'',''''),
      member_id = case when p ? ''membro'' then fe_member_param(o, p_user, p->>''membro'') else member_id end
      where id = v_old.id');
  v_src := replace(v_src, 'insert into credit_cards(user_id, name, bank, brand, limit_cents, closing_day, due_day, payment_account_id, color)',
    'insert into credit_cards(user_id, name, bank, brand, limit_cents, closing_day, due_day, payment_account_id, color, member_id)');
  v_src := replace(v_src, '(p->>''fechamento'')::int, (p->>''vencimento'')::int, v_acc, nullif(p->>''cor'',''''))',
    '(p->>''fechamento'')::int, (p->>''vencimento'')::int, v_acc, nullif(p->>''cor'',''''), fe_member_param(o, p_user, p->>''membro''))');
  if v_src not like '%fe_member_param(o, p_user, p->>''membro''))%' or v_src not like '%member_id = case when p ? ''membro''%' then raise exception 'fe_save_card inesperado'; end if;
  execute v_src;

  select pg_get_functiondef('public.fe_cards(uuid,jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src, '''status'', r.status,', '''status'', r.status, ''membro_id'', r.member_id,
      ''membro'', case when r.member_id is null then ''Família'' else (select name from profiles where id = r.member_id) end,');
  if v_src not like '%''membro_id'', r.member_id%' then raise exception 'fe_cards inesperado'; end if;
  execute v_src;

  select pg_get_functiondef('public.app_bootstrap(jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src, '''vencimento'', due_day) order by name)', '''vencimento'', due_day, ''membro_id'', member_id) order by name)');
  if v_src not like '%''membro_id'', member_id) order by name)%' then raise exception 'app_bootstrap inesperado'; end if;
  execute v_src;

  -- painel: alertas de quem está usando; acertos da pessoa filtrada
  select pg_get_functiondef('public.fe_month_overview(uuid,jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src, 'v_f text := p->>''membro_id'';', 'v_f text := p->>''membro_id''; v_actor uuid := p_user;');
  v_src := replace(v_src, '''alertas'', fe_alerts(p_user),', '''alertas'', fe_alerts(v_actor),');
  v_src := replace(v_src, '''meta_economia_cents'', (select monthly_savings_goal_cents from profiles where id = p_user)',
    '''acertos_a_pagar_cents'', case when nullif(v_f,'''') is null or v_f = ''familia'' then 0 else coalesce((select sum(amount_cents) from transactions
        where user_id = p_user and deleted_at is null and settle_status = ''pendente'' and member_id = v_f::uuid and date <= v_fim), 0) end,
    ''acertos_a_receber_cents'', case when nullif(v_f,'''') is null or v_f = ''familia'' then 0 else coalesce((select sum(amount_cents) from transactions
        where user_id = p_user and deleted_at is null and settle_status = ''pendente'' and owed_to = v_f::uuid and date <= v_fim), 0) end,
    ''meta_economia_cents'', (select monthly_savings_goal_cents from profiles where id = p_user)');
  if v_src not like '%fe_alerts(v_actor)%' or v_src not like '%acertos_a_receber_cents%' then raise exception 'fe_month_overview inesperado'; end if;
  execute v_src;
end $$;

-- Faturas de uma pessoa = faturas dos cartões DELA (quem paga a fatura é o dono do cartão)
create or replace function public.fe_invoices_due_between(p_owner uuid, p_from date, p_to date, p_member text) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select case when nullif(p_member,'') is null then fe_invoices_due_between(p_owner, p_from, p_to) else
    coalesce(sum(greatest(tot - pago, 0)), 0)::bigint end
  from (
    select t.card_id, t.invoice_due,
      coalesce(sum(t.amount_cents) filter (where t.type in ('despesa','ajuste')), 0)
        - coalesce(sum(t.amount_cents) filter (where t.type = 'receita'), 0) tot,
      coalesce(sum(t.amount_cents) filter (where t.type = 'pagamento_fatura'), 0) pago
    from transactions t join credit_cards c on c.id = t.card_id
    where t.user_id = p_owner and t.deleted_at is null and t.invoice_due between p_from and p_to
      and fe_member_match(c.member_id, p_member)
    group by t.card_id, t.invoice_due) f
$$;

-- ---------------------------------------------------------------------
-- DIVISÃO DE UMA COMPRA
-- p: os campos de um lançamento (tipo, valor, data, descricao, estabelecimento, categoria..., parcelas)
--    + dividir: true (partes iguais entre todos, mesmo cartão/conta)  ou
--    + partes: [{membro_id, valor | valor_cents, cartao | cartao_id | cartao_do_membro, conta | conta_id}]
-- ---------------------------------------------------------------------
create or replace function public.fe_create_split(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_type text := lower(coalesce(p->>'tipo','despesa')); v_total bigint; v_parts jsonb := '[]';
  v_n int; part jsonb; v_sum bigint := 0; v_member uuid; v_card uuid; v_acc uuid; v_cards jsonb; v_res jsonb; v_out jsonb := '[]';
  v_group uuid := gen_random_uuid(); v_owner uuid; v_cat uuid; i int := 0; v_val bigint; v_base jsonb; v_nome text; v_first jsonb;
begin
  if v_type <> 'despesa' then perform fe_err('Só despesas podem ser divididas.'); end if;
  if p ? 'valor_cents' then v_total := (p->>'valor_cents')::bigint; else v_total := round(nullif(p->>'valor','')::numeric * 100); end if;
  if v_total is null or v_total <= 0 then return jsonb_build_object('status','needs_value'); end if;
  select count(*) into v_n from household_members where owner_id = o;
  if v_n < 2 then return jsonb_build_object('status','no_family'); end if;

  -- categoria: valida antes de gravar qualquer parte
  if nullif(p->>'categoria_id','') is null then
    select r.category_id into v_cat from fe_resolve_category(o, 'despesa', p->>'categoria', p->>'subcategoria', p->>'estabelecimento') r;
    if v_cat is null and not coalesce((p->>'permitir_sem_categoria')::boolean, false) then
      return jsonb_build_object('status','needs_category','tipo','despesa','valor_cents', v_total);
    end if;
  end if;

  -- partes
  if jsonb_typeof(p->'partes') = 'array' and jsonb_array_length(p->'partes') > 0 then
    v_parts := p->'partes';
  else
    select jsonb_agg(jsonb_build_object('membro_id', member_id) order by joined_at) into v_parts from household_members where owner_id = o;
  end if;
  v_n := jsonb_array_length(v_parts);
  -- valores: informados ou partes iguais (centavos que sobram na 1ª)
  for part in select * from jsonb_array_elements(v_parts) loop
    i := i + 1;
    v_val := coalesce((part->>'valor_cents')::bigint, round(nullif(part->>'valor','')::numeric * 100));
    if v_val is null then v_val := v_total / v_n + case when i = 1 then v_total % v_n else 0 end; end if;
    v_sum := v_sum + v_val;
    v_member := fe_member_param(o, p_user, part->>'membro_id');
    if v_member is null then perform fe_err('Cada parte precisa ser de uma pessoa.'); end if;
    v_nome := (select name from profiles where id = v_member);
    -- meio de pagamento da parte (ou o da compra)
    v_card := null; v_acc := null;
    if coalesce((part->>'cartao_do_membro')::boolean, false) then
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', name) order by created_at), '[]') into v_cards
        from credit_cards where user_id = o and status = 'ativo' and member_id = v_member;
      if jsonb_array_length(v_cards) = 0 then return jsonb_build_object('status','needs_member_card','membro', v_nome, 'membro_id', v_member); end if;
      if jsonb_array_length(v_cards) > 1 and fe_norm(part->>'cartao') is null then
        return jsonb_build_object('status','choose_member_card','membro', v_nome, 'membro_id', v_member, 'cartoes', (select jsonb_agg(x->'nome') from jsonb_array_elements(v_cards) x));
      end if;
      if fe_norm(part->>'cartao') is not null then v_card := fe_resolve_card(o, part->>'cartao');
      else v_card := (v_cards->0->>'id')::uuid; end if;
    elsif nullif(coalesce(part->>'cartao_id', p->>'cartao_id'),'') is not null or fe_norm(coalesce(part->>'cartao', p->>'cartao')) is not null then
      v_card := fe_resolve_card(o, coalesce(part->>'cartao', p->>'cartao'), nullif(coalesce(part->>'cartao_id', p->>'cartao_id'),'')::uuid);
      if v_card is null then
        return jsonb_build_object('status', case when (select count(*) from credit_cards where user_id = o and status = 'ativo') = 0 then 'no_cards' else 'unknown_card' end,
          'cartao', coalesce(part->>'cartao', p->>'cartao'),
          'cartoes', (select coalesce(jsonb_agg(name order by name), '[]') from credit_cards where user_id = o and status = 'ativo'));
      end if;
    elsif p->>'forma_pagamento' = 'credito' and nullif(coalesce(part->>'conta', p->>'conta', part->>'conta_id', p->>'conta_id'),'') is null then
      -- "no cartão" sem dizer qual: o cartão de quem está registrando, se só tiver um
      select coalesce(jsonb_agg(name order by name), '[]') into v_cards from credit_cards where user_id = o and status = 'ativo' and member_id = p_user;
      if jsonb_array_length(v_cards) = 1 then v_card := fe_resolve_card(o, v_cards->>0);
      else return jsonb_build_object('status','needs_card','cartoes', (select coalesce(jsonb_agg(name order by name), '[]') from credit_cards where user_id = o and status = 'ativo')); end if;
    elsif nullif(coalesce(part->>'conta_id', p->>'conta_id'),'') is not null then
      v_acc := fe_resolve_account(o, null, coalesce(part->>'conta_id', p->>'conta_id')::uuid);
    elsif fe_norm(coalesce(part->>'conta', p->>'conta')) is not null then
      v_acc := fe_resolve_account(o, coalesce(part->>'conta', p->>'conta'));
      if v_acc is null then return jsonb_build_object('status','unknown_account','conta', coalesce(part->>'conta', p->>'conta')); end if;
    end if;
    v_parts := jsonb_set(v_parts, array[(i-1)::text], part || jsonb_build_object('_m', v_member, '_v', v_val, '_card', v_card, '_acc', v_acc, '_nome', v_nome));
  end loop;
  if v_sum <> v_total then perform fe_err(format('As partes somam R$ %s, mas a compra é de R$ %s.', fe_fmt(v_sum/100.0), fe_fmt(v_total/100.0))); end if;

  -- grava cada parte (pelo motor normal) e marca quem deve para quem
  v_base := (p - 'partes' - 'dividir' - 'valor' - 'valor_cents' - 'cartao' - 'cartao_id' - 'conta' - 'conta_id' - 'membro_id' - 'familia' - 'forma_pagamento')
            || jsonb_build_object('forcar', true);
  for part in select * from jsonb_array_elements(v_parts) loop
    v_res := fe_create_transaction(p_user, v_base || jsonb_build_object('valor_cents', (part->>'_v')::bigint, 'membro_id', part->>'_m')
             || case when part->>'_card' is not null then jsonb_build_object('cartao_id', part->>'_card')
                     when part->>'_acc' is not null then jsonb_build_object('conta_id', part->>'_acc')
                     else jsonb_build_object('conta', null) end);
    if v_res->>'status' <> 'created' then perform fe_err('Não foi possível registrar a divisão (' || (v_res->>'status') || ').'); end if;
    if part->>'_card' is not null then select member_id into v_owner from credit_cards where id = (part->>'_card')::uuid;
    else select a.member_id into v_owner from accounts a join transactions t on t.account_id = a.id where t.id = (v_res->'ids'->>0)::uuid; end if;
    update transactions set split_group = v_group,
      owed_to = case when v_owner is not null and v_owner <> (part->>'_m')::uuid then v_owner end,
      settle_status = case when v_owner is not null and v_owner <> (part->>'_m')::uuid then 'pendente' end
      where id in (select (x #>> '{}')::uuid from jsonb_array_elements(v_res->'ids') x);
    v_out := v_out || jsonb_build_object('membro_id', part->>'_m', 'membro', part->>'_nome', 'valor_cents', (part->>'_v')::bigint,
      'cartao', v_res->>'cartao', 'conta', v_res->'lancamento'->>'conta', 'fatura', v_res->'fatura'->>'vencimento',
      'deve_para', case when v_owner is not null and v_owner <> (part->>'_m')::uuid then (select name from profiles where id = v_owner) end,
      'parcelas', v_res->'parcelas', 'lancamento', fe_tx_json((select t from transactions t where t.id = (v_res->'ids'->>0)::uuid)));
    if v_first is null then v_first := v_res; end if;
  end loop;
  return jsonb_build_object('status','created','divisao_id', v_group, 'valor_total_cents', v_total, 'partes', v_out,
    'categoria_origem', v_first->>'categoria_origem', 'parcelas', v_first->'parcelas', 'lancamento', v_first->'lancamento');
end $$;

-- ---------------------------------------------------------------------
-- ACERTOS
-- ---------------------------------------------------------------------
-- O que quem está usando deve e tem a receber (pendentes até o fim do mês informado; padrão: mês atual)
create or replace function public.fe_debts(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_fim date;
begin
  select fim into v_fim from fe_month_bounds(p->>'mes', o);
  return (with x as (
      select t.id, t.amount_cents, t.date, case when t.member_id = p_user then 'devo' else 'recebo' end lado,
             case when t.member_id = p_user then t.owed_to else t.member_id end outro
      from transactions t
      where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and t.date <= v_fim
        and (t.member_id = p_user or t.owed_to = p_user))
    select jsonb_build_object('ate', v_fim,
      'devo', coalesce((select jsonb_agg(g order by g->>'pessoa') from (
          select jsonb_build_object('pessoa_id', outro, 'pessoa', (select name from profiles where id = outro), 'total_cents', sum(amount_cents),
            'itens', jsonb_agg(fe_tx_json((select t2 from transactions t2 where t2.id = x.id)) order by date)) g from x where lado = 'devo' group by outro) a), '[]'),
      'recebo', coalesce((select jsonb_agg(g order by g->>'pessoa') from (
          select jsonb_build_object('pessoa_id', outro, 'pessoa', (select name from profiles where id = outro), 'total_cents', sum(amount_cents),
            'itens', jsonb_agg(fe_tx_json((select t2 from transactions t2 where t2.id = x.id)) order by date)) g from x where lado = 'recebo' group by outro) a), '[]'),
      'futuro_cents', (select coalesce(sum(amount_cents), 0) from transactions t where t.user_id = o and t.deleted_at is null
          and t.settle_status = 'pendente' and t.date > v_fim and (t.member_id = p_user or t.owed_to = p_user))));
end $$;

-- Acertar com uma pessoa. p: pessoa_id (a outra pessoa), acao 'pago' | 'dispensar', data, forma (pix, dinheiro, transferencia...),
--   conta_origem_id (de quem paga), conta_destino_id (de quem recebe), mes (padrão: atual)
create or replace function public.fe_settle(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_other uuid; v_debtor uuid; v_creditor uuid; v_fim date; v_total bigint; v_set family_settlements;
  v_from uuid; v_to uuid; v_tr jsonb; v_acao text := coalesce(nullif(p->>'acao',''), 'pago'); v_date date;
begin
  v_other := fe_member_param(o, p_user, p->>'pessoa_id');
  if v_other is null or v_other = p_user then perform fe_err('Informe com quem é o acerto.'); end if;
  select fim into v_fim from fe_month_bounds(p->>'mes', o);
  v_date := coalesce(nullif(p->>'data','')::date, fe_today(p_user));
  -- quem deve para quem (se os dois devem, acerta o saldo líquido)
  select coalesce(sum(case when member_id = p_user then amount_cents else -amount_cents end), 0) into v_total
    from transactions where user_id = o and deleted_at is null and settle_status = 'pendente' and date <= v_fim
      and ((member_id = p_user and owed_to = v_other) or (member_id = v_other and owed_to = p_user));
  if v_total = 0 then return jsonb_build_object('status','nothing'); end if;
  if v_total > 0 then v_debtor := p_user; v_creditor := v_other; else v_debtor := v_other; v_creditor := p_user; v_total := -v_total; end if;
  if v_acao not in ('pago','dispensar') then perform fe_err('Ação inválida.'); end if;
  insert into family_settlements(user_id, debtor_id, creditor_id, amount_cents, date, method, status, created_by)
    values (o, v_debtor, v_creditor, v_total, v_date, nullif(p->>'forma',''), case when v_acao = 'pago' then 'pago' else 'dispensado' end, p_user)
    returning * into v_set;
  update transactions set settle_status = v_set.status, settlement_id = v_set.id, updated_at = now()
    where user_id = o and deleted_at is null and settle_status = 'pendente' and date <= v_fim
      and ((member_id = v_debtor and owed_to = v_creditor) or (member_id = v_creditor and owed_to = v_debtor));
  -- pagamento: transferência da conta de quem pagou para a de quem recebeu (não é despesa nova)
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
  return jsonb_build_object('status', v_set.status, 'valor_cents', v_total,
    'devedor', (select name from profiles where id = v_debtor), 'credor', (select name from profiles where id = v_creditor),
    'eu_devia', v_debtor = p_user, 'transferencia', v_tr is not null,
    'conta_origem', (select name from accounts where id = v_from), 'conta_destino', (select name from accounts where id = v_to));
end $$;

-- alerta do acerto (para quem deve)
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.fe_alerts(uuid,jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src, '  return v;
end',
    '  for r in select (select name from profiles where id = t.owed_to) nome, sum(t.amount_cents) tot from transactions t
           where t.user_id = o and t.deleted_at is null and t.settle_status = ''pendente'' and t.member_id = p_user
             and t.date <= (date_trunc(''month'', v_today) + interval ''1 month'' - interval ''1 day'')::date
           group by t.owed_to loop
    v := v || jsonb_build_object(''tipo'',''acerto'',''nivel'',''medio'',''icone'',''🤝'',
      ''texto'', format(''Você tem R$ %s de gastos divididos para acertar com %s.'', fe_fmt(r.tot/100.0), r.nome));
  end loop;
  return v;
end');
  v_src := replace(v_src, 'to_char((r.x->>''gasto_cents'')::numeric/100, ''FM999G999G990D00'')', 'fe_fmt((r.x->>''gasto_cents'')::numeric/100)');
  v_src := replace(v_src, 'to_char((r.x->>''limite_cents'')::numeric/100, ''FM999G999G990D00'')', 'fe_fmt((r.x->>''limite_cents'')::numeric/100)');
  v_src := replace(v_src, 'to_char((r.inv->>''restante_cents'')::numeric/100, ''FM999G999G990D00'')', 'fe_fmt((r.inv->>''restante_cents'')::numeric/100)');
  if v_src not like '%tipo'',''acerto''%' or v_src like '%FM999G999G990D00%' then raise exception 'fe_alerts inesperado'; end if;
  execute v_src;
end $$;

-- Detalhe dos painéis do Início
-- p: painel (receitas|despesas|saldo|compromissos|faturas|previstas|investimentos), mes, membro_id
create or replace function public.fe_kpi_detail(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_ini date; v_fim date; v_today date := fe_today(p_user); v_f text := p->>'membro_id'; v_k text := p->>'painel';
  v_txs jsonb := '[]'; v_fat jsonb := '[]';
begin
  select inicio, fim into v_ini, v_fim from fe_month_bounds(p->>'mes', o);
  if v_k in ('receitas','despesas','previstas','investimentos','compromissos') then
    select coalesce(jsonb_agg(fe_tx_json(t) order by t.date desc, t.amount_cents desc), '[]') into v_txs from transactions t
      where t.user_id = o and t.deleted_at is null and t.date between v_ini and v_fim and fe_member_match(t.member_id, v_f)
        and case v_k
          when 'receitas' then t.type = 'receita' and t.date <= v_today
          when 'despesas' then t.type = 'despesa' and t.date <= v_today
          when 'previstas' then t.type = 'receita' and t.date > v_today
          when 'investimentos' then t.type in ('investimento','resgate') and t.date <= v_today
          when 'compromissos' then t.type = 'despesa' and t.date > v_today and t.card_id is null end;
  end if;
  if v_k in ('faturas','compromissos') and v_fim >= v_today then
    select coalesce(jsonb_agg(fe_invoice_json(o, z.card_id, z.invoice_due) || jsonb_build_object('cartao', c.name, 'cor', c.color) order by z.invoice_due), '[]')
      into v_fat
      from (select distinct card_id, invoice_due from transactions t
             where t.user_id = o and t.deleted_at is null and t.card_id is not null and t.invoice_due between greatest(v_ini, v_today) and v_fim) z
      join credit_cards c on c.id = z.card_id
      where (nullif(v_f,'') is null or fe_member_match(c.member_id, v_f))
        and (fe_invoice_json(o, z.card_id, z.invoice_due)->>'restante_cents')::bigint > 0;
  end if;
  return jsonb_build_object('painel', v_k, 'inicio', v_ini, 'fim', v_fim, 'lancamentos', v_txs, 'faturas', v_fat,
    'contas', case when v_k = 'saldo' then fe_balances(o, jsonb_build_object('membro_id', v_f))->'contas' end);
end $$;

-- API do app
create or replace function public.app_kpi_detail(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_kpi_detail(app_uid(), p) $$;
create or replace function public.app_debts(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_debts(app_uid(), p) $$;
create or replace function public.app_settle(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_settle(app_uid(), p || '{"origem":"app_form"}') $$;
create or replace function public.app_save_split(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_create_split(app_uid(), (p - 'origem') || '{"origem":"app_form"}') $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('fe_fmt','fe_member_param','fe_create_split','fe_debts','fe_settle','fe_kpi_detail',
             'app_kpi_detail','app_debts','app_settle','app_save_split')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to %s', r.sig, case when r.proname like 'app\_%' then 'authenticated' else 'service_role' end);
  end loop;
end $$;

-- "algo mudou": acertos também
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.app_changes(jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src, '(select concat(count(*), max(created_at), max(deleted_at)) from goal_contributions where user_id = app_owner())',
    '(select concat(count(*), max(created_at), max(deleted_at)) from goal_contributions where user_id = app_owner()), ''|'',
       (select concat(count(*), max(created_at)) from family_settlements where user_id = app_owner()), ''|'',
       (select string_agg(concat(id, member_id), '','' order by id) from credit_cards where user_id = app_owner())');
  execute v_src;
end $$;
