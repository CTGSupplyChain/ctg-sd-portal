-- Hide a SKU from S&D, Inventory Parameters, PO Release and alerts (reversible; admin/superadmin via master_sku write RLS).
alter table public.master_sku add column if not exists hidden_at timestamptz, add column if not exists hidden_by text;
