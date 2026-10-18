-- Per-brand overrides of inventory_policy_config (id=1). NULL column = follow the default.
create table if not exists public.inventory_policy_brand (
  brand text primary key,
  z_a numeric, z_b numeric, z_c numeric, abc_a_cut numeric, abc_b_cut numeric,
  cv_cap numeric, default_cv numeric, min_history_wk integer, run_rate_weeks integer,
  review_wk numeric, lt_sigma_wk numeric, order_cost_rm numeric, holding_rate numeric,
  planning_basis text check (planning_basis is null or planning_basis in ('run_rate','forecast','max')),
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.inventory_policy_brand enable row level security;
revoke all on public.inventory_policy_brand from anon;
grant select, insert, update, delete on public.inventory_policy_brand to authenticated;
create policy "inventory_policy_brand read" on public.inventory_policy_brand for select to authenticated using (true);
create policy "inventory_policy_brand insert" on public.inventory_policy_brand for insert to authenticated with check (((select ctg_global_role()) = any (array['superadmin','supply_chain'])));
create policy "inventory_policy_brand update" on public.inventory_policy_brand for update to authenticated using (((select ctg_global_role()) = any (array['superadmin','supply_chain']))) with check (((select ctg_global_role()) = any (array['superadmin','supply_chain'])));
create policy "inventory_policy_brand delete" on public.inventory_policy_brand for delete to authenticated using (((select ctg_global_role()) = any (array['superadmin','supply_chain'])));
