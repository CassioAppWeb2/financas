-- =====================================================================
-- Áudios enviados ficam disponíveis para ouvir por 7 dias
--  * arquivos no Storage (bucket privado "audios"), pasta = id da pessoa
--  * cada pessoa só lê os próprios áudios
--  * o histórico do chat informa o caminho do áudio enquanto ele existir
-- =====================================================================
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
      values ('audios', 'audios', false, 15728640)
      on conflict (id) do nothing;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'audios: dono le') then
      create policy "audios: dono le" on storage.objects for select to authenticated
        using (bucket_id = 'audios' and (storage.foldername(name))[1] = (select auth.uid())::text);
    end if;
  end if;
end $$;

-- grava o caminho do áudio junto da mensagem
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
      values (p_user, v_id, p->>'audio_provider', p->>'content', nullif(p->>'audio_path',''));
  end if;
  update chat_conversations set updated_at = now() where id = v_conv;
  return jsonb_build_object('id', v_id);
end $$;

-- histórico: inclui o áudio dos últimos 7 dias
create or replace function public.app_chat_history(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'role', role, 'channel', channel, 'message_type', message_type,
    'content', content, 'cards', cards, 'created_at', created_at,
    'audio_path', (select a.storage_path from audio_messages a where a.chat_message_id = m.id and a.storage_path is not null
                   and m.created_at > now() - interval '7 days' limit 1)) order by created_at), '[]')
  from (select * from chat_messages where user_id = app_uid()
          and (nullif(p->>'antes','') is null or created_at < (p->>'antes')::timestamptz)
        order by created_at desc limit least(coalesce(nullif(p->>'limite','')::int, 60), 200)) m
$$;
revoke all on function public.app_chat_history(jsonb) from public, anon;
grant execute on function public.app_chat_history(jsonb) to authenticated;
