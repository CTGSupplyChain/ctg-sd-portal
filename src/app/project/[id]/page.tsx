'use client'
import React, { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import SDTable from '@/components/sd/SDTable'
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
import { RefreshCw, Download } from 'lucide-react'

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
  const [selectedSku, setSelectedSku] = useState<string>('')
  const [mrpResults, setMrpResults] = useState<ComponentMrpResult[]>([])
  const [fgPartNumber, setFgPartNumber] = useState<string>('')
  const [bomFgParts, setBomFgParts] = useState<any[]>([])
  const [bomLinesAll, setBomLinesAll] = useState<any[]>([])
  const [bomComponents, setBomComponents] = useState<ComponentMaster[]>([])

  useEffect(() => {
    sessionStorage.setItem('ctg_last_brand', brand)
    loadAll()
  }, [brand])

  async function loadAll() {
    setLoading(true)
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

    const { data: stockData } = await supabase
      .from('wms_inventory_snapshots').select('sku, atp, snapshot_date')
      .in('sku', skuData?.map((s: any) => s.sku) || []).order('snapshot_date', { ascending: false })

    const latestStock: Record<string, number> = {}
    const stockDates: string[] = []
    stockData?.forEach((s: any) => {
      if (!latestStock[s.sku]) { latestStock[s.sku] = s.atp; stockDates.push(s.snapshot_date) }
    })
    if (stockDates[0]) setLastUpdated(stockDates[0])

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
      }
      const skuSupply = supplyData?.filter((s: any) => s.sku === skuRaw.sku) || []
      const commits: Record<string, number> = {}
      const uncommits: Record<string, number> = {}
      const wkLabels = new Set(wkList.map(w => w.label))
      skuSupply.forEach((s: any) => {
        const wk = (s.receipt_wk && wkLabels.has(s.receipt_wk)) ? s.receipt_wk : CURRENT_WK,
        if (s.commit_status === 'Commit') commits[wk] = (commits[wk] || 0) + s.qty
        else uncommits[wk] = (uncommits[wk] || 0) + s.qty
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
    if (results.length > 0) setSelectedSku(results[0].sku.sku)

    // ── BOM MRP raw data (recomputed per selected SKU in a separate effect below) ──
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

      setBomFgParts(fgParts || [])
      setBomLinesAll(bomLines)
      setBomComponents(components)
    }

    setLoading(false)
  }

  // Recompute BOM/MRP explosion whenever the selected SKU changes (or the
  // underlying raw BOM data finishes loading). Previously this only ran once
  // on initial load, keyed off the first SKU in the list — so the "BOM
  // Component Orders" widget showed stale components/qty for every other SKU.
  useEffect(() => {
    if (!selectedSku || weeks.length === 0 || bomFgParts.length === 0 || bomLinesAll.length === 0 || bomComponents.length === 0) return

    const fgPart = bomFgParts.find((p: any) => p.master_sku_ref === selectedSku)
      ?? bomFgParts.find((p: any) => p.master_sku_ref != null)
      ?? bomFgParts[0]
    if (!fgPart) return

    setFgPartNumber(fgPart.part_number)

    const fgSkuResult = skuResults.find(r => r.sku.sku === fgPart.master_sku_ref)
      ?? skuResults.find(r => r.sku.sku === selectedSku)
      ?? skuResults[0]
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
    })
    setMrpResults(mrp)
  }, [selectedSku, bomFgParts, bomLinesAll, bomComponents, weeks, skuResults])

  const currentSkuResult = skuResults.find(s => s.sku.sku === selectedSku) || skuResults[0]
  const flag = currentSkuResult ? FLAG_DISPLAY[currentSkuResult.flag] : null
  const nextCommit = currentSkuResult?.weeks.find(w => w.supplyCommit > 0)

  function getAlertMessage(s: SkuSdResult) {
    const bo = s.backorderQty > 0 ? ` Backorder: ${s.backorderQty.toLocaleString()} units pending.` : ''
    if (s.flag === 'STOCKOUT')   return `${s.sku.sku} — stock depleted. WoC: ${s.weeksOfCover} wks.${bo} Raise a PO immediately.`
    if (s.flag === 'RELEASE_PO') return `${s.sku.sku} — stockout at ${s.stockoutWk ?? '—'} (within LT ${s.sku.leadTimeWk} wks).${bo} Release PO by ${s.plannedPoReleaseDateWk ?? '—'} · MOQ: ${s.sku.moq.toLocaleString()} ${s.sku.uom}.`
    if (s.flag === 'PLAN_PO')    return `${s.sku.sku} — stockout at ${s.stockoutWk ?? '—'} (beyond LT window).${bo} Plan PO by ${s.plannedPoReleaseDateWk ?? '—'}.`
    return `${s.sku.sku} — healthy. WoC: ${s.weeksOfCover} wks.`
  }

  const alertBg: Record<string, string> = {
    STOCKOUT:   '',
    RELEASE_PO: '',
    PLAN_PO:    '',
    OK:         '',
  }
  const alertStyle: Record<string, React.CSSProperties> = {
    STOCKOUT:   { background: '#FAEAEA', border: '1px solid #F5C6C4', color: '#C5453F' },
    RELEASE_PO: { background: '#FEF3E2', border: '1px solid #F9DEB8', color: '#E8A33D' },
    PLAN_PO:    { background: '#FEF3E2', border: '1px solid #F9DEB8', color: '#E8A33D' },
    OK:         { background: '#DCEAE8', border: '1px solid #DCEAE8', color: '#0E5C56' },
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE' }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name}
        userRole={profile?.role} brands={brands} activeBrand={brand} />
      <div className="flex-1 flex flex-col overflow-hidden">

        <div className="bg-white px-6 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid #E4DDD3' }}>
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>Supply & Demand</h1>
            <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: '#DCEAE8', color: '#0E5C56', border: '1px solid #DCEAE8' }}>{brand}</span>
            <span className="text-xs px-2.5 py-1 rounded-full" style={{ background: '#E4DDD3', color: '#4B5563' }}>{CURRENT_WK} 2026</span>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && <span className="text-xs" style={{ color: '#4B5563' }}>Inventory: {lastUpdated}</span>}
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
          ) : (
            <>
              {currentSkuResult && flag && (
                <div className="grid grid-cols-4 gap-4">
                  <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                    <div className="text-xs mb-1" style={{ color: '#4B5563' }}>On-Hand ({currentSkuResult.sku.sku})</div>
                    <div className="text-2xl font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>{currentSkuResult.onHand.toLocaleString()}</div>
                    <div className="text-xs mt-1" style={{ color: '#4B5563' }}>units in stock</div>
                  </div>
                  <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                    <div className="text-xs mb-1" style={{ color: '#4B5563' }}>Weeks of Cover</div>
                    <div className="text-2xl font-semibold" style={{
                      color: currentSkuResult.weeksOfCover < 0 ? '#C5453F' : currentSkuResult.weeksOfCover < 4 ? '#E8A33D' : '#2F9E68',
                      fontFamily: 'Cambria, Georgia, serif'
                    }}>{currentSkuResult.weeksOfCover}</div>
                    <div className="text-xs mt-1" style={{ color: '#4B5563' }}>Target: ≥ 8 wks</div>
                  </div>
                  <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                    <div className="text-xs mb-1" style={{ color: '#4B5563' }}>Next PO (Commit)</div>
                    <div className="text-2xl font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>
                      {nextCommit ? nextCommit.supplyCommit.toLocaleString() : '—'}
                    </div>
                    <div className="text-xs mt-1" style={{ color: '#4B5563' }}>
                      {nextCommit ? `ETA: ${nextCommit.wkLabel}` : 'No open PO'}
                    </div>
                  </div>
                  <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                    <div className="text-xs mb-1" style={{ color: '#4B5563' }}>Status</div>
                    <div className="text-lg font-semibold flex items-center gap-1.5 mt-1" style={{ color: flag.color, fontFamily: 'Cambria, Georgia, serif' }}>
                      <span>{flag.emoji}</span><span>{flag.label}</span>
                    </div>
                    <div className="text-xs mt-1" style={{ color: '#4B5563' }}>
                      {currentSkuResult.flag === 'RELEASE_PO' && `Release by ${currentSkuResult.plannedPoReleaseDateWk ?? '—'}`}
                      {currentSkuResult.flag === 'PLAN_PO' && `Plan by ${currentSkuResult.plannedPoReleaseDateWk ?? '—'}`}
                      {currentSkuResult.flag === 'STOCKOUT' && 'Urgent action required'}
                      {currentSkuResult.flag === 'OK' && 'No action needed'}
                    </div>
                  </div>
                </div>
              )}

              {currentSkuResult && currentSkuResult.flag !== 'OK' && (
                <div className="flex items-start justify-between gap-3 px-4 py-3 rounded-xl text-sm" style={alertStyle[currentSkuResult.flag]}>
                  <p className="text-sm leading-relaxed">{getAlertMessage(currentSkuResult)}</p>
                  <span className="text-xs font-medium whitespace-nowrap cursor-pointer opacity-70 hover:opacity-100">View PO →</span>
                </div>
              )}

              <div className="bg-white rounded-xl p-5" style={{ border: '1px solid #E4DDD3' }}>
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>Weekly Supply & Demand</h2>
                  <span className="text-xs" style={{ color: '#4B5563' }}>Rolling 52 weeks from {CURRENT_WK}</span>
                </div>
                {skuResults.length > 0 && weeks.length > 0
                  ? <SDTable skus={skuResults} weeks={weeks} currentWk={CURRENT_WK} selectedSku={selectedSku} onSkuChange={setSelectedSku} />
                  : <div className="text-sm text-center py-8" style={{ color: '#4B5563' }}>No SKU data found for {brand}</div>}
              </div>

              {skuResults.length > 0 && (
                <ForecastChart
                  selectedSku={selectedSku}
                  skuResult={skuResults.find(s => s.sku.sku === selectedSku) ?? null}
                  brand={brand}
                />
              )}

              {mrpResults.length > 0 && weeks.length > 0 && (() => {
                const fgSkuResult = skuResults.find(s => s.sku.sku === selectedSku) || skuResults[0]
                return (
                  <ComponentSD
                    results={mrpResults}
                    weeks={weeks}
                    currentWk={CURRENT_WK}
                    fgSku={fgSkuResult?.sku.sku ?? fgPartNumber}
                    fgDescription={fgSkuResult?.sku.description ?? ''}
                  />
                )
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
