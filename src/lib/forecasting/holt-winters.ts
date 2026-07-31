// ============================================================
// CTG Demand Forecasting Engine
// Pure TypeScript — no external ML dependencies
//
// Strategy:
//   >= 16 weeks history → Holt's Linear (Damped Double Exponential Smoothing)
//                          level + trend; no seasonal component (insufficient data for 52-wk cycle)
//                          α auto-optimised (0.05–0.95), β auto-optimised (0.05–0.95), φ=0.9
//    8–15 weeks history → SES (Single Exponential Smoothing)
//                          α auto-optimised; seed = avg of first 4 weeks; flat-line forecast
//   < 8 weeks history  → Simple trailing average
//
// Graduate SKU to Holt's Linear once >= 16 weeks of history available.
// Revisit seasonal layer when >= 24 months of data exists per SKU.
//
// Output: 26 weekly forecast points per SKU with 80% confidence bounds
// ============================================================

export type ForecastModel = 'holts_linear' | 'ses' | 'avg'

export interface ForecastPoint {
  isoYear: number
  isoWeek: number
  weekStartDate: string   // YYYY-MM-DD (Monday)
  wkLabel: string         // e.g. 'WK22'
  forecastQty: number
  lowerBound: number
  upperBound: number
}

export interface ForecastResult {
  sku: string
  model: ForecastModel
  historyWeeks: number
  cappedWeeks: number           // B2B event weeks capped
  stockoutCorrectedWeeks: number // zero-demand weeks corrected due to stockout
  points: ForecastPoint[]
  mape?: number
  residuals?: number[]          // fitted residuals (actual - fitted) over history; used by growth-hybrid
  series?: number[]             // cleaned weekly series (post gap-fill / stockout correction)
}

// ── ISO week utilities ──────────────────────────────────────

/** Returns Monday date of a given ISO year + week */
export function isoWeekToMonday(isoYear: number, isoWeek: number): Date {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4))
  const dayOfWeek = jan4.getUTCDay() || 7
  const mondayWk1 = new Date(jan4)
  mondayWk1.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1))
  const result = new Date(mondayWk1)
  result.setUTCDate(mondayWk1.getUTCDate() + (isoWeek - 1) * 7)
  return result
}

/** Returns ISO year and week for a given date */
export function dateToIsoWeek(date: Date): { isoYear: number; isoWeek: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayOfWeek = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek)
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const isoWeek = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + 1) / 7)
  return { isoYear: d.getUTCFullYear(), isoWeek }
}

/** Advance N weeks from an ISO week */
export function addIsoWeeks(
  isoYear: number,
  isoWeek: number,
  n: number
): { isoYear: number; isoWeek: number } {
  const monday = isoWeekToMonday(isoYear, isoWeek)
  monday.setUTCDate(monday.getUTCDate() + n * 7)
  return dateToIsoWeek(monday)
}

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0]
}

function toWkLabel(isoYear: number, isoWeek: number): string {
  // Year-qualified to match week_calendar.wk_label. A bare 'WK01' is ambiguous
  // across the 2026-W53 / 2027-W01 boundary and was silently colliding in
  // demand_forecast's Map<wk_label, qty> lookups.
  return `${isoYear}-WK${String(isoWeek).padStart(2, '0')}`
}

// ── Holt's Linear (Damped Double Exponential Smoothing) ──────
//
// Two components: level (L) and trend (T).
//   L(t) = α × A(t) + (1-α) × [L(t-1) + φ×T(t-1)]
//   T(t) = β × [L(t) - L(t-1)] + (1-β) × φ×T(t-1)
//   F(t+h) = L(t) + (φ + φ² + ... + φʰ) × T(t)
//
// Damping factor φ prevents runaway linear extrapolation over a 26-week horizon.
//   φ=0.9 (default) — steady/moderate growth; trend tapers but stays visible
//   φ=1.0           — undamped linear; use only for confirmed hypergrowth SKUs
//   φ=0.8           — aggressive taper; use for maturing/plateauing SKUs
//
// α and β are auto-optimised per SKU (0.05–0.95 in 0.05 steps, min MAE).

const PHI = 0.9  // default damping — override per SKU if growth profile is known

function hlSSE(series: number[], alpha: number, beta: number): number {
  let level = series[0]
  let trend = series[1] - series[0]
  let sse = 0
  for (let i = 1; i < series.length; i++) {
    const prevLevel = level
    const fitted = level + PHI * trend
    level = alpha * series[i] + (1 - alpha) * (level + PHI * trend)
    trend = beta * (level - prevLevel) + (1 - beta) * PHI * trend
    sse += (series[i] - fitted) ** 2
  }
  return sse
}

function hlFit(
  series: number[],
  alpha: number,
  beta: number,
  horizon: number
): { forecast: number[]; residuals: number[] } {
  let level = series[0]
  let trend = series[1] - series[0]
  const residuals: number[] = [0]

  for (let i = 1; i < series.length; i++) {
    const prevLevel = level
    const fitted = level + PHI * trend
    level = alpha * series[i] + (1 - alpha) * (level + PHI * trend)
    trend = beta * (level - prevLevel) + (1 - beta) * PHI * trend
    residuals.push(series[i] - fitted)
  }

  // Damped forecast: sum of geometric series φ + φ² + ... + φʰ
  const forecast: number[] = []
  let phiSum = 0
  for (let h = 1; h <= horizon; h++) {
    phiSum += Math.pow(PHI, h)
    forecast.push(Math.max(0, level + phiSum * trend))
  }

  return { forecast, residuals }
}

function holtsLinear(
  series: number[],
  horizon: number
): { forecast: number[]; residuals: number[] } {
  let bestAlpha = 0.3, bestBeta = 0.1, bestSSE = Infinity

  // α: 0.05–0.95 in 0.05 steps (19 values)
  // β: 0.05–0.95 in 0.05 steps (19 values)
  for (let a = 1; a <= 19; a++) {
    for (let b = 1; b <= 19; b++) {
      const alpha = a / 20
      const beta  = b / 20
      const sse = hlSSE(series, alpha, beta)
      if (sse < bestSSE) { bestSSE = sse; bestAlpha = alpha; bestBeta = beta }
    }
  }

  return hlFit(series, bestAlpha, bestBeta, horizon)
}

// ── Single Exponential Smoothing (SES) ──────────────────────
//
// Single component: level only. No trend, no seasonal.
//   L(t) = α × A(t) + (1-α) × L(t-1)
//   F(t+h) = L(t)  [flat line for all h]
//
// Seed: average of first 4 weeks (reduces noise from launch spikes).
// α auto-optimised per SKU (0.05–0.95 in 0.05 steps, min SSE).
// Correct model for stable/flat demand with 8–15 weeks of history.

function ses(
  series: number[],
  horizon: number
): { forecast: number[]; residuals: number[] } {
  // Seed with average of first min(4, n) observations
  const initWindow = Math.min(4, series.length)
  const seed = series.slice(0, initWindow).reduce((a, b) => a + b, 0) / initWindow

  let bestAlpha = 0.3, bestSSE = Infinity

  for (let a = 1; a <= 19; a++) {
    const alpha = a / 20
    let level = seed
    let sse = 0
    for (let i = 1; i < series.length; i++) {
      const fitted = level
      sse += (series[i] - fitted) ** 2
      level = alpha * series[i] + (1 - alpha) * level
    }
    if (sse < bestSSE) { bestSSE = sse; bestAlpha = alpha }
  }

  // Fit residuals with best alpha
  let level = seed
  const residuals: number[] = [0]
  for (let i = 1; i < series.length; i++) {
    const fitted = level
    residuals.push(series[i] - fitted)
    level = bestAlpha * series[i] + (1 - bestAlpha) * level
  }

  // Flat-line forecast
  const forecast = Array(horizon).fill(Math.max(0, level))
  return { forecast, residuals }
}

// ── Weighted Moving Average ─────────────────────────────────

function weightedMovingAverage(series: number[], horizon: number): {
  forecast: number[]
  residuals: number[]
} {
  const window = Math.min(8, series.length)
  const slice = series.slice(-window)
  const totalWeight = (window * (window + 1)) / 2
  const wma = slice.reduce((acc, v, i) => acc + v * (i + 1), 0) / totalWeight
  const forecast = Array(horizon).fill(Math.max(0, wma))
  const residuals = series.map(v => v - wma)
  return { forecast, residuals }
}

// ── Simple Average ──────────────────────────────────────────

function simpleAverage(series: number[], horizon: number): {
  forecast: number[]
  residuals: number[]
} {
  const avg = series.reduce((a, b) => a + b, 0) / series.length
  const forecast = Array(horizon).fill(Math.max(0, avg))
  const residuals = series.map(v => v - avg)
  return { forecast, residuals }
}

// ── Confidence Bounds (80% CI) ──────────────────────────────

function confidenceBounds(
  forecast: number[],
  residuals: number[]
): { lower: number[]; upper: number[] } {
  const Z = 1.28 // z-score for 80% CI
  const variance = residuals.length > 1
    ? residuals.reduce((s, r) => s + r ** 2, 0) / residuals.length
    : (forecast.reduce((a, b) => a + b, 0) / forecast.length * 0.2) ** 2
  const stdDev = Math.sqrt(variance)

  return {
    lower: forecast.map(f => Math.max(0, Math.round(f - Z * stdDev))),
    upper: forecast.map(f => Math.round(f + Z * stdDev)),
  }
}

// ── Cycle Detection & Residual Shape (for Growth-Hybrid) ────
//
// Used when a known forward-looking trend (e.g. management/GSheet revenue
// forecast) is available and should anchor the forecast level/trend, while
// the statistical model's role narrows to characterising the repeatable
// week-to-week oscillation ("shape") and noise (variance) around that trend.
//
// detectCycleLength: lightweight autocorrelation peak search over a candidate
// range (4–10 weeks), falling back to a sensible default when history is too
// short or no clear peak emerges.
//
// averageResidualsByCyclePosition: buckets residuals by (index mod cycleLength)
// and averages each bucket — producing a repeatable additive "shape" array of
// length cycleLength that can be tiled across the forecast horizon.

const DEFAULT_CYCLE_LENGTH = 7

/** Pearson-style autocorrelation of `series` at integer lag `k` */
function autocorrelation(series: number[], k: number): number {
  const n = series.length
  if (k >= n) return 0
  const mean = series.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) den += (series[i] - mean) ** 2
  for (let i = 0; i < n - k; i++) num += (series[i] - mean) * (series[i + k] - mean)
  return den > 0 ? num / den : 0
}

/**
 * Detect the dominant short-cycle length via ACF peak search over lags 4–10.
 * Returns null if history is too short (< 3x the candidate range) or no lag
 * produces a meaningfully positive autocorrelation (> 0.15).
 */
export function detectCycleLength(
  series: number[],
  minLag = 4,
  maxLag = 10
): number | null {
  if (series.length < maxLag * 3) return null

  let bestLag: number | null = null
  let bestAcf = 0.15 // minimum threshold to accept a cycle as "real"

  for (let lag = minLag; lag <= maxLag; lag++) {
    const acf = autocorrelation(series, lag)
    if (acf > bestAcf) { bestAcf = acf; bestLag = lag }
  }

  return bestLag
}

/**
 * Average residuals by position-in-cycle to produce a repeatable additive
 * "shape" array of length `cycleLength`. Buckets with no observations fall
 * back to 0 (no adjustment).
 */
export function averageResidualsByCyclePosition(
  residuals: number[],
  cycleLength: number
): number[] {
  const sums = new Array(cycleLength).fill(0)
  const counts = new Array(cycleLength).fill(0)

  for (let i = 0; i < residuals.length; i++) {
    const pos = i % cycleLength
    sums[pos] += residuals[i]
    counts[pos] += 1
  }

  return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0))
}

/**
 * Tile a cycle-length "shape" array across a forecast horizon, continuing
 * the cycle-position sequence from where history left off (so week h of the
 * forecast aligns with the correct phase of the recurring pattern).
 */
export function tileShapeOverHorizon(
  shape: number[],
  historyLength: number,
  horizon: number
): number[] {
  const cycleLength = shape.length
  const out: number[] = []
  for (let h = 0; h < horizon; h++) {
    const pos = (historyLength + h) % cycleLength
    out.push(shape[pos])
  }
  return out
}

/**
 * Variance-based confidence bounds that widen with horizon — reflecting
 * compounding uncertainty in both the residual noise and the anchor trend
 * (e.g. a management revenue forecast 6 months out is naturally less certain
 * than next month's).
 *
 * @param growthFactor  Per-step multiplicative widening applied to stdDev (default 3%/wk)
 */
export function growthHybridBounds(
  forecast: number[],
  residuals: number[],
  growthFactor = 0.03
): { lower: number[]; upper: number[] } {
  const Z = 1.28 // z-score for 80% CI
  const variance = residuals.length > 1
    ? residuals.reduce((s, r) => s + r ** 2, 0) / residuals.length
    : (forecast.reduce((a, b) => a + b, 0) / forecast.length * 0.2) ** 2
  const baseStdDev = Math.sqrt(variance)

  const lower: number[] = []
  const upper: number[] = []
  for (let h = 0; h < forecast.length; h++) {
    const widenedStdDev = baseStdDev * (1 + growthFactor * h)
    lower.push(Math.max(0, Math.round(forecast[h] - Z * widenedStdDev)))
    upper.push(Math.round(forecast[h] + Z * widenedStdDev))
  }

  return { lower, upper }
}

// ── Channel-aware Outlier Capping ──────────────────────────

/**
 * Cap B2B outlier weeks before combining with B2C.
 *
 * Rationale: B2B spikes are typically event/campaign stock-outs where
 * the project owner takes a large bulk quantity to an event. These are
 * not representative of recurring demand. B2C is the true demand signal
 * and is never capped.
 *
 * Method: for each B2B week, if qty > trailing 12-week mean + 2σ,
 * replace with the trailing mean. Applied before B2B+B2C are combined.
 *
 * @param b2bSeries  Weekly B2B quantities, sorted ascending by week
 * @param windowSize Trailing window for mean/std calculation (default 12)
 * @returns Capped B2B series + indices of weeks that were capped
 */
export function capB2BOutliers(
  b2bSeries: number[],
  windowSize = 12
): { capped: number[]; cappedIndices: number[] } {
  const result = [...b2bSeries]
  const cappedIndices: number[] = []

  for (let i = windowSize; i < b2bSeries.length; i++) {
    const window = b2bSeries.slice(i - windowSize, i)
    const mean = window.reduce((a, b) => a + b, 0) / window.length
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length
    const stdDev = Math.sqrt(variance)
    const ceiling = mean + 2 * stdDev

    if (b2bSeries[i] > ceiling && ceiling > 0) {
      result[i] = Math.round(mean)
      cappedIndices.push(i)
    }
  }

  return { capped: result, cappedIndices }
}

/**
 * Combine B2B and B2C weekly series into a single demand series.
 * B2B outliers are capped first; B2C is used as-is.
 *
 * Both series must be aligned (same weeks, same length).
 * Missing weeks in either channel should be filled with 0 before calling.
 */
export function combineChannels(
  b2bSeries: number[],
  b2cSeries: number[]
): { combined: number[]; b2bCappedIndices: number[] } {
  const { capped: cappedB2B, cappedIndices } = capB2BOutliers(b2bSeries)
  const combined = cappedB2B.map((b2b, i) => b2b + (b2cSeries[i] ?? 0))
  return { combined, b2bCappedIndices: cappedIndices }
}

// ── Dense Series Builder ────────────────────────────────────

/** Fill gaps between history points with 0 to produce a continuous series */
function buildDenseSeries(sorted: HistoryPoint[]): number[] {
  if (sorted.length === 0) return []
  const lookup = new Map(sorted.map(p => [`${p.isoYear}-${p.isoWeek}`, p.qty]))
  const series: number[] = []
  let cur = { isoYear: sorted[0].isoYear, isoWeek: sorted[0].isoWeek }
  const last = sorted[sorted.length - 1]

  while (
    cur.isoYear < last.isoYear ||
    (cur.isoYear === last.isoYear && cur.isoWeek <= last.isoWeek)
  ) {
    series.push(lookup.get(`${cur.isoYear}-${cur.isoWeek}`) ?? 0)
    cur = addIsoWeeks(cur.isoYear, cur.isoWeek, 1)
  }

  return series
}

/**
 * Fill null gaps in a weekly series with the trailing 8-week average.
 * Prevents sparse gaps (e.g. stock-out weeks or WMS non-trading periods)
 * from being treated as zero demand, which distorts the HW trend.
 * Nulls at the start of the series use the first observed value.
 */
function fillGapsWithTrailingAvg(values: (number | null)[], window = 8): number[] {
  const result: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== null) {
      result.push(values[i] as number)
    } else {
      // Trailing average of last `window` observed (non-null) values
      const observed = result.filter(v => v > 0)
      if (observed.length === 0) {
        // No prior data — look ahead for first non-null
        const ahead = values.slice(i + 1).find(v => v !== null)
        result.push(ahead ?? 0)
      } else {
        const slice = observed.slice(-window)
        result.push(Math.round(slice.reduce((a, b) => a + b, 0) / slice.length))
      }
    }
  }
  return result
}

/**
 * Apply stockout-aware demand correction to a weekly series.
 *
 * For each week where observed demand is zero:
 *   - ATP = 0 confirmed → stockout (censored demand) → replace with trailing 8-wk avg
 *   - ATP > 0 confirmed → genuine zero demand → keep as 0
 *   - No ATP data, gap in the MIDDLE of series → trailing avg fallback (likely non-trading gap)
 *   - No ATP data, zero at the TAIL (last 4 weeks) → leave as-is (could be real demand decline)
 *
 * The tail exception is critical: without it, a genuine recent demand drop gets inflated
 * to the historical average, making the forecast blind to the actual recent signal.
 *
 * @param series        Dense weekly demand series
 * @param stockoutWeeks Set of 'isoYear-isoWeek' keys where min_atp = 0
 * @param weekKeys      Parallel array of 'isoYear-isoWeek' keys for each series point
 * @param hasAtpData    Whether ANY ATP data exists for this SKU (activates genuine-zero logic)
 */
export function applyStockoutCorrection(
  series: number[],
  stockoutWeeks: Set<string>,
  weekKeys: string[],
  hasAtpData: boolean,
  window = 8
): { corrected: number[]; correctedCount: number } {
  const corrected = [...series]
  let correctedCount = 0
  const tailStart = series.length - 4  // last 4 weeks are protected from blind correction

  for (let i = 0; i < series.length; i++) {
    if (series[i] > 0) continue

    const isConfirmedStockout = stockoutWeeks.has(weekKeys[i])

    if (hasAtpData) {
      // ATP data available: only correct confirmed stockout weeks
      if (!isConfirmedStockout) continue
    } else {
      // No ATP data: correct mid-series gaps but leave tail zeros intact
      // Tail zeros may reflect a genuine recent demand decline — preserve that signal
      if (i >= tailStart) continue
    }

    // Replace with trailing 8-week average of prior non-zero weeks
    const observed = corrected.slice(0, i).filter(v => v > 0)
    if (observed.length > 0) {
      const slice = observed.slice(-window)
      const trailingAvg = Math.round(slice.reduce((a, b) => a + b, 0) / slice.length)
      if (trailingAvg > 0) {
        corrected[i] = trailingAvg
        correctedCount++
      }
    }
  }

  return { corrected, correctedCount }
}

// ── Main Entry Point ────────────────────────────────────────

export interface HistoryPoint {
  isoYear: number
  isoWeek: number
  qty: number
  channel?: 'B2B' | 'B2C'  // when provided, B2B outliers are capped; B2C is always used as-is
}

/**
 * Generate 26-week demand forecast for a single SKU.
 *
 * When history includes channel info, B2B event/campaign spikes are
 * capped (trailing 12-wk mean+2σ) before combining with B2C.
 * B2C is the true demand signal and is never modified.
 *
 * @param sku        SKU code
 * @param history    Weekly actuals from sales_history (any order)
 * @param startFrom  ISO week to start forecast from (default: current week + 1)
 */
export function generateForecast(
  sku: string,
  history: HistoryPoint[],
  startFrom?: { isoYear: number; isoWeek: number },
  stockoutWeeks?: Set<string>   // 'isoYear-isoWeek' keys where ATP=0 confirmed
): ForecastResult {
  const HORIZON = 52

  const sorted = [...history].sort(
    (a, b) => a.isoYear * 100 + a.isoWeek - (b.isoYear * 100 + b.isoWeek)
  )

  if (sorted.length === 0) {
    return { sku, model: 'avg', historyWeeks: 0, cappedWeeks: 0, stockoutCorrectedWeeks: 0, points: [], mape: undefined }
  }

  // Build dense aligned week list across full history range
  const firstWk = { isoYear: sorted[0].isoYear, isoWeek: sorted[0].isoWeek }
  const lastWk  = { isoYear: sorted[sorted.length-1].isoYear, isoWeek: sorted[sorted.length-1].isoWeek }
  const weeks: { isoYear: number; isoWeek: number }[] = []
  let cur = { ...firstWk }
  while (cur.isoYear < lastWk.isoYear || (cur.isoYear === lastWk.isoYear && cur.isoWeek <= lastWk.isoWeek)) {
    weeks.push({ ...cur })
    cur = addIsoWeeks(cur.isoYear, cur.isoWeek, 1)
  }
  const weekKeys = weeks.map(w => `${w.isoYear}-${w.isoWeek}`)

  const hasChannels = sorted.some(p => p.channel)
  let series: number[]
  let cappedWeeks = 0

  if (hasChannels) {
    const b2bMap = new Map<string, number>()
    const b2cMap = new Map<string, number>()
    for (const p of sorted) {
      const key = `${p.isoYear}-${p.isoWeek}`
      if (p.channel === 'B2B') b2bMap.set(key, (b2bMap.get(key) ?? 0) + p.qty)
      else                     b2cMap.set(key, (b2cMap.get(key) ?? 0) + p.qty)
    }

    const b2cValues = weeks.map(w => b2cMap.get(`${w.isoYear}-${w.isoWeek}`) ?? null)
    const b2cFilled = fillGapsWithTrailingAvg(b2cValues)
    const b2bValues = weeks.map(w => b2bMap.get(`${w.isoYear}-${w.isoWeek}`) ?? null)
    const b2bFilled = fillGapsWithTrailingAvg(b2bValues)

    const { combined, b2bCappedIndices } = combineChannels(b2bFilled, b2cFilled)
    series = combined
    cappedWeeks = b2bCappedIndices.length
  } else {
    const combinedMap = new Map<string, number>()
    for (const p of sorted) {
      const key = `${p.isoYear}-${p.isoWeek}`
      combinedMap.set(key, (combinedMap.get(key) ?? 0) + p.qty)
    }
    const rawValues = weeks.map(w => combinedMap.get(`${w.isoYear}-${w.isoWeek}`) ?? null)
    series = fillGapsWithTrailingAvg(rawValues)
  }

  // Apply stockout correction — replace confirmed stockout zeros with trailing avg
  const hasAtpData = stockoutWeeks !== undefined
  const { corrected: seriesAfterStockout, correctedCount: stockoutCorrectedWeeks } =
    applyStockoutCorrection(series, stockoutWeeks ?? new Set(), weekKeys, hasAtpData)
  series = seriesAfterStockout

  const n = series.length

  let model: ForecastModel
  let rawForecast: number[]
  let residuals: number[]

  if (n >= 16) {
    model = 'holts_linear'
    ;({ forecast: rawForecast, residuals } = holtsLinear(series, HORIZON))
  } else if (n >= 8) {
    model = 'ses'
    ;({ forecast: rawForecast, residuals } = ses(series, HORIZON))
  } else {
    model = 'avg'
    ;({ forecast: rawForecast, residuals } = simpleAverage(series, HORIZON))
  }

  const { lower, upper } = confidenceBounds(rawForecast, residuals)

  let { isoYear: curYear, isoWeek: curWeek } = startFrom ?? (() => {
    const iso = dateToIsoWeek(new Date())
    return addIsoWeeks(iso.isoYear, iso.isoWeek, 1)
  })()

  const points: ForecastPoint[] = rawForecast.map((_, h) => {
    const { isoYear, isoWeek } = addIsoWeeks(curYear, curWeek, h)
    const monday = isoWeekToMonday(isoYear, isoWeek)
    return {
      isoYear,
      isoWeek,
      weekStartDate: toDateStr(monday),
      wkLabel: toWkLabel(isoYear, isoWeek),
      forecastQty: Math.round(rawForecast[h]),
      lowerBound: lower[h],
      upperBound: upper[h],
    }
  })

  // MAPE holdout on last 4 weeks
  let mape: number | undefined
  if (n >= 8) {
    const trainSeries = series.slice(0, -4)
    const holdout = series.slice(-4)
    const { forecast: hindcast } = n >= 16
      ? holtsLinear(trainSeries, 4)
      : ses(trainSeries, 4)
    const mapeVals = holdout
      .map((actual, i) => actual > 0 ? Math.abs(actual - hindcast[i]) / actual : null)
      .filter((v): v is number => v !== null)
    if (mapeVals.length > 0) {
      mape = Math.round((mapeVals.reduce((a, b) => a + b, 0) / mapeVals.length) * 1000) / 10
    }
  }

  return { sku, model, historyWeeks: n, cappedWeeks, stockoutCorrectedWeeks, points, mape, residuals, series }
}
