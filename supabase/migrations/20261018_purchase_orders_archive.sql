-- 18 Oct 2026: backup of purchase_orders before retiring all legacy PO rows.
-- Legacy rows were then set to status='Cancelled', balance_qty=0 (data update, not DDL).
-- Future open orders are entered manually via the S&D Supply (Commit) row.
create table public.purchase_orders_archive_20261018 as select * from public.purchase_orders;
alter table public.purchase_orders_archive_20261018 enable row level security;
revoke all on public.purchase_orders_archive_20261018 from anon, authenticated;
