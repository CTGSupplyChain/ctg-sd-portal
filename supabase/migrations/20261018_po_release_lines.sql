-- PO release list: reference list of suggested purchase orders for the buyer to act on.
-- Not a PO system: finance/procurement keep the real PO. po_ref records the PO number
-- the buyer pasted once the line has been converted elsewhere.
create table if not exists public.po_release_lines (
  id            uuid primary key default gen_random_uuid(),
  sku           text not null,
  brand         text,
  suggested_qty integer not null default 0,
  order_qty     integer not null default 0,
  order_date    date not null default current_date,
  eta           date,
  reason        text,
  notes         text,
  po_ref        text,
  status        text not null default 'open' check (status in ('open','converted','dismissed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create unique index if not exists po_release_lines_one_open_per_sku
  on public.po_release_lines (sku) where status = 'open';
create index if not exists po_release_lines_status_idx on public.po_release_lines (status, brand);

alter table public.po_release_lines enable row level security;
drop policy if exists po_release_lines_staff_read on public.po_release_lines;
create policy po_release_lines_staff_read on public.po_release_lines
  for select to authenticated using ((select ctg_is_staff()));
revoke all on public.po_release_lines from anon;
grant select on public.po_release_lines to authenticated;
-- Writes go through /api/po-release (service role) after a role check.
