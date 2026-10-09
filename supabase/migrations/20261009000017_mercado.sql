-- =====================================================================
-- Mercado: indicadores econômicos oficiais (Banco Central do Brasil - SGS)
--  * os números são públicos e iguais para todos; o servidor busca e grava aqui
--  * o app lê pelo app_market; quando estiverem velhos (mais de 6 h), o servidor busca de novo
-- =====================================================================
create table if not exists public.market_series (
  code text not null,
  date date not null,
  value numeric not null,
  date_end date,
  primary key (code, date)
);
create table if not exists public.market_meta (
  code text primary key,
  updated_at timestamptz not null default now(),
  last_date date
);
alter table public.market_series enable row level security;
alter table public.market_meta enable row level security;
-- sem políticas: acesso só pelas funções abaixo

-- grava as séries recebidas do Banco Central: {series:[{code, pontos:[{data, valor, data_fim?}]}]}
create or replace function public.fe_market_save(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; n int := 0;
begin
  for s in select * from jsonb_array_elements(coalesce(p->'series','[]')) loop
    -- algumas séries trazem mais de um valor no mesmo dia: fica o último da lista
    insert into market_series(code, date, value, date_end)
      select distinct on ((x->>'data')::date) s->>'code', (x->>'data')::date, (x->>'valor')::numeric, nullif(x->>'data_fim','')::date
      from jsonb_array_elements(coalesce(s->'pontos','[]')) with ordinality as e(x, ord)
      where x->>'data' is not null and x->>'valor' ~ '^-?[0-9]+(\.[0-9]+)?$'
      order by (x->>'data')::date, ord desc
    on conflict (code, date) do update set value = excluded.value, date_end = excluded.date_end;
    get diagnostics n = row_count;
    insert into market_meta(code, updated_at, last_date)
      values (s->>'code', now(), (select max(date) from market_series where code = s->>'code'))
      on conflict (code) do update set updated_at = now(), last_date = excluded.last_date;
  end loop;
  return jsonb_build_object('status','ok');
end $$;

-- leitura: último valor e histórico de cada indicador
create or replace function public.fe_market(p_user uuid, p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with cfg(code, nome, unidade, freq, hist) as (values
    ('selic',     'Selic (meta)',        '% a.a.',  'diaria', 400),
    ('cdi',       'CDI',                 '% a.a.',  'diaria', 400),
    ('ipca_12m',  'IPCA (12 meses)',     '%',       'mensal', 420),
    ('ipca_mes',  'IPCA (no mês)',       '%',       'mensal', 420),
    ('igpm_mes',  'IGP-M (no mês)',      '%',       'mensal', 420),
    ('poupanca',  'Poupança',            '% a.m.',  'diaria', 400),
    ('tr',        'TR',                  '% a.m.',  'diaria', 400),
    ('dolar',     'Dólar (venda)',       'R$',      'diaria', 120),
    ('euro',      'Euro (venda)',        'R$',      'diaria', 120)
  )
  select jsonb_build_object(
    'fonte', 'Banco Central do Brasil (SGS)',
    'atualizado_em', (select max(updated_at) from market_meta),
    'desatualizado', coalesce((select max(updated_at) from market_meta) < now() - interval '6 hours', true),
    'indicadores', coalesce((select jsonb_object_agg(c.code, jsonb_build_object(
        'nome', c.nome, 'unidade', c.unidade, 'frequencia', c.freq,
        'valor', l.value, 'data', l.date, 'data_fim', l.date_end,
        'anterior', (select value from market_series where code = c.code and date < l.date order by date desc limit 1),
        'historico', coalesce((select jsonb_agg(jsonb_build_object('data', h.date, 'valor', h.value) order by h.date)
           from market_series h where h.code = c.code and h.date > l.date - c.hist), '[]')))
      from cfg c
      join lateral (select * from market_series s where s.code = c.code and s.date <= current_date order by s.date desc limit 1) l on true), '{}'::jsonb)
  )
$$;

create or replace function public.app_market(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select fe_market(app_uid(), p) $$;

revoke all on function public.fe_market_save(uuid, jsonb), public.fe_market(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_market_save(uuid, jsonb), public.fe_market(uuid, jsonb) to service_role;
revoke all on function public.app_market(jsonb) from public, anon;
grant execute on function public.app_market(jsonb) to authenticated;
