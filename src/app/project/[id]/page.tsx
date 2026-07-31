'use client'
import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import { SDGrid } from '@/components/sd/SDTable'
import ComponentSD from '@/components/sd/ComponentSD'
import dynamic from 'next/dynamic'
import { computeMRP } from '@/lib/bom-mrp'
import type { ComponentMaster, ComponentMrpResult } from '@/lib/bom-mrp'

const ForecastChart = dynamic(
  () => import('@/components/sd/ForecastChart'),
  { ssr: false, loading: () => (
    <div className="bg-white rounded-xl p-5 mt-4 h-32 flex items-center justify-center text-sm" style={{ border: '1px solid #E4DDD3', color: '#4B5563' }}>
      Loading forecast chart...
    </div>
  )}
)
import { computeSD, FLAG_DISPLAY } from '@/lib/sd-compute'
import type { SkuSdResult, WeekInfo } from '@/lib/sd-compute'
import { loadDemandForecast } from '@/lib/forecasting/forecast-lookup'
import { RefreshCw, Download, ChevronDown, ChevronRight, Search, X } from 'lucide-react'

function getCurrentMondayDate(): string {
  const now = new Date()
  const day = now.getDay() === 0 ? 7 : now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day - 1))
  const y = monday.getFullYear()
  const m = String(monday.getMonth() + 1).padStart(2, '0')
  const d = String(monday.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
const CURRENT_MONDAY = getCurrentMondayDate()
let CURRENT_WK = ''

export default function ProjectPage() {
  const params = useParams()
  const brand = decodeURIComponent(params.id as string)
  const supabase = createClient()

  const [profile, setProfile] = useState<any>(null)
  const [brands, setBrands] = useState<string[]>([])
  const [weeks, setWeeks] = useState<WeekInfo[]>([])
  const [skuResults, setSkuResults] = useState<SkuSdResult[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<string>('')
  // How many of this brand's SKUs are showing a live WMS figure vs the last
  // Excel snapshot. Surfaced in the header so the number's provenance is visible.
  const [liveSkus, setLiveSkus] = useState<{ live: number; total: number }>({ live: 0, total: 0 })

  // Which SKU's "BOM & History" panel is expanded — only one at a time to
  // keep MRP computation + chart rendering cheap. null = all collapsed.
  const [expandedSku, setExpandedSku] = useState<string | null>(null)

  // SKU search — filters the list below by SKU code or description
  const [searchQuery, setSearchQuery] = useState('')

  const [bomFgParts, setBomFgParts] = useState<any[]>([])
  const [bomLinesAll, setBomLinesAll] = useState<any[]>([])
  const [bomComponents, setBomComponents] = useState<ComponentMaster[]>([])
  const [bomComponentCommits, setBomComponentCommits] = useState<Record<string, Record<string, number>>>({})
  const [bomComponentUncommits, setBomComponentUncommits] = useState<Record<string, Record<string, number>>>({})

  // Lazily computed per SKU, cached once computed so re-expanding is instant.
  const [mrpBySku, setMrpBySku] = useState<Record<string, ComponentMrpResult[]>>({})
  const [fgPartBySku, setFgPartBySku] = useState<Record<string, string>>({})

  useEffect(() => {
    sessionStorage.setItem('ctg_last_brand', brand)
    loadAll()
  }, [brand])

  async function loadAll() {
    setLoading(true)
    setExpandedSku(null)
    setMrpBySku({})
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)

    const isAdmin = prof?.role === 'admin' || prof?.role === 'supply_chain'
    if (isAdmin) {
      const { data: allSkus } = await supabase.from('master_sku').select('brand').neq('brand', '')
      const uniqueBrands = [...new Set(allSkus?.map((s: any) => s.brand) || [])]
      setBrands(uniqueBrands as string[])
    } else {
      const { data: access } = await supabase.from('user_brand_access').select('brand').eq('user_id', user.id)
      setBrands(access?.map((a: any) => a.brand) || [])
    }

    const { data: wkData } = await supabase
      .from('week_calendar').select('*').gte('monday_date', CURRENT_MONDAY).order('monday_date').limit(52)

    const wkList: WeekInfo[] = (wkData || []).map((w: any) => ({
      label: w.wk_label, year: w.year, month: w.month, monthLabel: w.month_label,
      wkInYear: w.wk_in_year, wkInMonth: w.wk_in_month, mondayDate: w.monday_date, weeksInMonth: w.weeks_in_month,
    }))
    if (wkList.length > 0) CURRENT_WK = wkList[0].label
    setWeeks(wkList)

    const { data: skuData } = await supabase.from('master_sku').select('*').eq('brand', brand).eq('status', 'Active')

    const masterSkus: string[] = skuData?.map((s: any) => s.sku) || []

    // On-hand comes from v_stock_current, which serves the live WMS webhook value
    // when that SKU has moved since the last Excel upload and falls back to the
    // snapshot otherwise. The view already resolves sku_wms_mapping, so the old
    // variant-consolidation pass here is no longer needed - and must not be
    // reinstated: Bottle and Box are distinct products with separate WMS stock,
    // so summing them would double-count.
    const { data: stockData } = await supabase
      .from('v_stock_current')
      .select('portal_sku, atp_current, atp_source, live_event_at, snapshot_date')
      .in('portal_sku', masterSkus)

    const latestStock: Record<string, number> = {}
    let liveCount = 0
    let newestStamp = ''
    stockData?.forEach((s: any) => {
      latestStock[s.portal_sku] = s.atp_current || 0
      const stamp = s.atp_source === 'live' ? (s.live_event_at || '') : (s.snapshot_date || '')
      if (s.atp_source === 'live') liveCount++
      // Both are ISO-prefixed, so lexical comparison orders dates and timestamps alike
      if (stamp > newestStamp) newestStamp = stamp
    })
    setLiveSkus({ live: liveCount, total: stockData?.length ?? 0 })
    if (newestStamp) setLastUpdated(newestStamp.slice(0, 16).replace('T', ' '))

    const { data: projectRows } = await supabase
      .from('projects').select('id').eq('brand', brand)
    const projectData = projectRows?.[0] ?? null
    const allProjectIds = (projectRows || []).map((r: any) => r.id)

    const { data: fcstData } = await supabase
      .from('sales_forecast').select('*').eq('project_id', projectData?.id || '')
      .order('submitted_at', { ascending: false }).limit(1).single()

    const forecast = fcstData || null

    const { data: supplyData } = await supabase
      .from('purchase_orders')
      .select('*')
      .in('sku', skuData?.map((s: any) => s.sku) || [])
      .eq('status', 'Open')

    const { data: histData } = await supabase
      .from('historical_demand').select('sku, qty')
      .in('sku', skuData?.map((s: any) => s.sku) || [])
      .gte('iso_year', 2026).lte('iso_week', 17).gte('iso_week', 5)

    const histBySku: Record<string, number[]> = {}
    histData?.forEach((h: any) => {
      if (!histBySku[h.sku]) histBySku[h.sku] = []
      histBySku[h.sku].push(h.qty)
    })
    const histAvg: Record<string, number> = {}
    Object.entries(histBySku).forEach(([sku, qtys]) => {
      histAvg[sku] = qtys.reduce((a, b) => a + b, 0) / qtys.length
    })

    const skuList = skuData?.map((s: any) => s.sku) || []
    const demandForecastMap = await loadDemandForecast(skuList)

    const results: SkuSdResult[] = (skuData || []).map((skuRaw: any) => {
      const sku = {
        sku: skuRaw.sku, description: skuRaw.description, brand: skuRaw.brand,
        moq: skuRaw.moq, uom: skuRaw.uom, leadTimeWk: skuRaw.lead_time_wk,
        avgSellingPrice: skuRaw.avg_selling_price, safetyStock: skuRaw.safety_stock,
        bufferStock: skuRaw.buffer_stock, status: skuRaw.status,
        demandSource: skuRaw.demand_source,
      }
      const skuSupply = supplyData?.filter((s: any) => s.sku === skuRaw.sku) || []
      const commits: Record<string, number> = {}
      const uncommits: Record<string, number> = {}
      const wkLabels = new Set(wkList.map(w => w.label))
      skuSupply.forEach((s: any) => {
        const wk = (s.receipt_wk && wkLabels.has(s.receipt_wk)) ? s.receipt_wk : CURRENT_WK
        const remainingQty = s.balance_qty ?? (s.qty - (s.qty_shipped || 0))
        const incomingQty = Math.max(remainingQty, 0)
        if (s.commit_status === 'Commit') commits[wk] = (commits[wk] || 0) + incomingQty
        else uncommits[wk] = (uncommits[wk] || 0) + incomingQty
      })
      return computeSD({
        sku,
        onHand: latestStock[skuRaw.sku] || 0,
        backorderQty: skuRaw.backorder_qty || 0,
        weeks: wkList,
        forecast,
        historicalAvg: histAvg[skuRaw.sku] || 0,
        demandForecast: demandForecastMap.get(skuRaw.sku) ?? null,
        supplyCommits: commits,
        supplyUncommits: uncommits,
        currentWk: CURRENT_WK,
        thresholdOrderNow: 4,
        thresholdMonitor: 8,
      })
    })

    setSkuResults(results)

    // ── BOM MRP raw data (MRP itself is computed lazily per-SKU on expand) ──
    if (allProjectIds.length > 0) {
      const { data: fgParts } = await supabase
        .from('parts')
        .select('part_number, description, master_sku_ref')
        .in('project_id', allProjectIds)
        .eq('category', 'FG')

      const { data: bomData } = await supabase
        .from('bom_lines')
        .select('id, parent_pn, child_pn, bom_level, qty_per, uom, child:parts!bom_lines_child_pn_fkey(part_number, description, category, uom, on_hand_qty)')
        .eq('is_active', true)

      const { data: projectParts } = await supabase
        .from('parts').select('part_number').in('project_id', allProjectIds)

      const projectPns = new Set(projectParts?.map((p: any) => p.part_number) || [])
      ;(fgParts || []).forEach((p: any) => projectPns.add(p.part_number))

      const bomLines = (bomData || [])
        .filter((bl: any) => projectPns.has(bl.parent_pn) || projectPns.has(bl.child_pn))
        .map((bl: any) => ({
          partNumber: bl.child_pn,
          parentPn: bl.parent_pn,
          description: bl.child?.description || bl.child_pn,
          category: bl.child?.category || 'RM',
          bomLevel: bl.bom_level,
          qtyPer: parseFloat(bl.qty_per),
          uom: bl.uom,
        }))

      const compPns = [...new Set(bomLines.map((b: any) => b.partNumber as string))]

      const { data: psData } = compPns.length > 0
        ? await supabase.from('part_supplier')
            .select('part_number, moq, spq, lead_time_wk, supplier_id')
            .in('part_number', compPns).eq('is_preferred', true)
        : { data: [] }

      const supIds = [...new Set((psData || []).map((ps: any) => ps.supplier_id).filter(Boolean))]
      const { data: supData } = supIds.length > 0
        ? await supabase.from('plm_suppliers').select('id, name').in('id', supIds)
        : { data: [] }

      const supNameMap = new Map((supData || []).map((s: any) => [s.id, s.name]))
      const psMap = new Map((psData || []).map((ps: any) => [ps.part_number, ps]))

      const { data: partsData } = compPns.length > 0
        ? await supabase.from('parts')
            .select('part_number, description, category, uom, on_hand_qty')
            .in('part_number', compPns)
        : { data: [] }

      const components: ComponentMaster[] = (partsData || []).map((p: any) => {
        const ps = psMap.get(p.part_number)
        return {
          partNumber: p.part_number,
          description: p.description,
          category: p.category,
          uom: p.uom,
          onHandQty: p.on_hand_qty ?? 0,
          supplier: ps?.supplier_id ? supNameMap.get(ps.supplier_id) ?? null : null,
          moq: ps?.moq ?? null,
          spq: ps?.spq ?? null,
          leadTimeWk: ps?.lead_time_wk ?? null,
        }
      })

      // Real component PO supply (Supply Commit/Uncommit) — mirrors the FG
      // sku supplyCommits/supplyUncommits pattern above, keyed by part_number.
      const { data: componentSupplyData } = compPns.length > 0
        ? await supabase.from('purchase_orders')
            .select('part_number, qty, receipt_wk, commit_status')
            .in('part_number', compPns).eq('status', 'Open')
        : { data: [] }

      const wkLabelSet = new Set(wkList.map((w: any) => w.label))
      const componentCommits: Record<string, Record<string, number>> = {}
      const componentUncommits: Record<string, Record<string, number>> = {}
      ;(componentSupplyData || []).forEach((s: any) => {
        if (!s.part_number) return
        const wk = (s.receipt_wk && wkLabelSet.has(s.receipt_wk)) ? s.receipt_wk : CURRENT_WK
        const target = s.commit_status === 'Commit' ? componentCommits : componentUncommits
        if (!target[s.part_number]) target[s.part_number] = {}
        target[s.part_number][wk] = (target[s.part_number][wk] || 0) + (s.qty || 0)
      })

      setBomFgParts(fgParts || [])
      setBomLinesAll(bomLines)
      setBomComponents(components)
      setBomComponentCommits(componentCommits)
      setBomComponentUncommits(componentUncommits)
    }

    setLoading(false)
  }

  // Compute MRP/BOM explosion for one SKU on demand (first expand only —
  // cached in mrpBySku after that). Keeps the page fast with 10+ SKUs since
  // we're not exploding BOM for every SKU on every load.
  function ensureMrpForSku(sku: string) {
    if (mrpBySku[sku] || bomFgParts.length === 0 || bomLinesAll.length === 0 || bomComponents.length === 0 || weeks.length === 0) return

    const fgPart = bomFgParts.find((p: any) => p.master_sku_ref === sku)
      ?? bomFgParts.find((p: any) => p.master_sku_ref != null)
      ?? bomFgParts[0]
    if (!fgPart) return

    const fgSkuResult = skuResults.find(r => r.sku.sku === fgPart.master_sku_ref)
      ?? skuResults.find(r => r.sku.sku === sku)
    const fgDemandMap = new Map<string, number>()
    if (fgSkuResult) {
      fgSkuResult.weeks.forEach(w => fgDemandMap.set(w.wkLabel, w.forecastQty))
    }

    const mrp = computeMRP({
      fgPartNumber: fgPart.part_number,
      bomLines: bomLinesAll,
      components: bomComponents,
      fgWeeklyDemand: fgDemandMap,
      weeks,
      currentWkLabel: CURRENT_WK,
      componentSupplyCommits: bomComponentCommits,
      componentSupplyUncommits: bomComponentUncommits,
    })
    setMrpBySku(prev => ({ ...prev, [sku]: mrp }))
    setFgPartBySku(prev => ({ ...prev, [sku]: fgPart.part_number }))
  }

  function toggleExpand(sku: string) {
    setExpandedSku(prev => {
      const next = prev === sku ? null : sku
      if (next) ensureMrpForSku(next)
      return next
    })
  }

  function getAlertMessage(s: SkuSdResult) {
    const bo = s.backorderQty > 0 ? ` Backorder: ${s.backorderQty.toLocaleString()} units pending.` : ''
    if (s.flag === 'STOCKOUT')   return `${s.sku.sku} — stock depleted. WoC: ${s.weeksOfCover} wks.${bo} Raise a PO immediately.`
    if (s.flag === 'RELEASE_PO') return `${s.sku.sku} — stockout at ${s.stockoutWk ?? '—'} (within LT ${s.sku.leadTimeWk} wks).${bo} Release PO by ${s.plannedPoReleaseDateWk ?? '—'} · MOQ: ${s.sku.moq.toLocaleString()} ${s.sku.uom}.`
    if (s.flag === 'PLAN_PO')    return `${s.sku.sku} — stockout at ${s.stockoutWk ?? '—'} (beyond LT window).${bo} Plan PO by ${s.plannedPoReleaseDateWk ?? '—'}.`
    return `${s.sku.sku} — healthy. WoC: ${s.weeksOfCover} wks.`
  }

  const alertStyle: Record<string, React.CSSProperties> = {
    STOCKOUT:   { background: '#FAEAEA', border: '1px solid #F5C6C4', color: '#C5453F' },
    RELEASE_PO: { background: '#FEF3E2', border: '1px solid #F9DEB8', color: '#E8A33D' },
    PLAN_PO:    { background: '#FEF3E2', border: '1px solid #F9DEB8', color: '#E8A33D' },
    OK:         { background: '#DCEAE8', border: '1px solid #DCEAE8', color: '#0E5C56' },
  }

  const sortedSkus = useMemo(() =>
    [...skuResults].sort((a, b) => (a.sku.description || '').localeCompare(b.sku.description || '')),
    [skuResults])

  const filteredSkus = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sortedSkus
    return sortedSkus.filter(r =>
      r.sku.sku.toLowerCase().includes(q) ||
      (r.sku.description || '').toLowerCase().includes(q)
    )
  }, [sortedSkus, searchQuery])

  const flaggedCount = skuResults.filter(s => s.flag !== 'OK').length

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE' }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name}
        userRole={profile?.role} brands={brands} activeBrand={brand} />
      <div className="flex-1 flex flex-col overflow-hidden">

        <div className="bg-white px-6 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid #E4DDD3' }}>
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>Supply & Demand</h1>
            <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: '#DCEAE8', color: '#0E5C56', border: '1px solid #DCEAE8' }}>{brand}</span>
            <span className="text-xs px-2.5 py-1 rounded-full" style={{ background: '#E4DDD3', color: '#4B5563' }}>{CURRENT_WK}</span>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-xs flex items-center gap-1.5" style={{ color: '#4B5563' }}>
                <span
                  title={liveSkus.live > 0
                    ? `${liveSkus.live} of ${liveSkus.total} SKUs on live WMS data`
                    : 'All SKUs from the last Excel upload'}
                  style={{
                    width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                    background: liveSkus.live > 0 ? '#2F9E68' : '#B8A888',
                  }}
                />
                Inventory: {lastUpdated}
                {liveSkus.total > 0 && (
                  <span style={{ color: '#8A8578' }}>· {liveSkus.live}/{liveSkus.total} live</span>
                )}
              </span>
            )}
            <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E4DDD3] rounded-lg hover:bg-[#F4F2EE]" style={{ color: '#4B5563' }}>
              <Download size={12} /> Export
            </button>
            <button onClick={loadAll} className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E4DDD3] rounded-lg hover:bg-[#F4F2EE]" style={{ color: '#4B5563' }}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-sm" style={{ color: '#4B5563' }}>Loading S&D data...</div>
          ) : sortedSkus.length === 0 ? (
            <div className="text-sm text-center py-8" style={{ color: '#4B5563' }}>No SKU data found for {brand}</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>All SKUs — Weekly Supply & Demand</h2>
                  <p className="text-xs mt-0.5" style={{ color: '#4B5563' }}>
                    Rolling 52 weeks from {CURRENT_WK} · {sortedSkus.length} SKUs · scroll to review each, expand "BOM &amp; History" for component-level detail
                  </p>
                </div>
                {flaggedCount > 0 && (
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: '#FEF3E2', color: '#E8A33D', border: '1px solid #F9DEB8' }}>
                    {flaggedCount} SKU{flaggedCount > 1 ? 's' : ''} need attention
                  </span>
                )}
              </div>

              <div>
                <div className="relative max-w-md">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search SKU code or product description"
                    className="w-full text-xs rounded-lg pl-8 pr-8 py-2 focus:outline-none"
                    style={{ border: '1px solid #E4DDD3', color: '#1F2937', background: '#FFFFFF' }}
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2"
                      style={{ color: '#9CA3AF' }}
                      aria-label="Clear search"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {searchQuery && (
                  <p className="text-xs mt-1.5" style={{ color: '#4B5563' }}>
                    Matching {filteredSkus.length} of {sortedSkus.length} SKUs
                  </p>
                )}
              </div>

              {filteredSkus.length === 0 ? (
                <div className="text-sm text-center py-8" style={{ color: '#4B5563' }}>No SKUs match "{searchQuery}"</div>
              ) : filteredSkus.map(result => (
                <SkuCard
                  key={result.sku.sku}
                  result={result}
                  weeks={weeks}
                  currentWk={CURRENT_WK}
                  expanded={expandedSku === result.sku.sku}
                  onToggle={() => toggleExpand(result.sku.sku)}
                  mrpResults={mrpBySku[result.sku.sku] ?? []}
                  fgPartNumber={fgPartBySku[result.sku.sku] ?? ''}
                  alertStyle={alertStyle}
                  getAlertMessage={getAlertMessage}
                  brand={brand}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Single SKU card: KPIs + alert + S&D grid always visible, BOM/forecast/
// history collapsed behind a per-SKU expander. ─────────────────────────────
function SkuCard({
  result, weeks, currentWk, expanded, onToggle, mrpResults, fgPartNumber,
  alertStyle, getAlertMessage, brand,
}: {
  result: SkuSdResult
  weeks: WeekInfo[]
  currentWk: string
  expanded: boolean
  onToggle: () => void
  mrpResults: ComponentMrpResult[]
  fgPartNumber: string
  alertStyle: Record<string, React.CSSProperties>
  getAlertMessage: (s: SkuSdResult) => string
  brand: string
}) {
  const flag = FLAG_DISPLAY[result.flag]
  const nextCommit = result.weeks.find(w => w.supplyCommit > 0)
  const hasBackorder = result.backorderQty > 0

  return (
    <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #E4DDD3' }}>
      {/* Header: SKU identity + KPIs */}
      <div className="flex items-center justify-between gap-4 flex-wrap px-5 py-4" style={{ borderBottom: '1px solid #E4DDD3' }}>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-xs font-bold px-2 py-1 rounded flex-shrink-0" style={{ background: '#EEF0F4', color: '#3A4457' }}>{result.sku.sku}</span>
          <span className="text-sm font-semibold truncate">{result.sku.description}</span>
          <span className="text-xs flex-shrink-0" style={{ color: '#98A2B3' }}>
            {result.sku.uom || 'Unit'} · MOQ {(result.sku.moq || 0).toLocaleString()} · LT {result.sku.leadTimeWk || 0} wks
          </span>
          {hasBackorder && (
            <span className="text-xs bg-[#FEF3C7] text-[#92400E] border border-[#FCD34D] px-2 py-0.5 rounded-full font-medium flex-shrink-0">
              Backorder: {result.backorderQty.toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-5 flex-shrink-0">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide" style={{ color: '#98A2B3' }}>On-hand</div>
            <div className="text-sm font-bold">{result.onHand.toLocaleString()}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide" style={{ color: '#98A2B3' }}>WoC</div>
            <div className="text-sm font-bold" style={{ color: result.weeksOfCover < 0 ? '#C5453F' : result.weeksOfCover < 4 ? '#E8A33D' : '#2F9E68' }}>{result.weeksOfCover}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide" style={{ color: '#98A2B3' }}>Next PO</div>
            <div className="text-sm font-bold" style={{ color: nextCommit ? '#1F2937' : '#98A2B3' }}>{nextCommit ? nextCommit.supplyCommit.toLocaleString() : '—'}</div>
          </div>
          <span className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap" style={{ color: flag.color, background: result.flag === 'OK' ? '#DCEAE8' : '#FEF3E2' }}>
            {flag.emoji} {flag.label}
          </span>
        </div>
      </div>

      {/* Inline alert, if any */}
      {result.flag !== 'OK' && (
        <div className="flex items-start justify-between gap-3 px-5 py-2.5 text-xs" style={alertStyle[result.flag]}>
          <p className="leading-relaxed">{getAlertMessage(result)}</p>
          <span className="font-medium whitespace-nowrap cursor-pointer opacity-70 hover:opacity-100">View PO →</span>
        </div>
      )}

      {/* Weekly S&D grid — always visible */}
      <div className="px-5 pt-4 pb-2">
        <SDGrid current={result} weeks={weeks} currentWk={currentWk} />
      </div>

      {/* Expand: BOM component orders + demand forecast + sales history */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-5 py-2.5 text-xs font-medium hover:bg-[#F9FAFB] transition-colors"
        style={{ borderTop: '1px solid #E4DDD3', color: '#4B5563' }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        BOM & History
        <span className="text-[10px] font-normal" style={{ color: '#98A2B3' }}>
          — demand forecast chart, sales history, BOM component orders
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-5" style={{ borderTop: '1px solid #E4DDD3', background: '#FCFBF8' }}>
          <div className="pt-4">
            <ForecastChart
              selectedSku={result.sku.sku}
              skuResult={result}
              brand={brand}
            />
          </div>
          {mrpResults.length > 0 && weeks.length > 0 ? (
            <ComponentSD
              results={mrpResults}
              weeks={weeks}
              currentWk={currentWk}
              fgSku={result.sku.sku}
              fgDescription={result.sku.description || ''}
            />
          ) : (
            <div className="bg-white rounded-xl p-5 mt-4 text-xs" style={{ border: '1px solid #E4DDD3', color: '#98A2B3' }}>
              {fgPartNumber ? 'Loading BOM component orders...' : `No BOM components found for ${result.sku.sku}. Add BOM lines in PLM to enable MRP.`}
            </div>
          )
        }
        </div>
      )}
    </div>
  )
}
