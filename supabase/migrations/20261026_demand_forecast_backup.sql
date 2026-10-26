-- Applied 26 Oct 2026 as demand_forecast_backup_20261026.
-- Snapshot of iLady (PROJ_CTG007) and SkinDae (PROJ_CTG029) weekly demand_forecast rows taken just before
-- regenerate_attach_rate_forecast() was re-run on the 26 Oct forecast load. Backup only; nothing reads it.
create table public.demand_forecast_backup_20261026 as
  select * from public.demand_forecast where project_id in ('PROJ_CTG007','PROJ_CTG029');
alter table public.demand_forecast_backup_20261026 enable row level security;
revoke all on public.demand_forecast_backup_20261026 from anon, authenticated;
