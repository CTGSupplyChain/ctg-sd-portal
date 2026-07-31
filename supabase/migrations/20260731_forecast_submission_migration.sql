-- ============================================================
-- 20260731  Sales forecast: Google Sheet -> SD portal
--
-- Retires the GitHub Pages form + Apps Script + Google Sheet +
-- /api/forecast-sync pull chain. Submissions now land directly in
-- Supabase via the submit_forecast() RPC.
--
-- Wide `sales_forecast` (38 month columns) is replaced by a
-- normalised header/line pair. `sales_forecast` survives as a
-- read-only pivot VIEW so attach-rate-forecast.ts, sd-compute.ts,
-- regenerate-forecast, planned-po and project/[id] are unaffected.
--
-- Applied to project cnmpbitgyezrgfgwqbuh on 2026-07-31.
-- Recorded here for parity; see the three MCP migrations:
--   forecast_normalised_schema, forecast_normalised_rls,
--   submit_forecast_rpc
-- ============================================================

-- 1. Archive the pre-migration wide table (dates were day/month
--    swapped, total_rm mostly null, duplicate project spellings).
alter table public.sales_forecast rename to sales_forecast_legacy;

-- 2. Drop the unused SKU-level stubs, rebuild for RM'000 headers/lines.
drop table if exists public.forecast_monthly;
drop table if exists public.forecast_submissions;

create table public.forecast_submissions (
  id             uuid primary key default gen_random_uuid(),
  project_id     text        not null references public.projects(id),
  project_name   text        not null,
  brand          text        not null,
  company        text,
  owner_email    text        not null,
  submitted_by   uuid        references auth.users(id) on delete set null,
  submitted_at   timestamptz not null default now(),
  week_code      text        not null,
  year           int         not null,
  horizon_start  date        not null,
  horizon_months int         not null default 12,
  total_rm_k     numeric     not null default 0,
  notes          text,
  is_latest      boolean     not null default true,
  source         text        not null default 'portal'
                 check (source in ('portal','gsheet_migration')),
  created_at     timestamptz not null default now()
);

create index forecast_submissions_project_idx on public.forecast_submissions (project_id, submitted_at desc);
create index forecast_submissions_latest_idx  on public.forecast_submissions (project_id) where is_latest;
create index forecast_submissions_week_idx    on public.forecast_submissions (week_code);

create table public.forecast_monthly (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid    not null references public.forecast_submissions(id) on delete cascade,
  period         date    not null,
  forecast_rm_k  numeric not null default 0 check (forecast_rm_k >= 0),
  unique (submission_id, period)
);

create index forecast_monthly_period_idx on public.forecast_monthly (period);

-- 3. One is_latest per project.
create or replace function public.forecast_set_latest()
returns trigger language plpgsql as $$
begin
  if new.is_latest then
    update public.forecast_submissions
       set is_latest = false
     where project_id = new.project_id and id <> new.id and is_latest;
  end if;
  return new;
end;
$$;

create trigger forecast_submissions_set_latest
  after insert on public.forecast_submissions
  for each row execute function public.forecast_set_latest();

-- 4. Compatibility pivot view — see the MCP migration for the full
--    38-month column list (apr_26 .. may_29).
-- create view public.sales_forecast as select ... ;

-- 5. RLS: staff see everything, brand owners see and submit only
--    their own brands (mirrors read_scoped_projects).

-- 6. submit_forecast(p_project_id, p_notes, p_months numeric[])
--    security-definer RPC: atomic header + lines, brand/company/week/
--    total derived server-side.
