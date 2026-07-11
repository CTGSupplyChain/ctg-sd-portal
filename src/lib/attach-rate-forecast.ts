// ============================================================
// Attach-Rate Demand Translation
// Converts the latest monthly RM sales forecast into weekly
// SKU-level unit demand (demand_forecast, model 'attach_rate').
//
// Model (iLady handover, D1/D3):
//   channel split : DTC = min(total, dtc_floor), YRDZ = rest
//   units/month   : round(dtc_rm x rate_dtc + yrdz_rm x rate_yrdz)
//   weekly        : spread over that month's week_calendar rows,
//                   remainder to earliest weeks (total preserved)
// Brands opt in via brand_planning_config + attach_rates rows;
// their SKUs carry master_sku.demand_source = 'Attach Rate'.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

// sales_forecast monthly columns -> [year, month]
export const FORECAST_MONTH_COLS: Record<string, [number, number]> = {
  apr_26: [2026, 4], may_26: [2026, 5], jun_26: [2026, 6],
  jul_26: [2026, 7], aug_26: [2026, 8], sep_26: [2026, 9],
  oct_26: [2026, 10], nov_26: [2026, 11], dec_26: [2026, 12],
  jan_27: [2027, 1], feb_27: [2027, 2], mar_27: [2027, 3],
  apr_27: [2027, 4], may_27: [2027, 5], jun_27: [2027, 6],
}

export interface AttachRateResult {
  brand: string
  skus: number
  weeklyRows: number
  monthsCovered: number
  error?: string
}

export async function generateAttachRateForecast(
  supabase: SupabaseClient,
  brand: string
): Promise<AttachRateResult> {
  const fail = (error: string): AttachRateResult =>
    ({ brand, skus: 0, weeklyRows: 0, monthsCovered: 0, error })

  const { data: cfg } = await supabase
    .from('brand_planning_config').select('*').eq('brand', brand).single()
  if (!cfg) return fail('no brand_planning_config row')

  const today = new Date().toISOString().slice(0, 10)
  const { data: rateRows } = await supabase
    .from('attach_rates')
    .select('sku, channel, units_per_rm_k, effective_from')
    .eq('brand', brand).lte('effective_from', today)
    .order('effective_from', { ascending: false })
  if (!rateRows || rateRows.length === 0) return fail('no attach_rates')

  // Latest effective rate per sku+channel
  const rates = new Map<string, { dtc: number; yrdz: number }>()
  for (const r of rateRows) {
    const e = rates.get(r.sku) ?? { dtc: NaN, yrdz: NaN }
    if (r.channel === 'DTC' && isNaN(e.dtc)) e.dtc = parseFloat(r.units_per_rm_k)
    if (r.channel === 'YRDZ' && isNaN(e.yrdz)) e.yrdz = parseFloat(r.units_per_rm_k)
    rates.set(r.sku, e)
  }

  // Latest forecast submission for the brand's project(s)
  const { data: projectRows } = await supabase
    .from('projects').select('id').eq('brand', brand)
  const projectIds = (projectRows || []).map((p: { id: string }) => p.id)
  if (projectIds.length === 0) return fail('no projects row')

  const { data: fcRows } = await supabase
    .from('sales_forecast').select('*').in('project_id', projectIds)
    .order('submitted_at', { ascending: false }).limit(1)
  const fc: Record<string, unknown> | undefined = fcRows?.[0]
  if (!fc) return fail('no sales_forecast submission')

  // Week calendar grouped by (year, month)
  const { data: calendar } = await supabase
    .from('week_calendar')
    .select('year, month, monday_date, wk_label, wk_in_year')
    .order('monday_date')
  type WkRow = { year: number; month: number; monday_date: string; wk_label: string; wk_in_year: number }
  const byMonth = new Map<string, WkRow[]>()
  for (const w of (calendar || []) as WkRow[]) {
    const k = `${w.year}-${w.month}`
    if (!byMonth.has(k)) byMonth.set(k, [])
    byMonth.get(k)!.push(w)
  }

  const dtcFloor = parseFloat(String(cfg.dtc_floor_rm_k)) || 0
  const inserts: Record<string, unknown>[] = []
  let monthsCovered = 0

  for (const [col, [yr, mo]] of Object.entries(FORECAST_MONTH_COLS)) {
    const rm = parseFloat(String(fc[col] ?? 0)) || 0
    if (rm <= 0) continue
    const weeks = byMonth.get(`${yr}-${mo}`)
    if (!weeks || weeks.length === 0) continue // calendar not extended yet
    monthsCovered++

    const dtcRm = cfg.split_method === 'dtc_floor' ? Math.min(rm, dtcFloor) : rm
    const yrdzRm = cfg.split_method === 'dtc_floor' ? Math.max(rm - dtcFloor, 0) : 0

    rates.forEach((r, sku) => {
      const units = Math.round(
        dtcRm * (isNaN(r.dtc) ? 0 : r.dtc) + yrdzRm * (isNaN(r.yrdz) ? 0 : r.yrdz)
      )
      const base = Math.floor(units / weeks.length)
      const rem = units % weeks.length
      weeks.forEach((w, i) => {
        inserts.push({
          sku,
          brand,
          iso_year: w.year,
          iso_week: w.wk_in_year,
          week_start_date: w.monday_date,
          wk_label: w.wk_label,
          forecast_qty: base + (i < rem ? 1 : 0),
          lower_bound: 0,
          upper_bound: 0,
          model_used: 'attach_rate',
          history_weeks: 0,
          generated_at: new Date().toISOString(),
        })
      })
    })
  }

  // Replace the full horizon for these SKUs (stale rows must not linger)
  const skus = Array.from(rates.keys())
  const { error: delErr } = await supabase
    .from('demand_forecast').delete().in('sku', skus)
  if (delErr) return fail(`delete failed: ${delErr.message}`)

  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await supabase
      .from('demand_forecast').insert(inserts.slice(i, i + 500))
    if (error) return fail(`insert failed: ${error.message}`)
  }

  return { brand, skus: skus.length, weeklyRows: inserts.length, monthsCovered }
}
