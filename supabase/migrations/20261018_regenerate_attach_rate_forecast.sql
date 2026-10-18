-- Applied 18 Oct 2026 as regenerate_attach_rate_forecast_fn_2026_10_18.
-- SQL port of src/lib/attach-rate-forecast.ts keyed on project_id:
-- latest forecast submission → DTC/YRDZ split (brand_planning_config) → units = RM'000 × latest rate
-- → spread over the month's week_calendar rows (remainder to earliest weeks).
-- Upserts on (sku, iso_year, iso_week); rows from earlier runs are zeroed as 'superseded', never deleted.
create or replace function public.regenerate_attach_rate_forecast(p_project_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_brand text; v_floor numeric; v_split text; v_sub uuid; n int; v_run timestamptz := now();
begin
  if auth.uid() is not null and public.ctg_global_role() not in ('superadmin','supply_chain') then
    raise exception 'Only supply chain admins can regenerate forecasts';
  end if;
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
