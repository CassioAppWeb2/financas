-- =====================================================================
-- Importação de extrato (OFX/CSV/PDF) mais esperta:
--  * conta "a pagar"/"a receber" que aparece no extrato é marcada como PAGA (não vira lançamento novo)
--  * "pagamento de fatura" no extrato da conta vira pagamento do cartão (não conta como despesa de novo)
--  * pagamento de fatura já registrado não entra duas vezes
-- =====================================================================
create or replace function public.fe_import(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_acc uuid; v_card uuid; it jsonb; v_out jsonb := '[]';
  v_val bigint; v_date date; v_desc text; v_type text; v_dup uuid; v_cat uuid; v_sub uuid; v_src text; r jsonb;
  v_conf boolean := coalesce((p->>'confirmar')::boolean, false); v_new int := 0; v_skip int := 0; i int := 0;
  v_due date := nullif(p->>'vencimento','')::date; v_used uuid[] := '{}'; v_k int; v_n int; v_res jsonb;
  v_tot_new bigint := 0; v_tot_dup bigint := 0; v_pend transactions; v_pcard uuid; v_quit int := 0; v_pag int := 0;
begin
  perform set_config('app.actor', p_user::text, true);
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

    -- EXTRATO DA CONTA: pagamento da fatura de um cartão
    if v_acc is not null and v_type = 'despesa'
       and fe_norm(v_desc) ~ '(pagamento|pgto|pagto|pag)\.? ?(de |da |do )?(fatura|cartao|cart)|fatura (cartao|nubank|inter|itau|c6|santander|bradesco|banrisul|sicredi)|^nu pagamentos' then
      -- qual cartão: o nome dele no texto (de quem está importando primeiro); se só houver um, ele
      select c.id into v_pcard from credit_cards c
        where c.user_id = o and c.status = 'ativo' and fe_holder_visible(c.member_id)
          and (fe_norm(v_desc) like '%' || fe_norm(c.name) || '%' or (c.bank is not null and fe_norm(v_desc) like '%' || fe_norm(c.bank) || '%')
               or exists (select 1 from regexp_split_to_table(fe_norm(c.name), ' ') w where length(w) >= 4 and fe_norm(v_desc) like '%' || w || '%'))
        order by (c.member_id is not distinct from p_user) desc, c.created_at limit 1;
      if v_pcard is null and (select count(*) from credit_cards c where c.user_id = o and c.status = 'ativo' and fe_holder_visible(c.member_id)) = 1 then
        select c.id into v_pcard from credit_cards c where c.user_id = o and c.status = 'ativo' and fe_holder_visible(c.member_id);
      end if;
      if v_pcard is not null then
        select t.id into v_dup from transactions t
          where t.user_id = o and t.deleted_at is null and t.type = 'pagamento_fatura' and t.card_id = v_pcard
            and t.amount_cents = v_val and abs(t.date - v_date) <= 7 and not (t.id = any(v_used))
          order by abs(t.date - v_date) limit 1;
        if v_dup is not null then
          v_used := v_used || v_dup;
          v_out := v_out || jsonb_build_object('linha', i, 'situacao', 'duplicada', 'data', v_date, 'valor_cents', v_val, 'descricao', v_desc, 'tipo', 'despesa',
            'duplicada_de', fe_tx_json((select t from transactions t where t.id = v_dup)));
          v_dup := null; v_pcard := null; continue;
        end if;
        r := jsonb_build_object('linha', i, 'situacao', 'pagamento_fatura', 'data', v_date, 'valor_cents', v_val, 'descricao', v_desc, 'tipo', 'despesa',
          'cartao', (select name from credit_cards where id = v_pcard));
        if v_conf and not coalesce((it->>'ignorar')::boolean, false) then
          v_res := fe_pay_invoice(p_user, jsonb_build_object('cartao_id', v_pcard, 'valor_cents', v_val, 'data', v_date, 'conta_id', v_acc,
            'origem', coalesce(nullif(p->>'origem',''), 'importacao')));
          r := r || jsonb_build_object('resultado', v_res->>'status');
          if v_res->>'status' = 'paid' then v_pag := v_pag + 1; else v_skip := v_skip + 1; end if;
        elsif v_conf then v_skip := v_skip + 1;
        end if;
        v_out := v_out || r; v_pcard := null; continue;
      end if;
    end if;

    -- EXTRATO DA CONTA: conta "a pagar"/"a receber" já lançada -> marca como paga (mesmo valor, ou parecida e até 20% de diferença)
    if v_acc is not null then
      select t.* into v_pend from transactions t
        where t.user_id = o and t.deleted_at is null and t.type = v_type and fe_is_pending(t.status, t.card_id, t.type)
          and not (t.id = any(v_used)) and abs(t.date - v_date) <= 10
          and (t.amount_cents = v_val
               or (abs(t.amount_cents - v_val) <= greatest(t.amount_cents, v_val) * 0.2 and similarity_ok(t.description, v_desc)))
        order by (t.amount_cents = v_val) desc, abs(t.date - v_date) limit 1;
      if v_pend.id is not null then
        v_used := v_used || v_pend.id;
        r := jsonb_build_object('linha', i, 'situacao', 'quita_pendente', 'data', v_date, 'valor_cents', v_val, 'descricao', v_desc, 'tipo', v_type,
          'pendente', fe_tx_json(v_pend));
        if v_conf and not coalesce((it->>'ignorar')::boolean, false) then
          update transactions set status = 'efetivado', paid_at = now(), amount_cents = v_val, account_id = v_acc,
              date = least(v_date, fe_today(p_user)), updated_at = now()
            where id = v_pend.id;
          insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
            values (o, p_user, 'transaction', v_pend.id, 'paid', fe_tx_json((select t from transactions t where t.id = v_pend.id)), 'importacao');
          v_quit := v_quit + 1;
        elsif v_conf then v_skip := v_skip + 1;
        end if;
        v_out := v_out || r; v_pend := null; continue;
      end if;
    end if;

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
      if v_cat is not null then
        v_src := 'informada';
        if nullif(it->>'subcategoria_id','') is not null then
          select id into v_sub from subcategories where id = (it->>'subcategoria_id')::uuid and category_id = v_cat;
        end if;
      end if;
    end if;
    if v_cat is null then
      select r2.category_id, r2.subcategory_id, r2.source into v_cat, v_sub, v_src from fe_resolve_category(o, v_type, null, null, v_desc) r2;
    end if;
    if v_cat is null and (fe_norm(it->>'categoria') is not null or fe_norm(it->>'subcategoria') is not null) then
      select r2.category_id, r2.subcategory_id into v_cat, v_sub from fe_resolve_category(o, v_type, it->>'categoria', it->>'subcategoria', null) r2;
      if v_cat is not null then v_src := 'sugerida'; end if;
    end if;
    if v_cat is null then
      select id into v_cat from categories where user_id = o and kind = v_type and fe_norm(name) in ('outros','outros gastos','outras receitas') and archived_at is null;
      v_sub := null; v_src := 'padrao';
    end if;
    r := jsonb_build_object('linha', i, 'data', v_date, 'valor_cents', v_val, 'tipo', v_type, 'descricao', v_desc,
      'categoria_id', v_cat, 'categoria', (select name from categories where id = v_cat),
      'subcategoria_id', v_sub, 'icone', (select icon from categories where id = v_cat),
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
    v_dup := null;
  end loop;
  return jsonb_build_object('status', case when v_conf then 'imported' else 'preview' end, 'itens', v_out,
    'importados', v_new, 'quitados', v_quit, 'faturas_pagas', v_pag, 'ignorados', v_skip,
    'cartao', (select name from credit_cards where id = v_card), 'conta', (select name from accounts where id = v_acc),
    'vencimento', v_due, 'total_novas_cents', v_tot_new, 'total_duplicadas_cents', v_tot_dup,
    'fatura', case when v_card is not null and v_due is not null then fe_invoice_json(o, v_card, v_due) end);
end $$;
