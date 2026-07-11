-- ============================================================
-- Attach-rate demand translation (applied to prod 2026-07-10
-- via Supabase MCP as 'attach_rate_demand_translation').
-- Converts monthly RM sales forecast -> SKU weekly unit demand.
-- ============================================================

create table if not exists public.attach_rates (
  id              bigserial primary key,
  brand           text not null,
  sku             text not null references public.master_sku(sku),
  channel         text not null check (channel in ('DTC','YRDZ')),
  units_per_rm_k  numeric(8,4) not null,
  effective_from  date not null default current_date,
  note            text,
  created_at      timestamptz default now(),
  constraint attach_rates_unique unique (brand, sku, channel, effective_from)
);

create index if not exists idx_attach_rates_brand_sku
  on public.attach_rates (brand, sku, channel, effective_from desc);

create table if not exists public.brand_planning_config (
  brand           text primary key,
  split_method    text not null default 'dtc_floor' check (split_method in ('dtc_floor','none')),
  dtc_floor_rm_k  numeric(10,2) not null default 0,
  note            text,
  updated_at      timestamptz default now()
);

alter table public.sales_forecast add column if not exists apr_27 numeric(10,2) default 0;
alter table public.sales_forecast add column if not exists may_27 numeric(10,2) default 0;
alter table public.sales_forecast add column if not exists jun_27 numeric(10,2) default 0;

alter table public.attach_rates enable row level security;
alter table public.brand_planning_config enable row level security;

create policy "Authenticated read attach_rates"
  on public.attach_rates for select to authenticated using (true);
create policy "Supply chain write attach_rates"
  on public.attach_rates for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','supply_chain')));

create policy "Authenticated read brand_planning_config"
  on public.brand_planning_config for select to authenticated using (true);
create policy "Supply chain write brand_planning_config"
  on public.brand_planning_config for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','supply_chain')));
