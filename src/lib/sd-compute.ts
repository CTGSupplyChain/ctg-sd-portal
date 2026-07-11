// ============================================================
// CTG S&D Core Algorithm
// Computes weekly balance, WoC, and alert flags per SKU
// ============================================================

export const MONTH_WEEKS: Record<number, number> = {
  1:4, 2:4, 3:5, 4:4, 5:4, 6:5,
  7:4, 8:4, 9:5, 10:4, 11:4, 12:5
}

export const MONTHLY_FORECAST_COLS: Record<string, [number, number]> = {
  'apr_26': [2026, 4], 'may_26': [2026, 5], 'jun_26': [2026, 6],
  'jul_26': [2026, 7], 'aug_26': [2026, 8], 'sep_26': [2026, 9],
  'oct_26': [2026, 10], 'nov_26': [2026, 11], 'dec_26': [2026, 12],
  'jan_27': [2027, 1], 'feb_27': [2027, 2], 'mar_27': [2027, 3],
  'apr_27': [2027, 4], 'may_27': [2027, 5], 'jun_27': [2027, 6],
}

export interface WeekInfo {
  label: string
  year: number
  month: number
  monthLabel: string
  wkInYear: number
  wkInMonth: number
  mondayDate: string
  weeksInMonth: number
}

export interface SkuMaster {
  sku: string
  description: string
  brand: string
  moq: number
  uom: string
  leadTimeWk: number
  avgSellingPrice: number
  safetyStock: number
  bufferStock: number
  status: string
  demandSource?: string
}

export interface WeeklyRow {
  wkLabel: string
  forecastRm: number
  forecastQty: number
  backorderQty: number   // backlog units to fulfil — applied in current week only
  supplyCommit: number
  supplyUncommit: number
  balance: number
}

export interface SkuSdResult {
  sku: SkuMaster
  onHand: number
  backorderQty: number
  weeksOfCover: number
  flag: 'STOCKOUT' | 'RELEASE_PO' | 'PLAN_PO' | 'OK'
  plannedPoReleaseDateWk: string | null   // wkLabel of latest safe PO release date; null if no action needed
  stockoutWk: string | null               // first week balance goes negative within horizon; null if none
  weeks: WeeklyRow[]
}

// Compute weekly forecast qty for a SKU
function getForecastQty(
  sku: SkuMaster,
  year: number,
  month: number,
  wkLabel: string,
  forecast: Record<string, number> | null,
  historicalAvg: number,
  demandForecast: Map<string, number> | null   // wkLabel → qty from demand_forecast table
): number {
  const wksInMonth = MONTH_WEEKS[month] || 4

  // 'Attach Rate' SKUs: demand_forecast rows (RM x attach rate, channel-split,
  // pre-computed by generateAttachRateForecast) are authoritative. No fallback
  // to ASP or historical average - absence of rows means zero planned demand.
  if (sku.demandSource === 'Attach Rate') {
    const qty = demandForecast?.get(wkLabel)
    return qty !== undefined ? qty : 0
  }

  if (sku.avgSellingPrice > 0 && forecast) {
    // ASP > 0: use Google Sheet forecast (Revenue / ASP model)
    const colKey = Object.entries(MONTHLY_FORECAST_COLS).find(
      ([, [y, m]]) => y === year && m === month
    )?.[0]
    if (colKey && forecast[colKey]) {
      const monthlyRm = forecast[colKey]
      return Math.ceil((monthlyRm * 1000) / sku.avgSellingPrice / wksInMonth)
    }
    return 0
  } else {
    // ASP = 0: priority order:
    //   1. Statistical demand forecast (from demand_forecast table)
    //   2. Trailing historical average (legacy fallback)
    //   3. Zero
    const statForecast = demandForecast?.get(wkLabel)
    if (statForecast !== undefined && statForecast > 0) return statForecast
    return Math.ceil(historicalAvg)
  }
}

// Main S&D computation function
export function computeSD(params: {
  sku: SkuMaster
  onHand: number
  backorderQty?: number                        // units to fulfil immediately (current week)
  weeks: WeekInfo[]
  forecast: Record<string, number> | null
  historicalAvg: number
  demandForecast?: Map<string, number> | null  // wkLabel → qty from demand_forecast table
  supplyCommits: Record<string, number>        // wkLabel → qty
  supplyUncommits: Record<string, number>      // wkLabel → qty
  currentWk: string
  thresholdOrderNow: number   // default 4
  thresholdMonitor: number    // default 8
}): SkuSdResult {
  const {
    sku, onHand, weeks, forecast, historicalAvg,
    backorderQty = 0,
    demandForecast = null,
    supplyCommits, supplyUncommits, currentWk,
    thresholdOrderNow = 4, thresholdMonitor = 8
  } = params

  let balance = onHand
  const weeklyRows: WeeklyRow[] = []

  for (const wk of weeks) {
    const isCurrentWk = wk.label === currentWk
    const forecastQty = getForecastQty(sku, wk.year, wk.month, wk.label, forecast, historicalAvg, demandForecast)
    const commit   = supplyCommits[wk.label]   || 0
    const uncommit = supplyUncommits[wk.label] || 0

    // Backorder is consumed in the current week only
    const backorderThisWk = isCurrentWk ? backorderQty : 0

    const forecastRm = forecast
      ? (() => {
          const colKey = Object.entries(MONTHLY_FORECAST_COLS).find(
            ([, [y, m]]) => y === wk.year && m === wk.month
          )?.[0]
          return colKey && forecast[colKey]
            ? Math.round((forecast[colKey] / (MONTH_WEEKS[wk.month] || 4)) * 10) / 10
            : 0
        })()
      : 0

    balance = balance + commit - forecastQty - backorderThisWk

    weeklyRows.push({
      wkLabel: wk.label,
      forecastRm,
      forecastQty,
      backorderQty: backorderThisWk,
      supplyCommit: commit,
      supplyUncommit: uncommit,
      balance,
    })
  }

  // Weeks of Cover: balance at end of current week / avg demand next 4 weeks
  // The current-week balance already reflects backorder deduction, so WoC is
  // naturally adjusted for the backlog obligation.
  const curIdx = weeks.findIndex(w => w.label === currentWk)
  const curBalance = curIdx >= 0 ? weeklyRows[curIdx]?.balance ?? onHand : onHand
  const next4Demand = weeklyRows
    .slice(curIdx >= 0 ? curIdx + 1 : 0, (curIdx >= 0 ? curIdx + 1 : 0) + 4)
    .map(r => r.forecastQty)
  const avgDemand = next4Demand.length > 0
    ? next4Demand.reduce((a, b) => a + b, 0) / next4Demand.length
    : 0
  const woc = avgDemand > 0 ? curBalance / avgDemand : 0

  // ── LT-aware status logic ─────────────────────────────────────────────────────────────────────
  //
  // Find the first week where balance < 0 (committed supply only — uncommitted
  // is excluded intentionally: a PO not yet confirmed cannot prevent a stockout).
  //
  // Then determine if that stockout falls within the lead time window.
  // If it does, a PO must be placed NOW; if it's beyond LT, flag as PLAN_PO.
  //
  // Release date = stockout_week - LT - 1 week (ops buffer)
  //                            - safetyStock buffer [TODO: fill in after SS is defined per SKU]
  //
  const lt = sku.leadTimeWk ?? 0
  const curWkIdx = weeks.findIndex(w => w.label === currentWk)

  // Find first negative-balance week (committed supply only)
  let stockoutWk: string | null = null
  let stockoutWkIdx: number = -1
  {
    let balanceCommitOnly = onHand
    for (let i = 0; i < weeklyRows.length; i++) {
      const row = weeklyRows[i]
      const isCurrentWk = weeks[i].label === currentWk
      const backorderThisWk = isCurrentWk ? backorderQty : 0
      // Re-run balance using committed supply only (excludes uncommitted)
      balanceCommitOnly = balanceCommitOnly + row.supplyCommit - row.forecastQty - backorderThisWk
      if (balanceCommitOnly < 0 && stockoutWk === null) {
        stockoutWk = row.wkLabel
        stockoutWkIdx = i
      }
    }
  }

  // Calculate planned PO release date
  // = stockout_week_idx - LT - 1 (ops buffer)
  // Safety stock buffer: TODO — add `sku.safetyStock` in weeks once defined
  let plannedPoReleaseDateWk: string | null = null
  if (stockoutWkIdx >= 0) {
    const releaseIdx = stockoutWkIdx - lt - 1  // -1 = ops buffer week
    // Safety stock buffer will shift this further left once SS is configured per SKU
    if (releaseIdx >= 0 && releaseIdx < weeks.length) {
      plannedPoReleaseDateWk = weeks[releaseIdx].label
    } else if (releaseIdx < 0) {
      // Release date is in the past — overdue
      plannedPoReleaseDateWk = weeks[0].label  // pin to first visible week as "overdue"
    }
  }

  // Determine flag
  // STOCKOUT   : already negative this week
  // RELEASE_PO : stockout within LT horizon AND no committed supply covers it
  // PLAN_PO    : stockout exists but outside LT horizon (time to plan, not urgent)
  // OK         : no stockout within full horizon, or committed supply covers all gaps
  let flag: SkuSdResult['flag']
  if (curBalance <= 0) {
    flag = 'STOCKOUT'
  } else if (stockoutWkIdx >= 0 && stockoutWkIdx - curWkIdx <= lt) {
    flag = 'RELEASE_PO'
  } else if (stockoutWkIdx >= 0) {
    flag = 'PLAN_PO'
  } else {
    flag = 'OK'
  }

  return {
    sku,
    onHand,
    backorderQty,
    weeksOfCover: Math.round(woc * 10) / 10,
    flag,
    plannedPoReleaseDateWk,
    stockoutWk,
    weeks: weeklyRows,
  }
}

// Flag display helpers
export const FLAG_DISPLAY: Record<SkuSdResult['flag'], { emoji: string; label: string; color: string }> = {
  STOCKOUT:   { emoji: '🔴', label: 'STOCKOUT',   color: '#C5453F' },  // Signal red
  RELEASE_PO: { emoji: '🟠', label: 'RELEASE PO', color: '#E8A33D' },  // Signal amber
  PLAN_PO:    { emoji: '🟡', label: 'PLAN PO',    color: '#E8A33D' },  // Signal amber
  OK:         { emoji: '🟢', label: 'OK',         color: '#2F9E68' },  // Signal green
}
