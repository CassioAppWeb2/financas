-- Relatos de erro enviados pelo app (Configurações → Reportar um erro).
-- O texto e o contexto ficam guardados aqui; as imagens vão anexadas no e-mail.
create table if not exists public.error_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null,
  context jsonb not null default '{}',
  images int not null default 0,
  email_status text not null default 'pendente',
  telegram_status text,
  error text,
  created_at timestamptz not null default now()
);
alter table public.error_reports enable row level security;   -- sem políticas: só o servidor lê e grava
create index if not exists error_reports_user_idx on public.error_reports(user_id, created_at desc);

-- grava o relato e devolve quem enviou (nome/e-mail) e o Telegram de quem recebe (para o caso de o e-mail falhar)
create or replace function public.fe_report_save(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_txt text := btrim(coalesce(p->>'texto', ''));
begin
  if length(v_txt) < 5 then perform fe_err('Descreva o erro com um pouco mais de detalhe.'); end if;
  if (select count(*) from error_reports where user_id = p_user and created_at > now() - interval '1 day') >= 15 then
    perform fe_err('Você já enviou muitos relatos hoje. Tente de novo amanhã.');
  end if;
  insert into error_reports(user_id, message, context, images)
    values (p_user, left(v_txt, 5000), coalesce(p->'contexto', '{}'), coalesce(nullif(p->>'imagens','')::int, 0))
    returning id into v_id;
  return jsonb_build_object('id', v_id,
    'nome', (select name from profiles where id = p_user),
    'email', (select email from auth.users where id = p_user),
    'telegram_destino', (select tc.chat_id from auth.users u join telegram_connections tc on tc.user_id = u.id
                         where lower(u.email) = lower(p->>'destino') and tc.chat_id not like 'desvinculado-%' limit 1));
end $$;

create or replace function public.fe_report_done(p_user uuid, p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  update error_reports set email_status = coalesce(p->>'email', email_status), telegram_status = coalesce(p->>'telegram', telegram_status),
    error = left(p->>'erro', 500)
  where id = (p->>'id')::uuid and user_id = p_user;
  select jsonb_build_object('status','ok');
$$;

revoke all on function public.fe_report_save(uuid, jsonb), public.fe_report_done(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_report_save(uuid, jsonb), public.fe_report_done(uuid, jsonb) to service_role;
