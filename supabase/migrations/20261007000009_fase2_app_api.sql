-- =====================================================================
-- FASE 2 — API do aplicativo (usuário logado; sempre auth.uid())
-- =====================================================================

-- Bootstrap: gera recorrências pendentes e devolve cartões e metas
create or replace function public.app_bootstrap(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); o uuid := fe_owner(app_uid());
begin
  perform fe_run_recurring(o);
  return jsonb_build_object(
    'perfil', (select jsonb_build_object('id', u, 'nome', name, 'timezone', timezone,
               'meta_economia_cents', (select monthly_savings_goal_cents from profiles where id = o))
               from profiles where id = u),
    'familia', jsonb_build_object(
      'titular', o = u,
      'membros', coalesce((select jsonb_agg(jsonb_build_object('id', hm.member_id, 'nome', coalesce(pr.name, 'Membro'),
          'papel', hm.role, 'eu', hm.member_id = u) order by hm.joined_at)
          from household_members hm left join profiles pr on pr.id = hm.member_id where hm.owner_id = o), '[]')),
    'telegram', (select jsonb_build_object('conectado', true, 'usuario', username) from telegram_connections where user_id = u and chat_id not like 'desvinculado-%'),
    'hoje', fe_today(u),
    'contas', fe_balances(u),
    'cartoes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nome', name, 'cor', color, 'fechamento', closing_day, 'vencimento', due_day) order by name)
        from credit_cards where user_id = o and status = 'ativo'), '[]'),
    'metas', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nome', name) order by created_at)
        from financial_goals where user_id = o and status = 'ativa'), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.kind, 'nome', c.name, 'icone', c.icon,
        'sistema', c.is_system,
        'subcategorias', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.name) order by s.name)
                                   from subcategories s where s.category_id = c.id and s.archived_at is null), '[]'))
        order by c.kind, (c.name = 'Outros'), c.name) from categories c where c.user_id = o and c.archived_at is null), '[]'),
    'whatsapp', (select jsonb_build_object('status', status,
        'telefone_final', case when phone_number is not null then right(phone_number, 4) end)
        from whatsapp_connections where user_id = u));
end $$;

-- Lançamentos: filtro por cartão e por fatura
create or replace function public.app_transactions(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v_ini date; v_fim date; v_q text := fe_norm(p->>'busca');
begin
  select inicio, fim into v_ini, v_fim from fe_month_bounds(p->>'mes', u);
  return jsonb_build_object('inicio', v_ini, 'fim', v_fim, 'itens', coalesce((
    select jsonb_agg(fe_tx_json(t) order by t.date desc, t.created_at desc) from (
      select t.* from transactions t
      where t.user_id = u and t.deleted_at is null and t.date between v_ini and v_fim
        and (nullif(p->>'tipo','') is null or t.type = p->>'tipo')
        and (nullif(p->>'categoria_id','') is null or t.category_id = (p->>'categoria_id')::uuid)
        and (nullif(p->>'conta_id','') is null or t.account_id = (p->>'conta_id')::uuid or t.transfer_account_id = (p->>'conta_id')::uuid)
        and (nullif(p->>'cartao_id','') is null or t.card_id = (p->>'cartao_id')::uuid)
        and (v_q is null or fe_norm(t.description) like '%' || v_q || '%')
        and fe_member_match(t.member_id, p->>'membro_id')
      order by t.date desc, t.created_at desc
      limit least(coalesce(nullif(p->>'limite','')::int, 500), 1000)) t), '[]'));
end $$;

-- Cartões
create or replace function public.app_cards(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_cards(app_uid(), p) $$;
create or replace function public.app_save_card(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_save_card(app_uid(), p || '{"origem":"app_form"}') $$;
create or replace function public.app_archive_card(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_archive_card(app_uid(), p) $$;
create or replace function public.app_card_invoice(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_card_invoice(app_uid(), p) $$;
create or replace function public.app_pay_invoice(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_pay_invoice(app_uid(), p || '{"origem":"app_form"}') $$;

-- Recorrências
create or replace function public.app_recurrings(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform fe_run_recurring(app_owner()); return fe_recurrings(app_uid(), p); end $$;
create or replace function public.app_save_recurring(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p->>'membro' = 'familia' then p := p || '{"familia":true}';
  elsif nullif(p->>'membro','') is not null then p := p || jsonb_build_object('membro_id', p->>'membro'); end if;
  return fe_save_recurring(app_uid(), (p - 'membro') || '{"origem":"app_form"}');
end $$;
create or replace function public.app_cancel_recurring(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_cancel_recurring(app_uid(), p || '{"origem":"app_form"}') $$;

-- Metas
create or replace function public.app_goals(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_goals(app_uid(), p) $$;
create or replace function public.app_save_goal(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_save_goal(app_uid(), p || '{"origem":"app_form"}') $$;
create or replace function public.app_goal_contribute(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_goal_contribute(app_uid(), p || '{"origem":"app_form"}') $$;
create or replace function public.app_archive_goal(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_archive_goal(app_uid(), p) $$;
create or replace function public.app_remove_contribution(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update goal_contributions set deleted_at = now() where id = (p->>'id')::uuid and user_id = app_owner() and deleted_at is null;
  if not found then perform fe_err('Aporte não encontrado.'); end if;
  return jsonb_build_object('status','ok');
end $$;

-- Orçamentos
create or replace function public.app_budgets(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_budgets(app_uid(), p) $$;
create or replace function public.app_set_budget(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_set_budget(app_uid(), p || '{"origem":"app_form"}') $$;

-- Alertas e relatórios
create or replace function public.app_alerts(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_alerts(app_uid(), p) $$;
create or replace function public.app_report(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_report(app_uid(), p) $$;

-- ---------------------------------------------------------------------
-- IMPORTAÇÃO DE EXTRATO (OFX/CSV lidos no navegador)
-- p: conta_id | cartao_id, confirmar (false = só prévia),
--    itens: [{data, valor (negativo = saída), descricao, id_externo, categoria_id?, ignorar?}]
-- Duplicidade: mesmo id externo, ou mesmo valor e data (±2 dias) com descrição parecida / sem descrição
-- ---------------------------------------------------------------------
create or replace function public.app_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); o uuid := fe_owner(app_uid()); v_acc uuid; v_card uuid; it jsonb; v_out jsonb := '[]';
  v_val bigint; v_date date; v_desc text; v_type text; v_dup uuid; v_cat uuid; v_sub uuid; v_src text; r jsonb;
  v_conf boolean := coalesce((p->>'confirmar')::boolean, false); v_new int := 0; v_skip int := 0; i int := 0;
begin
  if nullif(p->>'cartao_id','') is not null then v_card := fe_resolve_card(o, null, (p->>'cartao_id')::uuid);
  else v_acc := fe_resolve_account(o, null, nullif(p->>'conta_id','')::uuid); end if;
  if jsonb_array_length(coalesce(p->'itens','[]')) > 2000 then perform fe_err('Arquivo grande demais (máximo 2.000 linhas).'); end if;
  for it in select * from jsonb_array_elements(coalesce(p->'itens','[]')) loop
    i := i + 1;
    begin
      v_date := (it->>'data')::date;
      v_val := round((it->>'valor')::numeric * 100);
    exception when others then
      v_out := v_out || jsonb_build_object('linha', i, 'situacao', 'invalida'); continue;
    end;
    if v_val is null or v_val = 0 or v_date is null then v_out := v_out || jsonb_build_object('linha', i, 'situacao', 'invalida'); continue; end if;
    v_desc := left(coalesce(nullif(trim(it->>'descricao'),''), 'Importado'), 120);
    -- no cartão, valores positivos no extrato da fatura costumam ser compras
    v_type := case when v_card is not null then case when v_val > 0 then 'despesa' else 'receita' end
                   else case when v_val < 0 then 'despesa' else 'receita' end end;
    if v_card is not null and v_type = 'receita' and fe_norm(v_desc) ~ '(pagamento|pgto|pag fatura)' then
      v_out := v_out || jsonb_build_object('linha', i, 'situacao', 'pagamento', 'data', v_date, 'valor_cents', abs(v_val), 'descricao', v_desc);
      continue;
    end if;
    v_val := abs(v_val);
    select t.id into v_dup from transactions t
      where t.user_id = o and t.deleted_at is null
        and ((nullif(it->>'id_externo','') is not null and t.external_id = it->>'id_externo')
             or (t.amount_cents = v_val and t.type = v_type and abs(t.date - v_date) <= 2
                 and (v_card is null or t.card_id = v_card) and (v_acc is null or t.account_id = v_acc or t.account_id is null)
                 and (similarity_ok(t.description, v_desc) or t.origin <> 'importacao')))
      order by abs(t.date - v_date) limit 1;
    select r2.category_id, r2.subcategory_id, r2.source into v_cat, v_sub, v_src
      from fe_resolve_category(o, v_type, null, null, v_desc) r2;
    if nullif(it->>'categoria_id','') is not null then v_cat := (it->>'categoria_id')::uuid; v_sub := null; v_src := 'informada'; end if;
    if v_cat is null then
      select id into v_cat from categories where user_id = o and kind = v_type and fe_norm(name) = 'outros' and archived_at is null;
      v_sub := null; v_src := 'padrao';
    end if;
    r := jsonb_build_object('linha', i, 'data', v_date, 'valor_cents', v_val, 'tipo', v_type, 'descricao', v_desc,
      'categoria_id', v_cat, 'categoria', (select name from categories where id = v_cat), 'categoria_origem', v_src,
      'situacao', case when v_dup is not null then 'duplicada' else 'nova' end, 'duplicada_de', case when v_dup is not null then fe_tx_json((select t from transactions t where t.id = v_dup)) end);
    if v_conf and v_dup is null and not coalesce((it->>'ignorar')::boolean, false) then
      r := r || jsonb_build_object('resultado', fe_create_transaction(u, jsonb_build_object(
        'tipo', v_type, 'valor_cents', v_val, 'data', v_date, 'descricao', v_desc, 'estabelecimento', v_desc,
        'categoria_id', v_cat, 'subcategoria_id', v_sub, 'conta_id', v_acc, 'cartao_id', v_card,
        'permitir_sem_categoria', true, 'forcar', true, 'origem', 'importacao', 'id_externo', nullif(it->>'id_externo',''))) ->> 'status');
      v_new := v_new + 1;
    elsif v_conf then v_skip := v_skip + 1;
    end if;
    v_out := v_out || r;
  end loop;
  return jsonb_build_object('status', case when v_conf then 'imported' else 'preview' end, 'itens', v_out,
    'importados', v_new, 'ignorados', v_skip);
end $$;

-- descrições "parecidas" para a checagem de duplicidade da importação
create or replace function public.similarity_ok(a text, b text) returns boolean
language sql immutable as $$
  select fe_norm(a) = fe_norm(b)
      or position(left(coalesce(fe_norm(a),''), 8) in coalesce(fe_norm(b),'')) > 0
      or position(left(coalesce(fe_norm(b),''), 8) in coalesce(fe_norm(a),'')) > 0
$$;

-- Permissões: fe_* só o servidor; app_* só usuários logados
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'fe\_%' or p.proname like 'app\_%' or p.proname = 'similarity_ok')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    if r.proname like 'app\_%' then
      execute format('grant execute on function %s to authenticated', r.sig);
    else
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end $$;

-- "Impressão digital" agora também acompanha cartões, metas, orçamentos e recorrências
create or replace function public.app_changes(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'lancamentos', (select concat(count(*) filter (where deleted_at is null), '|',
                                  extract(epoch from greatest(max(created_at), max(updated_at), max(deleted_at))))
                      from transactions where user_id = app_owner()),
    'cadastros', md5(concat(
       (select string_agg(concat(id, name, status, initial_balance_cents), ',' order by id) from accounts where user_id = app_owner()), '|',
       (select string_agg(concat(id, name, icon, archived_at), ',' order by id) from categories where user_id = app_owner()), '|',
       (select string_agg(concat(id, name, archived_at), ',' order by id) from subcategories where user_id = app_owner()), '|',
       (select string_agg(member_id::text, ',' order by member_id) from household_members where owner_id = app_owner()), '|',
       (select string_agg(concat(id, name, status, limit_cents, closing_day, due_day), ',' order by id) from credit_cards where user_id = app_owner()), '|',
       (select string_agg(concat(id, status, updated_at), ',' order by id) from financial_goals where user_id = app_owner()), '|',
       (select concat(count(*), max(created_at), max(deleted_at)) from goal_contributions where user_id = app_owner()), '|',
       (select string_agg(concat(id, amount_cents, month, updated_at), ',' order by id) from budgets where user_id = app_owner()), '|',
       (select string_agg(concat(id, active, updated_at), ',' order by id) from recurring_transactions where user_id = app_owner()))),
    'chat', (select extract(epoch from max(created_at))::text from chat_messages where user_id = app_uid())
  )
$$;
revoke all on function public.app_changes(jsonb) from public, anon;
grant execute on function public.app_changes(jsonb) to authenticated;
