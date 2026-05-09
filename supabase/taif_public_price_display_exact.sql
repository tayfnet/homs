-- TAIF Public Price Display — read-only RPC for public display screens.
-- نفّذ هذا الملف مرة واحدة داخل Supabase SQL Editor.
-- لا يضيف أي صلاحية كتابة. الدالة تقرأ بيانات العملات والأسعار فقط بدون تسجيل دخول.

create or replace function public.taif_public_price_display_state(target_org uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid := target_org;
  result jsonb;
  settings_row public.taif_currency_settings%rowtype;
  max_update timestamptz;
begin
  if org_id is null then
    select organization_id into org_id
    from public.taif_currency_settings
    order by updated_at desc nulls last, created_at desc nulls last
    limit 1;
  end if;

  if org_id is null then
    select organization_id into org_id
    from public.taif_currencies
    where is_active = true
    order by sort_order asc, created_at asc
    limit 1;
  end if;

  if org_id is null then
    return null;
  end if;

  select * into settings_row
  from public.taif_currency_settings
  where organization_id = org_id;

  if not exists (select 1 from public.taif_currencies where organization_id = org_id)
     and not exists (select 1 from public.taif_currency_settings where organization_id = org_id) then
    return null;
  end if;

  select greatest(
    coalesce((select max(updated_at) from public.taif_currency_settings where organization_id = org_id), 'epoch'::timestamptz),
    coalesce((select max(updated_at) from public.taif_currencies where organization_id = org_id), 'epoch'::timestamptz),
    coalesce((select max(updated_at) from public.taif_currency_rate_books where organization_id = org_id), 'epoch'::timestamptz),
    coalesce((select max(updated_at) from public.taif_currency_pairs where organization_id = org_id), 'epoch'::timestamptz),
    coalesce((select max(updated_at) from public.taif_currency_rates where organization_id = org_id), 'epoch'::timestamptz)
  ) into max_update;

  result := jsonb_build_object(
    'version', coalesce(settings_row.state_version, 3),
    'updatedAt', floor(extract(epoch from coalesce(max_update, now())) * 1000)::bigint,
    'systemCurrencyCode', coalesce(settings_row.system_currency_code, 'USD'),
    'counterpartCode', coalesce(settings_row.counterpart_code, 'SYP'),
    'activeRateBookCode', coalesce(settings_row.active_rate_book_code, 'OFFICIAL'),
    'currencies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', c.code,
        'name', c.name,
        'flag', c.flag,
        'usdConvention', c.usd_convention,
        'ratioBuy', c.ratio_buy,
        'ratioSell', c.ratio_sell,
        'ratioBuyText', c.ratio_buy_text,
        'ratioSellText', c.ratio_sell_text,
        'buy', c.buy,
        'sell', c.sell,
        'buyText', c.buy_text,
        'sellText', c.sell_text,
        'method', c.method,
        'decimals', c.decimals,
        'priceUpdateMode', c.price_update_mode,
        'rateMode', c.rate_mode,
        'legacySourceCode', c.legacy_source_code,
        'legacyZeroShift', c.legacy_zero_shift,
        'legacyZeroDropAllowed', c.legacy_zero_drop_allowed,
        'rateEditedAt', c.rate_edited_at
      ) order by c.sort_order asc, c.code asc)
      from public.taif_currencies c
      where c.organization_id = org_id and c.is_active = true
    ), '[]'::jsonb),
    'rateBooks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', rb.code,
        'label', rb.label,
        'isActive', rb.is_active
      ) order by rb.sort_order asc, rb.code asc)
      from public.taif_currency_rate_books rb
      where rb.organization_id = org_id
    ), '[]'::jsonb),
    'pairRegistry', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.pair_id,
        'baseCode', p.base_code,
        'quoteCode', p.quote_code,
        'usdConvention', p.usd_convention,
        'role', p.role,
        'sourceType', p.source_type
      ) order by p.sort_order asc, p.pair_id asc)
      from public.taif_currency_pairs p
      where p.organization_id = org_id
    ), '[]'::jsonb),
    'rateRecords', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bookCode', r.book_code,
        'pairId', r.pair_id,
        'bid', r.bid,
        'ask', r.ask,
        'bidText', r.bid_text,
        'askText', r.ask_text,
        'source', r.source,
        'status', r.status,
        'effectiveAt', r.effective_at,
        'updatedAt', r.raw_updated_at
      ) order by r.book_code asc, r.pair_id asc)
      from public.taif_currency_rates r
      where r.organization_id = org_id
    ), '[]'::jsonb)
  );

  return result;
end;
$$;

revoke all on function public.taif_public_price_display_state(uuid) from public;
grant execute on function public.taif_public_price_display_state(uuid) to anon, authenticated;

comment on function public.taif_public_price_display_state(uuid)
is 'Read-only public RPC for the standalone TAIF public price display screen.';
