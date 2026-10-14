-- =====================================================================
-- 1) Contas fixas com período: lança todos os meses do período (ex.: 12 meses)
--    e, no fim, pergunta se houve reajuste e renova.
-- 2) Central de notificações (sino do app) + envio para o celular (Web Push e Telegram).
-- 3) Envio automático a cada 30 min (pg_cron + pg_net, só no servidor).
-- =====================================================================

-- ---------- contas fixas ----------
alter table public.recurring_transactions add column if not exists renew_dismissed_end date;

-- data final a partir do pedido: "fim" (data), "meses" (quantidade) ou "sem_fim"
create or replace function public.fe_rec_end(p jsonb, p_first date) returns date
language sql immutable as $$
  select case
    when coalesce((p->>'sem_fim')::boolean, false) then null
    when nullif(p->>'fim','') is not null then (p->>'fim')::date
    when nullif(p->>'meses','') is not null then (p_first + make_interval(months => greatest(1, (p->>'meses')::int)) - interval '1 day')::date
    else null end
$$;

-- gera as ocorrências: com data final, gera o período todo (até 3 anos à frente); sem data final, até o fim do mês que vem
create or replace function public.fe_run_recurring(p_owner uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r recurring_transactions; v_today date := fe_today(p_owner);
  v_horizon date := (date_trunc('month', fe_today(p_owner)) + interval '2 months' - interval '1 day')::date;
  v_lim date; v_n int := 0; v_guard int; v_desc text;
begin
  for r in select * from recurring_transactions
           where user_id = p_owner and active and next_date is not null
             and next_date <= case when end_date is not null then greatest(least(end_date, v_today + 1100), v_horizon) else v_horizon end
           for update skip locked loop
    v_lim := case when r.end_date is not null then least(r.end_date, v_today + 1100) else v_horizon end;
    v_guard := 0;
    while r.next_date is not null and r.next_date <= v_lim and (r.end_date is null or r.next_date <= r.end_date) and v_guard < 160 loop
      v_desc := r.description;
      if not exists (select 1 from transactions where recurring_id = r.id and date = r.next_date and deleted_at is null) then
        insert into transactions(user_id, member_id, created_by, type, amount_cents, date, description, category_id, subcategory_id,
            account_id, card_id, invoice_due, payment_method, recurring_id, status, origin)
          values (p_owner, r.member_id, r.created_by, r.type, r.amount_cents, r.next_date, v_desc, r.category_id, r.subcategory_id,
            case when r.card_id is null then coalesce(r.account_id, fe_resolve_account(p_owner, null)) end,
            r.card_id, case when r.card_id is not null then fe_invoice_due(r.card_id, r.next_date) end,
            case when r.card_id is not null then 'credito' end, r.id,
            case when fe_is_pending('previsto', r.card_id, r.type) or r.next_date > v_today then 'previsto' else 'efetivado' end, 'recorrencia');
        v_n := v_n + 1;
      end if;
      r.next_date := fe_next_occurrence(r, r.next_date);
      v_guard := v_guard + 1;
    end loop;
    update recurring_transactions set next_date = case when r.end_date is not null and r.next_date > r.end_date then null else r.next_date end,
      -- continua ativa até a data final (todos os meses já ficam lançados)
      active = not (r.end_date is not null and r.end_date < v_today)
      where id = r.id;
  end loop;
  -- passou da data final: encerra
  update recurring_transactions set active = false where user_id = p_owner and active and end_date is not null and end_date < v_today;
  return v_n;
end $$;

-- salvar: aceita "meses" e "sem_fim"; ao editar sem falar do período, mantém o que estava
do $$
declare v_src text; v_new text;
begin
  select pg_get_functiondef('public.fe_save_recurring(uuid,jsonb)'::regprocedure) into v_src;
  if v_src not like '%fe_rec_end%' then
    v_new := replace(v_src, 'start_date = coalesce(v_start, v_old.start_date), end_date = nullif(p->>''fim'','''')::date,',
      'start_date = coalesce(v_start, v_old.start_date), end_date = case when p ? ''fim'' or p ? ''meses'' or p ? ''sem_fim'' then fe_rec_end(p, greatest(v_first, v_today + 1)) else v_old.end_date end, renew_dismissed_end = null,');
    v_new := replace(v_new, 'coalesce(v_start, v_first),
        nullif(p->>''fim'','''')::date, v_first, v_member, p_user)',
      'coalesce(v_start, v_first),
        fe_rec_end(p, v_first), v_first, v_member, p_user)');
    if (length(v_new) - length(replace(v_new, 'fe_rec_end', ''))) / length('fe_rec_end') <> 2 then raise exception 'fe_save_recurring inesperado'; end if;
    execute v_new;
  end if;

  select pg_get_functiondef('public.fe_recurring_json(recurring_transactions)'::regprocedure) into v_src;
  if v_src not like '%''renovar''%' then
    v_new := replace(v_src, '''membro_id'', r.member_id,',
      '''membro_id'', r.member_id,
    ''ultima'', (select max(t.date) from transactions t where t.recurring_id = r.id and t.deleted_at is null),
    ''lancadas_futuras'', (select count(*) from transactions t where t.recurring_id = r.id and t.deleted_at is null and t.date >= fe_today(r.user_id)),
    ''renovar'', r.end_date is not null and r.end_date <= fe_today(r.user_id) + 35 and r.end_date >= fe_today(r.user_id) - 60 and r.renew_dismissed_end is distinct from r.end_date,');
    if v_new = v_src then raise exception 'fe_recurring_json inesperado'; end if;
    execute v_new;
  end if;
end $$;

-- renovar (mesmo valor ou com reajuste) por mais N meses, ou encerrar
create or replace function public.fe_renew_recurring(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); r recurring_transactions; v_last date; v_meses int := coalesce(nullif(p->>'meses','')::int, 12);
  v_val bigint; v_next date; v_from date;
begin
  select * into r from recurring_transactions where id = nullif(p->>'id','')::uuid and user_id = o;
  if r.id is null then perform fe_err('Conta fixa não encontrada.'); end if;
  if coalesce((p->>'encerrar')::boolean, false) then
    update recurring_transactions set renew_dismissed_end = coalesce(end_date, fe_today(p_user)), updated_at = now() where id = r.id;
    insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
      values (o, p_user, 'recurring', r.id, 'end', fe_recurring_json(r), coalesce(p->>'origem','app_form'));
    return jsonb_build_object('status','encerrada','recorrencia', fe_recurring_json(r));
  end if;
  if v_meses not between 1 and 60 then perform fe_err('Escolha entre 1 e 60 meses.'); end if;
  v_val := coalesce((p->>'valor_cents')::bigint, round(nullif(p->>'valor','')::numeric * 100));
  if v_val is not null and v_val <= 0 then perform fe_err('Valor inválido.'); end if;
  select max(date) into v_last from transactions where recurring_id = r.id and deleted_at is null;
  v_from := greatest(coalesce(r.end_date, v_last, fe_today(p_user)), coalesce(v_last, r.end_date, fe_today(p_user)));
  v_next := fe_next_occurrence(r, v_from);
  update recurring_transactions set
      end_date = (v_from + make_interval(months => v_meses))::date,
      amount_cents = coalesce(v_val, amount_cents),
      next_date = v_next, active = true, renew_dismissed_end = null, updated_at = now()
    where id = r.id returning * into r;
  perform fe_run_recurring(o);
  select * into r from recurring_transactions where id = r.id;
  insert into audit_logs(user_id, actor_id, entity, entity_id, action, after, source)
    values (o, p_user, 'recurring', r.id, 'renew', fe_recurring_json(r), coalesce(p->>'origem','app_form'));
  update notifications set read_at = coalesce(read_at, now()) where type = 'renovar' and data->>'recorrencia_id' = r.id::text;
  return jsonb_build_object('status','renovada','recorrencia', fe_recurring_json(r), 'de', v_next, 'ate', r.end_date);
end $$;

-- ---------- notificações ----------
-- a tabela já existia (sem uso): ganha os campos da central de avisos
alter table public.notifications add column if not exists link text;
alter table public.notifications add column if not exists data jsonb not null default '{}';
alter table public.notifications add column if not exists dedupe text;
alter table public.notifications add column if not exists pushed_at timestamptz;
update public.notifications set dedupe = id::text where dedupe is null;
alter table public.notifications alter column dedupe set not null;
create unique index if not exists notifications_dedupe_idx on public.notifications(user_id, dedupe);
alter table public.notifications enable row level security;
-- cada pessoa só enxerga os próprios avisos
alter policy "family rows" on public.notifications using (user_id = (select auth.uid()));

alter table public.profiles add column if not exists notify_telegram boolean not null default true;

-- procura novidades para a pessoa e grava as que ainda não existem
create or replace function public.fe_notify_scan(p_user uuid, p jsonb default '{}') returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid := fe_owner(p_user); v_today date := fe_today(p_user); v_n int := 0; v_k int; r record;
begin
  -- contas a pagar / a receber em atraso
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'pendente',
      case when t.type = 'despesa' then 'Conta em atraso' else 'Valor a receber em atraso' end,
      format('%s — R$ %s, %s em %s. Toque no 👎 em Pendências quando %s.', coalesce(t.description, 'Lançamento'), fe_fmt(t.amount_cents/100.0),
        case when t.type = 'despesa' then 'venceu' else 'era para entrar' end, to_char(t.date, 'DD/MM'),
        case when t.type = 'despesa' then 'pagar' else 'receber' end),
      '#/', jsonb_build_object('tx_id', t.id), 'atraso:' || t.id
    from transactions t
    where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type) and t.date < v_today
      and (t.member_id is null or t.member_id = p_user)
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- vence hoje / amanhã
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'vence',
      case when t.date = v_today then 'Vence hoje' else 'Vence amanhã' end,
      format('%s — R$ %s (%s).', coalesce(t.description, 'Lançamento'), fe_fmt(t.amount_cents/100.0), case when t.type = 'despesa' then 'a pagar' else 'a receber' end),
      '#/', jsonb_build_object('tx_id', t.id), 'vence:' || t.id || ':' || t.date
    from transactions t
    where t.user_id = o and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type) and t.date between v_today and v_today + 1
      and (t.member_id is null or t.member_id = p_user)
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- conta fixa chegando ao fim: pergunta reajuste e renovação
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'renovar', 'Conta fixa terminando',
      format('%s (R$ %s %s) está lançada até %s. Houve reajuste? Renove por mais 12 meses.', r2.description, fe_fmt(r2.amount_cents/100.0),
        case r2.frequency when 'semanal' then 'por semana' when 'anual' then 'por ano' else 'por mês' end, to_char(r2.end_date, 'MM/YYYY')),
      '#/fixas', jsonb_build_object('recorrencia_id', r2.id, 'valor_cents', r2.amount_cents, 'fim', r2.end_date, 'descricao', r2.description),
      'renovar:' || r2.id || ':' || r2.end_date
    from recurring_transactions r2
    where r2.user_id = o and r2.end_date is not null and r2.end_date between v_today - 60 and v_today + 35
      and r2.renew_dismissed_end is distinct from r2.end_date
      and (r2.member_id is null or r2.member_id = p_user or r2.created_by = p_user)
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- faturas do cartão: vencendo em até 3 dias ou vencidas com saldo
  for r in select c.id, c.name, z.due, (fe_invoice_json(o, c.id, z.due)->>'restante_cents')::bigint resto
           from credit_cards c
           join lateral (select distinct invoice_due due from transactions t
                         where t.user_id = o and t.card_id = c.id and t.deleted_at is null and t.invoice_due between v_today - 10 and v_today + 3) z on true
           where c.user_id = o and c.status = 'ativo' and (c.member_id is null or c.member_id = p_user) loop
    if r.resto > 0 then
      insert into notifications(user_id, type, title, body, link, data, dedupe)
        values (p_user, 'fatura', case when r.due < v_today then 'Fatura vencida' else 'Fatura vencendo' end,
          format('Fatura do %s: R$ %s, %s %s.', r.name, fe_fmt(r.resto/100.0), case when r.due < v_today then 'venceu em' else 'vence em' end, to_char(r.due, 'DD/MM')),
          '#/cartoes', jsonb_build_object('cartao_id', r.id, 'vencimento', r.due),
          case when r.due < v_today then 'fatura_atraso:' else 'fatura:' end || r.id || ':' || r.due)
      on conflict (user_id, dedupe) do nothing;
      get diagnostics v_k = row_count; v_n := v_n + v_k;
    end if;
  end loop;

  -- orçamentos: 80% e estourado (uma vez por mês por categoria)
  for r in select e.value x from jsonb_array_elements(coalesce(fe_budgets(p_user, '{}')->'itens', '[]')) e
           where e.value->>'situacao' in ('estourado','atencao') loop
    insert into notifications(user_id, type, title, body, link, data, dedupe)
      values (p_user, 'orcamento', case when r.x->>'situacao' = 'estourado' then 'Orçamento estourado' else 'Orçamento perto do limite' end,
        format('%s: R$ %s de R$ %s (%s%%).', r.x->>'categoria', fe_fmt((r.x->>'gasto_cents')::numeric/100), fe_fmt((r.x->>'limite_cents')::numeric/100), round((r.x->>'percentual')::numeric)),
        '#/orcamentos', jsonb_build_object('categoria_id', r.x->>'categoria_id'),
        'orc:' || coalesce(r.x->>'categoria_id', r.x->>'categoria') || ':' || to_char(v_today, 'YYYY-MM') || ':' || (r.x->>'situacao'))
    on conflict (user_id, dedupe) do nothing;
    get diagnostics v_k = row_count; v_n := v_n + v_k;
  end loop;

  -- gasto dividido com você por outra pessoa da família
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'acerto', 'Gasto dividido com você',
      format('%s dividiu “%s” com você: sua parte é R$ %s.', coalesce((select split_part(name, ' ', 1) from profiles where id = t.created_by), 'Alguém da família'),
        coalesce(t.description, 'compra'), fe_fmt(t.amount_cents/100.0)),
      '#/', jsonb_build_object('tx_id', t.id), 'acerto:' || t.id
    from transactions t
    where t.user_id = o and t.deleted_at is null and t.settle_status = 'pendente' and t.member_id = p_user
      and t.created_by is distinct from p_user and t.created_at > now() - interval '45 days'
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- metas atingidas
  insert into notifications(user_id, type, title, body, link, data, dedupe)
    select p_user, 'meta', 'Meta atingida 🎉', format('Você chegou na meta “%s”.', g.name), '#/metas', jsonb_build_object('meta_id', g.id), 'meta:' || g.id
    from financial_goals g
    where g.user_id = o and g.status = 'ativa' and g.target_cents > 0 and g.current_cents >= g.target_cents
  on conflict (user_id, dedupe) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  return v_n;
end $$;

-- lista: some sozinha o que já foi resolvido (conta paga, fixa renovada...)
create or replace function public.fe_notifications(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with n as (
    select x.*, case
        when x.type in ('pendente','vence') then exists (select 1 from transactions t where t.id = (x.data->>'tx_id')::uuid and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type))
        when x.type = 'renovar' then exists (select 1 from recurring_transactions r where r.id = (x.data->>'recorrencia_id')::uuid and r.end_date = (x.data->>'fim')::date and r.renew_dismissed_end is distinct from r.end_date)
        when x.type = 'acerto' then exists (select 1 from transactions t where t.id = (x.data->>'tx_id')::uuid and t.deleted_at is null and t.settle_status = 'pendente')
        else true end as ativa
    from notifications x where x.user_id = p_user and x.created_at > now() - interval '90 days')
  select jsonb_build_object(
    'nao_lidas', (select count(*) from n where read_at is null and ativa),
    'itens', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'tipo', type, 'titulo', title, 'texto', body, 'link', link, 'dados', data,
        'criada_em', created_at, 'lida', read_at is not null, 'ativa', ativa) order by (read_at is null and ativa) desc, created_at desc)
      from (select * from n where ativa or created_at > now() - interval '7 days' order by created_at desc limit 40) z), '[]'))
$$;

create or replace function public.app_notifications(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform fe_run_recurring(app_owner());
  perform fe_notify_scan(app_uid());
  return fe_notifications(app_uid(), p);
end $$;

create or replace function public.app_notifications_read(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  with u as (update notifications set read_at = now()
    where user_id = app_uid() and read_at is null and (nullif(p->>'id','') is null or id = (p->>'id')::uuid) returning 1)
  select jsonb_build_object('status','ok','marcadas', (select count(*) from u))
$$;

create or replace function public.app_renew_recurring(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_renew_recurring(app_uid(), p) $$;

-- ---------- notificações no celular (Web Push) ----------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures int not null default 0
);
alter table public.push_subscriptions enable row level security;

-- segredos gerados pelo próprio servidor (chave do Web Push, chave do agendador); só o servidor lê
create table if not exists public.app_secrets (name text primary key, value text not null, created_at timestamptz not null default now());
alter table public.app_secrets enable row level security;
insert into public.app_secrets(name, value) values ('cron_key', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')) on conflict do nothing;

create or replace function public.fe_secret(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p ? 'valor' then
    insert into app_secrets(name, value) values (p->>'nome', p->>'valor') on conflict (name) do nothing;
  end if;
  return jsonb_build_object('valor', (select value from app_secrets where name = p->>'nome'));
end $$;

create or replace function public.app_push_subscribe(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if nullif(p->>'endpoint','') is null or nullif(p->'keys'->>'p256dh','') is null or nullif(p->'keys'->>'auth','') is null then
    perform fe_err('Inscrição inválida.');
  end if;
  insert into push_subscriptions(user_id, endpoint, p256dh, auth, user_agent)
    values (app_uid(), p->>'endpoint', p->'keys'->>'p256dh', p->'keys'->>'auth', left(p->>'ua', 200))
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0;
  return jsonb_build_object('status','ok');
end $$;
create or replace function public.app_push_unsubscribe(p jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  with d as (update push_subscriptions set failures = 99 where user_id = app_uid() and endpoint = p->>'endpoint' returning 1)
  select jsonb_build_object('status','ok')
$$;
create or replace function public.app_notify_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p ? 'telegram' then update profiles set notify_telegram = (p->>'telegram')::boolean where id = app_uid(); end if;
  return jsonb_build_object('telegram', (select notify_telegram from profiles where id = app_uid()),
    'aparelhos', (select count(*) from push_subscriptions where user_id = app_uid() and failures < 5),
    'telegram_conectado', exists (select 1 from telegram_connections where user_id = app_uid() and chat_id not like 'desvinculado-%'));
end $$;

-- fila de envio: varre todo mundo e devolve o que ainda não foi enviado ao celular (só entre 8h e 21h)
create or replace function public.fe_push_queue(p_user uuid, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u record; v_hora int := coalesce(nullif(p->>'hora','')::int, extract(hour from now() at time zone 'America/Sao_Paulo')::int);
begin
  for u in select id from profiles loop
    perform fe_run_recurring(fe_owner(u.id));
    perform fe_notify_scan(u.id);
  end loop;
  if v_hora < 8 or v_hora >= 21 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'user_id', n.user_id, 'tipo', n.type, 'titulo', n.title, 'texto', n.body, 'link', n.link, 'dados', n.data,
      'aparelhos', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)) from push_subscriptions s where s.user_id = n.user_id and s.failures < 5), '[]'),
      'telegram', (select tc.chat_id from telegram_connections tc join profiles pr on pr.id = tc.user_id
                   where tc.user_id = n.user_id and pr.notify_telegram and tc.chat_id not like 'desvinculado-%' limit 1))
      order by n.created_at)
    from notifications n
    where n.pushed_at is null and n.read_at is null and n.created_at > now() - interval '3 days'), '[]');
end $$;

create or replace function public.fe_push_done(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update notifications set pushed_at = now() where id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p->'ids','[]')) x);
  update push_subscriptions set last_ok_at = now(), failures = 0 where endpoint in (select x from jsonb_array_elements_text(coalesce(p->'ok','[]')) x);
  update push_subscriptions set failures = failures + 1 where endpoint in (select x from jsonb_array_elements_text(coalesce(p->'falhou','[]')) x);
  update push_subscriptions set failures = 99 where endpoint in (select x from jsonb_array_elements_text(coalesce(p->'expirou','[]')) x);
  return jsonb_build_object('status','ok');
end $$;

revoke all on function public.fe_rec_end(jsonb, date), public.fe_renew_recurring(uuid, jsonb), public.fe_notify_scan(uuid, jsonb), public.fe_notifications(uuid, jsonb),
  public.fe_secret(uuid, jsonb), public.fe_push_queue(uuid, jsonb), public.fe_push_done(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_renew_recurring(uuid, jsonb), public.fe_notify_scan(uuid, jsonb), public.fe_notifications(uuid, jsonb),
  public.fe_secret(uuid, jsonb), public.fe_push_queue(uuid, jsonb), public.fe_push_done(uuid, jsonb) to service_role;
revoke all on function public.app_notifications(jsonb), public.app_notifications_read(jsonb), public.app_renew_recurring(jsonb),
  public.app_push_subscribe(jsonb), public.app_push_unsubscribe(jsonb), public.app_notify_prefs(jsonb) from public, anon;
grant execute on function public.app_notifications(jsonb), public.app_notifications_read(jsonb), public.app_renew_recurring(jsonb),
  public.app_push_subscribe(jsonb), public.app_push_unsubscribe(jsonb), public.app_notify_prefs(jsonb) to authenticated;

-- ---------- agendador (só onde existem pg_cron e pg_net, ou seja, no servidor) ----------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'notificacoes';
    perform cron.schedule('notificacoes', '*/30 * * * *', $job$
      select net.http_post(
        url := 'https://xggsoktbreizikalxahl.supabase.co/functions/v1/assistant/notificar',
        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-key', (select value from public.app_secrets where name = 'cron_key')),
        body := '{}'::jsonb, timeout_milliseconds := 20000)
    $job$);
  end if;
end $$;
