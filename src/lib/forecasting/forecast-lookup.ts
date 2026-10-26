// ============================================================
// Demand Forecast Lookup
// Provides loadDemandForecast() for the S&D page to read
// statistical forecasts as Tier 2 fallback in computeSD()
// Uses browser client — safe for 'use client' components
// ============================================================

import { createClient } from '@/lib/supabase'

/**
 * Load the latest demand forecast for a set of SKUs, keyed by wk_label.
 * Returns: Map<sku, Map<wkLabel, forecastQty>>
 *
 * Usage in project page:
 *   const fcMap = await loadDemandForecast(['SDDLSC030', 'SDSDPD01S'])
 *   // passed into computeSD() as demandForecast param
 */
export async function loadDemandForecast(
  skus: string[]
): Promise<Map<string, Map<string, number>>> {
  if (skus.length === 0) return new Map()

  const supabase = createClient()

  const { data, error } = await supabase
    .from('demand_forecast')
    .select('sku, wk_label, forecast_qty')
    .in('sku', skus)
    .neq('model_used', 'superseded') // superseded rows are zeroed leftovers; they must never shadow a live week

  if (error || !data) {
    console.error('demand_forecast load error:', error)
    return new Map()
  }

  const result = new Map<string, Map<string, number>>()
  for (const row of data) {
    if (!result.has(row.sku)) result.set(row.sku, new Map())
    result.get(row.sku)!.set(row.wk_label, row.forecast_qty)
  }

  return result
}
