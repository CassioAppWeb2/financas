-- "Impressão digital" dos dados: o app consulta a cada poucos segundos e só
-- recarrega a tela quando algo mudou (ex.: lançamento feito pelo Telegram).
create or replace function public.app_changes(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'lancamentos', (select concat(count(*) filter (where deleted_at is null), '|',
                                  extract(epoch from greatest(max(created_at), max(updated_at), max(deleted_at))))
                      from transactions where user_id = app_owner()),
    'cadastros', md5(concat(
       (select string_agg(concat(id, name, status, initial_balance_cents), ',' order by id) from accounts where user_id = app_owner()), '|',
       (select string_agg(concat(id, name, icon, archived_at), ',' order by id) from categories where user_id = app_owner()), '|',
       (select string_agg(concat(id, name, archived_at), ',' order by id) from subcategories where user_id = app_owner()), '|',
       (select string_agg(member_id::text, ',' order by member_id) from household_members where owner_id = app_owner()))),
    'chat', (select extract(epoch from max(created_at))::text from chat_messages where user_id = app_uid())
  )
$$;
revoke all on function public.app_changes(jsonb) from public, anon;
grant execute on function public.app_changes(jsonb) to authenticated;
