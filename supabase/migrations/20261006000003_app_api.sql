-- =====================================================================
-- API DO APLICATIVO (chamada pelo navegador com o usuário logado)
-- Cada função usa auth.uid(): um usuário nunca alcança dados de outro.
-- =====================================================================

create or replace function public.app_uid() returns uuid
language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is null then perform public.fe_err('Sessão expirada. Entre novamente.'); end if;
  return v;
end $$;

-- Titular da família do usuário logado (dono dos dados financeiros)
create or replace function public.app_owner() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select fe_owner(app_uid())
$$;

create or replace function public.app_bootstrap(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); o uuid := fe_owner(app_uid());
begin
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
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.kind, 'nome', c.name, 'icone', c.icon,
        'sistema', c.is_system,
        'subcategorias', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.name) order by s.name)
                                   from subcategories s where s.category_id = c.id and s.archived_at is null), '[]'))
        order by c.kind, (c.name = 'Outros'), c.name) from categories c where c.user_id = o and c.archived_at is null), '[]'),
    'whatsapp', (select jsonb_build_object('status', status,
        'telefone_final', case when phone_number is not null then right(phone_number, 4) end)
        from whatsapp_connections where user_id = u));
end $$;

create or replace function public.app_dashboard(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select fe_month_overview(app_uid(), p)
$$;

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
        and (v_q is null or fe_norm(t.description) like '%' || v_q || '%')
        and fe_member_match(t.member_id, p->>'membro_id')
      order by t.date desc, t.created_at desc
      limit least(coalesce(nullif(p->>'limite','')::int, 500), 1000)) t), '[]'));
end $$;

-- Criar (sem id) ou editar (com id) um lançamento pelo formulário
create or replace function public.app_save_transaction(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid();
begin
  -- p.membro: 'familia' (compartilhado) | id de uma pessoa da família | vazio (quem está registrando)
  if p->>'membro' = 'familia' then p := p || '{"familia":true}';
  elsif nullif(p->>'membro','') is not null then p := p || jsonb_build_object('membro_id', p->>'membro');
  end if;
  p := p - 'membro';
  if nullif(p->>'id','') is not null then
    return fe_update_transaction(u, p || '{"origem":"app_form"}');
  end if;
  return fe_create_transaction(u, (p - 'id') || '{"origem":"app_form"}');
end $$;

create or replace function public.app_delete_transaction(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if nullif(p->>'id','') is null then perform fe_err('Informe o lançamento.'); end if;
  return fe_delete_transaction(app_uid(), jsonb_build_object('id', p->>'id', 'origem', 'app_form'));
end $$;

-- Contas
create or replace function public.app_save_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v accounts; v_before jsonb;
begin
  if fe_norm(p->>'nome') is null then perform fe_err('Informe o nome da conta.'); end if;
  if coalesce((p->>'padrao')::boolean, false) then
    update accounts set is_default = false where user_id = u and is_default
      and (nullif(p->>'id','') is null or id <> (p->>'id')::uuid);
  end if;
  if nullif(p->>'id','') is null then
    insert into accounts(user_id, name, institution, type, initial_balance_cents, is_default)
      values (u, trim(p->>'nome'), nullif(trim(p->>'instituicao'),''), coalesce(nullif(p->>'tipo',''),'corrente'),
              coalesce(round((p->>'saldo_inicial')::numeric * 100)::bigint, 0),
              coalesce((p->>'padrao')::boolean, false) or not exists (select 1 from accounts where user_id = u and is_default))
      returning * into v;
  else
    select to_jsonb(a) into v_before from accounts a where id = (p->>'id')::uuid and user_id = u;
    if v_before is null then perform fe_err('Conta não encontrada.'); end if;
    update accounts set name = trim(p->>'nome'), institution = nullif(trim(p->>'instituicao'),''),
      type = coalesce(nullif(p->>'tipo',''), type),
      initial_balance_cents = coalesce(round((p->>'saldo_inicial')::numeric * 100)::bigint, initial_balance_cents),
      is_default = coalesce((p->>'padrao')::boolean, is_default)
      where id = (p->>'id')::uuid and user_id = u returning * into v;
  end if;
  insert into audit_logs(user_id, entity, entity_id, action, before, after, source)
    values (u, 'account', v.id, case when v_before is null then 'create' else 'update' end, v_before, to_jsonb(v), 'app_form');
  return jsonb_build_object('status','ok','id', v.id);
exception when unique_violation then
  perform fe_err('Já existe uma conta padrão.');
end $$;

create or replace function public.app_archive_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v accounts;
begin
  select * into v from accounts where id = (p->>'id')::uuid and user_id = u;
  if v.id is null then perform fe_err('Conta não encontrada.'); end if;
  if v.is_default and v.status = 'ativa' then perform fe_err('Defina outra conta como padrão antes de arquivar esta.'); end if;
  update accounts set status = case when status = 'ativa' then 'arquivada' else 'ativa' end where id = v.id;
  insert into audit_logs(user_id, entity, entity_id, action, before, source) values (u, 'account', v.id, 'archive_toggle', to_jsonb(v), 'app_form');
  return jsonb_build_object('status','ok');
end $$;

-- Categorias
create or replace function public.app_save_category(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v_id uuid;
begin
  if fe_norm(p->>'nome') is null then perform fe_err('Informe o nome da categoria.'); end if;
  if nullif(p->>'id','') is null then
    if coalesce(p->>'tipo','') not in ('despesa','receita') then perform fe_err('Tipo de categoria inválido.'); end if;
    update categories set archived_at = null, icon = coalesce(nullif(p->>'icone',''), icon)
      where user_id = u and kind = p->>'tipo' and lower(name) = lower(trim(p->>'nome')) and archived_at is not null
      returning id into v_id;
    if v_id is null then
      insert into categories(user_id, kind, name, icon) values (u, p->>'tipo', trim(p->>'nome'), nullif(p->>'icone',''))
        returning id into v_id;
    end if;
  else
    update categories set name = trim(p->>'nome'), icon = coalesce(nullif(p->>'icone',''), icon)
      where id = (p->>'id')::uuid and user_id = u returning id into v_id;
    if v_id is null then perform fe_err('Categoria não encontrada.'); end if;
  end if;
  return jsonb_build_object('status','ok','id', v_id);
exception when unique_violation then
  perform fe_err('Já existe uma categoria com esse nome.');
end $$;

create or replace function public.app_delete_category(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v categories;
begin
  select * into v from categories where id = (p->>'id')::uuid and user_id = u;
  if v.id is null then perform fe_err('Categoria não encontrada.'); end if;
  if exists (select 1 from transactions where category_id = v.id and deleted_at is null) then
    perform fe_err('Esta categoria tem lançamentos. Mova-os para outra categoria antes de excluir.');
  end if;
  update categories set archived_at = now() where id = v.id;
  update subcategories set archived_at = now() where category_id = v.id and archived_at is null;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, before, source) values (u, app_uid(), 'category', v.id, 'archive', to_jsonb(v), 'app_form');
  return jsonb_build_object('status','ok');
end $$;

create or replace function public.app_save_subcategory(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner(); v_id uuid;
begin
  if fe_norm(p->>'nome') is null then perform fe_err('Informe o nome da subcategoria.'); end if;
  if not exists (select 1 from categories where id = (p->>'categoria_id')::uuid and user_id = u and archived_at is null) then
    perform fe_err('Categoria não encontrada.');
  end if;
  update subcategories set archived_at = null
    where category_id = (p->>'categoria_id')::uuid and lower(name) = lower(trim(p->>'nome')) and archived_at is not null
    returning id into v_id;
  if v_id is null then
    insert into subcategories(user_id, category_id, name) values (u, (p->>'categoria_id')::uuid, trim(p->>'nome'))
      returning id into v_id;
  end if;
  return jsonb_build_object('status','ok','id', v_id);
exception when unique_violation then
  perform fe_err('Essa subcategoria já existe.');
end $$;

create or replace function public.app_delete_subcategory(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_owner();
begin
  update transactions set subcategory_id = null where subcategory_id = (p->>'id')::uuid and user_id = u;
  update subcategories set archived_at = now() where id = (p->>'id')::uuid and user_id = u;
  return jsonb_build_object('status','ok');
end $$;

-- Perfil
create or replace function public.app_update_profile(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid();
begin
  update profiles set name = coalesce(nullif(trim(p->>'nome'),''), name), updated_at = now() where id = u;
  if p ? 'meta_economia' then
    update profiles set monthly_savings_goal_cents = nullif(round(nullif(p->>'meta_economia','')::numeric * 100)::bigint, 0)
      where id = fe_owner(u);
  end if;
  return jsonb_build_object('status','ok');
end $$;

-- Histórico unificado do chat (app + WhatsApp)
create or replace function public.app_chat_history(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'role', role, 'channel', channel, 'message_type', message_type,
    'content', content, 'cards', cards, 'created_at', created_at) order by created_at), '[]')
  from (select * from chat_messages where user_id = app_uid()
          and (nullif(p->>'antes','') is null or created_at < (p->>'antes')::timestamptz)
        order by created_at desc limit least(coalesce(nullif(p->>'limite','')::int, 60), 200)) m
$$;

-- Código de conexão: vale para WhatsApp E Telegram (15 minutos)
create or replace function public.app_link_code(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); v_code text;
begin
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from link_codes where code = v_code);
  end loop;
  insert into link_codes(code, user_id, expires_at) values (v_code, u, now() + interval '15 minutes')
    on conflict (user_id) do update set code = excluded.code, expires_at = excluded.expires_at, used_at = null;
  return jsonb_build_object('codigo', v_code, 'expira_em_minutos', 15);
end $$;

create or replace function public.app_unlink_channel(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid();
begin
  if p->>'canal' = 'whatsapp' then update whatsapp_connections set phone_number = null, status = 'pendente', verified_at = null where user_id = u;
  elsif p->>'canal' = 'telegram' then update telegram_connections set chat_id = 'desvinculado-' || id::text where user_id = u;
  else perform fe_err('Canal inválido.'); end if;
  insert into audit_logs(user_id, actor_id, entity, action, source) values (fe_owner(u), u, p->>'canal' || '_connection', 'unlink', 'app_form');
  return jsonb_build_object('status','ok');
end $$;

-- ---------------------------------------------------------------------
-- FAMÍLIA: convidar, entrar, sair/remover
-- ---------------------------------------------------------------------
create or replace function public.app_family_invite(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); v_code text;
begin
  if fe_owner(u) <> u then perform fe_err('Só o titular da família pode convidar pessoas.'); end if;
  if (select count(*) from household_members where owner_id = u) >= 6 then perform fe_err('A família já tem o máximo de 6 pessoas.'); end if;
  update household_invites set expires_at = now() where owner_id = u and used_by is null and expires_at > now();
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into household_invites(code, owner_id, expires_at) values (v_code, u, now() + interval '48 hours');
  return jsonb_build_object('codigo', v_code, 'expira_em_horas', 48);
end $$;

create or replace function public.app_family_join(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); v household_invites;
begin
  select * into v from household_invites
    where code = upper(trim(p->>'codigo')) and used_by is null and expires_at > now() for update;
  if v.code is null then perform fe_err('Código de convite inválido ou expirado.'); end if;
  if v.owner_id = u then perform fe_err('Este convite é da sua própria família.'); end if;
  if exists (select 1 from household_members where owner_id = u and member_id <> u) then
    perform fe_err('Você é titular de uma família com outras pessoas. Remova-as antes de entrar em outra.');
  end if;
  if exists (select 1 from transactions where user_id = u and deleted_at is null) then
    perform fe_err('Sua conta já tem lançamentos próprios. Para entrar numa família, use uma conta sem lançamentos.');
  end if;
  insert into household_members(member_id, owner_id, role) values (u, v.owner_id, 'membro')
    on conflict (member_id) do update set owner_id = excluded.owner_id, role = 'membro', joined_at = now();
  update household_invites set used_by = u where code = v.code;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, source) values (v.owner_id, u, 'household', u, 'join', 'app_form');
  return jsonb_build_object('status','ok','titular', (select name from profiles where id = v.owner_id));
end $$;

-- Titular remove alguém, ou a própria pessoa sai. Os lançamentos já feitos ficam com a família.
create or replace function public.app_family_remove(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := app_uid(); v_target uuid := coalesce(nullif(p->>'membro_id','')::uuid, u); v_owner uuid := fe_owner(u);
begin
  if v_target = v_owner then perform fe_err('O titular não pode sair da própria família.'); end if;
  if v_target <> u and v_owner <> u then perform fe_err('Só o titular pode remover outras pessoas.'); end if;
  if not exists (select 1 from household_members where member_id = v_target and owner_id = v_owner) then
    perform fe_err('Pessoa não encontrada na família.');
  end if;
  update household_members set owner_id = v_target, role = 'titular', joined_at = now() where member_id = v_target;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, source) values (v_owner, u, 'household', v_target, 'leave', 'app_form');
  return jsonb_build_object('status','ok');
end $$;

-- ---------------------------------------------------------------------
-- PERMISSÕES
--  * fe_*  : somente o servidor (service_role)
--  * app_* : somente usuários logados (authenticated)
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'fe\_%' or p.proname like 'app\_%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    if r.proname like 'app\_%' then
      execute format('grant execute on function %s to authenticated', r.sig);
    else
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end $$;
-- app_uid/fe_err/fe_norm são usados dentro das funções app_* (que rodam como dono), mas
-- app_dashboard e app_chat_history são SQL e chamam app_uid() no contexto do dono também.
