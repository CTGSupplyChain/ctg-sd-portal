-- SOW v2 Phase 2b — inventory parameter model (min/max, ROP, safety stock, EOQ)
-- Rebuilt 18 Oct 2026 from the 15 Sep iLady model. Tune inventory_policy_config, never the view body.
--
--   sigma_LT = CV_LT * mu * LT
--   SS       = sqrt((z*sigma_LT)^2 + (z*mu*lt_sigma_wk)^2)
--   ROP(Min) = mu*LT + SS          Max = mu*(LT+review_wk) + SS
--   EOQ      = sqrt(2*D*order_cost/(holding_rate*landed_price)), floored at MOQ
--   CV_LT is measured on rolling lead-time-length buckets (demand is lumpy), capped at cv_cap;
--   SKUs with thin history use default_cv. Run rate stops at the last loaded sales week,
--   so missing weeks are never read as zero demand.

create table if not exists public.inventory_policy_config (
  id int primary key default 1 check (id = 1),
  z_a numeric not null default 1.96,      -- 97.5%
  z_b numeric not null default 1.645,     -- 95%
  z_c numeric not null default 1.28,      -- 90%
  abc_a_cut numeric not null default 0.80,
  abc_b_cut numeric not null default 0.95,
  cv_cap numeric not null default 1.50,
  default_cv numeric not null default 0.60,
  min_history_wk int not null default 8,
  run_rate_weeks int not null default 13,
  review_wk numeric not null default 1,
  lt_sigma_wk numeric not null default 1,
  order_cost_rm numeric not null default 150,
  holding_rate numeric not null default 0.25,
  planning_basis text not null default 'max' check (planning_basis in ('run_rate','forecast','max')),
  updated_at timestamptz not null default now()
);
insert into public.inventory_policy_config (id) values (1) on conflict do nothing;
alter table public.inventory_policy_config enable row level security;
create policy "inventory_policy_config read" on public.inventory_policy_config for select to authenticated using (true);
create policy "inventory_policy_config write" on public.inventory_policy_config for update to authenticated
  using ((select public.ctg_global_role()) in ('superadmin','supply_chain'))
  with check ((select public.ctg_global_role()) in ('superadmin','supply_chain'));

create table if not exists public.sku_successor (
  old_sku text primary key references public.master_sku(sku),
  new_sku text not null references public.master_sku(sku),
  effective_from date not null,
  note text
);
alter table public.sku_successor enable row level security;
create policy "sku_successor read" on public.sku_successor for select to authenticated using ((select public.ctg_is_staff()) or new_sku in (select public.ctg_my_skus()));
create policy "sku_successor write" on public.sku_successor for all to authenticated
  using ((select public.ctg_global_role()) in ('superadmin','supply_chain'))
  with check ((select public.ctg_global_role()) in ('superadmin','supply_chain'));
insert into public.sku_successor (old_sku, new_sku, effective_from, note) values
  ('IPILBE120',  'IPILBEB120',  '2026-06-01', 'bottle -> box; bottle stays a kit component'),
  ('IPILESE120', 'IPILESEB120', '2026-06-01', 'bottle -> box; bottle stays a kit component'),
  ('IPILBSE30',  'IPILBSEB30',  '2026-06-01', 'bottle -> box; bottle stays a kit component'),
  ('IPILESE30',  'IPILESEB30',  '2026-06-01', 'bottle -> box; bottle stays a kit component')
on conflict (old_sku) do nothing;

create or replace view public.v_inventory_params with (security_invoker = on) as
with cfg as (select * from public.inventory_policy_config where id = 1),
last_wk as (select max(week_start_date) d from public.sales_history),
scope as (
  select m.sku, m.brand, m.project_id, m.description, m.status,
         greatest(coalesce(m.lead_time_wk, 4), 1) lt, coalesce(m.moq, 0) moq, m.landed_price
    from public.master_sku m
   where m.status = 'Active'
     and m.sku not in (select old_sku from public.sku_successor)),
wks as (  -- complete weekly series, zero-filled, ending at the last loaded week
  select s.sku, g.wk::date wk
    from scope s, cfg, last_wk,
         generate_series(last_wk.d - (7 * (greatest(cfg.run_rate_weeks, 26) - 1)), last_wk.d, interval '7 day') g(wk)),
series as (
  select w.sku, w.wk, coalesce(sum(h.qty), 0)::numeric q
    from wks w left join public.sales_history h on h.sku = w.sku and h.week_start_date = w.wk
   group by w.sku, w.wk),
run as (
  select s.sku,
         avg(q) filter (where wk > (select d from last_wk) - 7 * (select run_rate_weeks from cfg)) mu_run,
         stddev_samp(q) filter (where wk > (select d from last_wk) - 7 * (select run_rate_weeks from cfg)) sd_wk,
         count(*) filter (where q > 0) wks_with_sales,
         sum(q) total_26wk
    from series s group by s.sku),
roll as (  -- rolling lead-time-length demand buckets over the last 26 weeks
  select s.sku, sum(s2.q) bucket
    from series s
    join scope sc on sc.sku = s.sku
    join series s2 on s2.sku = s.sku and s2.wk > s.wk - 7 * sc.lt and s2.wk <= s.wk
   where s.wk >= (select d from last_wk) - 7 * 25 + 7 * (sc.lt - 1)
   group by s.sku, s.wk),
cvlt as (
  select sku, case when avg(bucket) > 0 then stddev_samp(bucket) / avg(bucket) end cv_lt
    from roll group by sku),
fc as (  -- forward forecast over the next 13 weeks from the current week
  select f.sku, sum(f.forecast_qty)::numeric / 13 mu_fc
    from public.demand_forecast f
   where f.model_used <> 'superseded'
     and f.week_start_date >= date_trunc('week', current_date)::date
     and f.week_start_date <  date_trunc('week', current_date)::date + 91
   group by f.sku),
stock as (
  select portal_sku sku, coalesce(usable_current, 0) usable, coalesce(incoming_current, 0) incoming, snapshot_date
    from public.v_stock_current),
base as (
  select sc.*, r.mu_run, r.sd_wk, r.wks_with_sales, coalesce(f.mu_fc, 0) mu_fc,
         case (select planning_basis from cfg)
           when 'run_rate' then coalesce(r.mu_run, 0)
           when 'forecast' then coalesce(f.mu_fc, 0)
           else greatest(coalesce(r.mu_run, 0), coalesce(f.mu_fc, 0)) end mu,
         case when r.wks_with_sales < (select min_history_wk from cfg) or c.cv_lt is null
              then (select default_cv from cfg)
              else least(c.cv_lt, (select cv_cap from cfg)) end cv_used,
         case when r.wks_with_sales < (select min_history_wk from cfg) or c.cv_lt is null then 'default' else 'measured' end cv_source,
         case when r.mu_run > 0 then r.sd_wk / r.mu_run end cv_wk,
         st.usable, st.incoming, st.snapshot_date
    from scope sc
    left join run r on r.sku = sc.sku
    left join cvlt c on c.sku = sc.sku
    left join fc f on f.sku = sc.sku
    left join stock st on st.sku = sc.sku),
abc as (
  select b.*, b.mu * 52 annual_units, b.mu * 52 * coalesce(b.landed_price, 0) annual_value,
         sum(b.mu * 52 * coalesce(b.landed_price, 0)) over (partition by b.brand order by b.mu * 52 * coalesce(b.landed_price, 0) desc, b.sku)
           / nullif(sum(b.mu * 52 * coalesce(b.landed_price, 0)) over (partition by b.brand), 0) cum_share
    from base b),
cls as (
  select a.*,
         case when a.landed_price is null or a.annual_value = 0 then 'C'
              when a.cum_share <= (select abc_a_cut from cfg) then 'A'
              when a.cum_share <= (select abc_b_cut from cfg) then 'B' else 'C' end abc,
         case when a.cv_wk is null then 'Z' when a.cv_wk < 0.5 then 'X' when a.cv_wk < 1.0 then 'Y' else 'Z' end xyz
    from abc a),
calc as (
  select c.*,
         case c.abc when 'A' then (select z_a from cfg) when 'B' then (select z_b from cfg) else (select z_c from cfg) end z
    from cls c),
p as (
  select k.*,
         round(sqrt(power(k.z * k.cv_used * k.mu * k.lt, 2) + power(k.z * k.mu * (select lt_sigma_wk from cfg), 2))) ss
    from calc k)
select p.sku, p.brand, p.project_id, p.description, p.lt lead_time_wk, p.moq, p.landed_price,
       round(p.mu_run, 1) run_rate_wk, round(p.mu_fc, 1) forecast_wk, round(p.mu, 1) planning_wk,
       (select planning_basis from cfg) planning_basis,
       round(p.cv_used, 2) cv_lt, p.cv_source, p.abc, p.xyz, p.abc || p.xyz segment, p.z,
       p.ss safety_stock,
       round(p.mu * p.lt + p.ss) rop_min,
       round(p.mu * (p.lt + (select review_wk from cfg)) + p.ss) max_level,
       case when p.landed_price > 0 and p.mu > 0
            then greatest(round(sqrt(2 * p.mu * 52 * (select order_cost_rm from cfg) / ((select holding_rate from cfg) * p.landed_price))), p.moq)
            else p.moq end eoq,
       p.usable, p.incoming, p.usable + p.incoming stock_position, p.snapshot_date,
       case when p.mu > 0 then round(p.usable / p.mu, 1) end woc_usable,
       case
         when p.mu = 0 then 0
         when p.usable + p.incoming > round(p.mu * p.lt + p.ss) then 0
         when p.moq > 0 then ceil((round(p.mu * (p.lt + (select review_wk from cfg)) + p.ss) - (p.usable + p.incoming)) / p.moq) * p.moq
         else round(p.mu * (p.lt + (select review_wk from cfg)) + p.ss) - (p.usable + p.incoming) end suggested_order_qty,
       case
         when p.mu = 0 and coalesce(p.usable, 0) > 0 then 'No demand'
         when p.mu = 0 then 'No signal'
         when p.usable <= 0 then 'Stocked out'
         when p.usable < p.ss then 'Below safety stock'
         when p.usable + p.incoming <= round(p.mu * p.lt + p.ss) then 'Order now'
         when p.usable > 1.5 * round(p.mu * (p.lt + (select review_wk from cfg)) + p.ss) then 'Excess'
         else 'OK' end status,
       (select d from last_wk) sales_through
  from p;

grant select on public.v_inventory_params to authenticated;
revoke all on public.v_inventory_params from anon;
