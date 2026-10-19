-- Painel "Compromissos futuros" de uma pessoa: inclui a parte dela nas compras divididas (a pagar a quem é dono do cartão)
do $$
declare v_src text; v_new text;
begin
  select pg_get_functiondef('public.fe_kpi_detail(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%''acertos'', case when v_k%' then
    v_new := replace(v_src, '''contas'', case when v_k = ''saldo''',
      '''acertos'', case when v_k = ''compromissos'' and nullif(v_f,'''') is not null and v_f <> ''familia'' then
        (select coalesce(jsonb_agg(fe_acerto_item(t, v_f::uuid) order by coalesce(t.invoice_due, t.date)), ''[]'') from transactions t
          where t.user_id = o and t.deleted_at is null and t.settle_status = ''pendente'' and t.member_id = v_f::uuid
            and coalesce(t.invoice_due, t.date) <= v_fim) else ''[]''::jsonb end,
    ''contas'', case when v_k = ''saldo''');
    if v_new = v_src then raise exception 'fe_kpi_detail inesperado'; end if;
    execute v_new;
  end if;
end $$;
