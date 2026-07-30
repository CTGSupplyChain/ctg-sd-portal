'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import { useRouter } from 'next/navigation'

// ── types ────────────────────────────────────────────────────────────────────

interface SkuRow { sku: string; brand: string; avg_selling_price: number; safety_stock: number; lead_time_wk: number }

interface BrandSummary {
  brand: string
  skuCount: number
  onHandUnits: number
  onHandValue: number
  avgWeeklyDemand: number
  daysOfCover: number | null
  openPoUnits: number
  hasLatePo: boolean
  fcstAcc: number | null
  status: 'Stockout' | 'Reorder' | 'Excess' | 'Healthy' | 'No data'
  velocity: 'High' | 'Med' | 'Low'
}

interface ChartPoint { wk: string; projected: number; safetyStock: number; poLanding: boolean }

// Live health of the WMS webhook/pull pipeline. Read from v_wms_feed_health.
// Heartbeat is the 5-min pull cron, NOT stock events - stock goes quiet overnight
// and flagging on that would make the indicator cry wolf nightly.
interface FeedHealth {
  status: 'healthy' | 'degraded' | 'error' | 'down'
  status_detail: string
  pull_minutes_ago: number | null
  event_minutes_ago: number | null
  events_last_hour: number
  skus_live: number
  skus_total: number
  pct_live: number | null
}

// ── helpers ──────────────────────────────────────────────────────────────────

function kpiCard(bg: string, tc: string, sc: string, border: string, label: string, val: string | number, hint: string) {
  return { bg, tc, sc, border, label, val: String(val), hint }
}

// ── component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const supabase = createClient()
  const router = useRouter()

  const [profile, setProfile] = useState<any>(null)
  const [feed, setFeed] = useState<FeedHealth | null>(null)
  const [brands, setBrands] = useState<string[]>([])
  const [brandSummary, setBrandSummary] = useState<BrandSummary[]>([])
  const [kpis, setKpis] = useState<{
    stockoutRisk: number
    belowReorder: number
    excessValue: number
    latePos: number
    openPoTotal: number
    snapshotDate: string
  } | null>(null)
  const [coverageChart, setCoverageChart] = useState<ChartPoint[]>([])
  const [chartBrand, setChartBrand] = useState('—')
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadDashboard() }, [])

  async function loadDashboard() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)

    const isAdmin = prof?.role === 'admin' || prof?.role === 'supply_chain'
    if (!isAdmin) { router.push('/project/SkinDae'); return }

    const today = new Date().toISOString().split('T')[0]
    const in84d = new Date(Date.now() + 84 * 86400000).toISOString().split('T')[0]
    const ago84d = new Date(Date.now() - 84 * 86400000).toISOString().split('T')[0]

    const [skuRes, wmsRes, poRes, forecastRes, salesRes, feedRes] = await Promise.all([
      supabase.from('master_sku')
        .select('sku, brand, avg_selling_price, safety_stock, lead_time_wk')
        .eq('status', 'Active'),
      supabase.from('wms_inventory_snapshots')
        .select('brand, usable, incoming, snapshot_date')
        .order('snapshot_date', { ascending: false })
        .limit(6000),
      supabase.from('purchase_orders')
        .select('brand, sku, qty, delivery_date, status, unit_price'),
      supabase.from('demand_forecast')
        .select('brand, sku, iso_year, iso_week, week_start_date, forecast_qty')
        .gte('week_start_date', today)
        .lte('week_start_date', in84d)
        .order('week_start_date', { ascending: true }),
      supabase.from('sales_history')
        .select('brand, sku, iso_year, iso_week, qty')
        .gte('week_start_date', ago84d),
      supabase.from('v_wms_feed_health').select('*').single(),
    ])

    setFeed((feedRes.data as FeedHealth) ?? null)

    const skuData: SkuRow[] = skuRes.data || []
    const wmsRaw = wmsRes.data || []
    const poData = poRes.data || []
    const forecastData = forecastRes.data || []
    const salesData = salesRes.data || []

    const uniqueBrands = [...new Set(skuData.map(s => s.brand))].sort((a, b) => a.localeCompare(b))
    setBrands(uniqueBrands)

    const latestDate = wmsRaw[0]?.snapshot_date || '—'
    const wmsLatest: Record<string, { onHand: number; incoming: number }> = {}
    wmsRaw
      .filter(r => r.snapshot_date === latestDate && r.brand && r.brand.trim())
      .forEach(r => {
        if (!wmsLatest[r.brand]) wmsLatest[r.brand] = { onHand: 0, incoming: 0 }
        wmsLatest[r.brand].onHand += r.usable || 0
        wmsLatest[r.brand].incoming += r.incoming || 0
      })

    const brandForecast: Record<string, { byWeek: Record<string, number>; bySku: Record<string, number> }> = {}
    forecastData.forEach(r => {
      if (!brandForecast[r.brand]) brandForecast[r.brand] = { byWeek: {}, bySku: {} }
      brandForecast[r.brand].byWeek[r.week_start_date] = (brandForecast[r.brand].byWeek[r.week_start_date] || 0) + r.forecast_qty
      brandForecast[r.brand].bySku[r.sku] = (brandForecast[r.brand].bySku[r.sku] || 0) + r.forecast_qty
    })

    const openPoByBrand: Record<string, number> = {}
    let latePoCount = 0
    let totalOpenPo = 0
    poData.filter(p => p.status === 'Open').forEach(p => {
      if (!p.brand) return
      openPoByBrand[p.brand] = (openPoByBrand[p.brand] || 0) + (p.qty || 0)
      totalOpenPo += p.qty || 0
      if (p.delivery_date && p.delivery_date < today) latePoCount++
    })

    type MapeAcc = { errSum: number; count: number }
    const brandMapeAcc: Record<string, MapeAcc> = {}
    const forecastLookup: Record<string, number> = {}
    forecastData.forEach(f => { forecastLookup[`${f.sku}-${f.iso_year}-${f.iso_week}`] = f.forecast_qty })
    salesData.forEach(s => {
      const fc = forecastLookup[`${s.sku}-${s.iso_year}-${s.iso_week}`]
      if (fc != null && s.qty > 0) {
        if (!brandMapeAcc[s.brand]) brandMapeAcc[s.brand] = { errSum: 0, count: 0 }
        brandMapeAcc[s.brand].errSum += Math.abs(fc - s.qty) / s.qty
        brandMapeAcc[s.brand].count++
      }
    })

    let stockoutRisk = 0; let belowReorder = 0; let excessValue = 0

    const summary: BrandSummary[] = uniqueBrands.map(brand => {
      const brandSkus = skuData.filter(s => s.brand === brand)
      const skuCount = brandSkus.length
      const wms = wmsLatest[brand] || { onHand: 0, incoming: 0 }
      const onHandUnits = wms.onHand
      const avgAsp = brandSkus.length > 0 ? brandSkus.reduce((sum, s) => sum + (s.avg_selling_price || 0), 0) / brandSkus.length : 0
      const onHandValue = onHandUnits * avgAsp
      const fc = brandForecast[brand]
      const weekCount = fc ? Object.keys(fc.byWeek).length : 0
      const totalFcstDemand = fc ? Object.values(fc.byWeek).reduce((a, b) => a + b, 0) : 0
      const avgWeeklyDemand = weekCount > 0 ? totalFcstDemand / weekCount : 0
      const avgDailyDemand = avgWeeklyDemand / 7
      const daysOfCover = avgDailyDemand > 0 ? Math.round(onHandUnits / avgDailyDemand) : null
      const totalSafetyStock = brandSkus.reduce((sum, s) => sum + (s.safety_stock || 0), 0)
      const openPoUnits = openPoByBrand[brand] || 0
      const hasLatePo = poData.some(p => p.brand === brand && p.status === 'Open' && p.delivery_date && p.delivery_date < today)
      if (avgWeeklyDemand > 0 && onHandUnits < avgWeeklyDemand * 2 && !openPoUnits) stockoutRisk++
      if (onHandUnits < totalSafetyStock && !openPoUnits) belowReorder++
      if (daysOfCover && daysOfCover > 90) excessValue += onHandValue
      const mapeAcc = brandMapeAcc[brand]
      const fcstAcc = mapeAcc && mapeAcc.count >= 3 ? Math.max(0, 100 - (mapeAcc.errSum / mapeAcc.count) * 100) : null
      const velocity: 'High' | 'Med' | 'Low' = avgWeeklyDemand > 3000 ? 'High' : avgWeeklyDemand > 500 ? 'Med' : 'Low'
      let status: BrandSummary['status']
      if (avgWeeklyDemand > 0 && onHandUnits < avgWeeklyDemand * 2 && !openPoUnits) status = 'Stockout'
      else if (onHandUnits < totalSafetyStock) status = 'Reorder'
      else if (daysOfCover && daysOfCover > 90) status = 'Excess'
      else if (avgWeeklyDemand === 0 && onHandUnits === 0) status = 'No data'
      else status = 'Healthy'
      return { brand, skuCount, onHandUnits, onHandValue, avgWeeklyDemand, daysOfCover, openPoUnits, hasLatePo, fcstAcc, status, velocity }
    })

    const statusOrder: Record<string, number> = { Stockout: 0, Reorder: 1, Excess: 2, Healthy: 3, 'No data': 4 }
    summary.sort((a, b) => statusOrder[a.status] - statusOrder[b.status])
    setBrandSummary(summary)

    const bestBrand = Object.entries(brandForecast).sort(([, a], [, b]) => Object.keys(b.byWeek).length - Object.keys(a.byWeek).length)[0]?.[0] || ''
    setChartBrand(bestBrand)

    if (bestBrand) {
      const chartSkus = skuData.filter(s => s.brand === bestBrand)
      const chartSafetyStock = chartSkus.reduce((sum, s) => sum + (s.safety_stock || 0), 0)
      const chartPos = poData.filter(p => p.brand === bestBrand && p.status === 'Open')
      let projected = wmsLatest[bestBrand]?.onHand || 0
      const weeks = Object.keys(brandForecast[bestBrand]?.byWeek || {}).slice(0, 12)
      const points: ChartPoint[] = weeks.map((wk, i) => {
        const demand = brandForecast[bestBrand]?.byWeek[wk] || 0
        const nextWk = new Date(new Date(wk).getTime() + 7 * 86400000).toISOString().split('T')[0]
        const receipt = chartPos.filter(p => p.delivery_date && p.delivery_date >= wk && p.delivery_date < nextWk).reduce((sum, p) => sum + (p.qty || 0), 0)
        projected = projected + receipt - demand
        return { wk: `wk${i + 1}`, projected: Math.max(0, projected), safetyStock: chartSafetyStock, poLanding: receipt > 0 }
      })
      setCoverageChart(points)
    }

    setKpis({ stockoutRisk, belowReorder, excessValue: Math.round(excessValue), latePos: latePoCount, openPoTotal: totalOpenPo, snapshotDate: latestDate })
    setLoading(false)
  }

  function CoverageChart() {
    if (coverageChart.length === 0) {
      return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, fontSize: 12, color: '#8B948F' }}>No forecast data available</div>
    }
    const maxVal = Math.max(...coverageChart.map(p => p.projected), coverageChart[0]?.safetyStock || 0) * 1.25 || 1
    const W = 540; const H = 160; const PAD = 48
    const xCoord = (i: number) => PAD + (i / Math.max(coverageChart.length - 1, 1)) * (W - PAD - 12)
    const yCoord = (v: number) => 24 + (1 - v / maxVal) * (H - 40)
    const safetyY = yCoord(coverageChart[0]?.safetyStock || 0)
    const points = coverageChart.map((p, i) => `${xCoord(i)},${yCoord(p.projected)}`).join(' ')
    const stockoutIdx = coverageChart.findIndex(p => p.projected <= (coverageChart[0]?.safetyStock || 0))
    return (
      <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: 'auto' }}>
        <line x1={PAD} y1={20} x2={PAD} y2={H} stroke="rgba(15,40,30,0.14)" strokeWidth="1"/>
        <line x1={PAD} y1={H} x2={W - 8} y2={H} stroke="rgba(15,40,30,0.14)" strokeWidth="1"/>
        {(coverageChart[0]?.safetyStock || 0) > 0 && (<>
          <line x1={PAD} y1={safetyY} x2={W - 8} y2={safetyY} stroke="#E24B4A" strokeWidth="1" strokeDasharray="4 4"/>
          <text x={PAD + 4} y={safetyY - 4} fontFamily="Inter,sans-serif" fontSize="9" fill="#A32D2D">safety stock</text>
        </>)}
        <polyline points={points} fill="none" stroke="#1D9E75" strokeWidth="2.4"/>
        {coverageChart.map((p, i) => p.poLanding && (
          <g key={`po-${i}`}>
            <circle cx={xCoord(i)} cy={yCoord(p.projected)} r="4" fill="#0F6E56"/>
            <text x={xCoord(i) - 10} y={yCoord(p.projected) - 7} fontFamily="Inter,sans-serif" fontSize="9" fill="#0F6E56">PO</text>
          </g>
        ))}
        {stockoutIdx > 0 && (
          <g>
            <circle cx={xCoord(stockoutIdx)} cy={yCoord(coverageChart[stockoutIdx].projected)} r="4" fill="#E24B4A"/>
            <text x={xCoord(stockoutIdx) - 20} y={H + 13} fontFamily="Inter,sans-serif" fontSize="9" fill="#A32D2D">alert {coverageChart[stockoutIdx].wk}</text>
          </g>
        )}
        <text x={PAD} y={H + 13} fontFamily="Inter,sans-serif" fontSize="9" fill="#8B948F">wk1</text>
        <text x={W - 22} y={H + 13} fontFamily="Inter,sans-serif" fontSize="9" fill="#8B948F">wk12</text>
        <text x={PAD - 4} y={22} fontFamily="Inter,sans-serif" fontSize="9" fill="#8B948F" textAnchor="end">units</text>
      </svg>
    )
  }

  function AccBar({ name, pct }: { name: string; pct: number | null }) {
    const color = pct == null ? '#8B948F' : pct >= 85 ? '#1D9E75' : pct >= 70 ? '#EF9F27' : '#E24B4A'
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: '#5C6862', width: 96, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <div style={{ flex: 1, height: 7, background: 'rgba(15,40,30,0.07)', borderRadius: 5, overflow: 'hidden' }}>
          {pct != null && <div style={{ width: `${Math.min(pct, 100)}%`, height: 7, background: color, borderRadius: 5 }}/>}
        </div>
        <span style={{ fontSize: 11, color: '#5C6862', width: 36, textAlign: 'right', fontFamily: 'monospace' }}>
          {pct != null ? `${Math.round(pct)}%` : '—'}
        </span>
      </div>
    )
  }

  const tiles = kpis ? [
    { label: 'Stockout risk', val: kpis.stockoutRisk, hint: 'SKUs < 2 wks cover, no PO', cls: kpis.stockoutRisk > 0 ? 'red' : 'neutral' },
    { label: 'Below reorder pt', val: kpis.belowReorder, hint: 'SKUs under safety stock', cls: kpis.belowReorder > 0 ? 'amber' : 'neutral' },
    { label: 'Excess / aged', val: kpis.excessValue > 0 ? `RM ${(kpis.excessValue / 1000).toFixed(1)}k` : '—', hint: '>90 days cover (value)', cls: kpis.excessValue > 0 ? 'amber' : 'neutral' },
    { label: 'Late POs', val: kpis.latePos, hint: 'past expected receipt', cls: kpis.latePos > 0 ? 'red' : 'neutral' },
    { label: 'Open PO units', val: kpis.openPoTotal.toLocaleString(), hint: 'committed inbound supply', cls: 'neutral' },
    { label: 'Active brands', val: brandSummary.filter(b => b.status !== 'No data').length, hint: `of ${brands.length} in master_sku`, cls: 'neutral' },
  ] : []

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE', fontFamily: 'Calibri, "Segoe UI", sans-serif' }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name} userRole={profile?.role} brands={brands} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div style={{ background: '#FFFFFF', borderBottom: '1px solid #E4DDD3', padding: '10px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1F2937', letterSpacing: '-0.01em', fontFamily: 'Cambria, Georgia, serif' }}>Inventory control tower</div>
            <div style={{ fontSize: 11.5, color: '#4B5563', marginTop: 1 }}>
              {loading ? 'Loading…' : `WMS snapshot ${kpis?.snapshotDate ?? '—'} · demand from statistical forecast`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {feed && (() => {
              // Amber/red must be readable without hovering - a tooltip-only
              // warning is the one that gets missed on the morning it matters.
              const tone = {
                healthy:  { dot: '#2F9E68', bg: '#FFFFFF', border: '#E4DDD3', text: '#4B5563', label: 'WMS feed live' },
                degraded: { dot: '#C08A2E', bg: '#FDF6E7', border: '#E8D5A8', text: '#7A5B14', label: 'WMS feed delayed' },
                error:    { dot: '#C0392B', bg: '#FBEDEB', border: '#E8B6AF', text: '#8C2A1E', label: 'WMS feed error' },
                down:     { dot: '#C0392B', bg: '#FBEDEB', border: '#E8B6AF', text: '#8C2A1E', label: 'WMS feed disconnected' },
              }[feed.status] ?? { dot: '#8A8578', bg: '#FFFFFF', border: '#E4DDD3', text: '#4B5563', label: 'WMS feed unknown' }
              return (
                <span
                  title={`${feed.status_detail}\nLast pull: ${feed.pull_minutes_ago ?? '?'} min ago · last stock event: ${feed.event_minutes_ago ?? '?'} min ago · ${feed.events_last_hour} events in the last hour`}
                  style={{ fontSize: 12, color: tone.text, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 8, padding: '5px 13px', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'help' }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: tone.dot, display: 'inline-block' }}/>
                  {tone.label}
                  {feed.status === 'healthy'
                    ? <span style={{ color: '#8A8578' }}>· {feed.skus_live}/{feed.skus_total} SKUs live</span>
                    : <span style={{ fontWeight: 600 }}>· check feed</span>}
                </span>
              )
            })()}
            <span style={{ fontSize: 12, color: '#4B5563', background: '#FFFFFF', border: '1px solid #E4DDD3', borderRadius: 8, padding: '5px 13px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2F9E68', display: 'inline-block' }}/>All brands
            </span>
            <span style={{ fontSize: 12, color: '#4B5563', background: '#FFFFFF', border: '1px solid #E4DDD3', borderRadius: 8, padding: '5px 13px' }}>Next 12 weeks</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ padding: '20px 24px 48px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#8B948F', fontSize: 13 }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 14 }}>
                {tiles.map(t => {
                  const bg = t.cls === 'red' ? '#FAEAEA' : t.cls === 'amber' ? '#FEF3E2' : '#FFFFFF'
                  const tc = t.cls === 'red' ? '#C5453F' : t.cls === 'amber' ? '#E8A33D' : '#1F2937'
                  const sc = t.cls === 'red' ? '#C5453F' : t.cls === 'amber' ? '#E8A33D' : '#4B5563'
                  const bdr = t.cls === 'neutral' ? '1px solid #E4DDD3' : t.cls === 'red' ? '1px solid #F5C6C4' : '1px solid #F9DEB8'
                  return (
                    <div key={t.label} style={{ background: bg, border: bdr, borderRadius: 10, padding: '12px 13px' }}>
                      <div style={{ fontSize: 11, fontWeight: 500, color: sc, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.label}</div>
                      <div style={{ fontSize: 24, fontWeight: 600, color: tc, margin: '2px 0 1px', letterSpacing: '-0.02em', fontFamily: 'Cambria, Georgia, serif' }}>{t.val}</div>
                      <div style={{ fontSize: 10.5, color: sc }}>{t.hint}</div>
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 12, marginBottom: 12 }}>
                <div style={{ background: '#fff', border: '0.5px solid rgba(15,40,30,0.09)', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: '#16201C' }}>Projected inventory coverage</span>
                    <span style={{ fontSize: 11, color: '#8B948F' }}>{chartBrand} · on-hand + receipts − demand</span>
                  </div>
                  <CoverageChart />
                </div>
                <div style={{ background: '#fff', border: '0.5px solid rgba(15,40,30,0.09)', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: '#16201C', marginBottom: 10 }}>Replenishment queue</div>
                  {brandSummary.filter(b => ['Stockout', 'Reorder', 'Excess'].includes(b.status)).length === 0 ? (
                    <div style={{ fontSize: 12, color: '#8B948F', paddingTop: 8 }}>No immediate reorder actions flagged.</div>
                  ) : (
                    brandSummary.filter(b => ['Stockout', 'Reorder', 'Excess'].includes(b.status)).slice(0, 7).map((b, i) => {
                      const tagBg = b.status === 'Stockout' ? '#FAEAEA' : b.status === 'Reorder' ? '#FEF3E2' : '#E4DDD3'
                      const tagTc = b.status === 'Stockout' ? '#C5453F' : b.status === 'Reorder' ? '#E8A33D' : '#4B5563'
                      const action = b.status === 'Stockout' ? 'reorder now' : b.status === 'Reorder' ? 'reorder soon' : 'monitor excess'
                      return (
                        <div key={b.brand} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: i === 0 ? 'none' : '0.5px solid rgba(15,40,30,0.09)', fontSize: 13, color: '#16201C' }}>
                          <span>{b.brand} · {b.skuCount} SKU{b.skuCount !== 1 ? 's' : ''}</span>
                          <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 9px', borderRadius: 7, background: tagBg, color: tagTc }}>{action}</span>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
              <div style={{ background: '#fff', border: '0.5px solid rgba(15,40,30,0.09)', borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ padding: '12px 16px', borderBottom: '0.5px solid rgba(15,40,30,0.09)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#16201C' }}>Brand health</span>
                  <span style={{ fontSize: 11, color: '#8B948F' }}>sorted by risk · click "View S&D" for SKU detail</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead>
                      <tr style={{ background: 'rgba(15,40,30,0.025)' }}>
                        {['Brand', 'SKUs', 'On-hand', 'Days cover', 'Velocity', 'Fcst acc', 'Open PO', 'Status', ''].map(h => (
                          <th key={h} style={{ fontSize: 11, fontWeight: 500, color: '#8B948F', padding: '7px 14px', textAlign: h === 'Brand' || h === '' ? 'left' : 'right', borderBottom: '0.5px solid rgba(15,40,30,0.09)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {brandSummary.map((row, i) => {
                        const statusStyle = row.status === 'Stockout' ? { background: '#FAEAEA', color: '#C5453F' } : row.status === 'Reorder' ? { background: '#FEF3E2', color: '#E8A33D' } : row.status === 'Excess' ? { background: '#FEF3E2', color: '#E8A33D' } : row.status === 'Healthy' ? { background: '#DCEAE8', color: '#0E5C56' } : { background: '#E4DDD3', color: '#4B5563' }
                        return (
                          <tr key={row.brand} style={{ background: i % 2 === 0 ? '#fff' : 'rgba(15,40,30,0.013)' }}>
                            <td style={{ padding: '9px 14px', fontWeight: 500, color: '#16201C', whiteSpace: 'nowrap' }}>{row.brand}</td>
                            <td style={{ padding: '9px 14px', color: '#5C6862', textAlign: 'right' }}>{row.skuCount}</td>
                            <td style={{ padding: '9px 14px', color: '#344054', textAlign: 'right', fontFamily: 'monospace' }}>{row.onHandUnits > 0 ? row.onHandUnits.toLocaleString() : '—'}</td>
                            <td style={{ padding: '9px 14px', color: '#344054', textAlign: 'right', fontFamily: 'monospace' }}>{row.daysOfCover != null ? `${row.daysOfCover} d` : '—'}</td>
                            <td style={{ padding: '9px 14px', color: '#5C6862', textAlign: 'right' }}>{row.avgWeeklyDemand > 0 ? row.velocity : '—'}</td>
                            <td style={{ padding: '9px 14px', color: '#344054', textAlign: 'right', fontFamily: 'monospace' }}>{row.fcstAcc != null ? `${Math.round(row.fcstAcc)}%` : '—'}</td>
                            <td style={{ padding: '9px 14px', color: '#1849A9', fontWeight: 500, textAlign: 'right', fontFamily: 'monospace' }}>{row.openPoUnits > 0 ? row.openPoUnits.toLocaleString() : '—'}</td>
                            <td style={{ padding: '9px 14px', textAlign: 'right' }}>
                              <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 9px', borderRadius: 7, ...statusStyle }}>{row.status}</span>
                            </td>
                            <td style={{ padding: '9px 14px' }}>
                              <button onClick={() => router.push(`/project/${encodeURIComponent(row.brand)}`)} style={{ fontSize: 11.5, color: '#0E5C56', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>View S&D →</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: '#fff', border: '0.5px solid rgba(15,40,30,0.09)', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: '#16201C' }}>Forecast accuracy</span>
                    <span style={{ fontSize: 11, color: '#8B948F' }}>100 − MAPE by brand</span>
                  </div>
                  {brandSummary.filter(b => b.fcstAcc != null).length === 0 ? (
                    <div style={{ fontSize: 12, color: '#8B948F', lineHeight: 1.7 }}>
                      Insufficient actuals vs. forecast overlap (need ≥ 3 matching SKU-weeks).<br/>
                      Will populate as historical data accumulates.
                    </div>
                  ) : (
                    brandSummary.filter(b => b.fcstAcc != null).sort((a, b) => (b.fcstAcc ?? 0) - (a.fcstAcc ?? 0)).map(b => <AccBar key={b.brand} name={b.brand} pct={b.fcstAcc} />)
                  )}
                  <div style={{ display: 'flex', gap: 12, fontSize: 10.5, color: '#8B948F', marginTop: 10, flexWrap: 'wrap' }}>
                    {[['#2F9E68', '≥85% trusted'], ['#E8A33D', '70–85% buffer'], ['#C5453F', '<70% override']].map(([c, l]) => (
                      <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <i style={{ width: 9, height: 2, background: c, display: 'inline-block', borderRadius: 2 }}/>{l}
                      </span>
                    ))}
                  </div>
                </div>
                <div style={{ background: '#fff', border: '0.5px solid rgba(15,40,30,0.09)', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: '#16201C' }}>Inventory aging</span>
                    <span style={{ fontSize: 11, color: '#8B948F' }}>days to expiry</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#8B948F', lineHeight: 1.7 }}>
                    Expiry / lot data not yet captured in WMS upload.<br/>
                    Pending confirmation per design brief §9 open decisions.<br/>
                    <span style={{ color: '#85530B' }}>Interim:</span> age-from-receipt buckets will populate once lot tracking is active.
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 72, padding: '12px 6px 0', opacity: 0.25 }}>
                    {[{ h: 62, c: '#9FE1CB', lbl: '>180d' }, { h: 42, c: '#FAC775', lbl: '90–180' }, { h: 24, c: '#EF9F27', lbl: '30–90' }, { h: 10, c: '#E24B4A', lbl: '<30d' }].map(b => (
                      <div key={b.lbl} style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{ height: b.h, background: b.c, borderRadius: '4px 4px 0 0' }}/>
                        <div style={{ fontSize: 10, color: '#5C6862', marginTop: 4 }}>{b.lbl}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: '#8B948F', marginTop: 22, textAlign: 'center' }}>
                On-hand from WMS snapshot ({kpis?.snapshotDate}) · Demand from Holt-Winters forecast · Open POs from purchase order register · Days cover = on-hand ÷ avg daily demand
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
