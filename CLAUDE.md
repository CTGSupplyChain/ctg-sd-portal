# CTG Supply Chain Portal

## Stack
Next.js 15.5 (App Router, src/app) · React 19 · TypeScript · Tailwind 3 · Recharts · xlsx
Supabase (Postgres 17, Auth, Storage, Edge Functions, pg_cron) via @supabase/ssr
Vercel (Node 24)

## Environments (the only ones)
- GitHub: CTGSupplyChain/ctg-sd-portal — source of truth. `main` = production.
- Vercel: team ctg-supply-chain-s-projects (team_J0z8E4obA8QUD8x3fso4QwkI),
  project ctg-sd-portal (prj_IGfzH3HcpKfF1pEdmUVDgfqdKMfj), https://ctg-sd-portal.vercel.app
- Supabase: cnmpbitgyezrgfgwqbuh (ap-southeast-1)
  Edge functions: wms-stock-webhook (no JWT), wms-stock-pull (pg_cron job `wms-stock-pull-5min`, PAUSED until a new RADAR_PULL_TOKEN is set)
- RETIRED, never write: cxmpkvwpdmheddquixjw, supplychain-portal.vercel.app
- Secrets only in Vercel env vars / Supabase secrets / .env.local. Never commit or print.

## Workflow
1. Branch from main → commit → push → open the Vercel preview URL and check the page.
2. Merge to main only after SimpleJack sees the preview.
3. Every schema change = a file in supabase/migrations, committed with its code.
   (Migrations applied before 18 Oct 2026 live only in supabase_migrations.schema_migrations — backfill pending.)
4. Back up before any migration that alters or deletes data.
5. Run Supabase security advisors after DDL; no new ERROR-level findings.
6. After production deploy, load the live page and confirm the change.

## Roles (src/lib/roles.ts ↔ RLS ctg_global_role)
| View | profiles.role | RLS token | Can |
|---|---|---|---|
| CTG Supply Chain | superadmin | superadmin | everything |
| | admin (legacy `supply_chain`) | supply_chain | edit master data, uploads, PLM, forecasts |
| | buyer | buyer | read all brands, write POs / supply input |
| Brand owner | project_owner | brand_owner | read own brand(s) only (user_brand_access) |
- Read policies use `(select ctg_is_staff()) or lower(brand) in (select ctg_my_brands())` — keep the `(select …)` wrappers, per-row calls time out.
- New users: add a row to `ctg_pending_access` (email, role, brand) first; `handle_new_user` applies it on sign-up.
- Views must be `security_invoker = on`. Nothing is granted to `anon`.

## Domain rules
- Plan recurring SKUs only; flag one-off/promo/GWP, never auto-discontinue.
- Check bom_lines (child_pn) before discontinuing any SKU.
- attach_rates / brand_planning_config / demand_forecast keyed on project_id, never brand.
- Retire a rate with a 0.0 row whose effective_from is later than all existing rows.
- Pack cutovers live in sku_successor; retired = in sku_successor.old_sku OR all-zero rates.
- Bulk B2B orders never enter attach-rate history.
- WOC = weeks until running balance first goes negative, from current ISO week; usable stock only, inbound shown separately.
- Never size parameters off a run rate that stops mid-quarter; run rate ends at the last loaded sales week.
- Regenerate attach-rate demand with `select regenerate_attach_rate_forecast('<project_id>')`.

## Data loads
- Order reports (Packxpert B2B/B2C): Order Date is `dd/mm/yyyy, HH:MM:SS`. Exclude cancelled, return_completed,
  return_assigned, cancelled_putaway. Brand comes from master_sku by SKU, never the Company column. Drop partial weeks.
- Inventory report (Packxpert): load as wms_inventory_snapshots for the report date; v_stock_current uses the latest snapshot.

## Current work
docs/SOW-v2.md. One phase at a time.
