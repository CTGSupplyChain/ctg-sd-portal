-- Applied 26 Oct 2026 as fix_wk53_forecast_keys_2026_10_26.
-- Problem: the S&D grid showed 0 forecast for 2026-WK53 (week of 2026-12-28) and December 2026 demand lost a
-- share to a past week.
--   1. 30 stale demand_forecast rows for that week were keyed iso_year 2027 with wk_label '2026-WK53'; the grid
--      reads forecast by wk_label only, so a stale zero row shadowed the real value.
--   2. week_calendar row 2026-WK01 (monday 2025-12-29, month_label Dec'25) carried year 2026 / month 12, so it
--      counted as a 5th week of December 2026 and took 1/5 of that month's demand in the past.

-- 1. Backup of the mis-keyed rows (iso_year does not match the year in wk_label).
create table public.demand_forecast_stale_keys_backup_20261026 as
  select * from public.demand_forecast where iso_year::text <> left(wk_label, 4);
alter table public.demand_forecast_stale_keys_backup_20261026 enable row level security;
revoke all on public.demand_forecast_stale_keys_backup_20261026 from anon, authenticated;

-- 2. Calendar: that row is December 2025. (Previous value: year 2026.)
update public.week_calendar set year = 2025
 where wk_label = '2026-WK01' and monday_date = '2025-12-29' and year = 2026 and month = 12;

-- 3. Stale rows: re-key where no correct row exists, otherwise zero and mark superseded
--    (same convention as regenerate_attach_rate_forecast).
update public.demand_forecast s set iso_year = 2026
 where s.iso_year::text <> left(s.wk_label, 4) and s.model_used <> 'superseded'
   and not exists (select 1 from public.demand_forecast d where d.sku = s.sku and d.iso_year = 2026 and d.iso_week = s.iso_week);
update public.demand_forecast s set forecast_qty = 0, model_used = 'superseded'
 where s.iso_year::text <> left(s.wk_label, 4) and s.model_used <> 'superseded';

-- Then: select regenerate_attach_rate_forecast('PROJ_CTG007'); select regenerate_attach_rate_forecast('PROJ_CTG029');
