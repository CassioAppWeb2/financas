-- Dois cartões com o mesmo nome (ex.: "Nubank" do Cássio e "Nubank" da Bruna):
-- quando a pessoa fala só o nome, vale o cartão DELA.
create or replace function public.fe_actor() returns uuid
language sql stable as $$ select coalesce(nullif(current_setting('app.actor', true), '')::uuid, auth.uid()) $$;

create or replace function public.fe_resolve_card(p_owner uuid, p_name text, p_id uuid DEFAULT NULL::uuid) returns uuid
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
    order by (fe_norm(name) = n) desc, (member_id is not distinct from fe_actor()) desc, created_at limit 1;
  return v;
end $$;

-- quem está lançando fica registrado para a escolha do cartão
do $$
declare f text; v_src text; v_new text;
begin
  foreach f in array array['public.fe_create_transaction(uuid,jsonb)', 'public.fe_create_split(uuid,jsonb)'] loop
    select pg_get_functiondef(f::regprocedure) into v_src;
    if v_src not like '%app.actor%' then
      v_new := regexp_replace(v_src, E'\nbegin\n', E'\nbegin\n  perform set_config(''app.actor'', p_user::text, true);\n');
      if v_new = v_src then raise exception '% inesperado', f; end if;
      execute v_new;
    end if;
  end loop;
end $$;
