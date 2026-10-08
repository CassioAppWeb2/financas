-- =====================================================================
-- Nome do assistente: cada pessoa pode dar um nome ao assistente ("Jarbas").
-- O nome volta no contexto do assistente (para reconhecer quando é chamado)
-- e no bootstrap do app (cabeçalho do chat e Configurações).
-- =====================================================================
alter table public.profiles add column if not exists assistant_name text
  check (assistant_name is null or char_length(assistant_name) between 2 and 30);

-- contexto do assistente
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.fe_context_data(uuid)'::regprocedure) into v_src;
  if v_src not like '%''assistente''%' then
    if v_src not like '%''nome'', (select name from profiles where id = p_user),%' then raise exception 'fe_context_data inesperado'; end if;
    v_src := replace(v_src, '''nome'', (select name from profiles where id = p_user),',
      '''nome'', (select name from profiles where id = p_user),
    ''assistente'', (select assistant_name from profiles where id = p_user),');
    execute v_src;
  end if;
end $$;

-- bootstrap do app
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.app_bootstrap(jsonb)'::regprocedure) into v_src;
  if v_src not like '%''assistente''%' then
    if v_src not like '%jsonb_build_object(''id'', u, ''nome'', name, ''timezone'', timezone,%' then raise exception 'app_bootstrap inesperado'; end if;
    v_src := replace(v_src, 'jsonb_build_object(''id'', u, ''nome'', name, ''timezone'', timezone,',
      'jsonb_build_object(''id'', u, ''nome'', name, ''timezone'', timezone, ''assistente'', assistant_name,');
    execute v_src;
  end if;
end $$;

-- perfil: aceita o nome do assistente ("" volta ao padrão)
create or replace function public.app_update_profile(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); v_nome text;
begin
  update profiles set name = coalesce(nullif(trim(p->>'nome'),''), name), updated_at = now() where id = u;
  if p ? 'meta_economia' then
    update profiles set monthly_savings_goal_cents = nullif(round(nullif(p->>'meta_economia','')::numeric * 100)::bigint, 0)
      where id = fe_owner(u);
  end if;
  if p ? 'assistente' then
    v_nome := nullif(regexp_replace(trim(coalesce(p->>'assistente','')), '\s+', ' ', 'g'), '');
    if v_nome is not null and (char_length(v_nome) < 2 or char_length(v_nome) > 30) then
      perform fe_err('O nome do assistente deve ter entre 2 e 30 letras.');
    end if;
    if v_nome is not null and v_nome !~ '^[[:alpha:]][[:alpha:][:digit:] ''.-]*$' then
      perform fe_err('Use só letras no nome do assistente.');
    end if;
    update profiles set assistant_name = v_nome, updated_at = now() where id = u;
  end if;
  return jsonb_build_object('status','ok', 'assistente', (select assistant_name from profiles where id = u));
end $$;
