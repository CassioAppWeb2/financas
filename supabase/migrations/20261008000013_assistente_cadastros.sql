-- =====================================================================
-- Cadastros pelo assistente: o servidor executa, em nome da pessoa, as mesmas
-- ações das telas do app (contas, categorias, subcategorias, perfil).
-- Só a função do servidor (service_role) pode chamar; a lista de ações é fechada.
-- =====================================================================
create or replace function public.fe_admin(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_acao text := p->>'acao'; d jsonb := coalesce(p->'dados', '{}'); r jsonb;
begin
  if p_user is null then perform fe_err('Usuário não identificado.'); end if;
  -- age como a própria pessoa (as funções do app usam auth.uid())
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  r := case v_acao
    when 'salvar_conta' then app_save_account(d)
    when 'arquivar_conta' then app_archive_account(d)
    when 'salvar_categoria' then app_save_category(d)
    when 'excluir_categoria' then app_delete_category(d)
    when 'salvar_subcategoria' then app_save_subcategory(d)
    when 'excluir_subcategoria' then app_delete_subcategory(d)
    when 'perfil' then app_update_profile(d)
    when 'cadastros' then jsonb_build_object(
      'contas', fe_balances(p_user)->'contas',
      'cartoes', fe_cards(p_user, '{}'),
      'categorias', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.kind, 'nome', c.name, 'icone', c.icon,
          'subcategorias', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nome', s.name) order by s.name)
            from subcategories s where s.category_id = c.id and s.archived_at is null), '[]')) order by c.kind, c.name), '[]')
          from categories c where c.user_id = fe_owner(p_user) and c.archived_at is null),
      'meta_economia_cents', (select monthly_savings_goal_cents from profiles where id = fe_owner(p_user)))
    else null end;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  if r is null then perform fe_err('Ação não permitida.'); end if;
  return r;
end $$;

revoke all on function public.fe_admin(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_admin(uuid, jsonb) to service_role;
