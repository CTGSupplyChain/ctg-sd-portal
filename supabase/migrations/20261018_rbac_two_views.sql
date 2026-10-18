-- SOW v2 Phase 0/1 — applied 18 Oct 2026 to cnmpbitgyezrgfgwqbuh as
--   rbac_two_views_a_2026_10_18, rbac_two_views_b_privileges_2026_10_18,
--   rbac_two_views_c_fast_policies_2026_10_18
-- Consolidated, final state below.
--
-- App roles (profiles.role):  superadmin | admin (legacy: supply_chain) | buyer | project_owner (= brand owner)
-- RLS tokens (ctg_global_role): superadmin | supply_chain | buyer | brand_owner | no-access

create or replace function public.ctg_global_role()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.role from public.ctg_roles r where r.portal_sub = public.ctg_current_sub()),
    (select case p.role
              when 'superadmin'    then 'superadmin'
              when 'admin'         then 'supply_chain'
              when 'supply_chain'  then 'supply_chain'
              when 'buyer'         then 'buyer'
              when 'project_owner' then 'brand_owner'
              else 'no-access' end
       from public.profiles p where p.id = auth.uid()),
    'no-access');
$$;

create or replace function public.ctg_is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.ctg_global_role() in ('superadmin','supply_chain','buyer');
$$;

create or replace function public.ctg_my_brands()
returns setof text language sql stable security definer set search_path = '' as $$
  select lower(u.brand) from public.user_brand_access u where u.user_id = auth.uid();
$$;

create or replace function public.ctg_my_skus()
returns setof text language sql stable security definer set search_path = '' as $$
  select m.sku from public.master_sku m
  where lower(m.brand) in (select lower(u.brand) from public.user_brand_access u where u.user_id = auth.uid());
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = 'public' as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role in ('admin','supply_chain','superadmin'));
$$;

-- Read policies. (select fn()) forms are evaluated once per query, not per row.
do $$
declare t text;
begin
  foreach t in array array['master_sku','projects','purchase_orders','forecast_submissions',
    'sales_history','demand_forecast','attach_rates','supply_input','sd_supply_manual',
    'stock_snapshot','historical_demand','brand_planning_config','sku_wms_mapping'] loop
    execute format('alter policy %I on public.%I using ((select public.ctg_is_staff()) or lower(brand) in (select public.ctg_my_brands()))', t || ' read', t);
  end loop;
  foreach t in array array['bom_lines','bom_revisions','component_requirements','cost_rollup',
    'cost_rollup_lines','manufacturer_parts','part_supplier','parts','plm_documents',
    'plm_suppliers','purchase_requisitions'] loop
    execute format('alter policy %I on public.%I using ((select public.ctg_is_staff()))', t || ' read', t);
  end loop;
end $$;

alter policy "forecast_monthly read" on public.forecast_monthly
  using ((select public.ctg_is_staff()) or submission_id in
         (select s.id from public.forecast_submissions s where lower(s.brand) in (select public.ctg_my_brands())));
alter policy "wms_inventory_snapshots read" on public.wms_inventory_snapshots
  using ((select public.ctg_is_staff()) or sku in (select public.ctg_my_skus()));
create policy "wms_stock_live read" on public.wms_stock_live for select to authenticated
  using ((select public.ctg_is_staff()) or sku in (select public.ctg_my_skus()));
create policy "wms_pull_state read" on public.wms_pull_state for select to authenticated
  using ((select public.ctg_is_staff()));
create policy "wms_webhook_events read" on public.wms_webhook_events for select to authenticated
  using ((select public.ctg_is_staff()));
create index if not exists wms_inventory_snapshots_date_sku_idx on public.wms_inventory_snapshots (snapshot_date, sku);

alter view public.v_stock_current set (security_invoker = on);
alter view public.v_wms_feed_health set (security_invoker = on);

-- Privileges: nothing for anon; write RPCs and trigger fns for service_role only
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
revoke execute on function public.apply_wms_stock_batch(jsonb), public.bulk_upsert_wms_snapshots(jsonb),
  public.log_wms_events_batch(jsonb), public.sync_wms_descriptions(jsonb),
  public.prevent_profile_role_change(), public.sd_supply_manual_set_brand(), public.handle_new_user()
  from authenticated;
revoke all on public.v_stock_current, public.v_wms_feed_health, public.sales_forecast,
  public.sd_view, public.weekly_atp_snapshot from anon;

alter function public.sync_wms_descriptions(jsonb) set search_path = public;
alter function public.forecast_set_latest() set search_path = public;
alter function public.bulk_upsert_wms_snapshots(jsonb) set search_path = public;
alter function public.handle_updated_at() set search_path = public;

-- Pre-assigned access: a user created with one of these emails gets the role + brand on sign-up
create table if not exists public.ctg_pending_access (
  email text primary key,
  role text not null check (role in ('project_owner','buyer','admin','superadmin')),
  brand text,
  created_at timestamptz not null default now()
);
alter table public.ctg_pending_access enable row level security;
insert into public.ctg_pending_access (email, role, brand) values
  ('owner_ilady@ctg4u.com', 'project_owner', 'iLady'),
  ('admin_ilady@ctg4u.com', 'admin',         'iLady'),
  ('buyer_ilady@ctg4u.com', 'buyer',         'iLady')
on conflict (email) do nothing;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare pa public.ctg_pending_access;
begin
  select * into pa from public.ctg_pending_access where lower(email) = lower(new.email);
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name', coalesce(pa.role, 'no-access'));
  if pa.brand is not null then
    insert into public.user_brand_access (user_id, brand, can_edit) values (new.id, pa.brand, false);
  end if;
  return new;
end; $$;

-- RADAR pull on hold (token revoked): job paused, re-enable with active := true
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'wms-stock-pull-5min'), active := false);
