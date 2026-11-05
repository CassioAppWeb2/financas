-- O assistente passa a receber as últimas mensagens da conversa (das últimas 3 horas),
-- para entender respostas e correções ("não é dividido, é só meu", "e o lançamento?").
create or replace function public.fe_chat_state(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_conv uuid := fe_conversation(p_user); v_old jsonb;
begin
  select pending into v_old from chat_conversations where id = v_conv;
  if p ? 'pending' then
    update chat_conversations set pending = case when jsonb_typeof(p->'pending') = 'null' then null else p->'pending' end,
      updated_at = now() where id = v_conv;
  end if;
  return jsonb_build_object('pending', v_old,
    'recentes', case when coalesce((p->>'historico')::boolean, false) then coalesce((
      select jsonb_agg(jsonb_build_object('papel', role, 'texto', left(content, 600)) order by created_at)
      from (select role, content, created_at from chat_messages
            where conversation_id = v_conv and created_at > now() - interval '3 hours'
              and id <> coalesce((select id from chat_messages where conversation_id = v_conv order by created_at desc limit 1), gen_random_uuid())
            order by created_at desc limit 10) m), '[]'::jsonb) end);
end $$;
