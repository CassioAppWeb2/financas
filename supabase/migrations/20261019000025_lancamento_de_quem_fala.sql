-- O lançamento considera QUEM está registrando:
--  * cartão ou conta citados pelo nome (nomes repetidos na família): vale o da pessoa
--  * "no cartão" sem dizer qual: se a pessoa tem um cartão só, é esse
--  * conta não informada: a conta da pessoa (padrão dela) antes da conta da família
create or replace function public.fe_resolve_account(p_user uuid, p_name text, p_id uuid DEFAULT NULL::uuid) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid; a uuid := fe_actor();
begin
  if p_id is not null then
    select id into v from accounts where id = p_id and user_id = p_user and status = 'ativa';
    if v is null then perform fe_err('Conta não encontrada.'); end if;
    return v;
  end if;
  if fe_norm(p_name) is not null then
    select id into v from accounts
      where user_id = p_user and status = 'ativa'
        and (fe_norm(name) = fe_norm(p_name) or fe_norm(institution) = fe_norm(p_name)
             or fe_norm(name) like '%' || fe_norm(p_name) || '%')
      order by (fe_norm(name) = fe_norm(p_name)) desc, (member_id is not distinct from a) desc, is_default desc, created_at limit 1;
    return v;   -- nome informado não existe: quem chamou decide (perguntar)
  end if;
  select id into v from accounts where user_id = p_user and status = 'ativa'
    order by (a is not null and member_id = a and is_default) desc, (a is not null and member_id = a) desc, is_default desc, created_at limit 1;
  return v;
end $$;

do $$
declare r record; v_src text; v_new text;
begin
  -- "no cartão" sem dizer qual: o cartão de quem está lançando, se for um só
  select pg_get_functiondef('public.fe_create_transaction(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%cartão de quem lança%' then
    v_new := replace(v_src,
      E'      if v_ncards = 1 then select id into v_card from credit_cards where user_id = p_user and status = ''ativo'';\n      elsif v_ncards > 1 then',
      E'      -- cartão de quem lança, se a pessoa tiver um só\n      select c.id into v_card from credit_cards c where c.user_id = p_user and c.status = ''ativo'' and c.member_id = v_actor\n        and (select count(*) from credit_cards x where x.user_id = p_user and x.status = ''ativo'' and x.member_id = v_actor) = 1;\n      if v_card is not null then null;\n      elsif v_ncards = 1 then select id into v_card from credit_cards where user_id = p_user and status = ''ativo'';\n      elsif v_ncards > 1 then');
    if v_new = v_src then raise exception 'fe_create_transaction inesperado'; end if;
    execute v_new;
  end if;

  -- todas as funções que escolhem cartão/conta pelo nome sabem quem está lançando
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'fe\_%' and p.proname not in ('fe_resolve_card','fe_resolve_account')
             and pg_get_function_identity_arguments(p.oid) like 'p_user uuid%' loop
    v_src := pg_get_functiondef(r.oid);
    if (v_src like '%fe_resolve_card(%' or v_src like '%fe_resolve_account(%') and v_src not like '%app.actor%' and v_src ~ E'\nbegin\n' then
      execute regexp_replace(v_src, E'\nbegin\n', E'\nbegin\n  perform set_config(''app.actor'', p_user::text, true);\n');
    end if;
  end loop;
end $$;
