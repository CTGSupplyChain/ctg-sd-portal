# CTG Supply Chain Portal — Full Handover to Claude Code

Written 18 Oct 2026 (Sun, Asia/Kuala_Lumpur) from the Claude app session that built SOW v2 Phases 0–2 and the PO Release / hide-SKU work.
Read this file first, then `CLAUDE.md` (rules), then `docs/SOW-v2.md` (scope). Nothing here contains a secret; see §3 for where secrets live.

---

## 0. How to use this handover

1. This file lives at `docs/HANDOVER.md` in the repo. `CLAUDE.md` points to it, so Claude Code loads it automatically when opened in the repo.
2. Treat the **repo + live database** as the source of truth. Where this file and the code disagree, the code wins — then fix this file.
3. Work **one SOW phase at a time** and follow the workflow in §10. Verify live pages in Chrome after every production deploy (the owner asked for this explicitly).

---

## 1. Owner, working style and context

- **Owner / decision maker:** SimpleJack = JiaJie Ong, `jiajie.ong@ctg4u.com`, Penang, Malaysia (UTC+8).
- **Status:** left CTG; started a new job on 12 Oct 2026. Continues as a **contractor** to finish this portal. Target completion in the SOW was **18 Oct 2026** (the day of this handover). Free tiers only.
- **How he wants to be worked with:** professional, direct, minimal small talk (ENTJ). Give structured results, not running commentary. Do not tie answers to his other work or field unless he asks. He decides. Until 18 Oct he approved every production merge explicitly; from 18 Oct 2026 he approved auto-merge (see §10).
- **Expectation:** own the loop end to end — branch, commit, push, preview, (he checks), merge, production deploy, **verify the live page in Chrome**, report. Ask only when genuinely blocked or when a decision is irreversible.
- He tests on Vercel preview URLs and the live site himself; if previews are awkward he asks for a standalone HTML mock-up instead.
- Use SOW/own terminology: "S&D", "Supply (Commit)", "WOC", "PO Release", "Brand owner", "CTG Supply Chain view".

## 2. Vision

A single source of truth for CTG's supply & demand planning, replacing spreadsheets:
- **Two views.** *CTG Supply Chain* (superadmin, admin, buyer) sees all brands and acts. *Brand owner* (e.g. iLady) is **view-only for their own brand**.
- Demand comes from each brand's monthly RM sales forecast, translated to weekly SKU demand via **attach rates** (units per RM'000 of sales), checked against WMS actuals (WMAPE/bias).
- Stock comes from the Packxpert WMS (inventory report uploads + live webhook).
- The portal tells the buyer **what to order, how much and by when** (inventory parameters → PO Release list), and shows each SKU's weekly balance for 52 weeks.
- BOM explosion turns finished-goods demand into component demand and planned POs (Phase 4).
- Final step, after all phases: connect to the **Procurement portal** (owned by another colleague) so PO quantity/ETA populate automatically and manual PO entry is retired.
- Constraints: free tiers (Vercel, Supabase, GitHub), no paid services.

---

## 3. Environments, accounts and access (no secrets here)

| Item | Value |
|---|---|
| GitHub (source of truth) | `CTGSupplyChain/ctg-sd-portal`, `main` = production. Public repo. |
| Vercel | team `ctg-supply-chain-s-projects` (`team_J0z8E4obA8QUD8x3fso4QwkI`), project `ctg-sd-portal` (`prj_IGfzH3HcpKfF1pEdmUVDgfqdKMfj`), production https://ctg-sd-portal.vercel.app. Branch previews: `ctg-sd-portal-git-<branch>-ctg-supply-chain-s-projects.vercel.app` |
| Supabase | project ref `cnmpbitgyezrgfgwqbuh` (ap-southeast-1), Postgres 17. Auth, Storage, Edge Functions, pg_cron. |
| **RETIRED — never write** | Supabase `cxmpkvwpdmheddquixjw` and https://supplychain-portal.vercel.app (the corporate CTG2U stack). Older notes and memory files still say to use `cxmpkvwpdmheddquixjw` — **that is obsolete**. |
| Edge functions | `wms-stock-webhook` (no JWT), `wms-stock-pull` |
| pg_cron | job `wms-stock-pull-5min` (`*/5 * * * *`) is **PAUSED** until a new `RADAR_PULL_TOKEN` is set |
| Runtime | Next.js 15.5.18 (App Router, `src/app`), React 19, TypeScript, Tailwind 3, Recharts, xlsx, lucide-react, date-fns; Vercel on Node 24 |
| Key env vars (names only) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Vercel env / `.env.local`), `RADAR_PULL_TOKEN` (Supabase secret, to be reissued), plus `NEXT_PUBLIC_APP_NAME / CURRENT_WEEK / CURRENT_YEAR` from `.env.local.example` |

**Where secrets live:** Vercel project env vars, Supabase secrets, and `.env.local`. Never commit, print or paste them. Passwords are **not** recorded anywhere in this repo or handover.

### Login accounts (existing rows in `profiles`)
| Email | profiles.role | Normalised role | Brand access |
|---|---|---|---|
| jiajie.ong@ctg4u.com | `supply_chain` (legacy) | admin (CTG Supply Chain) | all |
| lilian@ctg4u.com | `supply_chain` | admin | all — manages PO uploads |
| ctggodview@ctg4u.com | `supply_chain` | admin | all ("God View") |
| admin_ilady@ctg4u.com | `admin` | admin | iLady |
| buyer_ilady@ctg4u.com | `buyer` | buyer | iLady |
| owner_ilady@ctg4u.com | `project_owner` | brand_owner | iLady |
| ilady@ctg4u.com | `project_owner` | brand_owner | iLady |
| skindae@ctg4u.com | `project_owner` | brand_owner | SkinDae |

- There is **no `superadmin` row yet** in `profiles`; promote one account when the owner asks (set `profiles.role='superadmin'`).
- The three iLady test accounts exist in `profiles` and in `ctg_pending_access`; their passwords are not known to this handover. To log in as them, reset the password in the Supabase Auth dashboard (create/reset users in the Dashboard UI, **not** raw SQL — bcrypt cost issues). **An assistant must never type passwords** — ask the owner to sign in.
- Preview deployments are per host, so the owner must sign in on each preview URL separately (cookies are per host).
- New users: insert a row into `ctg_pending_access (email, role, brand)` first; trigger `handle_new_user` applies it on sign-up.

---

## 4. Roles and security

`src/lib/roles.ts` ↔ RLS function `ctg_global_role()`:

| View | profiles.role | RLS token | Can |
|---|---|---|---|
| CTG Supply Chain | superadmin | superadmin | everything |
| | admin (legacy `supply_chain`) | supply_chain | edit master data, uploads, PLM, forecasts, open-PO entry, hide SKUs |
| | buyer | buyer | read all brands, PO Release, write POs / supply input |
| Brand owner | project_owner | brand_owner | read own brand(s) only (`user_brand_access`) |

Helpers in `roles.ts`: `normalizeRole`, `isStaff`, `canEdit` (superadmin/admin), `canBuy` (superadmin/admin/buyer), `isBrandOwner`.

RLS rules to preserve:
- Read policies use `(select ctg_is_staff()) or lower(brand) in (select ctg_my_brands())`. **Keep the `(select …)` wrappers** — per-row function calls time out.
- Views must be `security_invoker = on`. **Nothing is granted to `anon`.**
- `master_sku` write policy = roles `supply_chain` + `superadmin` (this is what lets the Inventory Parameters page edit LT/MOQ and the S&D page hide SKUs from the browser).
- Write API routes use the service role **after** checking the caller's role from the Bearer token.
- Supabase advisors last run: no ERROR findings. Remaining: INFO `rls_enabled_no_policy` on 7 tables (incl. `_sh_stage`, the archive table), WARN executable SECURITY DEFINER functions (`regenerate_attach_rate_forecast` checks role internally), leaked-password protection off.

---

## 5. Architecture map

### Pages (`src/app`)
`login`, `dashboard` (Inventory Health, open to brand owners), `inventory-params`, `po-release` (staff only), `project/[id]` (S&D per brand: `/project/iLady`, `/project/SkinDae`, `/project/Kata`), `forecast-submit`, `forecast-log`, `sales-history-upload`, `inventory-upload`, `master-sku` (+ `/upload`), `part-master`, `planned-po`, `supply-input`, `plm` + `plm/[pn]`.

### API routes (`src/app/api`)
`open-po` (manual Supply (Commit) entry, canEdit), `po-release` (actions `refresh|import|save|convert|dismiss`, canBuy, `maxDuration=30`), `regenerate-forecast`, `sales-history-upload`, `inventory-upload`, `master-sku`, `po-sync`, `supply-input`, `supply-input-component`.

### Libraries and components
`lib/sd-compute.ts` (S&D balance/flags), `lib/bom-mrp.ts`, `lib/attach-rate-forecast.ts`, `lib/forecasting/*` (Holt-Winters, order-report parser), `lib/roles.ts`, `lib/supabase.ts`, `lib/plm-*`. `components/sd/SDTable.tsx` (SDGrid, CommitEntryRow, SDLegend, `compact` mode), `components/layout/Sidebar.tsx` (`VISIBLE_BRANDS = ['ilady','skindae','kata']` controls "My Projects"), `components/plm/*`.

### Database (public schema)
Tables: `master_sku` (incl. `hidden_at`, `hidden_by`), `projects`, `week_calendar`, `sales_history`, `demand_forecast`, `attach_rates`, `brand_planning_config`, `forecast_submissions`, `forecast_monthly`, `sku_successor`, `sku_wms_mapping`, `wms_inventory_snapshots`, `wms_stock_live`, `wms_webhook_events`, `wms_pull_state`, `wms_customer_map`, `stock_snapshot`, `purchase_orders`, `purchase_orders_archive_20261018`, `purchase_requisitions`, `supply_input`, `sd_supply_manual`, `po_release_lines`, `inventory_policy_config` (id=1 default), `inventory_policy_brand` (per-brand overrides, NULL = follow default), `bom_revisions`, `bom_lines`, `component_requirements`, `cost_rollup(_lines)`, `parts`, `manufacturer_parts`, `part_supplier`, `plm_documents`, `plm_suppliers`, `profiles`, `user_brand_access`, `ctg_roles`, `ctg_grants`, `ctg_identities`, `ctg_pending_access`, `historical_demand`, `sales_forecast_legacy`, `_sh_stage` (scratch; to drop).
Views: `v_inventory_params`, `v_stock_current` (live webhook value if newer, else latest snapshot), `v_wms_feed_health`, `weekly_atp_snapshot`, `sd_view`, `sales_forecast` (compat).
Functions: `regenerate_attach_rate_forecast('<project_id>')`, `handle_new_user`, `ctg_global_role()`, `ctg_is_staff()`, `ctg_my_brands()`, `bulk_upsert_wms_snapshots(jsonb)`.

### Migrations
`supabase/migrations/`: `001_initial_schema`, `20260515_*`, `20260516_*`, `20260710_*`, `20260731_*`, and the 18 Oct 2026 set: `rbac_two_views`, `regenerate_attach_rate_forecast`, `inventory_params` (**superseded** — do not rely on it), `inventory_policy_brand`, `inventory_params_per_brand`, `inventory_params_hidden` (**current** view definition), `po_release_lines`, `po_release_snooze`, `purchase_orders_archive`, `master_sku_hidden`.
**Gap:** migrations applied before 18 Oct 2026 live only in `supabase_migrations.schema_migrations`; backfilling them into the repo is pending (use `list_migrations` and the schema as the reference).

---

## 6. SOW v2 (scope, phases, status as of 18 Oct 2026)

Full SOW is the Claude doc "Supply Chain Portal — SOW v2" (owner SimpleJack); the repo copy is `docs/SOW-v2.md`. If the doc is needed, ask the owner to export it.

| Phase | Scope | Status |
|---|---|---|
| 0 — Consolidate | Git = production, migrations in repo, write functions locked down, calendar, data refresh | Done except: backfill of pre-18-Oct migrations; RADAR token (cron paused) |
| 1 — Two views | CTG Supply Chain (superadmin/admin/buyer) and Brand owner (view-only own brand) | Done in DB + UI; test users exist in `profiles`, owner to test sign-in |
| 2a — Inventory health | `/dashboard`, SKU-level WOC / run-out / bands | Live; open to brand owners |
| 2b — Inventory parameters | `/inventory-params` over `v_inventory_params` | Live; LT/MOQ editable, Target WOC column, per-brand policy |
| 3 — Accuracy + onboarding | Weekly attach-rate log, WMAPE/bias, onboard other brands | **Next** |
| 4 — BOM explosion | Kits → component demand → planned PO | **Next** |
| 5 — PO release list | Suggested POs for the buyer to review, edit and release | Built 18 Oct (see §8); polish/feedback only |
| Backlog | Supplier / PO approval workflow | Not scheduled |
| After all phases | Connect to the Procurement portal so PO quantity/ETA auto-populate; retires manual Supply (Commit) entry | **Do last. Not started.** |

Older roadmaps still in the repo/memory (context, lower priority): `ROADMAP.md` — PLM phases (BOM core live; Phase 2 multi-MPN + tabbed part detail; Phase 3 PO trigger/BOM explosion; Phase 4 compliance docs & cert expiry; Phase 5 ECO/change control). May-2026 portal roadmap: verify login+S&D, UI fixes, Power Query/GSheet forecast connect (replaced by in-portal forecast submission), Supply Input form, BoldSign PO approval, Resend supplier email, multi-brand expansion (NatureLish/iProcare/Mejorecare/Bonlife), PLM BOM management + technical drawing upload. Upload templates: title row, instructions row, header row only; data from row 4; no sample rows unless asked.

---

## 7. Domain rules (must follow)

- Plan **recurring SKUs only**; flag one-off/promo/GWP, **never auto-discontinue**.
- Before discontinuing any SKU check `bom_lines` (`child_pn`) — a SKU with no demand can still be a live component (box/retail variant = naked bottle + unit box + sealing fee; suppress the bottle's independent demand with a 0.0 rate instead).
- `attach_rates`, `brand_planning_config`, `demand_forecast` are keyed on **`project_id`, never brand**.
- Retire a rate by inserting a **0.0 row whose `effective_from` is later than all existing rows** for that sku+channel (latest date wins; no `effective_to`).
- Pack cutovers live in `sku_successor`; **retired = in `sku_successor.old_sku` OR all-zero rates** (keep both tests).
- **Bulk B2B orders never enter attach-rate history.**
- **WOC** = weeks until the running balance first goes negative, from the **current ISO week** (forecast start = current week, not +1); usable stock only; inbound shown separately.
- **Never size parameters off a run rate that stops mid-quarter**; run rate ends at the last loaded sales week.
- Regenerate attach-rate demand with `select regenerate_attach_rate_forecast('<project_id>')`.
- Forecast for capacity/OEM booking; run rate for replenishment timing (WMAPE ~75–105%, bias +11…+33% on iLady).
- iLady vs iProcare: `master_sku` brand is **iLady** only; always resolve to iLady (company column may say iProcare).
- Brand names in DB: `iLady`, `SkinDae`, `Kata`, `Naturelish`, `Ninoko`, `Mejorcare`, `Bonlife`, `GoHerb`, `GTI`, `MCS`, `Mizino`, `NomoQ`, `SwissMed`, `Wellspring`. Compare brands case-insensitively (`lower(brand)`); note a stray `Skindae` spelling existed in `purchase_orders`.

---

## 8. What exists today (feature reference)

**S&D grid** (`/project/[brand]`): rolling 52 weeks from current week; rows Forecast RM'000, Forecast Qty, Supply (Uncommit), Supply (Commit), Balance. Compact layout (`.sd-compact` in `globals.css`). Cards show On-hand, WoC, Next PO, flag (STOCKOUT / RELEASE PO / PLAN PO / OK), expandable "BOM & History".
- **Supply (Commit) is editable** for admin/superadmin: type the *total* commit for a week; stored as `purchase_orders` row `po_number = OPEN-<sku>-<wk_label>` (status Open if qty>0 else Cancelled, `commit_status='Commit'`, supplier "Manual entry") via `/api/open-po`; the delta vs non-manual supply is stored. Temporary until Procurement-portal connection.
- **"Show all SKUs" checkbox** (default off): hides SKUs with no forecast demand and no alert (count shown); search always spans all SKUs.
- **Hide / Restore SKU** (admin/superadmin): "Hide" button on each card → sets `master_sku.hidden_at`; undo bar; "Hidden (N)" list with Restore. Hidden SKUs drop out of S&D, alert counts, `v_inventory_params` (so Inventory Parameters, Inventory Health and PO Release suggestions) and open PO Release lines.
- Sidebar "My Projects": iLady, Kata, SkinDae.

**Inventory Parameters** (`/inventory-params`, view `v_inventory_params`): model (s,S) min-max.
`SS = sqrt((z·CV_LT·μ·LT)² + (z·μ·σ_LT)²)`, `ROP = μ·LT + SS`, `Max = μ·(LT+review)+SS`, `EOQ = sqrt(2·D·order_cost/(holding·price))` floored at MOQ, suggested qty rounds up to MOQ (0 above ROP). z by ABC (A 97.5 / B 95 / C 90); CV measured on rolling lead-time buckets, capped, with a default CV for thin history. Planning basis per brand: run rate / forecast / max of both. **Target WOC = Max level / μ** (lead time + review + safety stock, per SKU). Statuses: Stocked out, Below safety stock, Order now, OK, Excess, No demand, No signal.
- **LT wk and MOQ are editable inline** (admin/superadmin → `master_sku`); recalculates on save.
- Policy knobs: `inventory_policy_config` (default) + `inventory_policy_brand` overrides (pick a brand to edit only that brand; only differing values are stored).
- Usable / Incoming / WOC columns were removed on request (Target WOC shown instead).

**PO Release** (`/po-release`, staff): reference list for the buyer — order date, SKU, quantity, ETA, notes. Because inventory and finance systems are separate, the buyer places the PO in the finance/procurement system and pastes the **PO number** back ("Mark converted"). No PO numbering, no approval workflow (backlog). Features: brand filter (default iLady), tabs "To action" / "Converted", inline-editable date/qty/notes, columns Stock·incoming, WOC now, WOC after PO, Target WOC, Export CSV, Import PO numbers (xlsx/CSV), Refresh suggestions (also auto-runs once per visit). **Dismiss** snoozes a line until **next Monday 00:00 MYT**, when it returns. One open line per SKU (partial unique index). Converted lines with ETA ≥ today suppress re-suggestion.

**Other live pages:** Inventory Health `/dashboard`, forecast submission/log, sales-history and inventory uploads, master SKU, part master, planned PO, supply input, PLM (BOM viewer, cost rollup, suppliers, where-used, documents).

### Production merges in this stretch
#13 (d7959ee) SOW v2 earlier work · #14 (ba6ac59) editable Supply (Commit), PO Release, per-brand policy · #15 (7eec377) compact S&D · #16 (68e7079) show-all toggle + SkinDae/Kata projects · #17 (e9f2911) Inventory Parameters edit LT/MOQ + Target WOC + PO archive · #18 (976a743) hide/restore SKU. Each was verified live (the owner asked that Chrome be used to confirm every live deploy).

---

## 9. Data state (18 Oct 2026) and data-load procedures

- `sales_history` through the week of **21 Sep 2026**. **October order reports deliberately left out** until the owner says otherwise. Work on data to end of September.
- Stock = Packxpert inventory report dated **18 Oct 2026** (`wms_inventory_snapshots`, snapshot_date 2026-10-18; `v_stock_current` uses the latest snapshot / newer live value).
- **Forecasts (26 Oct 2026):** the Google Sheet export `CTG Sales Forecast.xlsx` was loaded into `forecast_submissions` / `forecast_monthly` (57 submissions newer than the DB, `source='gsheet_migration'`, horizon from Apr'26, 18 months). Latest iLady = W43/2026, RM21,300K. `regenerate_attach_rate_forecast` was re-run for **iLady and SkinDae only** (backup: `demand_forecast_backup_20261026`). Kata, Naturelish and Ninoko have submissions but were not regenerated (not yet onboarded to attach rates). **Humeal** was added as project `PROJ_CTG035` (brand Naturelish, company Naturelish) on 26 Oct with its 2 submissions (latest W43/2026, RM4,250K); not on attach rates. Next forecasts should come through the portal submission page.
- **WK53 fix (26 Oct 2026):** stale rows keyed iso_year 2027 for 2026-WK53 and a mislabelled calendar row (2026-WK01 carried year 2026) were corrected (migration `20261026_fix_wk53_forecast_keys.sql`, backups `demand_forecast_stale_keys_backup_20261026`); iLady and SkinDae re-generated. The S&D lookup now ignores `superseded` rows.
- **Purchase orders:** all 88 legacy rows were set to `Cancelled` (balance 0) on 18 Oct because inventory is per the uploaded file; a full copy is in `purchase_orders_archive_20261018`. **All future open orders are entered manually** via Supply (Commit). The owner has no iLady open-PO information yet.
- iLady has 26 active SKUs; 6 new SKUs were added to the active watch list. Kata 24 active, SkinDae 15 active. Other brands exist in `master_sku` but only iLady/SkinDae/Kata are in the sidebar.

**Order-report load (Packxpert B2B/B2C `.xls`) → `sales_history`:**
1. Columns: Company, Seller Sku, Item Name, Order Date (`dd/mm/yyyy, HH:MM:SS`), Order Number, Ordered Quantity, Order Status.
2. Exclude statuses `cancelled`, `return_completed`, `return_assigned`, `cancelled_putaway`; keep in-progress ones.
3. Brand comes from `master_sku` by SKU — **never the Company column**; unmatched SKUs are dropped (flag them to the owner, don't invent a brand).
4. Aggregate to (brand, company, sku, channel, iso_year, iso_week, week_start_date): qty sum, distinct order count.
5. Dedupe on `(sku, channel, iso_year, iso_week)`; skip weeks already loaded; **drop partial weeks** (a >10× drop vs a full week is a red flag).
6. Insert with `source='WMS Upload'`, `uploaded_by='jiajie.ong@ctg4u.com'`, ~150 rows per statement; verify row count and sum(qty).
7. B2B bulk orders stay out of attach-rate history.

**Inventory report (Packxpert):** load as `wms_inventory_snapshots` for the report date (daily endpoint `/inventory-upload`).

**Attach-rate onboarding / refresh** is documented in `docs/SD_Demand_Translation_Methodology.md` and the Claude skill `demand-forecast-databees` (derive attach rates from a Databees "Order Form" export; apply to iLady, Kata, SkinDae and other brands).

---

## 10. Working agreement (workflow)

1. Branch from `main` → commit → push → open the Vercel preview URL and check the page.
2. **Auto-merge (owner rule, 19 Oct 2026):** once typecheck + build pass and the branch preview is READY and checked (pages load, no console errors), squash-merge the PR to `main` yourself; do not wait for the owner. Ask first only for irreversible/destructive data actions, role/security changes, or undecided product choices.
3. Every schema change = a file in `supabase/migrations`, committed with its code.
4. **Back up before any migration that alters or deletes data.** Prefer reversible changes (cancel/archive) over hard deletes.
5. Run Supabase security advisors after DDL; no new ERROR findings.
6. After production deploy, **load the live page in Chrome and confirm the change**, then report.
7. Commit messages: end with the attribution lines the harness provides.
8. `docs/SOW-v2.md` is "Current work": one phase at a time.

### Practical gotchas learned
- In the Claude app sandbox `gh pr create` failed (GraphQL blocked); REST works: `gh api repos/CTGSupplyChain/ctg-sd-portal/pulls …` and `…/pulls/N/merge -f merge_method=squash`. In Claude Code on his machine `gh` may work normally.
- A stop hook complains about "unpushed commits / no remote branch" when a local branch has no tracking info: `git config --add remote.origin.fetch +refs/heads/<b>:refs/remotes/origin/<b>; git fetch; git branch -u origin/<b>`.
- Supabase `apply_migration` can cancel on very large combined statements — split DDL into small migrations; `execute_sql` with several statements only returns the last result.
- An auto-mode classifier can block writes to the live DB without explicit user approval; ask the owner, don't work around it.
- Check the Vercel deployment state before assuming a fix is live (a failed build silently keeps the previous deploy).
- When adding an optional param to `loadAll`, don't pass it as `onClick={loadAll}` (event arg) — use `() => loadAll()`.
- Policy upsert must use an explicit key list (exclude `id`/`updated_at`).
- Read policies need `(select …)` wrappers (see §4). Views `security_invoker = on`.
- Fetch file SHA before GitHub API PUTs (409 on stale SHA) if editing via API.

---

## 11. Open items, risks and what is awaited

**Waiting on the owner**
- Open iLady PO data (he will enter via Supply (Commit)).
- New `RADAR_PULL_TOKEN` → then un-pause cron `wms-stock-pull-5min`.
- Real **MOQ and lead times for Kata** (all 24 SKUs have MOQ 0; LT is 4 or 8 wks — looks defaulted). SkinDae master data is filled in.
- Sign-in test of the three iLady test accounts (view-only brand owner, admin, buyer) and decision on a `superadmin` account.
- Whether to extend the sidebar beyond iLady/SkinDae/Kata (edit `VISIBLE_BRANDS`).

**Data observations to keep in mind**
- SkinDae on 18 Oct: 13 of 13 visible SKUs flagged; 8 stocked out; WMS stock genuinely trended to 0 (not a load gap). WMS "incoming" values are tiny and static (20, 2) and unreliable — ignore until explained. Hide SDSDB10S / SDSDAP05S was the owner's example (brochure/angpow type items).
- Kata on 18 Oct: 9 of 24 stocked out, 7 below safety stock.
- Corporate-DB defects found on 15 Sep (missing attach-rate transfers, kits with no BOM, duplicate planning SKUs across companies, `landed_price` NULL / MOQ 0 on accessory SKUs, IPIPITK01 with forecast but no sales) — re-check against the CTGSupplyChain DB before relying on them. `bom_revisions` / `component_requirements` may still be empty for kits (needed for Phase 4).
- `week_calendar` previously ended 2027-05-24 (silently dropping the last forecast month); the S&D grid now reaches 2027-WK40 — verify coverage whenever a 12-month forecast is loaded.

**Engineering backlog (from SOW)**
1. Backfill pre-18-Oct migrations into `supabase/migrations`.
2. Drop `_sh_stage`; reconcile/remove superseded `20261018_inventory_params.sql`.
3. Phase 3: weekly attach-rate log, WMAPE/bias tracking (see memory note "attach-rate-mape-tracking"), onboard remaining brands (Naturelish, Ninoko, Mejorcare, Bonlife, GoHerb, GTI, MCS, Mizino, NomoQ, SwissMed, Wellspring).
4. Phase 4: BOM explosion → component demand → planned PO (`planned-po` page, `bom-mrp.ts`).
5. Supplier / PO approval workflow (backlog, unscheduled).
6. **Last:** Procurement-portal integration (owner of that portal: another colleague; not yet contacted/connected).
7. Optional: update the Claude doc "SOW v2" (only the repo copy was updated), advisor warnings clean-up.

---

## 12. Decision log (why things are the way they are)

- 15 Oct 2026: CTGSupplyChain GitHub/Supabase (`cnmpbitgyezrgfgwqbuh`)/Vercel is the real stack — the corporate CTG2U stack was too slow (PR approval wait, no preview). No corporate data to migrate; this DB is the "vault of truth".
- Open-PO entry kept simple: make the existing **Supply (Commit)** row editable, no separate form.
- PO Release is a **reference list**, no PO numbering, no approval, because inventory and finance systems are independent; buyer pastes the PO number back.
- Dismissed PO lines return every **Monday 00:00 (MYT)**.
- WOC for the buyer = current usable stock / planning rate (excludes incoming); target WOC is per SKU (lead time + review + safety stock), controls are per brand.
- Compact S&D layout approved from a standalone HTML mock-up.
- Show-all toggle is a checkbox; manual **Hide** is a separate, persistent, brand-wide action that also removes the SKU from PO Release and inventory alerts (owner chose "out of scope everywhere").
- Legacy POs were cancelled, not deleted, with an archive table as backup.
- iLady uses the July forecast (higher side) for buffer until a new one arrives.

---

## 13. Verification checklist after any change

1. `npx tsc --noEmit` clean; `npm run build` passes.
2. Preview URL loads, owner has seen it.
3. Advisors: no new ERROR after DDL.
4. After production deploy: open https://ctg-sd-portal.vercel.app in Chrome (`/project/iLady`, `/project/SkinDae`, `/project/Kata`, `/inventory-params`, `/po-release`, `/dashboard`) and confirm the change renders; check the browser console for errors.
5. Report: what changed, what was verified, what is next. Keep it short.
