-- Phase 3a: weekly attach-rate accuracy log (WMAPE / bias).
-- Applied 19 Oct 2026 in four parts (a: table + log function, b: views, c: regenerate hook + cron, d: total-basis columns on the views; file holds the final form).
-- Insert-only snapshot of forecast vs actual per project/SKU/closed week, so accuracy history
-- survives forecast regeneration (demand_forecast is overwritten on every regenerate).
-- Actuals are B2C only: attach-rate demand excludes bulk B2B by design; B2B is kept for reference.
-- WMAPE = sum|F-A| / sum A.  Bias = (sum F - sum A) / sum A  (positive = over-forecast).

-- ===== part a =====
create table if not exists public.attach_rate_accuracy_log (
  project_id             text not null,
  brand                  text not null,
  sku                    text not null,
  iso_year               integer not null,
  iso_week               integer not null,
  week_start_date        date not null,
  forecast_qty           integer not null,
  actual_b2c             integer not null default 0,
  actual_b2b             integer not null default 0,
  forecast_submission_id uuid,
  forecast_generated_at  timestamptz,
  logged_at              timestamptz not null default now(),
  primary key (project_id, sku, week_start_date)
);
create index if not exists attach_rate_accuracy_log_brand_week
  on public.attach_rate_accuracy_log (lower(brand), week_start_date);

alter table public.attach_rate_accuracy_log enable row level security;
drop policy if exists attach_rate_accuracy_log_read on public.attach_rate_accuracy_log;
create policy attach_rate_accuracy_log_read on public.attach_rate_accuracy_log
  for select to authenticated
  using ((select ctg_is_staff()) or lower(brand) in (select ctg_my_brands()));
revoke all on public.attach_rate_accuracy_log from anon;
grant select on public.attach_rate_accuracy_log to authenticated;
-- No write policies: rows are only written by log_attach_rate_accuracy().

-- Logs every closed week that (1) is on/after the week of the latest forecast submission (ex-ante only),
-- (2) is before the current MYT week and (3) is on/before the brand's last loaded sales week.
-- Never updates or deletes: first logged value wins.
create or replace function public.log_attach_rate_accuracy(p_project_id text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n int; v_monday date := date_trunc('week', (now() at time zone 'Asia/Kuala_Lumpur'))::date;
begin
  if auth.uid() is not null and public.ctg_global_role() not in ('superadmin','supply_chain') then
    raise exception 'Only supply chain admins can log forecast accuracy';
  end if;
  insert into attach_rate_accuracy_log
    (project_id, brand, sku, iso_year, iso_week, week_start_date, forecast_qty,
     actual_b2c, actual_b2b, forecast_submission_id, forecast_generated_at)
  select d.project_id, d.brand, d.sku, d.iso_year, d.iso_week, d.week_start_date, d.forecast_qty,
         coalesce(s.b2c, 0), coalesce(s.b2b, 0), sub.id, d.generated_at
    from demand_forecast d
    join lateral (select id, date_trunc('week', submitted_at at time zone 'Asia/Kuala_Lumpur')::date wk
                    from forecast_submissions f where f.project_id = d.project_id
                   order by submitted_at desc limit 1) sub on true
    left join lateral (select sum(qty) filter (where channel = 'B2C') b2c,
                              sum(qty) filter (where channel = 'B2B') b2b
                         from sales_history h
                        where h.sku = d.sku and h.week_start_date = d.week_start_date) s on true
   where d.model_used = 'attach_rate'
     and d.project_id is not null
     and (p_project_id is null or d.project_id = p_project_id)
     and d.week_start_date >= sub.wk
     and d.week_start_date < v_monday
     and d.week_start_date <= (select max(h2.week_start_date) from sales_history h2 where lower(h2.brand) = lower(d.brand))
  on conflict (project_id, sku, week_start_date) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.log_attach_rate_accuracy(text) from public, anon;
grant execute on function public.log_attach_rate_accuracy(text) to authenticated, service_role;

-- ===== part b =====
create or replace view public.v_attach_rate_accuracy_weekly with (security_invoker = on) as
select project_id, brand, week_start_date, iso_year, iso_week,
       count(*)::int                                   as skus,
       sum(forecast_qty)::int                          as forecast_qty,
       sum(actual_b2c)::int                            as actual_b2c,
       sum(actual_b2b)::int                            as actual_b2b,
       sum(abs(forecast_qty - actual_b2c))::int        as abs_err,
       round(sum(abs(forecast_qty - actual_b2c))::numeric / nullif(sum(actual_b2c), 0), 4) as wmape,
       round((sum(forecast_qty) - sum(actual_b2c))::numeric / nullif(sum(actual_b2c), 0), 4) as bias,
       -- same metrics against total outflow (B2C + B2B): what the S&D balance actually has to cover
       sum(abs(forecast_qty - actual_b2c - actual_b2b))::int as abs_err_total,
       round(sum(abs(forecast_qty - actual_b2c - actual_b2b))::numeric / nullif(sum(actual_b2c + actual_b2b), 0), 4) as wmape_total,
       round((sum(forecast_qty) - sum(actual_b2c + actual_b2b))::numeric / nullif(sum(actual_b2c + actual_b2b), 0), 4) as bias_total
  from public.attach_rate_accuracy_log
 group by project_id, brand, week_start_date, iso_year, iso_week;

-- Trailing 8 logged weeks per SKU.
create or replace view public.v_attach_rate_accuracy_sku with (security_invoker = on) as
with ranked as (
  select l.*, row_number() over (partition by project_id, sku order by week_start_date desc) rn
    from public.attach_rate_accuracy_log l)
select project_id, brand, sku,
       count(*)::int                                   as weeks,
       sum(forecast_qty)::int                          as forecast_qty,
       sum(actual_b2c)::int                            as actual_b2c,
       sum(abs(forecast_qty - actual_b2c))::int        as abs_err,
       round(sum(abs(forecast_qty - actual_b2c))::numeric / nullif(sum(actual_b2c), 0), 4) as wmape,
       round((sum(forecast_qty) - sum(actual_b2c))::numeric / nullif(sum(actual_b2c), 0), 4) as bias,
       sum(actual_b2b)::int                            as actual_b2b,
       sum(abs(forecast_qty - actual_b2c - actual_b2b))::int as abs_err_total,
       round(sum(abs(forecast_qty - actual_b2c - actual_b2b))::numeric / nullif(sum(actual_b2c + actual_b2b), 0), 4) as wmape_total,
       round((sum(forecast_qty) - sum(actual_b2c + actual_b2b))::numeric / nullif(sum(actual_b2c + actual_b2b), 0), 4) as bias_total
  from ranked where rn <= 8
 group by project_id, brand, sku;

revoke all on public.v_attach_rate_accuracy_weekly, public.v_attach_rate_accuracy_sku from anon;
grant select on public.v_attach_rate_accuracy_weekly, public.v_attach_rate_accuracy_sku to authenticated;

-- ===== part c =====
-- Regenerate now freezes accuracy history first (same body as 20261018_regenerate_attach_rate_forecast.sql
-- plus the perform line), then overwrites demand_forecast.
create or replace function public.regenerate_attach_rate_forecast(p_project_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_brand text; v_floor numeric; v_split text; v_sub uuid; n int; v_run timestamptz := now();
begin
  if auth.uid() is not null and public.ctg_global_role() not in ('superadmin','supply_chain') then
    raise exception 'Only supply chain admins can regenerate forecasts';
  end if;
  perform public.log_attach_rate_accuracy(p_project_id);
  select brand into v_brand from projects where id = p_project_id;
  select dtc_floor_rm_k, split_method into v_floor, v_split from brand_planning_config where project_id = p_project_id;
  select id into v_sub from forecast_submissions where project_id = p_project_id order by submitted_at desc limit 1;
  if v_sub is null then raise exception 'No forecast submission for %', p_project_id; end if;

  with rates as (
    select distinct on (sku, channel) sku, channel, units_per_rm_k::numeric r
      from attach_rates where project_id = p_project_id and effective_from <= current_date
     order by sku, channel, effective_from desc),
  rp as (
    select sku, coalesce(max(r) filter (where channel = 'DTC'), 0) dtc,
                coalesce(max(r) filter (where channel = 'YRDZ'), 0) yrdz
      from rates group by sku),
  m as (
    select extract(year from period)::int y, extract(month from period)::int mo, forecast_rm_k::numeric rm
      from forecast_monthly where submission_id = v_sub and forecast_rm_k > 0),
  sp as (
    select y, mo,
           case when v_split = 'dtc_floor' then least(rm, coalesce(v_floor, 0)) else rm end dtc_rm,
           case when v_split = 'dtc_floor' then greatest(rm - coalesce(v_floor, 0), 0) else 0 end yrdz_rm
      from m),
  u as (
    select rp.sku, sp.y, sp.mo, round(sp.dtc_rm * rp.dtc + sp.yrdz_rm * rp.yrdz)::int units
      from sp cross join rp),
  wk as (
    select year y, month mo, monday_date, wk_label, wk_in_year,
           row_number() over (partition by year, month order by monday_date) rn,
           count(*) over (partition by year, month) nw
      from week_calendar)
  insert into demand_forecast (sku, brand, project_id, iso_year, iso_week, week_start_date, wk_label,
                               forecast_qty, lower_bound, upper_bound, model_used, history_weeks, generated_at)
  select u.sku, v_brand, p_project_id, w.y, w.wk_in_year, w.monday_date, w.wk_label,
         (u.units / w.nw) + case when w.rn <= (u.units % w.nw) then 1 else 0 end,
         0, 0, 'attach_rate', 0, v_run
    from u join wk w on w.y = u.y and w.mo = u.mo
  on conflict (sku, iso_year, iso_week) do update
    set forecast_qty = excluded.forecast_qty, brand = excluded.brand, project_id = excluded.project_id,
        week_start_date = excluded.week_start_date, wk_label = excluded.wk_label,
        model_used = 'attach_rate', generated_at = v_run;
  get diagnostics n = row_count;

  update demand_forecast set forecast_qty = 0, model_used = 'superseded', generated_at = v_run
   where (project_id = p_project_id or brand = v_brand)
     and generated_at < v_run and model_used <> 'superseded';
  return n;
end $$;
revoke execute on function public.regenerate_attach_rate_forecast(text) from public, anon;
grant execute on function public.regenerate_attach_rate_forecast(text) to authenticated, service_role;

-- Daily 04:00 MYT (20:00 UTC): picks up any newly loaded closed week. Idempotent.
select cron.unschedule(jobid) from cron.job where jobname = 'attach-rate-accuracy-log-daily';
select cron.schedule('attach-rate-accuracy-log-daily', '0 20 * * *', $$select public.log_attach_rate_accuracy()$$);
