-- =====================================================================
-- MOTOR FINANCEIRO (Financial Engine)
--
-- A IA apenas interpreta. TODA validação, gravação, cálculo e auditoria
-- acontece aqui, dentro do banco, de forma transacional.
--
--  fe_*  -> funções do motor. Recebem o usuário explicitamente e só podem
--           ser chamadas pelo servidor (papel service_role), nunca pelo
--           navegador.
--  app_* -> funções chamadas pelo aplicativo. Usam o usuário logado
--           (auth.uid()) e repassam para o motor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
create or replace function public.fe_norm(t text) returns text
language sql immutable as $$
  select nullif(regexp_replace(trim(translate(lower(coalesce(t,'')),
    'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')), '\s+', ' ', 'g'), '')
$$;

create or replace function public.fe_err(msg text) returns void
language plpgsql as $$ begin raise exception using message = msg, errcode = 'P0001'; end $$;

create or replace function public.fe_today(p_user uuid) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone coalesce((select timezone from profiles where id = p_user), 'America/Sao_Paulo'))::date
$$;

create or replace function public.fe_month_bounds(p_mes text, p_user uuid, out inicio date, out fim date)
language plpgsql stable as $$
begin
  if p_mes is null or p_mes = '' then
    inicio := date_trunc('month', public.fe_today(p_user))::date;
  elsif p_mes !~ '^\d{4}-\d{2}$' then
    perform public.fe_err('Mês inválido. Use o formato AAAA-MM.');
  else
    inicio := (p_mes || '-01')::date;
  end if;
  fim := (inicio + interval '1 month' - interval '1 day')::date;
end $$;

-- ---------------------------------------------------------------------
-- Categorias padrão
-- ---------------------------------------------------------------------
create or replace function public.fe_seed_categories(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record; v_cat uuid; s text;
begin
  for r in select * from (values
    ('despesa','Alimentação','🍽️', array['Supermercado','Padaria','Restaurante','Delivery','Lanches']),
    ('despesa','Moradia','🏠', array['Aluguel','Condomínio','Energia','Água','Gás','Internet','Manutenção']),
    ('despesa','Transporte','🚗', array['Combustível','Uber','Transporte público','Manutenção','Estacionamento','Pedágio']),
    ('despesa','Saúde','🩺', array['Consultas','Exames','Medicamentos','Plano de saúde','Odontologia']),
    ('despesa','Educação','📚', array['Escola','Cursos','Livros','Material']),
    ('despesa','Vestuário','👕', array['Roupas','Calçados','Acessórios']),
    ('despesa','Lazer','🎉', array['Viagens','Cinema','Eventos','Jogos','Streaming']),
    ('despesa','Financeiro','🏦', array['Tarifas','Juros','IOF','Empréstimos']),
    ('despesa','Outros','📦', array[]::text[]),
    ('receita','Salário','💼', array[]::text[]),
    ('receita','Pró-labore','🧾', array[]::text[]),
    ('receita','Vendas','🛍️', array[]::text[]),
    ('receita','Freelance','💻', array[]::text[]),
    ('receita','Rendimentos','📈', array[]::text[]),
    ('receita','Investimentos','💹', array[]::text[]),
    ('receita','Aluguel recebido','🔑', array[]::text[]),
    ('receita','Outros','💰', array[]::text[])
  ) as x(kind, name, icon, subs)
  loop
    insert into categories(user_id, kind, name, icon, is_system)
      values (p_user, r.kind, r.name, r.icon, true)
      on conflict do nothing
      returning id into v_cat;
    if v_cat is null then
      select id into v_cat from categories where user_id = p_user and kind = r.kind and lower(name) = lower(r.name);
    end if;
    foreach s in array r.subs loop
      insert into subcategories(user_id, category_id, name) values (p_user, v_cat, s) on conflict do nothing;
    end loop;
    v_cat := null;
  end loop;
end $$;

-- Novo usuário: perfil, conta "Carteira", categorias e conversa
create or replace function public.fe_handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into profiles(id, name) values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
    on conflict (id) do nothing;
  insert into accounts(user_id, name, type, is_default) values (new.id, 'Carteira', 'dinheiro', true);
  perform fe_seed_categories(new.id);
  insert into household_members(member_id, owner_id, role) values (new.id, new.id, 'titular') on conflict do nothing;
  insert into chat_conversations(user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.fe_handle_new_user();

-- ---------------------------------------------------------------------
-- Resolução de categoria / conta
-- ---------------------------------------------------------------------
create or replace function public.fe_resolve_category(
  p_user uuid, p_kind text, p_cat text, p_sub text, p_estab text,
  out category_id uuid, out subcategory_id uuid, out source text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_kind text := case when p_kind = 'receita' then 'receita' else 'despesa' end;
begin
  if fe_norm(p_cat) is not null then
    select c.id into category_id from categories c
      where c.user_id = p_user and c.kind = v_kind and c.archived_at is null and fe_norm(c.name) = fe_norm(p_cat);
    if category_id is null then  -- o nome informado pode ser de uma subcategoria
      select s.category_id, s.id into category_id, subcategory_id from subcategories s
        join categories c on c.id = s.category_id
        where s.user_id = p_user and c.kind = v_kind and c.archived_at is null and s.archived_at is null and fe_norm(s.name) = fe_norm(p_cat)
        order by c.is_system desc limit 1;
    end if;
    if category_id is not null then source := 'informada'; end if;
  end if;

  if fe_norm(p_sub) is not null then
    if category_id is not null and subcategory_id is null then
      select s.id into subcategory_id from subcategories s
        where s.category_id = fe_resolve_category.category_id and s.archived_at is null and fe_norm(s.name) = fe_norm(p_sub);
    elsif category_id is null then
      select s.category_id, s.id into category_id, subcategory_id from subcategories s
        join categories c on c.id = s.category_id
        where s.user_id = p_user and c.kind = v_kind and c.archived_at is null and s.archived_at is null and fe_norm(s.name) = fe_norm(p_sub)
        order by c.is_system desc limit 1;
      if category_id is not null then source := 'informada'; end if;
    end if;
  end if;

  -- Aprendizado: o que o usuário já usou para este estabelecimento
  if category_id is null and fe_norm(p_estab) is not null then
    select ec.category_id, ec.subcategory_id into category_id, subcategory_id
      from establishment_categories ec
      join establishments e on e.id = ec.establishment_id
      join categories c on c.id = ec.category_id
      where ec.user_id = p_user and e.normalized_name = fe_norm(p_estab) and c.kind = v_kind and c.archived_at is null;
    if category_id is not null then source := 'aprendida'; end if;
  end if;
end $$;

create or replace function public.fe_resolve_account(p_user uuid, p_name text, p_id uuid default null) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid;
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
      order by (fe_norm(name) = fe_norm(p_name)) desc, is_default desc limit 1;
    if v is not null then return v; end if;
    return null; -- nome informado não existe: quem chamou decide (perguntar)
  end if;
  select id into v from accounts where user_id = p_user and is_default and status = 'ativa';
  if v is null then
    select id into v from accounts where user_id = p_user and status = 'ativa' order by created_at limit 1;
  end if;
  return v;
end $$;

-- Aprendizado: registra/atualiza "estabelecimento -> categoria"
create or replace function public.fe_learn(p_user uuid, p_estab uuid, p_cat uuid, p_sub uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_estab is null or p_cat is null then return; end if;
  insert into establishment_categories(user_id, establishment_id, category_id, subcategory_id, hits)
    values (p_user, p_estab, p_cat, p_sub, 1)
  on conflict (user_id, establishment_id) do update set
    hits = case when establishment_categories.category_id = excluded.category_id
                 and establishment_categories.subcategory_id is not distinct from excluded.subcategory_id
            then establishment_categories.hits + 1 else 1 end,
    category_id = excluded.category_id,
    subcategory_id = excluded.subcategory_id,
    updated_at = now();
end $$;

-- Representação padrão de um lançamento
create or replace function public.fe_tx_json(t public.transactions) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', t.id, 'tipo', t.type, 'valor_cents', t.amount_cents, 'data', t.date,
    'descricao', t.description,
    'estabelecimento', (select name from establishments where id = t.establishment_id),
    'categoria_id', t.category_id, 'subcategoria_id', t.subcategory_id,
    'categoria', (select name from categories where id = t.category_id),
    'icone', (select icon from categories where id = t.category_id),
    'subcategoria', (select name from subcategories where id = t.subcategory_id),
    'conta_id', t.account_id, 'conta', (select name from accounts where id = t.account_id),
    'conta_destino_id', t.transfer_account_id, 'conta_destino', (select name from accounts where id = t.transfer_account_id),
    'parcela', t.installment_number, 'parcelas', t.installment_total, 'grupo', t.installment_group,
    'membro_id', t.member_id,
    'membro', case when t.member_id is null then 'Família' else (select coalesce(name,'Membro') from profiles where id = t.member_id) end,
    'registrado_por', (select name from profiles where id = t.created_by),
    'origem', t.origin, 'criado_em', t.created_at)
$$;

-- ---------------------------------------------------------------------
-- CRIAR LANÇAMENTO
-- p: tipo, valor (reais) | valor_cents, data, descricao, estabelecimento,
--    categoria | categoria_id, subcategoria | subcategoria_id,
--    conta | conta_id, conta_destino | conta_destino_id, parcelas,
--    origem, mensagem_original, transcricao, interpretation_id,
--    forcar (ignora alerta de duplicidade), permitir_sem_categoria
-- ---------------------------------------------------------------------
create or replace function public.fe_create_transaction(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := p_user;
  v_member uuid;
  v_type text := lower(coalesce(p->>'tipo', ''));
  v_total bigint;
  v_date date;
  v_today date := fe_today(p_user);
  v_n int := coalesce(nullif(p->>'parcelas','')::int, 1);
  v_estab_name text := nullif(trim(p->>'estabelecimento'), '');
  v_estab uuid;
  v_desc text;
  v_cat uuid; v_sub uuid; v_src text;
  v_acc uuid; v_acc2 uuid;
  v_origin text := coalesce(nullif(p->>'origem',''), 'app_form');
  v_group uuid;
  v_part bigint; v_first bigint;
  v_ids uuid[] := '{}';
  v_tx transactions;
  v_dup transactions;
  i int;
begin
  if p_user is null then perform fe_err('Usuário não identificado.'); end if;
  p_user := fe_owner(v_actor);   -- os dados pertencem à família
  -- de quem é o lançamento: da pessoa que registrou, da Família (compartilhado) ou de outro membro
  if coalesce((p->>'familia')::boolean, false) then v_member := null;
  elsif nullif(p->>'membro_id','') is not null then
    select member_id into v_member from household_members where member_id = (p->>'membro_id')::uuid and owner_id = p_user;
    if v_member is null then perform fe_err('Pessoa não faz parte da família.'); end if;
  else v_member := v_actor;
  end if;
  if v_type not in ('receita','despesa','transferencia','investimento','resgate','ajuste') then
    perform fe_err('Tipo de lançamento inválido.');
  end if;

  -- Valor
  if p ? 'valor_cents' then v_total := (p->>'valor_cents')::bigint;
  elsif p ? 'valor' then v_total := round((p->>'valor')::numeric * 100);
  else return jsonb_build_object('status','needs_value'); end if;
  if v_total is null or (v_total <= 0 and v_type <> 'ajuste') or v_total = 0 then
    perform fe_err('O valor precisa ser maior que zero.');
  end if;
  if abs(v_total) > 100000000000 then perform fe_err('Valor muito alto. Confira o número.'); end if;

  -- Data
  begin
    v_date := coalesce(nullif(p->>'data','')::date, v_today);
  exception when others then perform fe_err('Data inválida.');
  end;
  if v_date < date '2000-01-01' or v_date > v_today + interval '10 years' then
    perform fe_err('Data fora do intervalo permitido.');
  end if;

  if v_n < 1 or v_n > 72 then perform fe_err('Número de parcelas deve ser entre 1 e 72.'); end if;
  if v_n > 1 and v_type not in ('despesa','receita') then perform fe_err('Parcelamento só vale para despesas e receitas.'); end if;

  -- Conta
  if p ? 'conta_id' and nullif(p->>'conta_id','') is not null then
    v_acc := fe_resolve_account(p_user, null, (p->>'conta_id')::uuid);
  else
    v_acc := fe_resolve_account(p_user, p->>'conta');
    if v_acc is null then
      return jsonb_build_object('status','unknown_account','conta', p->>'conta');
    end if;
  end if;
  if v_type = 'transferencia' then
    if nullif(p->>'conta_destino_id','') is not null then
      v_acc2 := fe_resolve_account(p_user, null, (p->>'conta_destino_id')::uuid);
    elsif fe_norm(p->>'conta_destino') is not null then
      v_acc2 := fe_resolve_account(p_user, p->>'conta_destino');
    end if;
    if v_acc2 is null then return jsonb_build_object('status','needs_destination_account','conta_destino', p->>'conta_destino'); end if;
    if v_acc2 = v_acc then perform fe_err('A conta de origem e a de destino são iguais.'); end if;
  end if;

  -- Categoria (somente receitas e despesas)
  if v_type in ('receita','despesa') then
    if nullif(p->>'categoria_id','') is not null then
      select id into v_cat from categories where id = (p->>'categoria_id')::uuid and user_id = p_user
        and kind = v_type and archived_at is null;
      if v_cat is null then perform fe_err('Categoria não encontrada.'); end if;
      if nullif(p->>'subcategoria_id','') is not null then
        select id into v_sub from subcategories where id = (p->>'subcategoria_id')::uuid and category_id = v_cat;
      end if;
      v_src := 'informada';
    else
      select r.category_id, r.subcategory_id, r.source into v_cat, v_sub, v_src
        from fe_resolve_category(p_user, v_type, p->>'categoria', p->>'subcategoria', v_estab_name) r;
    end if;
    if v_cat is null then
      if coalesce((p->>'permitir_sem_categoria')::boolean, false) then
        select id into v_cat from categories where user_id = p_user and kind = v_type and fe_norm(name) = 'outros';
      else
        return jsonb_build_object('status','needs_category','tipo',v_type,'valor_cents',v_total);
      end if;
    end if;
  end if;

  -- Estabelecimento
  if v_estab_name is not null then
    insert into establishments(user_id, name, normalized_name)
      values (p_user, left(v_estab_name, 80), fe_norm(v_estab_name))
      on conflict (user_id, normalized_name) do update set name = establishments.name
      returning id into v_estab;
  end if;

  v_desc := left(coalesce(nullif(trim(p->>'descricao'),''), v_estab_name,
            (select name from subcategories where id = v_sub),
            (select name from categories where id = v_cat), initcap(v_type)), 120);

  -- Duplicidade: mesmo valor/tipo/data/descrição nos últimos 10 minutos
  if not coalesce((p->>'forcar')::boolean, false) then
    select * into v_dup from transactions t
      where t.user_id = p_user and t.deleted_at is null and t.type = v_type and t.date = v_date
        and t.created_at > now() - interval '10 minutes'
        and coalesce(t.installment_number,1) = 1
        and (case when t.installment_total > 1
                  then (select sum(amount_cents) from transactions x where x.installment_group = t.installment_group and x.deleted_at is null)
                  else t.amount_cents end) = v_total
        and (fe_norm(t.description) = fe_norm(v_desc) or (v_estab is not null and t.establishment_id = v_estab))
      order by t.created_at desc limit 1;
    if found then
      return jsonb_build_object('status','possible_duplicate','existente', fe_tx_json(v_dup));
    end if;
  end if;

  -- Gravação (com parcelas, se houver)
  if v_n > 1 then v_group := gen_random_uuid(); end if;
  v_part := (v_total / v_n);
  v_first := v_total - v_part * (v_n - 1);   -- centavos que sobram ficam na 1ª parcela
  for i in 1..v_n loop
    insert into transactions(user_id, member_id, created_by, type, amount_cents, date, description, establishment_id,
      category_id, subcategory_id, account_id, transfer_account_id, payment_method,
      installment_number, installment_total, installment_group, status, origin,
      original_message, transcript, interpretation_id)
    values (p_user, v_member, v_actor, v_type, case when i = 1 then v_first else v_part end,
      (v_date + make_interval(months => i - 1))::date,
      case when v_n > 1 then left(v_desc, 110) || ' (' || i || '/' || v_n || ')' else v_desc end,
      v_estab, v_cat, v_sub, v_acc, v_acc2, nullif(p->>'forma_pagamento',''),
      case when v_n > 1 then i end, case when v_n > 1 then v_n end, v_group,
      case when (v_date + make_interval(months => i - 1))::date > v_today then 'previsto' else 'efetivado' end,
      v_origin, left(p->>'mensagem_original', 2000), left(p->>'transcricao', 4000),
      nullif(p->>'interpretation_id','')::uuid)
    returning * into v_tx;
    v_ids := v_ids || v_tx.id;
    if i = 1 then
      insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
        values (p_user, v_actor, 'transaction', v_tx.id, 'create',
                fe_tx_json(v_tx) || jsonb_build_object('categoria_origem', v_src), v_origin);
    end if;
  end loop;

  perform fe_learn(p_user, v_estab, v_cat, v_sub);

  select * into v_tx from transactions where id = v_ids[1];
  return jsonb_build_object(
    'status', 'created',
    'categoria_origem', v_src,
    'valor_total_cents', v_total,
    'valor_parcela_cents', case when v_n > 1 then v_part end,
    'parcelas', v_n,
    'ids', to_jsonb(v_ids),
    'lancamento', fe_tx_json(v_tx));
end $$;

-- Localiza o alvo de edição/exclusão: id informado ou "último"
create or replace function public.fe_target(p_user uuid, p jsonb) returns public.transactions
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v transactions;
begin
  if nullif(p->>'id','') is not null and p->>'id' <> 'ultimo' then
    select * into v from transactions where id = (p->>'id')::uuid and user_id = fe_owner(p_user) and deleted_at is null;
  else
    select * into v from transactions where user_id = fe_owner(p_user) and created_by = p_user and deleted_at is null
      and (p->>'tipo' is null or type = p->>'tipo')
      order by created_at desc, coalesce(installment_number,1) limit 1;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- EDITAR LANÇAMENTO (inclui "corrigir categoria")
-- p: id | 'ultimo', tipo (filtro do "último"), categoria | categoria_id,
--    subcategoria | subcategoria_id, valor, data, descricao, conta | conta_id
-- ---------------------------------------------------------------------
create or replace function public.fe_update_transaction(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v transactions; v_after transactions;
  v_cat uuid; v_sub uuid; v_acc uuid;
  v_before jsonb;
  v_group_filter boolean;
  v_actor uuid := p_user;
  v_member uuid;
begin
  v := fe_target(v_actor, p);
  p_user := fe_owner(v_actor);
  if v.id is null then return jsonb_build_object('status','not_found'); end if;
  v_before := fe_tx_json(v);
  v_cat := v.category_id; v_sub := v.subcategory_id; v_acc := v.account_id; v_member := v.member_id;
  if coalesce((p->>'familia')::boolean, false) then v_member := null;
  elsif nullif(p->>'membro_id','') is not null then
    select member_id into v_member from household_members where member_id = (p->>'membro_id')::uuid and owner_id = p_user;
    if v_member is null then perform fe_err('Pessoa não faz parte da família.'); end if;
  end if;
  v_group_filter := v.installment_group is not null;

  if nullif(p->>'categoria_id','') is not null then
    select id into v_cat from categories where id = (p->>'categoria_id')::uuid and user_id = p_user and kind = v.type;
    if v_cat is null then perform fe_err('Categoria não encontrada.'); end if;
    v_sub := null;
    if nullif(p->>'subcategoria_id','') is not null then
      select id into v_sub from subcategories where id = (p->>'subcategoria_id')::uuid and category_id = v_cat;
    end if;
  elsif fe_norm(p->>'categoria') is not null or fe_norm(p->>'subcategoria') is not null then
    select r.category_id, r.subcategory_id into v_cat, v_sub
      from fe_resolve_category(p_user, v.type, p->>'categoria', p->>'subcategoria', null) r;
    if v_cat is null then
      return jsonb_build_object('status','unknown_category','categoria', coalesce(p->>'categoria', p->>'subcategoria'));
    end if;
  end if;

  if nullif(p->>'conta_id','') is not null then v_acc := fe_resolve_account(p_user, null, (p->>'conta_id')::uuid);
  elsif fe_norm(p->>'conta') is not null then
    v_acc := fe_resolve_account(p_user, p->>'conta');
    if v_acc is null then return jsonb_build_object('status','unknown_account','conta',p->>'conta'); end if;
  end if;

  if (p ? 'valor' or p ? 'valor_cents' or p ? 'data') and v_group_filter then
    perform fe_err('Para mudar valor ou data de uma compra parcelada, apague e lance novamente.');
  end if;

  update transactions t set
    category_id = v_cat,
    subcategory_id = v_sub,
    member_id = v_member,
    account_id = v_acc,
    amount_cents = coalesce((p->>'valor_cents')::bigint, round((p->>'valor')::numeric * 100)::bigint, t.amount_cents),
    date = coalesce(nullif(p->>'data','')::date, t.date),
    description = case when nullif(trim(p->>'descricao'),'') is null then t.description
                       when t.installment_total > 1 then left(trim(p->>'descricao'),110) || ' (' || t.installment_number || '/' || t.installment_total || ')'
                       else left(trim(p->>'descricao'),120) end,
    updated_at = now()
  where t.user_id = p_user and t.deleted_at is null
    and (t.id = v.id or (v_group_filter and t.installment_group = v.installment_group));

  select * into v_after from transactions where id = v.id;
  if v_after.amount_cents <= 0 and v_after.type <> 'ajuste' then perform fe_err('O valor precisa ser maior que zero.'); end if;

  if v_after.category_id is distinct from v.category_id or v_after.subcategory_id is distinct from v.subcategory_id then
    perform fe_learn(p_user, v.establishment_id, v_after.category_id, v_after.subcategory_id);
  end if;

  insert into audit_logs(user_id, actor_id, entity, entity_id, action, before, after, source)
    values (p_user, v_actor, 'transaction', v.id, 'update', v_before, fe_tx_json(v_after), coalesce(p->>'origem','app_form'));

  return jsonb_build_object('status','updated','antes', v_before, 'lancamento', fe_tx_json(v_after));
end $$;

-- ---------------------------------------------------------------------
-- APAGAR LANÇAMENTO (exclusão lógica: fica na auditoria)
-- ---------------------------------------------------------------------
create or replace function public.fe_delete_transaction(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v transactions; v_count int; v_actor uuid := p_user;
begin
  v := fe_target(v_actor, p);
  if v.id is null then return jsonb_build_object('status','not_found'); end if;
  p_user := fe_owner(v_actor);
  update transactions t set deleted_at = now(), updated_at = now()
    where t.user_id = p_user and t.deleted_at is null
      and (t.id = v.id or (v.installment_group is not null and t.installment_group = v.installment_group));
  get diagnostics v_count = row_count;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, before, source)
    values (p_user, v_actor, 'transaction', v.id, 'delete', fe_tx_json(v), coalesce(p->>'origem','app_form'));
  return jsonb_build_object('status','deleted','quantidade', v_count, 'lancamento', fe_tx_json(v),
    'valor_total_cents', case when v.installment_group is not null
      then (select sum(amount_cents) from transactions where installment_group = v.installment_group) else v.amount_cents end);
end $$;

-- ---------------------------------------------------------------------
-- CONSULTAS  (todas no nível da FAMÍLIA; filtro opcional por pessoa)
--   p.membro_id: vazio = todos | 'familia' = só compartilhados | uuid = pessoa
-- ---------------------------------------------------------------------
create or replace function public.fe_member_match(t_member uuid, f text) returns boolean
language sql immutable as $$
  select case when nullif(f,'') is null then true
              when f = 'familia' then t_member is null
              else t_member = f::uuid end
$$;

-- Totais por pessoa (para "família e individual")
create or replace function public.fe_member_split(p_owner uuid, p_type text, p_ini date, p_fim date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('membro_id', x.member_id,
           'membro', case when x.member_id is null then 'Família' else coalesce(pr.name,'Membro') end,
           'total_cents', x.total) order by x.total desc), '[]')
  from (select member_id, sum(amount_cents) total from transactions
        where user_id = p_owner and deleted_at is null and type = p_type and date between p_ini and p_fim
        group by member_id) x
  left join profiles pr on pr.id = x.member_id
$$;

-- Saldos por conta (somente lançamentos até hoje)
create or replace function public.fe_balances(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with today as (select coalesce(nullif(p->>'ate','')::date, fe_today(p_user)) d),
  o as (select fe_owner(p_user) id),
  bal as (
    select a.id, a.name, a.type, a.institution, a.is_default, a.status,
      a.initial_balance_cents + coalesce((
        select sum(case
          when t.account_id = a.id and t.type in ('receita','resgate','ajuste') then t.amount_cents
          when t.account_id = a.id and t.type in ('despesa','investimento','transferencia') then -t.amount_cents
          when t.transfer_account_id = a.id and t.type = 'transferencia' then t.amount_cents
          else 0 end)
        from transactions t
        where t.user_id = (select id from o) and t.deleted_at is null and t.card_id is null
          and t.date <= (select d from today)
          and (t.account_id = a.id or t.transfer_account_id = a.id)), 0) as balance_cents
    from accounts a where a.user_id = (select id from o)
  )
  select jsonb_build_object(
    'contas', coalesce(jsonb_agg(jsonb_build_object('id',id,'nome',name,'tipo',type,'instituicao',institution,
              'padrao',is_default,'status',status,'saldo_cents',balance_cents) order by is_default desc, name), '[]'),
    'total_cents', coalesce(sum(balance_cents) filter (where status = 'ativa'), 0))
  from bal
$$;

-- Totais de um período, com filtros
-- p: inicio, fim, tipo (despesa|receita), categoria, subcategoria, estabelecimento, somente_parcelas
create or replace function public.fe_period_totals(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ini date; v_fim date;
  v_type text := coalesce(nullif(p->>'tipo',''), 'despesa');
  v_cat uuid; v_sub uuid; v_estab text := fe_norm(p->>'estabelecimento');
  v_res jsonb;
begin
  p_user := fe_owner(p_user);
  select inicio, fim into v_ini, v_fim from fe_month_bounds(null, p_user);
  v_ini := coalesce(nullif(p->>'inicio','')::date, v_ini);
  v_fim := coalesce(nullif(p->>'fim','')::date, v_fim);
  if fe_norm(p->>'categoria') is not null or fe_norm(p->>'subcategoria') is not null then
    select r.category_id, r.subcategory_id into v_cat, v_sub
      from fe_resolve_category(p_user, v_type, p->>'categoria', p->>'subcategoria', null) r;
    if v_cat is null and v_estab is null then
      v_estab := fe_norm(coalesce(p->>'subcategoria', p->>'categoria'));  -- tenta como estabelecimento/descrição
    end if;
  end if;

  with f as (
    select t.* from transactions t
    left join establishments e on e.id = t.establishment_id
    where t.user_id = p_user and t.deleted_at is null and t.type = v_type
      and t.date between v_ini and v_fim
      and (v_cat is null or t.category_id = v_cat)
      and (v_sub is null or t.subcategory_id = v_sub)
      and (v_estab is null or e.normalized_name like '%' || v_estab || '%' or fe_norm(t.description) like '%' || v_estab || '%')
      and (not coalesce((p->>'somente_parcelas')::boolean,false) or t.installment_group is not null)
      and fe_member_match(t.member_id, p->>'membro_id')
  )
  select jsonb_build_object(
    'inicio', v_ini, 'fim', v_fim, 'tipo', v_type,
    'categoria', (select name from categories where id = v_cat),
    'subcategoria', (select name from subcategories where id = v_sub),
    'estabelecimento', case when v_cat is null then v_estab end,
    'total_cents', coalesce((select sum(amount_cents) from f), 0),
    'quantidade', (select count(*) from f),
    'por_membro', coalesce((select jsonb_agg(jsonb_build_object('membro_id', member_id,
        'membro', case when member_id is null then 'Família' else (select coalesce(name,'Membro') from profiles where id = member_id) end,
        'total_cents', tot) order by tot desc) from (select member_id, sum(amount_cents) tot from f group by member_id) z), '[]'),
    'por_categoria', coalesce((select jsonb_agg(x order by (x->>'total_cents')::bigint desc) from (
        select jsonb_build_object('categoria', coalesce(c.name,'Sem categoria'), 'icone', c.icon,
               'total_cents', sum(f.amount_cents)) x
        from f left join categories c on c.id = f.category_id group by c.name, c.icon
        order by sum(f.amount_cents) desc) q), '[]'))
  into v_res;
  return v_res;
end $$;

-- Maior lançamento do período
create or replace function public.fe_largest(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_ini date; v_fim date; v transactions;
begin
  p_user := fe_owner(p_user);
  select inicio, fim into v_ini, v_fim from fe_month_bounds(null, p_user);
  v_ini := coalesce(nullif(p->>'inicio','')::date, v_ini);
  v_fim := coalesce(nullif(p->>'fim','')::date, v_fim);
  select * into v from transactions
    where user_id = p_user and deleted_at is null and type = coalesce(nullif(p->>'tipo',''),'despesa')
      and date between v_ini and v_fim and fe_member_match(member_id, p->>'membro_id')
    order by amount_cents desc, date desc limit 1;
  return jsonb_build_object('inicio', v_ini, 'fim', v_fim,
    'lancamento', case when v.id is null then null else fe_tx_json(v) end);
end $$;

-- Visão geral do mês (dashboard)
create or replace function public.fe_month_overview(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ini date; v_fim date; v_today date := fe_today(p_user);
  v_res jsonb;
  v_f text := p->>'membro_id';
begin
  p_user := fe_owner(p_user);
  select inicio, fim into v_ini, v_fim from fe_month_bounds(p->>'mes', p_user);

  with m as (
    select * from transactions
    where user_id = p_user and deleted_at is null and date between v_ini and v_fim and fe_member_match(member_id, v_f)
  ),
  months as (
    select generate_series(date_trunc('month', v_ini) - interval '5 months', date_trunc('month', v_ini), interval '1 month')::date as mi
  )
  select jsonb_build_object(
    'mes', to_char(v_ini, 'YYYY-MM'), 'inicio', v_ini, 'fim', v_fim, 'hoje', v_today,
    'receitas_cents',  coalesce((select sum(amount_cents) from m where type='receita' and date <= v_today), 0),
    'despesas_cents',  coalesce((select sum(amount_cents) from m where type='despesa' and date <= v_today), 0),
    'investimentos_cents', coalesce((select sum(amount_cents) from m where type='investimento' and date <= v_today), 0)
                         - coalesce((select sum(amount_cents) from m where type='resgate' and date <= v_today), 0),
    'receitas_previstas_cents', coalesce((select sum(amount_cents) from m where type='receita' and date > v_today), 0),
    'compromissos_futuros_cents', coalesce((select sum(amount_cents) from m where type='despesa' and date > v_today), 0),
    'receitas_mes_total_cents', coalesce((select sum(amount_cents) from m where type='receita'), 0),
    'despesas_mes_total_cents', coalesce((select sum(amount_cents) from m where type='despesa'), 0),
    'por_categoria', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('categoria_id', c.id, 'categoria', coalesce(c.name,'Sem categoria'), 'icone', c.icon,
          'total_cents', sum(m.amount_cents),
          'orcamento_cents', (select amount_cents from budgets b where b.user_id = p_user and b.category_id = c.id and b.month = v_ini)) x
        from m left join categories c on c.id = m.category_id
        where m.type = 'despesa' group by c.id, c.name, c.icon order by sum(m.amount_cents) desc) q), '[]'),
    'por_conta', (fe_balances(p_user)->'contas'),
    'saldo_contas_cents', (fe_balances(p_user)->'total_cents'),
    'evolucao', (select jsonb_agg(jsonb_build_object(
        'mes', to_char(mi,'YYYY-MM'),
        'receitas_cents', coalesce((select sum(amount_cents) from transactions t where t.user_id=p_user and t.deleted_at is null and fe_member_match(t.member_id, v_f) and t.type='receita' and t.date between mi and (mi + interval '1 month' - interval '1 day')::date), 0),
        'despesas_cents', coalesce((select sum(amount_cents) from transactions t where t.user_id=p_user and t.deleted_at is null and fe_member_match(t.member_id, v_f) and t.type='despesa' and t.date between mi and (mi + interval '1 month' - interval '1 day')::date), 0),
        'patrimonio_cents', (fe_balances(p_user, jsonb_build_object('ate', least((mi + interval '1 month' - interval '1 day')::date, v_today)))->>'total_cents')::bigint
      ) order by mi) from months),
    'recentes', coalesce((select jsonb_agg(fe_tx_json(t) order by t.date desc, t.created_at desc) from (
        select * from transactions where user_id = p_user and deleted_at is null and date <= v_today
          and fe_member_match(member_id, v_f)
        order by date desc, created_at desc limit 8) t), '[]'),
    'despesas_por_membro', fe_member_split(p_user, 'despesa', v_ini, least(v_fim, v_today)),
    'receitas_por_membro', fe_member_split(p_user, 'receita', v_ini, least(v_fim, v_today)),
    'meta_economia_cents', (select monthly_savings_goal_cents from profiles where id = p_user)
  ) into v_res;
  return v_res;
end $$;

-- "Quanto posso gastar até o fim do mês?" — ESTIMATIVA
create or replace function public.fe_available(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date := fe_today(p_user);
  v_fim date := (date_trunc('month', v_today) + interval '1 month' - interval '1 day')::date;
  v_saldo bigint; v_rp bigint; v_dp bigint; v_meta bigint; v_disp bigint; v_dias int;
  v_gasto bigint;
begin
  p_user := fe_owner(p_user);
  v_saldo := (fe_balances(p_user)->>'total_cents')::bigint;
  select coalesce(sum(amount_cents) filter (where type='receita'),0),
         coalesce(sum(amount_cents) filter (where type='despesa'),0)
    into v_rp, v_dp
    from transactions where user_id = p_user and deleted_at is null and date > v_today and date <= v_fim and card_id is null;
  select coalesce(sum(amount_cents),0) into v_gasto from transactions
    where user_id = p_user and deleted_at is null and type='despesa' and date between date_trunc('month', v_today)::date and v_today;
  v_meta := coalesce((select monthly_savings_goal_cents from profiles where id = p_user), 0);
  v_disp := v_saldo + v_rp - v_dp - v_meta;
  v_dias := v_fim - v_today + 1;
  return jsonb_build_object(
    'hoje', v_today, 'fim_mes', v_fim, 'dias_restantes', v_dias,
    'saldo_atual_cents', v_saldo,
    'receitas_previstas_cents', v_rp,
    'despesas_previstas_cents', v_dp,
    'meta_economia_cents', v_meta,
    'gasto_mes_cents', v_gasto,
    'disponivel_cents', v_disp,
    'diario_cents', case when v_disp > 0 then v_disp / v_dias else 0 end,
    'compra_cents', nullif(p->>'valor_cents','')::bigint);
end $$;

-- Comparação de meses e análise de comportamento
create or replace function public.fe_analysis(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date := fe_today(p_user);
  v_ini date := date_trunc('month', v_today)::date;
  v_fim date := (v_ini + interval '1 month' - interval '1 day')::date;
  v_dia int := extract(day from v_today);
  v_prev_ini date := (v_ini - interval '1 month')::date;
  v_prev_fim date := (v_ini - interval '1 day')::date;
  v_prev_same date := least(v_prev_ini + (v_dia - 1), v_prev_fim);
  v_res jsonb;
begin
  p_user := fe_owner(p_user);
  with t as (select * from transactions where user_id = p_user and deleted_at is null and type in ('despesa','receita')),
  cats as (
    select coalesce(c.name,'Sem categoria') categoria, c.icon,
      coalesce(sum(t.amount_cents) filter (where t.date between v_ini and v_today),0) atual,
      coalesce(sum(t.amount_cents) filter (where t.date between v_prev_ini and v_prev_same),0) anterior_mesmo_periodo,
      coalesce(sum(t.amount_cents) filter (where t.date between v_prev_ini and v_prev_fim),0) anterior,
      coalesce(sum(t.amount_cents) filter (where t.date between (v_ini - interval '3 months')::date and v_prev_fim),0) / 3 media_3m
    from t left join categories c on c.id = t.category_id
    where t.type = 'despesa' group by c.name, c.icon
  )
  select jsonb_build_object(
    'hoje', v_today, 'dia', v_dia, 'dias_no_mes', extract(day from v_fim),
    'despesas_atual_cents', coalesce((select sum(amount_cents) from t where type='despesa' and date between v_ini and v_today),0),
    'receitas_atual_cents', coalesce((select sum(amount_cents) from t where type='receita' and date between v_ini and v_today),0),
    'despesas_anterior_cents', coalesce((select sum(amount_cents) from t where type='despesa' and date between v_prev_ini and v_prev_fim),0),
    'receitas_anterior_cents', coalesce((select sum(amount_cents) from t where type='receita' and date between v_prev_ini and v_prev_fim),0),
    'despesas_anterior_mesmo_periodo_cents', coalesce((select sum(amount_cents) from t where type='despesa' and date between v_prev_ini and v_prev_same),0),
    'media_despesas_3m_cents', coalesce((select sum(amount_cents) from t where type='despesa' and date between (v_ini - interval '3 months')::date and v_prev_fim),0) / 3,
    'meses_com_historico', (select count(distinct date_trunc('month', date)) from t where date < v_ini and date >= (v_ini - interval '3 months')::date),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('categoria',categoria,'icone',icon,'atual_cents',atual,
        'anterior_cents',anterior,'anterior_mesmo_periodo_cents',anterior_mesmo_periodo,'media_3m_cents',media_3m) order by atual desc)
        from cats where atual > 0 or anterior > 0), '[]')
  ) into v_res;
  return v_res;
end $$;

-- ---------------------------------------------------------------------
-- CONVERSA, INTERPRETAÇÕES E CONTEXTO
-- ---------------------------------------------------------------------
create or replace function public.fe_conversation(p_user uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  select id into v from chat_conversations where user_id = p_user;
  if v is null then
    insert into chat_conversations(user_id) values (p_user) on conflict (user_id) do nothing returning id into v;
    if v is null then select id into v from chat_conversations where user_id = p_user; end if;
  end if;
  return v;
end $$;

create or replace function public.fe_chat_append(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_conv uuid := fe_conversation(p_user);
begin
  insert into chat_messages(conversation_id, user_id, role, channel, message_type, content, cards)
    values (v_conv, p_user, p->>'role', coalesce(p->>'channel','app'), coalesce(p->>'message_type','text'),
            left(coalesce(p->>'content',''), 8000), p->'cards')
    returning id into v_id;
  if p->>'message_type' = 'audio' and p->>'role' = 'user' then
    insert into audio_messages(user_id, chat_message_id, provider, transcript, storage_path)
      values (p_user, v_id, p->>'audio_provider', p->>'content', p->>'audio_path');
  end if;
  update chat_conversations set updated_at = now() where id = v_conv;
  return jsonb_build_object('id', v_id);
end $$;

-- Lê e (opcionalmente) troca a pergunta pendente da conversa
create or replace function public.fe_chat_state(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_conv uuid := fe_conversation(p_user); v_old jsonb;
begin
  select pending into v_old from chat_conversations where id = v_conv;
  if p ? 'pending' then
    update chat_conversations set pending = case when jsonb_typeof(p->'pending') = 'null' then null else p->'pending' end,
      updated_at = now() where id = v_conv;
  end if;
  return jsonb_build_object('pending', v_old);
end $$;

create or replace function public.fe_log_interpretation(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into ai_interpretations(user_id, chat_message_id, provider, model, input, output, confidence)
    values (p_user, nullif(p->>'chat_message_id','')::uuid, coalesce(p->>'provider','regras'), p->>'model',
            left(coalesce(p->>'input',''), 8000), coalesce(p->'output','{}'), nullif(p->>'confidence','')::numeric)
    returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Contexto do usuário para a IA (categorias e contas existentes)
create or replace function public.fe_context(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with o as (select fe_owner(p_user) id)
  select jsonb_build_object(
    'hoje', fe_today(p_user),
    'eu', p_user,
    'nome', (select name from profiles where id = p_user),
    'membros', coalesce((select jsonb_agg(jsonb_build_object('id', hm.member_id, 'nome', coalesce(pr.name,'Membro'),
        'eu', hm.member_id = p_user) order by hm.joined_at)
        from household_members hm left join profiles pr on pr.id = hm.member_id where hm.owner_id = (select id from o)), '[]'),
    'categorias', coalesce((select jsonb_agg(jsonb_build_object('tipo', c.kind, 'nome', c.name, 'icone', c.icon,
        'subcategorias', coalesce((select jsonb_agg(s.name order by s.name) from subcategories s where s.category_id = c.id and s.archived_at is null), '[]'))
        order by c.kind, c.name) from categories c where c.user_id = (select id from o) and c.archived_at is null), '[]'),
    'contas', coalesce((select jsonb_agg(name order by is_default desc, name) from accounts where user_id = (select id from o) and status = 'ativa'), '[]'))
$$;

-- ---------------------------------------------------------------------
-- WHATSAPP: vínculo número <-> usuário
-- ---------------------------------------------------------------------
create or replace function public.fe_whatsapp_lookup(p_user uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('user_id',
    (select user_id from whatsapp_connections where phone_number = regexp_replace(p->>'phone','\D','','g') and status = 'ativo'))
$$;

-- Valida um código de conexão (gerado no app) e devolve a pessoa
create or replace function public.fe_take_link_code(p_code text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  update link_codes set used_at = now()
    where code = trim(p_code) and expires_at > now() and used_at is null returning user_id into v;
  return v;
end $$;

create or replace function public.fe_whatsapp_link(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid; v_phone text := regexp_replace(p->>'phone','\D','','g');
begin
  if length(v_phone) < 10 then return jsonb_build_object('status','invalid_phone'); end if;
  v_user := fe_take_link_code(p->>'code');
  if v_user is null then return jsonb_build_object('status','invalid_code'); end if;
  update whatsapp_connections set phone_number = null, status = 'pendente' where phone_number = v_phone and user_id <> v_user;
  insert into whatsapp_connections(user_id, phone_number, status, verified_at) values (v_user, v_phone, 'ativo', now())
    on conflict (user_id) do update set phone_number = excluded.phone_number, status = 'ativo', verified_at = now();
  insert into audit_logs(user_id, actor_id, entity, action, after, source)
    values (fe_owner(v_user), v_user, 'whatsapp_connection', 'link', jsonb_build_object('phone_final', right(v_phone, 4)), 'whatsapp');
  return jsonb_build_object('status','linked','user_id', v_user);
end $$;

-- TELEGRAM: vínculo chat <-> pessoa
create or replace function public.fe_telegram_lookup(p_user uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('user_id', (select user_id from telegram_connections where chat_id = p->>'chat_id'))
$$;

create or replace function public.fe_telegram_link(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid;
begin
  if nullif(p->>'chat_id','') is null then return jsonb_build_object('status','invalid_chat'); end if;
  v_user := fe_take_link_code(p->>'code');
  if v_user is null then return jsonb_build_object('status','invalid_code'); end if;
  update telegram_connections set chat_id = 'desvinculado-' || id::text where chat_id = p->>'chat_id' and user_id <> v_user;
  insert into telegram_connections(user_id, chat_id, username) values (v_user, p->>'chat_id', nullif(p->>'username',''))
    on conflict (user_id) do update set chat_id = excluded.chat_id, username = excluded.username, verified_at = now();
  insert into audit_logs(user_id, actor_id, entity, action, source)
    values (fe_owner(v_user), v_user, 'telegram_connection', 'link', 'telegram');
  return jsonb_build_object('status','linked','user_id', v_user);
end $$;

-- Reserva o envio de 1 mensagem no mês, respeitando um limite (trava do plano gratuito)
create or replace function public.fe_usage_take(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_month text := to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM');
  v_limit int := coalesce(nullif(p->>'limite','')::int, 950);
  v_sent int;
begin
  insert into messaging_usage(channel, month, sent) values (p->>'channel', v_month, 0) on conflict do nothing;
  update messaging_usage set sent = sent + 1
    where channel = p->>'channel' and month = v_month and sent < v_limit
    returning sent into v_sent;
  if v_sent is null then
    select sent into v_sent from messaging_usage where channel = p->>'channel' and month = v_month;
    return jsonb_build_object('allowed', false, 'sent', v_sent, 'limite', v_limit);
  end if;
  return jsonb_build_object('allowed', true, 'sent', v_sent, 'limite', v_limit);
end $$;
