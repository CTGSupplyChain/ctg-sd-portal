// ============================================================
// POST /api/regenerate-forecast
// Regenerates demand_forecast from existing sales_history data.
// No re-upload needed — reads what's already in the DB.
// Body: { brand?: string, skus?: string[] }
//
// PERF: All data is bulk-fetched upfront (not per-SKU) so the
// total DB round-trips are O(1) not O(N SKUs). This avoids
// Vercel 504 timeouts on large SKU sets.
// ============================================================

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { canEdit } from '@/lib/roles'
import {
  generateForecast, dateToIsoWeek,
  detectCycleLength, averageResidualsByCyclePosition, tileShapeOverHorizon, growthHybridBounds,
} from '@/lib/forecasting/holt-winters'

// Weeks per calendar month — mirrors sd-compute.ts MONTH_WEEKS (kept in sync; both
// derive from the same fiscal week-mapping convention used across the portal)
const MONTH_WEEKS: Record<number, number> = {
  1: 4, 2: 4, 3: 5, 4: 4, 5: 4, 6: 5,
  7: 4, 8: 4, 9: 5, 10: 4, 11: 4, 12: 5,
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: { user }, error: authErr } = await getSupabase().auth.getUser(token)
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getSupabase()
      .from('profiles').select('role').eq('id', user.id).single()
    if (!canEdit(profile?.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const { brand, skus: requestedSkus } = body as { brand?: string; skus?: string[] }

    // ── Bulk-fetch all data upfront (O(1) queries regardless of SKU count) ──

    // 1. Master SKUs
    const { data: masterSkus } = await getSupabase()
      .from('master_sku').select('sku, brand, avg_selling_price')
    const skuBrandMap = new Map((masterSkus ?? []).map((m: any) => [m.sku, m.brand]))
    const skuAspMap = new Map((masterSkus ?? []).map((m: any) => [m.sku, Number(m.avg_selling_price ?? 0)]))

    // 2. All sales_history (filtered to target SKUs/brand)
    let historyQuery = getSupabase()
      .from('sales_history').select('sku, iso_year, iso_week, qty, channel')
      .order('iso_year', { ascending: true }).order('iso_week', { ascending: true })
    if (requestedSkus?.length) historyQuery = historyQuery.in('sku', requestedSkus)
    else if (brand) historyQuery = historyQuery.eq('brand', brand)
    const { data: allHistory } = await historyQuery

    const targetSkus = [...new Set((allHistory ?? []).map((r: any) => r.sku))]
    if (targetSkus.length === 0) {
      return NextResponse.json({ error: 'No SKUs found in sales_history for the given filter' }, { status: 404 })
    }

    // Group history by SKU
    const historyBySku = new Map<string, any[]>()
    for (const row of allHistory ?? []) {
      if (!historyBySku.has(row.sku)) historyBySku.set(row.sku, [])
      historyBySku.get(row.sku)!.push(row)
    }

    // 3. ATP data for all target SKUs
    const { data: atpData } = await getSupabase()
      .from('weekly_atp_snapshot').select('sku, iso_year, iso_week, min_atp')
      .in('sku', targetSkus)

    // Group ATP by SKU
    const atpBySku = new Map<string, Set<string>>()
    const atpSkuSet = new Set<string>()
    for (const row of atpData ?? []) {
      atpSkuSet.add(row.sku)
      if (!atpBySku.has(row.sku)) atpBySku.set(row.sku, new Set())
      if (row.min_atp === 0) atpBySku.get(row.sku)!.add(`${row.iso_year}-${row.iso_week}`)
    }

    // 4. Management forecast (sales_forecast) for all relevant brands
    const relevantBrands = [...new Set(targetSkus.map(s => skuBrandMap.get(s)).filter(Boolean))]
    const { data: gsheetRows, error: gsheetErr } = await getSupabase()
      .from('sales_forecast')
      .select('brand, apr_26, may_26, jun_26, jul_26, aug_26, sep_26, oct_26, nov_26, dec_26, jan_27, feb_27, mar_27, submitted_at')
      .in('brand', relevantBrands)
      .order('submitted_at', { ascending: false })
    if (gsheetErr) console.error('sales_forecast fetch error (growth-hybrid backbone unavailable):', gsheetErr)

    // Keep only latest submission per brand
    const latestGsheetByBrand = new Map<string, any>()
    for (const row of gsheetRows ?? []) {
      if (!latestGsheetByBrand.has(row.brand)) latestGsheetByBrand.set(row.brand, row)
    }

    const COL_TO_MONTH: Record<string, string> = {
      apr_26: '2026-04', may_26: '2026-05', jun_26: '2026-06', jul_26: '2026-07',
      aug_26: '2026-08', sep_26: '2026-09', oct_26: '2026-10',
      nov_26: '2026-11', dec_26: '2026-12', jan_27: '2027-01',
      feb_27: '2027-02', mar_27: '2027-03',
    }

    // Precompute monthly RM map per brand: 'YYYY-MM' -> forecasted revenue (RM)
    // This is the raw forward-looking trajectory submitted by project owners —
    // it already encodes their own read on upcoming demand drivers (campaigns,
    // ad pushes, etc). Used directly as the growth-hybrid trend backbone below
    // (replacing the old normalized "seasonal index" multiplier, which could
    // reshape proportions but couldn't inject an absolute growth trajectory).
    const monthlyRmByBrand = new Map<string, Map<string, number>>()
    for (const [brand, gsheet] of latestGsheetByBrand) {
      const monthRevMap = new Map<string, number>()
      for (const [col, monthKey] of Object.entries(COL_TO_MONTH)) {
        const val = Number((gsheet as any)[col] ?? 0)
        if (val > 0) monthRevMap.set(monthKey, val)
      }
      if (monthRevMap.size > 0) monthlyRmByBrand.set(brand, monthRevMap)
    }

    /** Convert a monthly RM figure into a per-week quantity (mirrors sd-compute.ts getForecastQty) */
    function rmToWeeklyQty(monthlyRm: number, asp: number, monthKey: string): number {
      if (asp <= 0 || monthlyRm <= 0) return 0
      const month = parseInt(monthKey.slice(5, 7), 10)
      const wksInMonth = MONTH_WEEKS[month] || 4
      return Math.ceil((monthlyRm * 1000) / asp / wksInMonth)
    }

    // ── Generate forecasts in memory ─────────────────────────────────────────
    const curIso = dateToIsoWeek(new Date())
    const startFrom = { isoYear: curIso.isoYear, isoWeek: curIso.isoWeek }

    const summary: Record<string, any> = {}
    const allForecastRecords: any[] = []
    const allWeekDates = new Set<string>()

    for (const sku of targetSkus) {
      try {
        const history = historyBySku.get(sku) ?? []
        if (history.length === 0) continue

        const historyPoints = history.map((h: any) => ({
          isoYear: h.iso_year, isoWeek: h.iso_week, qty: h.qty, channel: h.channel as 'B2B' | 'B2C',
        }))

        const stockoutWeeks = atpBySku.get(sku)
        const hasAtpData = atpSkuSet.has(sku)
        const result = generateForecast(sku, historyPoints, startFrom, hasAtpData ? stockoutWeeks : undefined)

        summary[sku] = {
          model: result.model, historyWeeks: result.historyWeeks,
          cappedWeeks: result.cappedWeeks, stockoutCorrectedWeeks: result.stockoutCorrectedWeeks, mape: result.mape,
        }

        const asp = skuAspMap.get(sku) ?? 0
        const skuBrand = skuBrandMap.get(sku) ?? ''
        let forecastPoints = result.points
        let modelStr: string = result.model

        // ── Growth-Hybrid (ASP > 0 only — see forecast-growth-hybrid-proposal.md) ──
        //
        // Anchor the trend on the project owner's own forward-looking monthly
        // revenue forecast (sales_forecast), converted to weekly qty. The
        // statistical model's role narrows to characterising the repeatable
        // week-to-week "shape" (cyclical oscillation) and noise — it no longer
        // drives the trend, which is where Holt's Linear was flattening out.
        //
        //   finalForecast(t) = backbone(t) + residualShape(t mod cycleLength)
        //
        // Falls back to the plain statistical forecast (no hybrid) when the
        // brand has no usable sales_forecast submission, or when there isn't
        // enough history to characterise a residual shape.
        if (asp > 0 && skuBrand) {
          const monthRevMap = monthlyRmByBrand.get(skuBrand)
          const series = result.series
          const residuals = result.residuals

          if (monthRevMap && monthRevMap.size > 0 && series) {
            const backbone = result.points.map(p =>
              rmToWeeklyQty(monthRevMap.get(p.weekStartDate.substring(0, 7)) ?? 0, asp, p.weekStartDate.substring(0, 7))
            )
            const haveBackbone = backbone.some(v => v > 0)

            if (haveBackbone && residuals && series.length >= 8) {
              // Enough history to characterise a repeatable cyclical "shape" —
              // layer it on top of the Gsheet-anchored backbone.
              const cycleLength = detectCycleLength(series) ?? 7
              const shape = averageResidualsByCyclePosition(residuals, cycleLength)
              const tiledShape = tileShapeOverHorizon(shape, series.length, backbone.length)

              const combined = backbone.map((b, h) => Math.max(0, Math.round(b + tiledShape[h])))
              const { lower, upper } = growthHybridBounds(combined, residuals)

              forecastPoints = result.points.map((p, h) => ({
                ...p,
                forecastQty: combined[h],
                lowerBound: lower[h],
                upperBound: upper[h],
              }))
              modelStr = 'growth_hybrid'
            } else if (haveBackbone) {
              // Not enough history yet to characterise a shape (< 8 weeks) —
              // run on the Gsheet-anchored backbone alone. Confidence bounds
              // widen faster (higher growthFactor) to reflect the lack of a
              // statistically-grounded noise estimate; this narrows back to
              // the standard band once the SKU accrues >= 8 weeks of history
              // and graduates to the full shape-layered hybrid above.
              const combined = backbone.map(b => Math.max(0, Math.round(b)))
              const fallbackResiduals = residuals && residuals.length > 0 ? residuals : combined
              const { lower, upper } = growthHybridBounds(combined, fallbackResiduals, 0.06)

              forecastPoints = result.points.map((p, h) => ({
                ...p,
                forecastQty: combined[h],
                lowerBound: lower[h],
                upperBound: upper[h],
              }))
              modelStr = 'growth_hybrid'
            }
          }
        }

        for (const p of forecastPoints) {
          allWeekDates.add(p.weekStartDate)
          allForecastRecords.push({
            sku, brand: skuBrand || 'Unknown',
            iso_year: p.isoYear, iso_week: p.isoWeek,
            week_start_date: p.weekStartDate,
            wk_label: p.wkLabel, // filled in below
            forecast_qty: p.forecastQty,
            lower_bound: p.lowerBound, upper_bound: p.upperBound,
            model_used: modelStr, history_weeks: result.historyWeeks,
            generated_at: new Date().toISOString(),
          })
        }
      } catch (skuErr: any) {
        console.error(`Forecast error for ${sku}:`, skuErr)
      }
    }

    // 5. Week calendar — one bulk fetch for all needed dates
    if (allForecastRecords.length > 0) {
      const { data: wkCalendar } = await getSupabase()
        .from('week_calendar').select('wk_label, monday_date')
        .in('monday_date', [...allWeekDates])
      const calMap = new Map((wkCalendar ?? []).map((w: any) => [w.monday_date, w.wk_label]))

      for (const rec of allForecastRecords) {
        rec.wk_label = calMap.get(rec.week_start_date) ?? rec.wk_label
      }

      // 6. Single bulk upsert for all forecast records
      await getSupabase().from('demand_forecast')
        .upsert(allForecastRecords, { onConflict: 'sku,iso_year,iso_week' })
    }

    return NextResponse.json({
      success: true,
      skusProcessed: targetSkus.length,
      skusUpdated: Object.keys(summary).length,
      summary,
    })

  } catch (err: any) {
    console.error('regenerate-forecast error:', err)
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 })
  }
}
