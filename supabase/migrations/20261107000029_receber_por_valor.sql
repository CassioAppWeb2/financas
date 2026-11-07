-- "recebi 200" dá baixa numa parcela a receber de exatamente esse valor (vencendo perto de hoje),
-- mesmo sem dizer de quê. Para despesas continua exigindo a descrição/categoria.
create or replace function public.fe_match_pending(p_user uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with o as (select fe_owner(p_user) id),
  a as (select coalesce(nullif(p->>'data','')::date, fe_today(p_user)) d,
               round(nullif(p->>'valor','')::numeric * 100)::bigint v,
               nullif(fe_norm(coalesce(p->>'categoria','')),'') cat, nullif(fe_norm(coalesce(p->>'subcategoria','')),'') sub,
               nullif(fe_norm(coalesce(p->>'descricao','')),'') de, nullif(fe_norm(coalesce(p->>'estabelecimento','')),'') es)
  select fe_tx_json(t) from transactions t
    left join categories c on c.id = t.category_id left join subcategories s on s.id = t.subcategory_id
    left join establishments e on e.id = t.establishment_id, a
  where t.user_id = (select id from o) and t.deleted_at is null and fe_is_pending(t.status, t.card_id, t.type)
    and t.type = coalesce(p->>'tipo','despesa') and t.date between a.d - 25 and a.d + 10
    and ((a.sub is not null and fe_norm(coalesce(s.name,'')) = a.sub)
      or (a.de is not null and (fe_norm(coalesce(t.description,'')) like '%' || a.de || '%' or a.de like '%' || fe_norm(coalesce(t.description,'')) || '%') and char_length(coalesce(t.description,'')) >= 3)
      or (a.es is not null and fe_norm(coalesce(e.name,'')) = a.es)
      or (a.sub is null and a.de is null and a.cat is not null and fe_norm(coalesce(c.name,'')) = a.cat)
      or (t.type = 'receita' and a.v is not null and t.amount_cents = a.v and t.date <= a.d + 10))
  order by (t.amount_cents = a.v) desc, abs(t.date - a.d)
  limit 1
$$;
revoke all on function public.fe_match_pending(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fe_match_pending(uuid, jsonb) to service_role;
