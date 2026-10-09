-- =====================================================================
-- Categorias reorganizadas (receitas e despesas) — lista nova, mais completa.
-- As categorias existentes são renomeadas/juntadas SEM perder lançamentos:
-- lançamentos, contas fixas, orçamentos e o aprendizado por estabelecimento
-- acompanham a categoria/subcategoria para onde ela foi.
-- =====================================================================

-- move uma subcategoria para outra categoria (e opcionalmente com outro nome); junta se já existir lá
create or replace function public.fe_sub_move(p_sub uuid, p_to_cat uuid, p_name text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare s subcategories; v_target uuid; v_name text;
begin
  select * into s from subcategories where id = p_sub;
  if s.id is null then return null; end if;
  v_name := coalesce(p_name, s.name);
  select id into v_target from subcategories where category_id = p_to_cat and lower(name) = lower(v_name) and id <> s.id;
  if v_target is not null then
    update subcategories set archived_at = null where id = v_target;
    update transactions set category_id = p_to_cat, subcategory_id = v_target where subcategory_id = s.id;
    update recurring_transactions set category_id = p_to_cat, subcategory_id = v_target where subcategory_id = s.id;
    update establishment_categories set category_id = p_to_cat, subcategory_id = v_target where subcategory_id = s.id;
    update subcategories set archived_at = coalesce(archived_at, now()), name = left(name || ' (antiga ' || left(s.id::text, 4) || ')', 80) where id = s.id;
    return v_target;
  end if;
  update subcategories set category_id = p_to_cat, name = v_name where id = s.id;
  update transactions set category_id = p_to_cat where subcategory_id = s.id;
  update recurring_transactions set category_id = p_to_cat where subcategory_id = s.id;
  update establishment_categories set category_id = p_to_cat where subcategory_id = s.id;
  return s.id;
end $$;

-- junta a categoria p_from dentro de p_to
create or replace function public.fe_cat_merge(p_from uuid, p_to uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  if p_from is null or p_to is null or p_from = p_to then return; end if;
  for r in select id from subcategories where category_id = p_from loop perform fe_sub_move(r.id, p_to); end loop;
  update transactions set category_id = p_to where category_id = p_from;
  update recurring_transactions set category_id = p_to where category_id = p_from;
  update establishment_categories set category_id = p_to where category_id = p_from;
  update budgets b set amount_cents = b.amount_cents + f.amount_cents, updated_at = now()
    from budgets f where f.category_id = p_from and b.category_id = p_to and b.user_id = f.user_id and b.month = f.month;
  update budgets f set category_id = p_to where f.category_id = p_from
    and not exists (select 1 from budgets b where b.category_id = p_to and b.user_id = f.user_id and b.month = f.month);
  update categories set archived_at = coalesce(archived_at, now()), is_system = false,
      name = left(name || ' (antiga ' || left(id::text, 4) || ')', 80)
    where id = p_from;
end $$;

-- garante a categoria "p_new" (renomeando/juntando as antigas da lista p_olds)
create or replace function public.fe_cat_ensure(p_user uuid, p_kind text, p_new text, p_icon text, p_olds text[]) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; r record;
begin
  select id into v_id from categories where user_id = p_user and kind = p_kind and lower(name) = lower(p_new);
  if v_id is not null then
    update categories set archived_at = null, is_system = true, icon = coalesce(nullif(icon,''), p_icon) where id = v_id;
  else
    -- a primeira antiga encontrada vira a nova (mantém o mesmo id)
    select c.id into v_id from categories c, unnest(p_olds) with ordinality o(nm, ord)
      where c.user_id = p_user and c.kind = p_kind and c.archived_at is null and fe_norm(c.name) = fe_norm(o.nm)
      order by o.ord limit 1;
    if v_id is not null then
      update categories set name = p_new, icon = p_icon, is_system = true where id = v_id;
    else
      insert into categories(user_id, kind, name, icon, is_system) values (p_user, p_kind, p_new, p_icon, true) returning id into v_id;
    end if;
  end if;
  -- as outras antigas são juntadas nela
  for r in select c.id from categories c where c.user_id = p_user and c.kind = p_kind and c.archived_at is null and c.id <> v_id
             and fe_norm(c.name) = any (select fe_norm(x) from unnest(p_olds) x) loop
    perform fe_cat_merge(r.id, v_id);
  end loop;
  return v_id;
end $$;

-- move (ou renomeia) uma subcategoria de qualquer categoria para dentro de p_cat
create or replace function public.fe_sub_ensure(p_user uuid, p_cat uuid, p_name text, p_from_cat_names text[] default '{}', p_old_names text[] default '{}') returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_kind text;
begin
  select kind into v_kind from categories where id = p_cat;
  -- subcategorias antigas (nome antigo ou atual) nesta categoria ou nas categorias de origem indicadas
  for r in select s.id from subcategories s join categories c on c.id = s.category_id
           where s.user_id = p_user and c.kind = v_kind and s.archived_at is null
             and fe_norm(s.name) = any (select fe_norm(x) from unnest(array_append(p_old_names, p_name)) x)
             and (s.category_id = p_cat or fe_norm(regexp_replace(c.name, ' \(antiga [0-9a-f]{4}\)$', '')) = any (select fe_norm(x) from unnest(p_from_cat_names) x))
  loop
    perform fe_sub_move(r.id, p_cat, p_name);
  end loop;
  insert into subcategories(user_id, category_id, name) values (p_user, p_cat, p_name) on conflict do nothing;
  update subcategories set archived_at = null where category_id = p_cat and lower(name) = lower(p_name);
end $$;

-- a nova organização (também usada para quem cria conta)
create or replace function public.fe_seed_categories(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c uuid;
begin
  -- ---------------- DESPESAS ----------------
  c := fe_cat_ensure(p_user, 'despesa', 'Moradia e contas da casa', '🏠', array['Moradia','Casa','Moradia e contas da casa']);
  perform fe_sub_ensure(p_user, c, 'Aluguel');
  perform fe_sub_ensure(p_user, c, 'Financiamento');
  perform fe_sub_ensure(p_user, c, 'Condomínio');
  perform fe_sub_ensure(p_user, c, 'Água');
  perform fe_sub_ensure(p_user, c, 'Luz', '{}', array['Energia','Energia elétrica']);
  perform fe_sub_ensure(p_user, c, 'Gás');
  perform fe_sub_ensure(p_user, c, 'Internet');
  perform fe_sub_ensure(p_user, c, 'Manutenção');

  c := fe_cat_ensure(p_user, 'despesa', 'Alimentação', '🍽️', array['Alimentação','Alimentacao','Comida']);
  perform fe_sub_ensure(p_user, c, 'Supermercado');
  perform fe_sub_ensure(p_user, c, 'Açougue');
  perform fe_sub_ensure(p_user, c, 'Feira');
  perform fe_sub_ensure(p_user, c, 'Padaria');
  perform fe_sub_ensure(p_user, c, 'Restaurante');
  perform fe_sub_ensure(p_user, c, 'Delivery');
  perform fe_sub_ensure(p_user, c, 'Lanches');

  c := fe_cat_ensure(p_user, 'despesa', 'Transporte', '🚗', array['Transporte']);
  perform fe_sub_ensure(p_user, c, 'Combustível');
  perform fe_sub_ensure(p_user, c, 'Uber e táxi', '{}', array['Uber','Taxi','Táxi']);
  perform fe_sub_ensure(p_user, c, 'Ônibus e metrô', '{}', array['Transporte público','Onibus','Ônibus']);
  perform fe_sub_ensure(p_user, c, 'Estacionamento');
  perform fe_sub_ensure(p_user, c, 'Pedágio');
  perform fe_sub_ensure(p_user, c, 'Manutenção');
  perform fe_sub_ensure(p_user, c, 'IPVA');

  c := fe_cat_ensure(p_user, 'despesa', 'Saúde', '🩺', array['Saúde','Saude']);
  perform fe_sub_ensure(p_user, c, 'Plano de saúde');
  perform fe_sub_ensure(p_user, c, 'Consultas');
  perform fe_sub_ensure(p_user, c, 'Exames');
  perform fe_sub_ensure(p_user, c, 'Farmácia', '{}', array['Medicamentos','Remédios']);
  perform fe_sub_ensure(p_user, c, 'Dentista', '{}', array['Odontologia']);

  c := fe_cat_ensure(p_user, 'despesa', 'Educação', '📚', array['Educação','Educacao']);
  perform fe_sub_ensure(p_user, c, 'Escola');
  perform fe_sub_ensure(p_user, c, 'Faculdade');
  perform fe_sub_ensure(p_user, c, 'Cursos');
  perform fe_sub_ensure(p_user, c, 'Livros');
  perform fe_sub_ensure(p_user, c, 'Material escolar', '{}', array['Material']);

  c := fe_cat_ensure(p_user, 'despesa', 'Filhos e família', '👨‍👩‍👧', array['Filhos','Família','Familia','Filhos e família']);
  perform fe_sub_ensure(p_user, c, 'Roupas infantis');
  perform fe_sub_ensure(p_user, c, 'Brinquedos');
  perform fe_sub_ensure(p_user, c, 'Atividades');
  perform fe_sub_ensure(p_user, c, 'Mesada');
  perform fe_sub_ensure(p_user, c, 'Despesas escolares');

  c := fe_cat_ensure(p_user, 'despesa', 'Cuidados pessoais', '💇', array['Cuidados pessoais','Beleza']);
  perform fe_sub_ensure(p_user, c, 'Cabeleireiro');
  perform fe_sub_ensure(p_user, c, 'Estética');
  perform fe_sub_ensure(p_user, c, 'Higiene pessoal');
  perform fe_sub_ensure(p_user, c, 'Academia');

  c := fe_cat_ensure(p_user, 'despesa', 'Vestuário', '👕', array['Vestuário','Vestuario','Roupas']);
  perform fe_sub_ensure(p_user, c, 'Roupas');
  perform fe_sub_ensure(p_user, c, 'Calçados');
  perform fe_sub_ensure(p_user, c, 'Acessórios');

  c := fe_cat_ensure(p_user, 'despesa', 'Viagens', '✈️', array['Viagens','Viagem']);
  perform fe_sub_ensure(p_user, c, 'Passagens');
  perform fe_sub_ensure(p_user, c, 'Hospedagem');
  perform fe_sub_ensure(p_user, c, 'Passeios na viagem');
  perform fe_sub_ensure(p_user, c, 'Alimentação em viagens');
  perform fe_sub_ensure(p_user, c, 'Outros da viagem', array['Lazer','Lazer e entretenimento'], array['Viagens']);   -- a antiga Lazer > Viagens vem para cá

  c := fe_cat_ensure(p_user, 'despesa', 'Assinaturas e serviços', '📺', array['Assinaturas','Assinaturas e serviços']);
  perform fe_sub_ensure(p_user, c, 'Streaming', array['Lazer','Lazer e entretenimento']);
  perform fe_sub_ensure(p_user, c, 'Música');
  perform fe_sub_ensure(p_user, c, 'Aplicativos');
  perform fe_sub_ensure(p_user, c, 'Armazenamento em nuvem');

  c := fe_cat_ensure(p_user, 'despesa', 'Lazer e entretenimento', '🎉', array['Lazer','Entretenimento','Lazer e entretenimento']);
  perform fe_sub_ensure(p_user, c, 'Cinema');
  perform fe_sub_ensure(p_user, c, 'Passeios');
  perform fe_sub_ensure(p_user, c, 'Eventos e shows', '{}', array['Eventos']);
  perform fe_sub_ensure(p_user, c, 'Restaurantes de lazer');
  perform fe_sub_ensure(p_user, c, 'Jogos');
  perform fe_sub_ensure(p_user, c, 'Hobbies');

  c := fe_cat_ensure(p_user, 'despesa', 'Compras pessoais e casa', '🛋️', array['Compras','Compras pessoais e casa']);
  perform fe_sub_ensure(p_user, c, 'Eletrônicos');
  perform fe_sub_ensure(p_user, c, 'Móveis');
  perform fe_sub_ensure(p_user, c, 'Eletrodomésticos');
  perform fe_sub_ensure(p_user, c, 'Utensílios');
  perform fe_sub_ensure(p_user, c, 'Compras online');

  c := fe_cat_ensure(p_user, 'despesa', 'Pets', '🐾', array['Pets','Pet','Animais']);
  perform fe_sub_ensure(p_user, c, 'Ração');
  perform fe_sub_ensure(p_user, c, 'Veterinário');
  perform fe_sub_ensure(p_user, c, 'Banho e tosa');
  perform fe_sub_ensure(p_user, c, 'Medicamentos do pet');

  c := fe_cat_ensure(p_user, 'despesa', 'Impostos e taxas', '🧾', array['Impostos','Impostos e taxas']);
  perform fe_sub_ensure(p_user, c, 'IPTU');
  perform fe_sub_ensure(p_user, c, 'IPVA');
  perform fe_sub_ensure(p_user, c, 'Tarifas bancárias', array['Financeiro','Dívidas e empréstimos'], array['Tarifas']);
  perform fe_sub_ensure(p_user, c, 'IOF', array['Financeiro','Dívidas e empréstimos']);
  perform fe_sub_ensure(p_user, c, 'Outras taxas');

  c := fe_cat_ensure(p_user, 'despesa', 'Seguros', '🛡️', array['Seguros','Seguro']);
  perform fe_sub_ensure(p_user, c, 'Seguro do carro');
  perform fe_sub_ensure(p_user, c, 'Seguro residencial');
  perform fe_sub_ensure(p_user, c, 'Seguro de vida');

  c := fe_cat_ensure(p_user, 'despesa', 'Dívidas e empréstimos', '💳', array['Financeiro','Dívidas','Dividas e emprestimos']);
  perform fe_sub_ensure(p_user, c, 'Empréstimos');
  perform fe_sub_ensure(p_user, c, 'Financiamentos');
  perform fe_sub_ensure(p_user, c, 'Juros');
  perform fe_sub_ensure(p_user, c, 'Multas por atraso');

  c := fe_cat_ensure(p_user, 'despesa', 'Investimentos e reservas', '💹', array['Investimentos e reservas','Reservas']);
  perform fe_sub_ensure(p_user, c, 'Reserva de emergência');
  perform fe_sub_ensure(p_user, c, 'Poupança');
  perform fe_sub_ensure(p_user, c, 'Aplicações financeiras');

  c := fe_cat_ensure(p_user, 'despesa', 'Outros gastos', '📦', array['Outros','Outras despesas','Outros gastos']);
  perform fe_sub_ensure(p_user, c, 'Presentes');
  perform fe_sub_ensure(p_user, c, 'Doações');
  perform fe_sub_ensure(p_user, c, 'Despesas eventuais');

  -- ---------------- RECEITAS ----------------
  c := fe_cat_ensure(p_user, 'receita', 'Salário e remuneração', '💼', array['Salário','Salario','Salário e remuneração']);
  perform fe_sub_ensure(p_user, c, 'Salário');
  perform fe_sub_ensure(p_user, c, 'Horas extras');
  perform fe_sub_ensure(p_user, c, 'Comissões');
  perform fe_sub_ensure(p_user, c, 'Férias');
  perform fe_sub_ensure(p_user, c, '13º salário');

  c := fe_cat_ensure(p_user, 'receita', 'Renda extra', '💻', array['Freelance','Renda extra','Bicos']);
  perform fe_sub_ensure(p_user, c, 'Freelances');
  perform fe_sub_ensure(p_user, c, 'Serviços');
  perform fe_sub_ensure(p_user, c, 'Trabalhos eventuais');

  c := fe_cat_ensure(p_user, 'receita', 'Negócios e vendas', '🛍️', array['Vendas','Negócios e vendas']);
  perform fe_sub_ensure(p_user, c, 'Vendas');
  perform fe_sub_ensure(p_user, c, 'Prestação de serviços');
  perform fe_sub_ensure(p_user, c, 'Faturamento do negócio');
  perform fe_sub_ensure(p_user, c, 'Pró-labore');
  -- a antiga categoria "Pró-labore" vira subcategoria aqui
  perform fe_cat_merge_into_sub(p_user, 'receita', array['Pró-labore','Pro-labore','Prolabore'], c, 'Pró-labore');

  c := fe_cat_ensure(p_user, 'receita', 'Investimentos', '📈', array['Investimentos']);
  perform fe_sub_ensure(p_user, c, 'Dividendos');
  perform fe_sub_ensure(p_user, c, 'Juros');
  perform fe_sub_ensure(p_user, c, 'Rendimentos de aplicações');
  perform fe_cat_merge_into_sub(p_user, 'receita', array['Rendimentos'], c, 'Rendimentos de aplicações');

  c := fe_cat_ensure(p_user, 'receita', 'Aluguéis recebidos', '🔑', array['Aluguel recebido','Aluguéis recebidos','Alugueis recebidos']);
  perform fe_sub_ensure(p_user, c, 'Imóveis');
  perform fe_sub_ensure(p_user, c, 'Veículos');
  perform fe_sub_ensure(p_user, c, 'Equipamentos');

  c := fe_cat_ensure(p_user, 'receita', 'Benefícios e auxílios', '🎁', array['Benefícios','Benefícios e auxílios']);
  perform fe_sub_ensure(p_user, c, 'Vale ou benefício em dinheiro');
  perform fe_sub_ensure(p_user, c, 'Auxílios');

  c := fe_cat_ensure(p_user, 'receita', 'Aposentadoria e pensão', '🧓', array['Aposentadoria','Aposentadoria e pensão']);
  perform fe_sub_ensure(p_user, c, 'INSS');
  perform fe_sub_ensure(p_user, c, 'Previdência privada');
  perform fe_sub_ensure(p_user, c, 'Pensão recebida');

  c := fe_cat_ensure(p_user, 'receita', 'Reembolsos', '↩️', array['Reembolso','Reembolsos']);
  perform fe_sub_ensure(p_user, c, 'Reembolso de despesas');
  perform fe_sub_ensure(p_user, c, 'Devoluções recebidas');

  c := fe_cat_ensure(p_user, 'receita', 'Outras receitas', '💰', array['Outros','Outras receitas']);
  perform fe_sub_ensure(p_user, c, 'Presentes em dinheiro');
  perform fe_sub_ensure(p_user, c, 'Prêmios');
  perform fe_sub_ensure(p_user, c, 'Receitas eventuais');
end $$;

-- categoria antiga inteira -> vira uma subcategoria dentro de outra
create or replace function public.fe_cat_merge_into_sub(p_user uuid, p_kind text, p_olds text[], p_to uuid, p_sub text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_sub uuid;
begin
  select id into v_sub from subcategories where category_id = p_to and lower(name) = lower(p_sub);
  for r in select c.id from categories c where c.user_id = p_user and c.kind = p_kind and c.archived_at is null and c.id <> p_to
             and fe_norm(c.name) = any (select fe_norm(x) from unnest(p_olds) x) loop
    update transactions set category_id = p_to, subcategory_id = coalesce(subcategory_id, v_sub) where category_id = r.id and subcategory_id is null;
    update recurring_transactions set category_id = p_to, subcategory_id = coalesce(subcategory_id, v_sub) where category_id = r.id and subcategory_id is null;
    update establishment_categories set category_id = p_to, subcategory_id = coalesce(subcategory_id, v_sub) where category_id = r.id and subcategory_id is null;
    perform fe_cat_merge(r.id, p_to);
  end loop;
end $$;

-- "Outros": aceita os nomes novos
do $$
declare f text; v_src text; v_new text;
begin
  foreach f in array array['fe_import(uuid,jsonb)','fe_create_transaction(uuid,jsonb)','fe_save_recurring(uuid,jsonb)'] loop
    select pg_get_functiondef(('public.' || f)::regprocedure) into v_src;
    if v_src not like '%''outros gastos''%' then
      v_new := replace(v_src, 'fe_norm(name) = ''outros''', 'fe_norm(name) in (''outros'',''outros gastos'',''outras receitas'')');
      if v_new = v_src then raise exception '% inesperado', f; end if;
      execute v_new;
    end if;
  end loop;
  select pg_get_functiondef('public.app_bootstrap(jsonb)'::regprocedure) into v_src;
  if v_src not like '%''Outros gastos''%' then
    v_new := replace(v_src, '(c.name = ''Outros'')', '(c.name in (''Outros'',''Outros gastos'',''Outras receitas''))');
    if v_new = v_src then raise exception 'app_bootstrap inesperado'; end if;
    execute v_new;
  end if;
end $$;

-- resolve nomes antigos de categoria (o que a pessoa falar ou o que a IA mandar)
create or replace function public.fe_category_alias(p_kind text, p_name text) returns text
language sql immutable as $$
  select case fe_norm(p_name)
    when 'moradia' then 'Moradia e contas da casa' when 'casa' then 'Moradia e contas da casa' when 'contas da casa' then 'Moradia e contas da casa'
    when 'lazer' then 'Lazer e entretenimento' when 'entretenimento' then 'Lazer e entretenimento'
    when 'financeiro' then 'Dívidas e empréstimos' when 'dividas' then 'Dívidas e empréstimos' when 'emprestimos' then 'Dívidas e empréstimos'
    when 'impostos' then 'Impostos e taxas' when 'taxas' then 'Impostos e taxas'
    when 'assinaturas' then 'Assinaturas e serviços' when 'compras' then 'Compras pessoais e casa'
    when 'filhos' then 'Filhos e família' when 'familia' then 'Filhos e família'
    when 'beleza' then 'Cuidados pessoais' when 'seguro' then 'Seguros' when 'pet' then 'Pets'
    when 'outros' then case when p_kind = 'receita' then 'Outras receitas' else 'Outros gastos' end
    when 'salario' then 'Salário e remuneração' when 'freelance' then 'Renda extra' when 'vendas' then 'Negócios e vendas'
    when 'pro-labore' then 'Negócios e vendas' when 'pro labore' then 'Negócios e vendas' when 'rendimentos' then 'Investimentos'
    when 'aluguel recebido' then 'Aluguéis recebidos' when 'aposentadoria' then 'Aposentadoria e pensão' when 'reembolso' then 'Reembolsos'
    else null end
$$;

do $$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src from pg_proc p where proname = 'fe_resolve_category';
  if v_src not like '%fe_category_alias%' then
    v_new := replace(v_src, '    if category_id is null then  -- o nome informado pode ser de uma subcategoria',
'    if category_id is null and fe_category_alias(v_kind, p_cat) is not null then   -- nome antigo ("Moradia", "Lazer"...)
      select c.id into category_id from categories c
        where c.user_id = p_user and c.kind = v_kind and c.archived_at is null and fe_norm(c.name) = fe_norm(fe_category_alias(v_kind, p_cat));
    end if;
    if category_id is null then  -- o nome informado pode ser de uma subcategoria');
    if v_new = v_src then raise exception 'fe_resolve_category inesperado'; end if;
    execute v_new;
  end if;
end $$;

-- aplica a nova organização para todas as famílias existentes
do $$
declare r record;
begin
  for r in select distinct user_id from categories loop
    perform fe_seed_categories(r.user_id);
  end loop;
end $$;

revoke all on function public.fe_sub_move(uuid, uuid, text), public.fe_cat_merge(uuid, uuid), public.fe_cat_ensure(uuid, text, text, text, text[]),
  public.fe_sub_ensure(uuid, uuid, text, text[], text[]), public.fe_cat_merge_into_sub(uuid, text, text[], uuid, text) from public, anon, authenticated;
