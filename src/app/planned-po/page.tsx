'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import { computeSD, FLAG_DISPLAY } from '@/lib/sd-compute'
import type { SkuSdResult, WeekInfo } from '@/lib/sd-compute'
import { computeMRP } from '@/lib/bom-mrp'
import type { ComponentMaster, BomLine } from '@/lib/bom-mrp'
import { loadDemandForecast } from '@/lib/forecasting/forecast-lookup'
import { Download, RefreshCw, AlertTriangle, Clock } from 'lucide-react'

// ── helpers ───────────────────────────────────────────────────────────────────

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

// ── types ─────────────────────────────────────────────────────────────────────

// Unified row shape — both FG-level (SKU) and component-level (RM/PK/SA/WIP)
// planned orders render in the same table so procurement has one queue to work.
type Bucket = 'RELEASE_PO' | 'PLAN_PO'
type Level = 'FG' | 'RM' | 'PK' | 'SA' | 'WIP'

interface UnifiedPlannedRow {
  level: Level
  brand: string
  code: string              // SKU or component part number
  description: string
  uom: string
  leadTimeWk: number | null
  onHandQty: number | null
  woc: number | null        // FG only
  stockoutWk: string | null // FG only
  releaseByWk: string       // '—' if unknown
  releaseDateLabel: string  // '—' if unknown
  orderQty: number
  bucket: Bucket
  badgeLabel: string        // e.g. STOCKOUT / RELEASE PO / PLAN PO / OVERDUE / URGENT / PLAN / SET LT
  badgeColor: string
  note: string
}

const LEVEL_COLORS: Record<Level, { bg: string; text: string }> = {
  FG:  { bg: '#DCEAE8', text: '#0E5C56' },
  PK:  { bg: '#E0ECFC', text: '#1849A9' },
  SA:  { bg: '#EFE5FB', text: '#6B3FA0' },
  RM:  { bg: '#FCEBD9', text: '#B75E13' },
  WIP: { bg: '#FDF3C7', text: '#8A6D1D' },
}

// ── component ─────────────────────────────────────────────────────────────────

export default function PlannedPoPage() {
  const supabase = createClient()

  const [profile, setProfile] = useState<any>(null)
  const [brands, setBrands] = useState<string[]>([])
  const [rows, setRows] = useState<UnifiedPlannedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filterFlag, setFilterFlag] = useState<'ALL' | 'RELEASE_PO' | 'PLAN_PO'>('ALL')
  const [filterLevel, setFilterLevel] = useState<'ALL' | 'FG' | 'COMPONENT'>('ALL')
  const [snapshotDate, setSnapshotDate] = useState('')

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)

    // ── 1. Determine accessible brands ────────────────────────────────────────
    const isAdmin = prof?.role === 'admin' || prof?.role === 'supply_chain'
    let accessibleBrands: string[] = []
    if (isAdmin) {
      const { data: allSkus } = await supabase.from('master_sku').select('brand').neq('brand', '')
      accessibleBrands = [...new Set(allSkus?.map((s: any) => s.brand) || [])] as string[]
    } else {
      const { data: access } = await supabase.from('user_brand_access').select('brand').eq('user_id', user.id)
      accessibleBrands = access?.map((a: any) => a.brand) || []
    }
    setBrands(accessibleBrands.sort((a, b) => a.localeCompare(b)))

    // ── 2. Week calendar ──────────────────────────────────────────────────────
    const { data: wkData } = await supabase
      .from('week_calendar').select('*').gte('monday_date', CURRENT_MONDAY).order('monday_date').limit(52)

    const wkList: WeekInfo[] = (wkData || []).map((w: any) => ({
      label: w.wk_label, year: w.year, month: w.month, monthLabel: w.month_label,
      wkInYear: w.wk_in_year, wkInMonth: w.wk_in_month, mondayDate: w.monday_date, weeksInMonth: w.weeks_in_month,
    }))
    const wkByLabel: Record<string, WeekInfo> = {}
    wkList.forEach(w => { wkByLabel[w.label] = w })
    if (wkList.length > 0) CURRENT_WK = wkList[0].label

    // ── 3. Batch-load all active SKUs ─────────────────────────────────────────
    const { data: allSkuData } = await supabase
      .from('master_sku').select('*')
      .in('brand', accessibleBrands)
      .eq('status', 'Active')

    const allSkus = allSkuData || []
    const allSkuIds = allSkus.map((s: any) => s.sku)

    // ── 4. Batch-load stock, supply, history ──────────────────────────────────
    const [
      { data: stockData },
      { data: supplyData },
      { data: histData },
    ] = await Promise.all([
      supabase.from('wms_inventory_snapshots').select('sku, atp, snapshot_date')
        .in('sku', allSkuIds).order('snapshot_date', { ascending: false }),
      supabase.from('purchase_orders').select('*').in('sku', allSkuIds).eq('status', 'Open'),
      supabase.from('historical_demand').select('sku, qty')
        .in('sku', allSkuIds).gte('iso_year', 2026).lte('iso_week', 17).gte('iso_week', 5),
    ])

    // Latest on-hand per SKU
    const latestStock: Record<string, number> = {}
    const stockDates: string[] = []
    stockData?.forEach((s: any) => {
      if (!latestStock[s.sku]) { latestStock[s.sku] = s.atp; stockDates.push(s.snapshot_date) }
    })
    if (stockDates[0]) setSnapshotDate(stockDates[0])

    // Historical avg per SKU
    const histBySku: Record<string, number[]> = {}
    histData?.forEach((h: any) => {
      if (!histBySku[h.sku]) histBySku[h.sku] = []
      histBySku[h.sku].push(h.qty)
    })
    const histAvg: Record<string, number> = {}
    Object.entries(histBySku).forEach(([sku, qtys]) => {
      histAvg[sku] = qtys.reduce((a, b) => a + b, 0) / qtys.length
    })

    // Supply commits/uncommits per SKU
    const commitsBySku: Record<string, Record<string, number>> = {}
    const uncommitsBySku: Record<string, Record<string, number>> = {}
    supplyData?.forEach((s: any) => {
      if (s.commit_status === 'Commit') {
        if (!commitsBySku[s.sku]) commitsBySku[s.sku] = {}
        commitsBySku[s.sku][s.receipt_wk] = (commitsBySku[s.sku][s.receipt_wk] || 0) + s.qty
      } else {
        if (!uncommitsBySku[s.sku]) uncommitsBySku[s.sku] = {}
        uncommitsBySku[s.sku][s.receipt_wk] = (uncommitsBySku[s.sku][s.receipt_wk] || 0) + s.qty
      }
    })

    // ── 5. Load sales forecasts — one per brand (latest per project) ──────────
    const forecastByBrand: Record<string, any> = {}
    const uniqueBrands = [...new Set(allSkus.map((s: any) => s.brand))] as string[]
    await Promise.all(uniqueBrands.map(async (brand) => {
      const { data: proj } = await supabase
        .from('projects').select('id').eq('brand', brand).limit(1).single()
      if (proj?.id) {
        const { data: fcst } = await supabase
          .from('sales_forecast').select('*').eq('project_id', proj.id)
          .order('submitted_at', { ascending: false }).limit(1).single()
        if (fcst) forecastByBrand[brand] = fcst
      }
    }))

    // ── 6. Load statistical demand forecasts ──────────────────────────────────
    const demandForecastMap = await loadDemandForecast(allSkuIds)

    // ── 7. Compute SD for every SKU — keep every result (not just actionable) so
    //       component MRP below can look up FG weekly demand regardless of the
    //       FG's own flag ──────────────────────────────────────────────────────
    const unifiedRows: UnifiedPlannedRow[] = []
    const skuResultBySku = new Map<string, SkuSdResult>()

    for (const skuRaw of allSkus) {
      const sku = {
        sku: skuRaw.sku, description: skuRaw.description, brand: skuRaw.brand,
        moq: skuRaw.moq, uom: skuRaw.uom, leadTimeWk: skuRaw.lead_time_wk,
        avgSellingPrice: skuRaw.avg_selling_price, safetyStock: skuRaw.safety_stock,
        bufferStock: skuRaw.buffer_stock, status: skuRaw.status,
      }

      const result: SkuSdResult = computeSD({
        sku,
        onHand: latestStock[skuRaw.sku] || 0,
        backorderQty: skuRaw.backorder_qty || 0,
        weeks: wkList,
        forecast: forecastByBrand[skuRaw.brand] || null,
        historicalAvg: histAvg[skuRaw.sku] || 0,
        demandForecast: demandForecastMap.get(skuRaw.sku) ?? null,
        supplyCommits: commitsBySku[skuRaw.sku] || {},
        supplyUncommits: uncommitsBySku[skuRaw.sku] || {},
        currentWk: CURRENT_WK,
        thresholdOrderNow: 4,
        thresholdMonitor: 8,
      })

      skuResultBySku.set(skuRaw.sku, result)

      if (result.flag !== 'RELEASE_PO' && result.flag !== 'PLAN_PO') continue

      const releaseWkInfo = result.plannedPoReleaseDateWk ? wkByLabel[result.plannedPoReleaseDateWk] : null
      const releaseDateLabel = releaseWkInfo?.mondayDate ?? '—'

      const avgWklyDemand = result.weeks.slice(0, 4).reduce((a, w) => a + w.forecastQty, 0) / 4 || 0
      const moqCoverWks = avgWklyDemand > 0 ? Math.round(skuRaw.moq / avgWklyDemand) : null
      const note = [
        `MOQ (${skuRaw.moq.toLocaleString()} ${skuRaw.uom}) covers ~${moqCoverWks ?? '?'} wks at current demand.`,
        `Safety stock buffer: TBD.`,
      ].join(' ')

      const badge = FLAG_DISPLAY[result.flag]
      unifiedRows.push({
        level: 'FG',
        brand: skuRaw.brand,
        code: skuRaw.sku,
        description: skuRaw.description,
        uom: skuRaw.uom,
        leadTimeWk: skuRaw.lead_time_wk,
        onHandQty: latestStock[skuRaw.sku] ?? null,
        woc: result.weeksOfCover,
        stockoutWk: result.stockoutWk ?? '—',
        releaseByWk: result.plannedPoReleaseDateWk ?? '—',
        releaseDateLabel,
        orderQty: skuRaw.moq,
        bucket: 'RELEASE_PO',
        badgeLabel: badge.label,
        badgeColor: badge.color,
        note,
      })
    }

    // ── 8. Component-level (BOM) planned orders across accessible brands ─────
    if (accessibleBrands.length > 0) {
      const { data: projectRows } = await supabase
        .from('projects').select('id, brand').in('brand', accessibleBrands)
      const projectIds = (projectRows || []).map((p: any) => p.id)
      const brandByProjectId = new Map((projectRows || []).map((p: any) => [p.id, p.brand]))

      if (projectIds.length > 0) {
        const { data: fgParts } = await supabase
          .from('parts')
          .select('part_number, description, master_sku_ref, project_id')
          .in('project_id', projectIds)
          .eq('category', 'FG')

        const { data: bomData } = await supabase
          .from('bom_lines')
          .select('id, parent_pn, child_pn, bom_level, qty_per, uom, child:parts!bom_lines_child_pn_fkey(part_number, description, category, uom, on_hand_qty)')
          .eq('is_active', true)

        const { data: projectParts } = await supabase
          .from('parts').select('part_number').in('project_id', projectIds)

        const projectPns = new Set(projectParts?.map((p: any) => p.part_number) || [])
        ;(fgParts || []).forEach((p: any) => projectPns.add(p.part_number))

        const bomLines: BomLine[] = (bomData || [])
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

        const compPns = [...new Set(bomLines.map(b => b.partNumber))]

        const { data: psData } = compPns.length > 0
          ? await supabase.from('part_supplier')
              .select('part_number, moq, spq, lead_time_wk, supplier_id')
              .in('part_number', compPns).eq('is_preferred', true)
          : { data: [] as any[] }

        const supIds = [...new Set((psData || []).map((ps: any) => ps.supplier_id).filter(Boolean))]
        const { data: supData } = supIds.length > 0
          ? await supabase.from('plm_suppliers').select('id, name').in('id', supIds)
          : { data: [] as any[] }

        const supNameMap = new Map((supData || []).map((s: any) => [s.id, s.name]))
        const psMap = new Map((psData || []).map((ps: any) => [ps.part_number, ps]))

        const { data: partsData } = compPns.length > 0
          ? await supabase.from('parts')
              .select('part_number, description, category, uom, on_hand_qty')
              .in('part_number', compPns)
          : { data: [] as any[] }

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

        // Real component PO supply (Supply Commit/Uncommit) — same convention
        // as the project page, keyed by part_number then receipt week.
        const { data: componentSupplyData } = compPns.length > 0
          ? await supabase.from('purchase_orders')
              .select('part_number, qty, receipt_wk, commit_status')
              .in('part_number', compPns).eq('status', 'Open')
          : { data: [] as any[] }

        const wkLabelSet = new Set(wkList.map(w => w.label))
        const componentCommits: Record<string, Record<string, number>> = {}
        const componentUncommits: Record<string, Record<string, number>> = {}
        ;(componentSupplyData || []).forEach((s: any) => {
          if (!s.part_number) return
          const wk = (s.receipt_wk && wkLabelSet.has(s.receipt_wk)) ? s.receipt_wk : CURRENT_WK
          const target = s.commit_status === 'Commit' ? componentCommits : componentUncommits
          if (!target[s.part_number]) target[s.part_number] = {}
          target[s.part_number][wk] = (target[s.part_number][wk] || 0) + (s.qty || 0)
        })

        // Aggregate across FG parts — a shared component (e.g. common cap/bottle)
        // used by multiple FGs is netted per-FG (each MRP run starts from full
        // on-hand), so totals here are additive across FGs, not cross-netted.
        // Directionally useful for procurement; not a substitute for a full
        // multi-FG netting run.
        const componentAgg = new Map<string, {
          comp: ComponentMaster
          brand: string
          orderQty: number
          earliestWk: string | null
          earliestFlag: 'OVERDUE' | 'URGENT' | 'PLAN' | 'OK' | null
        }>()

        for (const fgPart of (fgParts || [])) {
          if (!fgPart.master_sku_ref) continue
          const fgResult = skuResultBySku.get(fgPart.master_sku_ref)
          if (!fgResult) continue

          const fgDemandMap = new Map<string, number>()
          fgResult.weeks.forEach(w => fgDemandMap.set(w.wkLabel, w.forecastQty))

          const mrp = computeMRP({
            fgPartNumber: fgPart.part_number,
            bomLines,
            components,
            fgWeeklyDemand: fgDemandMap,
            weeks: wkList,
            currentWkLabel: CURRENT_WK,
            componentSupplyCommits: componentCommits,
            componentSupplyUncommits: componentUncommits,
          })

          const brand = brandByProjectId.get(fgPart.project_id) || ''

          for (const compResult of mrp) {
            if (compResult.totalPlannedOrderQty <= 0) continue

            const releaseBatchQty = compResult.earliestPoReleaseWk
              ? compResult.weeks
                  .filter(w => w.poReleaseWk === compResult.earliestPoReleaseWk)
                  .reduce((sum, w) => sum + w.plannedOrderQty, 0)
              : compResult.totalPlannedOrderQty

            const key = `${brand}::${compResult.component.partNumber}`
            const existing = componentAgg.get(key)
            if (!existing) {
              componentAgg.set(key, {
                comp: compResult.component,
                brand,
                orderQty: releaseBatchQty,
                earliestWk: compResult.earliestPoReleaseWk,
                earliestFlag: compResult.earliestPoReleaseFlag,
              })
            } else {
              existing.orderQty += releaseBatchQty
              // Keep the more urgent of the two flags/weeks
              const order = { OVERDUE: 0, URGENT: 1, PLAN: 2, OK: 3 }
              const curRank = existing.earliestFlag ? order[existing.earliestFlag] : 4
              const newRank = compResult.earliestPoReleaseFlag ? order[compResult.earliestPoReleaseFlag] : 4
              if (newRank < curRank) {
                existing.earliestWk = compResult.earliestPoReleaseWk
                existing.earliestFlag = compResult.earliestPoReleaseFlag
              }
            }
          }
        }

        for (const { comp, brand, orderQty, earliestWk, earliestFlag } of componentAgg.values()) {
          const releaseWkInfo = earliestWk ? wkByLabel[earliestWk] : null
          const releaseDateLabel = releaseWkInfo?.mondayDate ?? '—'

          let badgeLabel: string
          let badgeColor: string
          let bucket: Bucket

          if (comp.leadTimeWk == null) {
            badgeLabel = 'SET LT'
            badgeColor = '#E8A33D'
            bucket = 'PLAN_PO'
          } else if (earliestFlag === 'OVERDUE') {
            badgeLabel = 'OVERDUE'; badgeColor = '#C5453F'; bucket = 'RELEASE_PO'
          } else if (earliestFlag === 'URGENT') {
            badgeLabel = 'URGENT'; badgeColor = '#E8A33D'; bucket = 'RELEASE_PO'
          } else {
            badgeLabel = 'PLAN'; badgeColor = '#E8A33D'; bucket = 'PLAN_PO'
          }

          const note = [
            `On-hand: ${comp.onHandQty.toLocaleString()} ${comp.uom}.`,
            comp.supplier ? `Supplier: ${comp.supplier}.` : `No preferred supplier set.`,
            comp.leadTimeWk == null ? `Lead time missing — set in Part Master to compute release date.` : '',
          ].filter(Boolean).join(' ')

          unifiedRows.push({
            level: (comp.category as Level) || 'RM',
            brand,
            code: comp.partNumber,
            description: comp.description,
            uom: comp.uom,
            leadTimeWk: comp.leadTimeWk,
            onHandQty: comp.onHandQty,
            woc: null,
            stockoutWk: null,
            releaseByWk: earliestWk ?? '—',
            releaseDateLabel,
            orderQty,
            bucket,
            badgeLabel,
            badgeColor,
            note,
          })
        }
      }
    }

    // Sort: RELEASE_PO first, then PLAN_PO; within each group by release date asc
    unifiedRows.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket === 'RELEASE_PO' ? -1 : 1
      return a.releaseByWk.localeCompare(b.releaseByWk)
    })

    setRows(unifiedRows)
    setLoading(false)
  }

  // ── CSV export ───────────────────────────────────────────────────────────────

  function exportCsv() {
    const headers = [
      'Priority', 'Level', 'Brand', 'Code', 'Description', 'UOM',
      'LT (wks)', 'On Hand', 'Release By (Week)', 'Release By (Date)', 'Order Qty', 'Note'
    ]
    const csvRows = visibleRows.map(r => [
      r.badgeLabel, r.level, r.brand, r.code, `"${r.description}"`, r.uom,
      r.leadTimeWk ?? '—', r.onHandQty ?? '—', r.releaseByWk, r.releaseDateLabel, r.orderQty, `"${r.note}"`
    ])
    const csv = [headers, ...csvRows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `planned-po-${CURRENT_WK}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── render ────────────────────────────────────────────────────────────────────

  const levelFiltered = filterLevel === 'ALL' ? rows : filterLevel === 'FG' ? rows.filter(r => r.level === 'FG') : rows.filter(r => r.level !== 'FG')
  const visibleRows = filterFlag === 'ALL' ? levelFiltered : levelFiltered.filter(r => r.bucket === filterFlag)
  const releaseCount = levelFiltered.filter(r => r.bucket === 'RELEASE_PO').length
  const planCount = levelFiltered.filter(r => r.bucket === 'PLAN_PO').length
  const fgCount = rows.filter(r => r.level === 'FG').length
  const componentCount = rows.filter(r => r.level !== 'FG').length

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE' }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name}
        userRole={profile?.role} brands={brands} />

      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <div className="bg-white px-6 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid #E4DDD3' }}>
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>Planned PO</h1>
            <span className="text-xs px-2.5 py-1 rounded-full" style={{ background: '#E4DDD3', color: '#4B5563' }}>{CURRENT_WK} 2026</span>
            {snapshotDate && (
              <span className="text-xs" style={{ color: '#4B5563' }}>Inventory: {snapshotDate}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCsv}
              disabled={loading || rows.length === 0}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E4DDD3] rounded-lg hover:bg-[#F4F2EE] disabled:opacity-40" style={{ color: '#4B5563' }}
            >
              <Download size={12} /> Export CSV
            </button>
            <button
              onClick={loadAll}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-[#E4DDD3] rounded-lg hover:bg-[#F4F2EE]" style={{ color: '#4B5563' }}
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-sm" style={{ color: '#4B5563' }}>
              Computing replenishment queue across all SKUs and BOM components...
            </div>
          ) : (
            <>
              {/* KPI strip */}
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                  <div className="text-xs mb-1" style={{ color: '#4B5563' }}>Release PO</div>
                  <div className="text-2xl font-semibold" style={{ color: '#C5453F', fontFamily: 'Cambria, Georgia, serif' }}>{releaseCount}</div>
                  <div className="text-xs mt-1" style={{ color: '#4B5563' }}>Overdue or due within lead time</div>
                </div>
                <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                  <div className="text-xs mb-1" style={{ color: '#4B5563' }}>Plan PO</div>
                  <div className="text-2xl font-semibold" style={{ color: '#E8A33D', fontFamily: 'Cambria, Georgia, serif' }}>{planCount}</div>
                  <div className="text-xs mt-1" style={{ color: '#4B5563' }}>Due beyond lead time — plan ahead</div>
                </div>
                <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                  <div className="text-xs mb-1" style={{ color: '#4B5563' }}>FG SKUs Flagged</div>
                  <div className="text-2xl font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>{fgCount}</div>
                  <div className="text-xs mt-1" style={{ color: '#4B5563' }}>Finished goods needing a PO</div>
                </div>
                <div className="bg-white rounded-xl p-4" style={{ border: '1px solid #E4DDD3' }}>
                  <div className="text-xs mb-1" style={{ color: '#4B5563' }}>Components Flagged</div>
                  <div className="text-2xl font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>{componentCount}</div>
                  <div className="text-xs mt-1" style={{ color: '#4B5563' }}>RM/PK/SA/WIP needing a PO</div>
                </div>
              </div>

              {/* Filter tabs */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {(['ALL', 'RELEASE_PO', 'PLAN_PO'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setFilterFlag(f)}
                      className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                        filterFlag === f
                          ? 'bg-[#1F2937] text-white border-[#1F2937]'
                          : 'bg-white border-[#E4DDD3] hover:bg-[#F4F2EE]'
                      }`}
                    >
                      {f === 'ALL' ? `All (${levelFiltered.length})`
                       : f === 'RELEASE_PO' ? `Release PO (${releaseCount})`
                       : `Plan PO (${planCount})`}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  {(['ALL', 'FG', 'COMPONENT'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setFilterLevel(f)}
                      className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                        filterLevel === f
                          ? 'bg-[#1F2937] text-white border-[#1F2937]'
                          : 'bg-white border-[#E4DDD3] hover:bg-[#F4F2EE]'
                      }`}
                    >
                      {f === 'ALL' ? 'All Levels' : f === 'FG' ? `FG (${fgCount})` : `Components (${componentCount})`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Table */}
              {visibleRows.length === 0 ? (
                <div className="bg-white rounded-xl p-10 text-center text-sm" style={{ border: '1px solid #E4DDD3', color: '#4B5563' }}>
                  No replenishment actions required.
                </div>
              ) : (
                <div className="bg-white rounded-xl overflow-hidden" style={{ border: '1px solid #E4DDD3' }}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ background: '#F4F2EE', borderBottom: '1px solid #E4DDD3' }}>
                        <th className="text-left px-4 py-3 font-medium w-24" style={{ color: '#4B5563' }}>Priority</th>
                        <th className="text-left px-4 py-3 font-medium w-16" style={{ color: '#4B5563' }}>Level</th>
                        <th className="text-left px-4 py-3 font-medium" style={{ color: '#4B5563' }}>Brand</th>
                        <th className="text-left px-4 py-3 font-medium" style={{ color: '#4B5563' }}>Code</th>
                        <th className="text-left px-4 py-3 font-medium max-w-[200px]" style={{ color: '#4B5563' }}>Description</th>
                        <th className="text-center px-4 py-3 font-medium" style={{ color: '#4B5563' }}>LT (wks)</th>
                        <th className="text-center px-4 py-3 font-medium" style={{ color: '#4B5563' }}>On Hand</th>
                        <th className="text-center px-4 py-3 font-medium" style={{ color: '#4B5563' }}>Release By</th>
                        <th className="text-right px-4 py-3 font-medium" style={{ color: '#4B5563' }}>Order Qty</th>
                        <th className="text-left px-4 py-3 font-medium w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E4DDD3]">
                      {visibleRows.map((row, i) => {
                        const lvlColor = LEVEL_COLORS[row.level] || LEVEL_COLORS.RM
                        return (
                        <tr key={`${row.level}-${row.code}-${i}`} className="hover:bg-[#F4F2EE] transition-colors">

                          {/* Priority badge */}
                          <td className="px-4 py-3">
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium text-[11px]"
                              style={{
                                background: row.bucket === 'RELEASE_PO' ? '#FAEAEA' : '#FEF3E2',
                                color: row.badgeColor,
                                border: `1px solid ${row.bucket === 'RELEASE_PO' ? '#F5C6C4' : '#F9DEB8'}`,
                              }}
                            >
                              {row.bucket === 'RELEASE_PO' ? <AlertTriangle size={10} /> : <Clock size={10} />}
                              {row.badgeLabel}
                            </span>
                          </td>

                          {/* Level badge */}
                          <td className="px-4 py-3">
                            <span
                              className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={{ background: lvlColor.bg, color: lvlColor.text }}
                            >
                              {row.level}
                            </span>
                          </td>

                          <td className="px-4 py-3 font-medium" style={{ color: '#1F2937' }}>{row.brand}</td>
                          <td className="px-4 py-3 font-mono font-medium" style={{ color: '#1F2937' }}>{row.code}</td>
                          <td className="px-4 py-3 max-w-[200px] truncate" style={{ color: '#4B5563' }} title={row.description}>
                            {row.description}
                          </td>

                          {/* LT */}
                          <td className="px-4 py-3 text-center" style={{ color: row.leadTimeWk == null ? '#E8A33D' : '#1F2937' }}>
                            {row.leadTimeWk ?? '—'}
                          </td>

                          {/* On hand */}
                          <td className="px-4 py-3 text-center" style={{ color: '#1F2937' }}>
                            {row.onHandQty != null ? row.onHandQty.toLocaleString() : '—'}
                          </td>

                          {/* Release by — flag overdue in red */}
                          <td className="px-4 py-3 text-center">
                            <span style={{
                              fontWeight: 500,
                              color: row.releaseByWk !== '—' && row.releaseByWk <= CURRENT_WK ? '#C5453F' : '#1F2937'
                            }}>
                              {row.releaseByWk}
                            </span>
                            {row.releaseDateLabel !== '—' && (
                              <div className="text-[10px]" style={{ color: '#4B5563' }}>{row.releaseDateLabel}</div>
                            )}
                          </td>

                          {/* Order qty */}
                          <td className="px-4 py-3 text-right font-medium" style={{ color: '#1F2937' }}>
                            {row.orderQty.toLocaleString()}
                            <span className="font-normal ml-1" style={{ color: '#4B5563' }}>{row.uom}</span>
                          </td>

                          {/* Note tooltip */}
                          <td className="px-4 py-3 text-center">
                            <span
                              title={row.note}
                              className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium cursor-help"
                              style={{ background: '#E4DDD3', color: '#4B5563' }}
                            >
                              ?
                            </span>
                          </td>

                        </tr>
                      )})}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
