# S&D Portal — Demand Translation Methodology (Handover)

**Purpose:** Reusable, self-contained methodology for converting a sales forecast into the weekly Supply & Demand table in the CTG S&D Portal. Written from the iLady implementation (shipped 11 Jul 2026, commit `f8e9a28`) so any brand — especially those with historical order data — can be onboarded the same way.
**Owner:** Supply Chain (JJ) · **Portal:** https://ctg-sd-portal.vercel.app · **Repo:** github.com/CTGSupplyChain/ctg-sd-portal

---

## 1. The S&D table math (identical for every brand)

Each SKU gets a horizontal weekly grid (rolling 52 weeks from current week, 4/4/5 retail calendar from `week_calendar`). Five data rows, same semantics as the Excel S&D template:

| Row | Source | Formula |
|---|---|---|
| Forecast Sales RM'000 | `sales_forecast` (latest submission per project) | monthly RM ÷ weeks in month (display only) |
| Forecast Qty | demand model output (§2) | per-week units |
| Supply (Uncommit) | `purchase_orders`, status Open, `commit_status='Uncommit'` | qty bucketed by `receipt_wk` |
| Supply (Commit) | same, `commit_status='Commit'` | qty bucketed by `receipt_wk` |
| **Balance** | computed | `prev balance + Supply(Commit) − Forecast Qty − backorder` |

Rules baked into `src/lib/sd-compute.ts`:

- **Opening balance** = latest WMS ATP snapshot (`wms_inventory_snapshots`), with variant SKUs summed into their master SKU via `sku_wms_mapping`.
- **Uncommitted supply never protects the balance.** A PO that isn't confirmed cannot prevent a stockout; it is displayed but excluded from Balance and stockout detection.
- **Weeks of Cover** = balance at end of current week ÷ average Forecast Qty of the next 4 weeks.
- **Flags:** STOCKOUT (balance ≤ 0 now) · RELEASE PO (first negative-balance week falls within lead time) · PLAN PO (negative beyond LT) · OK. **PO release week** = stockout week − LT − 1 ops-buffer week.

Everything above is brand-agnostic. The only thing that differs per brand is how Forecast Qty is produced — the demand model.

---

## 2. Choosing the demand model (per SKU, via `master_sku.demand_source`)

`computeSD` resolves Forecast Qty in this priority order:

| Tier | `demand_source` | Model | Use when |
|---|---|---|---|
| 1 | `Attach Rate` | RM forecast × attach rates (§3–4) | Multi-SKU brand selling packages/bundles; revenue forecast exists; historical order data available to derive rates |
| 2 | ASP > 0 (legacy) | monthly RM × 1000 ÷ ASP ÷ weeks | **Single-hero-SKU brands only.** Applies the whole project's revenue to each priced SKU — wrong for multi-SKU brands (iLady SH300 came out ~2.9× over plan under this model) |
| 3 | ASP = 0, statistical | Holt-Winters / WMA from `sales_history` weekly actuals (`demand_forecast`, `model_used='holt_winters'`) | No usable revenue forecast, but ≥ ~12 weeks of clean weekly unit history; demand is continuation-of-trend rather than target-driven |
| 4 | fallback | trailing historical average, else 0 | Stopgap only |

Decision rule of thumb: **if sales sets an RM target that differs from run rate, use attach rates** (the statistical model can only extrapolate the past — it cannot express a +40–85% step-up like iLady FY27). If the brand has no revenue target and demand is organic, the statistical tier on historical data is appropriate. The two coexist: a brand can run heroes on attach rates and long-tail SKUs statistically.

---

## 3. Attach-rate model — the calculation chain

Implemented in `src/lib/attach-rate-forecast.ts`, re-run automatically on every Forecast Sync for each brand in `brand_planning_config`. All data DB-driven; no code changes per brand.

**Step 1 — Input.** Latest `sales_forecast` submission for the brand's project (by `submitted_at`; the sync pulls the Google Sheet and carries forward the last non-zero month). Monthly values in RM'000.

**Step 2 — Channel split** (per `brand_planning_config`):

```
DTC_rm  = min(total_rm, dtc_floor_rm_k)     -- iLady: floor = 600 (stable channel held flat)
YRDZ_rm = max(total_rm − dtc_floor_rm_k, 0) -- growth channel carries the residual
```

Why split: attach rates differ structurally by channel (iLady SH300: ~2.1 DTC vs ~5.1 YRDZ). If a blended rate is used while channel mix shifts, you systematically under/over-buy — iLady blended would have under-bought shampoo ~20%. If a brand has one channel or identical rates, set `split_method='none'`.

**Step 3 — Monthly units per SKU:**

```
units(sku, month) = round( DTC_rm × rate_dtc(sku) + YRDZ_rm × rate_yrdz(sku) )
```

Rates come from `attach_rates` (units per RM1,000 net revenue), latest `effective_from` per sku+channel wins — so a rate refresh is an INSERT, never an UPDATE, preserving audit history. SKUs whose rate applies to *total* revenue (iLady masks, pinned at peak) simply carry the same rate on both channels: `600r + (T−600)r = T×r`.

**Step 4 — Weekly spread.** Divide monthly units across that month's **actual** `week_calendar` rows: `base = floor(units/n)`, first `units mod n` weeks get +1. Divisor is the count of actual week rows, not the declared `weeks_in_month` — this preserves monthly totals even where the calendar has gaps (Dec'26 currently declares 5 weeks but holds 4 rows).

**Step 5 — Landing.** Rows upserted into `demand_forecast` (`model_used='attach_rate'`), replacing the SKU's full horizon each run so stale rows never linger. Changing the RM forecast in the sheet and re-syncing re-explodes everything — no manual unit-forecast maintenance.

**Worked check (iLady, verified in prod):** Jul'26 = RM1,500K → DTC 600 / YRDZ 900. NE120: 600×3.09 + 900×3.25 = **4,779**. SH300: 600×2.14 + 900×5.12 = **5,892**. M200: 1,500×1.38 = **2,070**. All match handover §7 exactly; weekly NE120 = [1,195×3, 1,194] in a 4-week month.

---

## 4. Deriving attach rates from historical data (the reusable part)

This is the methodology to run for any new brand with order history. Source: raw order exports (one row per order, one qty column per product variant, plus order status, channel, and SubTotal).

**4.1 Clean the data**
- Exclude cancelled orders. Treat pending + shipped as sold unless the brand owner says otherwise (confirm — for iLady, 78% of one channel sat in "Pending" as status hygiene).
- **Keep zero-revenue (free-gift) orders in the unit numerator.** They are real demand triggered by revenue-generating business; dropping them biases rates low. Revenue denominator = SubTotal of paying orders.
- Build a **SKU consolidation map**: the same physical SKU appears under multiple column names (renames, leading/trailing spaces, duplicated headers). Sum them into one canonical SKU.
- **Explode sets/bundles** into component units (e.g. Big Essence Set = 1× NE120 + 1× NB120), confirmed against a channel that books at bottle level if one exists.
- Exclude discontinued lines and non-resale premiums/GWP by owner direction.

**4.2 Compute rates**

```
rate(sku, channel, month) = units_sold(sku, channel, month) / (net_revenue(channel, month) / 1000)
```

**4.3 Test before trusting** — three checks, in order of importance:
1. **Channel-split test:** compare rates across channels. If any A-item differs materially (>~30%), model channels separately; otherwise blend.
2. **Stability (the real uncertainty):** within-channel monthly rates over the last 3+ months. Stable ±5% → high confidence. Trending → suspect package-composition change; confirm with the brand team and weight recent months (iLady adopted 20/40/40 over Apr/May/Jun). Regime change (mask went ~50 → ~1,900/mo) → averages are meaningless; pin at the peak or the new-regime rate per owner direction.
3. **Sampling precision:** order-level bootstrap if volumes are small. In practice precision is second-order versus stability — don't over-invest here.

Also check **pairing constraints** (iLady NE:NB = 1:1 within ±1% → plan as a symmetric pair; either stockout kills the package sale) and identify **leading indicators** (one package driving a rate — iLady PLATINUM alone drives YRDZ shampoo attach; its order count moves ~a month ahead of the aggregate rate).

**4.4 Maintenance loop**
- **Monthly refresh:** re-run the ETL on a rolling 3-month window per channel; insert new `attach_rates` rows (new `effective_from`) for any SKU drifting >10%. Package redesigns surface here first.
- **Demand-sensing gate at each PO cycle:** MTD revenue <75% of plan by mid-month → cut next PO to run rate; >110% → pull next PO forward. Rates convert RM to units correctly, but they cannot fix an RM forecast that doesn't materialise — attainment risk always dominates rate risk.

---

## 5. Statistical model for history-rich brands (tier 3)

For brands planned off actuals instead of an RM target: upload weekly unit history via Sales History (`sales_history`, keyed sku+channel+ISO week). The regenerate-forecast job fits Holt-Winters (falling back to weighted moving average / average for short histories) and writes 26 weeks into `demand_forecast` with 80% confidence bounds. Same S&D table, supply logic, and flags apply unchanged. Guidance: needs reasonably clean, continuous weekly history; promo-driven spikes will be extrapolated, so review the fitted forecast against the promo calendar before trusting PO suggestions.

---

## 6. Onboarding checklist for a new brand

1. **Master data:** SKUs in `master_sku` (LT, MOQ, UOM, SS); set `status='Inactive'` for variants/GWP that shouldn't be planned; map WMS variant codes in `sku_wms_mapping` so stock consolidates.
2. **Pick the demand model per SKU** (§2 decision rule).
3. If attach-rate: run §4 on the order exports → insert `attach_rates` rows + one `brand_planning_config` row (split method, floor). Set `master_sku.demand_source='Attach Rate'` on those SKUs.
4. If statistical: upload sales history, run regenerate-forecast, leave ASP = 0.
5. Ensure the project exists in `projects` and its name matches the forecast sheet's Project column (sync matches case-insensitively).
6. Run Forecast Sync → engine populates `demand_forecast`.
7. **Verify before go-live:** sum `demand_forecast` by 4/4/5 month (join `week_calendar` on `monday_date`) and reconcile against an independent spreadsheet calculation of RM × rates. iLady acceptance was exact-match to the unit.
8. Load on-hand (inventory upload) and enter open POs (Supply Input) so Balance and flags reflect reality.

**Known data caveats (as of 11 Jul 2026):** `week_calendar` Dec'26 has 4 rows vs 5 declared (totals preserved by design, but fix the calendar); calendar ends 2027-05-24 — extend before planning into Jun'27; Apr–Jun'27 forecast columns backfill on next sync.

---

## 7. Design decisions worth keeping (rationale log)

| Decision | Rationale |
|---|---|
| Attach rates (units/RM1,000), not package BOMs | Packages churn weekly; exports already explode to SKU units; the ratio is the stable object |
| Dedicated `attach_rates` table, not phantom planning BOMs | Same math as handover §12's phantom-BOM idea, but keeps fake RM'000 parts out of PLM, Planned PO, and component MRP views |
| Rate changes are INSERTs with `effective_from` | Full audit trail; engine picks latest effective automatically |
| Channel split with a flat floor on the stable channel | Growth channel absorbs forecast variance where the distinct rates live |
| Weekly divisor = actual calendar rows | Monthly totals survive calendar data gaps |
| Full-horizon replace on each regeneration | No stale demand rows when the forecast shortens or shifts |
| Uncommitted supply excluded from Balance | Unconfirmed POs can't prevent stockouts; visibility without false comfort |
