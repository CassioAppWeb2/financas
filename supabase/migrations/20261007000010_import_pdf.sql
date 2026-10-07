-- =====================================================================
-- Importação de fatura/extrato também pelo assistente (PDF lido pela IA)
--  * fe_import: mesma regra para o app e para o Telegram
--  * fatura com vencimento conhecido: cada compra entra NESSA fatura
--  * duplicidade 1 para 1 (dois cafés iguais não viram "duplicados" do mesmo lançamento)
--  * estornos no cartão abatem a fatura
-- =====================================================================

-- fe_create_transaction: aceita "fatura_vencimento" e estorno (receita) no cartão
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.fe_create_transaction(uuid,jsonb)'::regprocedure) into v_src;
  v_src := replace(v_src,
    'if v_type = ''despesa'' then
    if nullif(p->>''cartao_id'','''') is not null then',
    'if v_type = ''despesa'' or (v_type = ''receita'' and nullif(p->>''cartao_id'','''') is not null) then
    if nullif(p->>''cartao_id'','''') is not null then');
  v_src := replace(v_src,
    'case when v_card is not null then (fe_invoice_due(v_card, v_date) + make_interval(months => i - 1))::date end,',
    'case when v_card is not null then (coalesce(nullif(p->>''fatura_vencimento'','''')::date, fe_invoice_due(v_card, v_date)) + make_interval(months => i - 1))::date end,');
  v_src := replace(v_src,
    '''fatura'', case when v_card is not null then fe_invoice_json(p_user, v_card, fe_invoice_due(v_card, v_date)) end,',
    '''fatura'', case when v_card is not null then fe_invoice_json(p_user, v_card, coalesce(nullif(p->>''fatura_vencimento'','''')::date, fe_invoice_due(v_card, v_date))) end,');
  if v_src not like '%fatura_vencimento%' or v_src not like '%v_type = ''receita'' and nullif%' then
    raise exception 'fe_create_transaction não tem o formato esperado';
  end if;
  execute v_src;
end $$;

-- Importação (prévia ou confirmação)
-- p: conta_id | conta | cartao_id | cartao, vencimento (fatura), confirmar, origem,
--    itens: [{data, valor (fatura: compra +, estorno/pagamento −; extrato: saída −, entrada +),
--             descricao, id_externo, parcela "3/10", categoria, subcategoria, categoria_id, ignorar}]
create or replace function public.fe_import(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_acc uuid; v_card uuid; it jsonb; v_out jsonb := '[]';
  v_val bigint; v_date date; v_desc text; v_type text; v_dup uuid; v_cat uuid; v_sub uuid; v_src text; r jsonb;
  v_conf boolean := coalesce((p->>'confirmar')::boolean, false); v_new int := 0; v_skip int := 0; i int := 0;
  v_due date := nullif(p->>'vencimento','')::date; v_used uuid[] := '{}'; v_k int; v_n int; v_res jsonb;
  v_tot_new bigint := 0; v_tot_dup bigint := 0;
begin
  if nullif(p->>'cartao_id','') is not null or fe_norm(p->>'cartao') is not null then
    v_card := fe_resolve_card(o, p->>'cartao', nullif(p->>'cartao_id','')::uuid);
    if v_card is null then return jsonb_build_object('status','unknown_card','cartao', p->>'cartao'); end if;
  elsif nullif(p->>'conta_id','') is not null then v_acc := fe_resolve_account(o, null, (p->>'conta_id')::uuid);
  else
    v_acc := fe_resolve_account(o, p->>'conta');
    if v_acc is null then return jsonb_build_object('status','unknown_account','conta', p->>'conta'); end if;
  end if;
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
    v_desc := left(coalesce(nullif(trim(it->>'descricao'),''), 'Importado'), 110);
    v_type := case when v_card is not null then case when v_val > 0 then 'despesa' else 'receita' end
                   else case when v_val < 0 then 'despesa' else 'receita' end end;
    if v_card is not null and v_type = 'receita' and fe_norm(v_desc) ~ '(pagamento|pgto|pag fatura|pagto)' then
      v_out := v_out || jsonb_build_object('linha', i, 'situacao', 'pagamento', 'data', v_date, 'valor_cents', abs(v_val), 'descricao', v_desc, 'tipo', 'receita');
      continue;
    end if;
    v_val := abs(v_val);
    -- parcela de compra antiga: a data vira a do mês desta fatura (ex.: compra em maio, parcela 3/10 -> julho)
    if (it->>'parcela') ~ '^\d{1,2}/\d{1,2}$' then
      v_k := split_part(it->>'parcela', '/', 1)::int; v_n := split_part(it->>'parcela', '/', 2)::int;
      if v_due is not null and v_k > 1 and v_date < v_due - 45 then
        v_date := (v_date + make_interval(months => v_k - 1))::date;
        while v_date > v_due loop v_date := (v_date - interval '1 month')::date; end loop;
      end if;
      if v_desc !~ '\(\d{1,2}/\d{1,2}\)$' then v_desc := v_desc || ' (' || v_k || '/' || v_n || ')'; end if;
    end if;
    -- duplicidade (cada lançamento existente só "casa" com uma linha)
    select t.id into v_dup from transactions t
      where t.user_id = o and t.deleted_at is null and t.amount_cents = v_val and t.type = v_type
        and not (t.id = any(v_used))
        and ((nullif(it->>'id_externo','') is not null and t.external_id = it->>'id_externo')
             or (v_card is not null and v_due is not null and t.card_id = v_card and t.invoice_due = v_due)
             or (abs(t.date - v_date) <= 2
                 and (v_card is null or t.card_id = v_card) and (v_acc is null or t.account_id = v_acc or t.account_id is null)
                 and (similarity_ok(t.description, v_desc) or t.origin <> 'importacao')))
      order by (nullif(it->>'id_externo','') is not null and t.external_id = it->>'id_externo') desc, abs(t.date - v_date) limit 1;
    if v_dup is not null then v_used := v_used || v_dup; end if;
    -- categoria: escolhida na prévia > aprendida pelo histórico > sugerida (regras/IA) > Outros
    v_cat := null; v_sub := null; v_src := null;
    if nullif(it->>'categoria_id','') is not null then
      select id into v_cat from categories where id = (it->>'categoria_id')::uuid and user_id = o and kind = v_type;
      if v_cat is not null then v_src := 'informada'; end if;
    end if;
    if v_cat is null then
      select r2.category_id, r2.subcategory_id, r2.source into v_cat, v_sub, v_src from fe_resolve_category(o, v_type, null, null, v_desc) r2;
    end if;
    if v_cat is null and (fe_norm(it->>'categoria') is not null or fe_norm(it->>'subcategoria') is not null) then
      select r2.category_id, r2.subcategory_id into v_cat, v_sub from fe_resolve_category(o, v_type, it->>'categoria', it->>'subcategoria', null) r2;
      if v_cat is not null then v_src := 'sugerida'; end if;
    end if;
    if v_cat is null then
      select id into v_cat from categories where user_id = o and kind = v_type and fe_norm(name) = 'outros' and archived_at is null;
      v_sub := null; v_src := 'padrao';
    end if;
    r := jsonb_build_object('linha', i, 'data', v_date, 'valor_cents', v_val, 'tipo', v_type, 'descricao', v_desc,
      'categoria_id', v_cat, 'categoria', (select name from categories where id = v_cat),
      'icone', (select icon from categories where id = v_cat),
      'subcategoria', (select name from subcategories where id = v_sub), 'categoria_origem', v_src,
      'situacao', case when v_dup is not null then 'duplicada' else 'nova' end,
      'duplicada_de', case when v_dup is not null then fe_tx_json((select t from transactions t where t.id = v_dup)) end);
    if v_dup is null then v_tot_new := v_tot_new + case when v_type = 'despesa' then v_val else -v_val end;
    else v_tot_dup := v_tot_dup + case when v_type = 'despesa' then v_val else -v_val end; end if;
    if v_conf and v_dup is null and not coalesce((it->>'ignorar')::boolean, false) then
      v_res := fe_create_transaction(p_user, jsonb_build_object(
        'tipo', v_type, 'valor_cents', v_val, 'data', v_date, 'descricao', v_desc, 'estabelecimento', regexp_replace(v_desc, '\s*\(\d{1,2}/\d{1,2}\)$', ''),
        'categoria_id', v_cat, 'subcategoria_id', v_sub, 'conta_id', v_acc, 'cartao_id', v_card, 'fatura_vencimento', v_due,
        'permitir_sem_categoria', true, 'forcar', true, 'origem', coalesce(nullif(p->>'origem',''), 'importacao'),
        'id_externo', nullif(it->>'id_externo','')));
      r := r || jsonb_build_object('resultado', v_res->>'status');
      if v_res->>'status' = 'created' then v_new := v_new + 1; else v_skip := v_skip + 1; end if;
    elsif v_conf then v_skip := v_skip + 1;
    end if;
    v_out := v_out || r;
  end loop;
  return jsonb_build_object('status', case when v_conf then 'imported' else 'preview' end, 'itens', v_out,
    'importados', v_new, 'ignorados', v_skip,
    'cartao', (select name from credit_cards where id = v_card), 'conta', (select name from accounts where id = v_acc),
    'vencimento', v_due, 'total_novas_cents', v_tot_new, 'total_duplicadas_cents', v_tot_dup,
    'fatura', case when v_card is not null and v_due is not null then fe_invoice_json(o, v_card, v_due) end);
end $$;

-- O app usa a mesma função
create or replace function public.app_import(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select fe_import(app_uid(), (p - 'origem') || '{"origem":"importacao"}')
$$;

revoke all on function public.fe_import(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_import(uuid, jsonb) to service_role;
revoke all on function public.app_import(jsonb) from public, anon;
grant execute on function public.app_import(jsonb) to authenticated;
