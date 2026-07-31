'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import { useRouter } from 'next/navigation'

// ── constants ────────────────────────────────────────────────────────────────
// Order-window buffer and excess line are fixed constants, not UI controls —
// user removed them as user-facing knobs on 31 Jul 2026.
const BUF = 4
const EXC = 26

// A SKU is treated as sub if it appears as a component of an active BOM, or if
// its description matches an accessory/packaging/sample pattern. Everything
// else is main. Ported verbatim from inventory-health-dashboard-v1.html.
const SUB_PATTERN = /(box sleeve|shipping box|brochure|angpow|playing card|cosmetic pouch|towel|comb|shaker|sample|deluxe|eye mask|box display|basket ball|silk square|candle|massaging rod)/i

const BANDS = [
  { k: 'stockout', l: 'Stocked out', c: '#2E2A24', d: 'zero usable stock with live demand' },
  { k: 'critical', l: 'Critical', c: '#C0392B', d: 'runs out inside the lead time — cannot be fixed by ordering' },
  { k: 'risk', l: 'At risk', c: '#D9A13B', d: 'runs out inside lead time + order window' },
  { k: 'healthy', l: 'Healthy', c: '#1D9E75', d: 'covered beyond the order window, below the excess line' },
  { k: 'excess', l: 'Excess', c: '#2C6E9B', d: 'cover above the excess threshold' },
  { k: 'nosignal', l: 'No demand signal', c: '#8A8578', d: 'no forecast rows — cannot be scored' },
] as const
type Band = typeof BANDS[number]['k']
const BM: Record<string, typeof BANDS[number]> = {}
BANDS.forEach(b => { BM[b.k] = b })
const URG: Record<string, number> = { stockout: 0, critical: 1, risk: 2, nosignal: 3, excess: 4, healthy: 5 }

// ── types ────────────────────────────────────────────────────────────────────

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

interface SkuComputed {
  sku: string
  desc: string
  proj: string
  moq: number
  lt: number
  usable: number
  incoming: number
  unusable: number
  reserved: number
  hasExpiry: boolean
  stockSrc: 'L' | 'S'
  demandSource: string
  fc: number[]
  nwk: number
  avgWk: number
  dmdTot: number
  hasSignal: boolean
  runout: number | null
  runoutIn: number | null
  woc: number | null
  wocIn: number | null
  inbound: number
  poNext: string | null
  poLate: number
  band: Band
  action: string
  flags: string[]
  cls: 'main' | 'sub'
  bomChild: boolean
}

interface Mismatch {
  group: string
  starved: SkuComputed[]
  idle: SkuComputed[]
}

// ── helpers ──────────────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString())
const woc = (v: number | null | undefined) => (v == null ? '—' : v > 99 ? '99+' : v.toFixed(1))
const esc = (s: string) => s

// ── component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const supabase = createClient()
  const router = useRouter()

  const [profile, setProfile] = useState<any>(null)
  const [feed, setFeed] = useState<FeedHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [pulledAt, setPulledAt] = useState<string>('—')
  const [liveCount, setLiveCount] = useState(0)

  const [all, setAll] = useState<SkuComputed[]>([])
  const [projNames, setProjNames] = useState<Record<string, string>>({})
  const [brands, setBrands] = useState<string[]>([])

  const [fProj, setFProj] = useState('')
  const [fMS, setFMS] = useState<'all' | 'main' | 'sub'>('all')
  const [sortKey, setSortKey] = useState('urg')
  const [sortDir, setSortDir] = useState(1)
  const [ovSub, setOvSub] = useState<Set<string>>(new Set())
  const [ovMain, setOvMain] = useState<Set<string>>(new Set())
  const [ovSubText, setOvSubText] = useState('')
  const [ovMainText, setOvMainText] = useState('')

  useEffect(() => { loadDashboard() }, [])

  async function loadDashboard() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)

    const isAdmin = prof?.role === 'admin' || prof?.role === 'supply_chain'
    if (!isAdmin) { router.push('/project/SkinDae'); return }

    const [skuRes, stockRes, wmsLiveRes, poRes, forecastRes, feedRes, bomRes] = await Promise.all([
      supabase.from('master_sku')
        .select('sku, description, project_id, brand, moq, lead_time_wk, demand_source')
        .eq('status', 'Active'),
      supabase.from('v_stock_current')
        .select('portal_sku, usable_current, incoming_current, atp_source'),
      supabase.from('wms_stock_live')
        .select('sku, unusable_qty, reserved_qty, available_batches'),
      supabase.from('purchase_orders')
        .select('sku, qty, delivery_date, status, part_number')
        .eq('status', 'Open'),
      supabase.from('demand_forecast')
        .select('sku, week_start_date, forecast_qty')
        .order('week_start_date', { ascending: true }),
      supabase.from('v_wms_feed_health').select('*').single(),
      supabase.from('bom_lines').select('child_pn').eq('is_active', true),
    ])

    setFeed((feedRes.data as FeedHealth) ?? null)

    const skuData = skuRes.data || []
    const stockData = stockRes.data || []
    const wmsLiveData = wmsLiveRes.data || []
    const poData = poRes.data || []
    const forecastData = forecastRes.data || []
    const bomChildren = new Set((bomRes.data || []).map((b: any) => b.child_pn))

    const stockBySku: Record<string, { usable: number; incoming: number; source: string }> = {}
    stockData.forEach((r: any) => {
      stockBySku[r.portal_sku] = {
        usable: r.usable_current ?? 0,
        incoming: r.incoming_current ?? 0,
        source: r.atp_source ?? 'S',
      }
    })

    const wmsBySku: Record<string, { unusable: number; reserved: number; hasExpiry: boolean }> = {}
    wmsLiveData.forEach((r: any) => {
      let hasExpiry = false
      if (Array.isArray(r.available_batches)) {
        hasExpiry = r.available_batches.some((b: any) => b?.expiry_date)
      }
      wmsBySku[r.sku] = { unusable: r.unusable_qty ?? 0, reserved: r.reserved_qty ?? 0, hasExpiry }
    })

    const fcBySku: Record<string, { wk: string; qty: number }[]> = {}
    forecastData.forEach((r: any) => {
      if (!fcBySku[r.sku]) fcBySku[r.sku] = []
      fcBySku[r.sku].push({ wk: r.week_start_date, qty: r.forecast_qty })
    })

    const poBySku: Record<string, { qty: number; delivery_date: string }[]> = {}
    poData.forEach((r: any) => {
      const key = r.sku || r.part_number
      if (!key) return
      if (!poBySku[key]) poBySku[key] = []
      poBySku[key].push({ qty: r.qty ?? 0, delivery_date: r.delivery_date })
    })

    const today = new Date().toISOString().split('T')[0]
    const week1 = fcBySku[Object.keys(fcBySku)[0]]?.[0]?.wk || today

    const computed: SkuComputed[] = skuData.map((s: any) => {
      const stock = stockBySku[s.sku] || { usable: 0, incoming: 0, source: 'S' }
      const wmsLive = wmsBySku[s.sku] || { unusable: 0, reserved: 0, hasExpiry: false }
      const fcRows = (fcBySku[s.sku] || []).sort((a, b) => a.wk.localeCompare(b.wk))
      const fc = fcRows.map(r => r.qty)
      const n = fc.length
      const h = Math.min(8, n)
      const avgWkRaw = h ? fc.slice(0, h).reduce((a, b) => a + b, 0) / h : 0
      const dmdTot = fc.reduce((a, b) => a + b, 0)
      const hasSignal = dmdTot > 0

      const usable = stock.usable
      const incoming = stock.incoming

      let cum = 0
      let runout: number | null = null
      for (let i = 0; i < n; i++) { cum += fc[i]; if (cum > usable) { runout = i + 1; break } }

      const pos = poBySku[s.sku] || []
      const poUnits = pos.reduce((a, p) => a + p.qty, 0)
      const poSorted = [...pos].sort((a, b) => (a.delivery_date || '').localeCompare(b.delivery_date || ''))
      const poNext = poSorted[0]?.delivery_date || null
      const poLate = pos.filter(p => p.delivery_date && p.delivery_date < today).reduce((a, p) => a + p.qty, 0)
      const inbound = incoming + poUnits

      // run-out including inbound: WMS incoming lands week 1, each open PO lands on
      // its promised week. Past-due POs land at week 1 — deliberately optimistic,
      // and flagged separately via poLate.
      let bal = usable + incoming
      let runoutIn: number | null = null
      const poWeekMap: Record<number, number> = {}
      pos.forEach(p => {
        if (!p.delivery_date) return
        const wkIdx = p.delivery_date < today
          ? 1
          : Math.max(1, Math.floor((new Date(p.delivery_date).getTime() - new Date(week1).getTime()) / 6048e5) + 1)
        poWeekMap[wkIdx] = (poWeekMap[wkIdx] || 0) + p.qty
      })
      for (let i = 0; i < n; i++) {
        if (poWeekMap[i + 1]) bal += poWeekMap[i + 1]
        bal -= fc[i]
        if (bal < 0) { runoutIn = i + 1; break }
      }

      const wocVal = avgWkRaw > 0 ? usable / avgWkRaw : null
      const wocInVal = avgWkRaw > 0 ? (usable + inbound) / avgWkRaw : null

      const target = s.lead_time_wk + BUF
      let band: Band
      if (!hasSignal) band = 'nosignal'
      else if (usable <= 0) band = 'stockout'
      else if (runout !== null && runout <= s.lead_time_wk) band = 'critical'
      else if (runout !== null && runout <= target) band = 'risk'
      else if (wocVal !== null && wocVal > EXC) band = 'excess'
      else if (runout === null && wocVal !== null && wocVal > EXC) band = 'excess'
      else band = 'healthy'

      let action: string
      if (band === 'nosignal') action = usable > 0 ? 'Confirm SKU still recurring' : 'Retire or seed forecast'
      else if (band === 'stockout') action = inbound > 0 ? 'Expedite inbound — already out' : 'Emergency order now'
      else if (band === 'critical') action = (runoutIn === null || runoutIn > s.lead_time_wk + BUF) ? 'Covered by inbound — chase ETA' : 'Order today / expedite'
      else if (band === 'risk') action = 'Place order this cycle'
      else if (band === 'excess') action = 'Hold ordering — review MOQ & shelf life'
      else action = 'No action'

      const flags: string[] = []
      if (poLate > 0) flags.push('PO overdue')
      if (stock.source !== 'L') flags.push('no live feed')
      if (n > 0 && n < 26) flags.push(`fcst horizon ${n}w`)
      if (s.moq > 0 && dmdTot > 0 && s.moq > dmdTot) flags.push('MOQ > 26w demand')
      if (wmsLive.unusable > 0 && usable > 0 && wmsLive.unusable / (usable + wmsLive.unusable) > 0.1) {
        flags.push(`unusable ${Math.round(100 * wmsLive.unusable / (usable + wmsLive.unusable))}%`)
      }
      if (!wmsLive.hasExpiry) flags.push('no expiry data')

      const bomChild = bomChildren.has(s.sku)
      // cls is a placeholder here — allClassified (below, reactive to ovSub/ovMain)
      // is the single source of truth used everywhere in the render tree.
      const cls: 'main' | 'sub' = bomChild
        ? 'sub'
        : SUB_PATTERN.test(s.description || '')
          ? 'sub'
          : 'main'

      return {
        sku: s.sku, desc: s.description || '', proj: s.project_id || '', moq: s.moq || 0, lt: s.lead_time_wk || 0,
        usable, incoming, unusable: wmsLive.unusable, reserved: wmsLive.reserved, hasExpiry: wmsLive.hasExpiry,
        stockSrc: (stock.source === 'L' ? 'L' : 'S'), demandSource: s.demand_source || '',
        fc, nwk: n, avgWk: Math.round(avgWkRaw), dmdTot, hasSignal,
        runout, runoutIn, woc: wocVal, wocIn: wocInVal, inbound, poNext, poLate,
        band, action, flags, cls, bomChild,
      }
    })

    setAll(computed)
    const live = computed.filter(r => r.stockSrc === 'L').length
    setLiveCount(live)
    setPulledAt(today)

    const names: Record<string, string> = {}
    skuData.forEach((s: any) => { if (s.project_id) names[s.project_id] = s.brand || s.project_id })
    setProjNames(names)

    const isAdminBrands = [...new Set(skuData.map((s: any) => s.brand).filter(Boolean))].sort()
    setBrands(isAdminBrands)

    setLoading(false)
  }

  // ── classification override handlers ──────────────────────────────────────
  function applyOverrides() {
    const parse = (t: string) => new Set(t.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean))
    setOvSub(parse(ovSubText))
    setOvMain(parse(ovMainText))
  }
  function clearOverrides() {
    setOvSubText(''); setOvMainText(''); setOvSub(new Set()); setOvMain(new Set())
  }

  // recompute classification when overrides change, without refetching
  const allClassified = useMemo(() => {
    return all.map(r => {
      const cls: 'main' | 'sub' = ovMain.has(r.sku)
        ? 'main'
        : ovSub.has(r.sku)
          ? 'sub'
          : r.bomChild
            ? 'sub'
            : SUB_PATTERN.test(r.desc)
              ? 'sub'
              : 'main'
      return { ...r, cls }
    })
  }, [all, ovSub, ovMain])

  const visible = useMemo(() => {
    return allClassified.filter(r => (!fProj || r.proj === fProj) && (fMS === 'all' || r.cls === fMS))
  }, [allClassified, fProj, fMS])

  const mismatches = useMemo(() => findMismatches(allClassified), [allClassified])

  const sortedRows = useMemo(() => {
    const rows = [...visible]
    rows.sort((a, b) => {
      if (sortKey === 'urg') {
        const d = URG[a.band] - URG[b.band]
        if (d) return d
        return (a.runout ?? 999) - (b.runout ?? 999)
      }
      const va: any = (a as any)[sortKey]
      const vb: any = (b as any)[sortKey]
      if (va == null) return 1
      if (vb == null) return -1
      return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sortDir
    })
    return rows
  }, [visible, sortKey, sortDir])

  function onSort(k: string) {
    if (sortKey === k) setSortDir(d => d * -1)
    else { setSortKey(k); setSortDir(1) }
  }

  if (loading || !profile) {
    return (
      <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE' }}>
        <Sidebar userEmail={profile?.email} userName={profile?.full_name} userRole={profile?.role} brands={brands} />
        <div className="flex-1 flex items-center justify-center" style={{ color: '#8B948F', fontSize: 13 }}>Loading…</div>
      </div>
    )
  }

  const scored = visible.filter(r => r.band !== 'nosignal')
  const healthy = scored.filter(r => r.band === 'healthy').length
  const healthPct = scored.length ? Math.round(100 * healthy / scored.length) : 0
  const stale = allClassified.length - liveCount

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE', fontFamily: 'Calibri, "Segoe UI", sans-serif', fontSize: 13 }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name} userRole={profile?.role} brands={brands} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div style={{ background: '#FFFFFF', borderBottom: '1px solid #E4DDD3', padding: '10px 24px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1F2937', letterSpacing: '-0.01em', fontFamily: 'Cambria, Georgia, serif' }}>Inventory Management Control Tower</div>
            <div style={{ fontSize: 11.5, color: '#4B5563', marginTop: 2 }}>
              {allClassified.length} active SKUs · live WMS stock for {liveCount} of {allClassified.length} SKUs
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <FeedPill feed={feed} />
            {stale > 0 && (
              <Pill tone="warn">{stale} SKUs snapshot-only</Pill>
            )}
            <Pill tone="neutral">pulled {pulledAt}</Pill>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ padding: '16px 20px 48px' }}>
          {/* Controls */}
          <Card>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label style={labelStyle}>Project / brand</label>
                <select value={fProj} onChange={e => setFProj(e.target.value)} style={inputStyle}>
                  <option value="">All projects</option>
                  {Object.keys(projNames).sort().map(p => (
                    <option key={p} value={p}>{p} · {projNames[p]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Classification</label>
                <div style={{ display: 'flex', gap: 5 }}>
                  {(['all', 'main', 'sub'] as const).map(v => (
                    <Chip key={v} on={fMS === v} onClick={() => setFMS(v)}>
                      {v === 'all' ? 'Main + sub' : v === 'main' ? 'Main only' : 'Sub only'}
                    </Chip>
                  ))}
                </div>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <button style={ghostBtnStyle} onClick={() => { setFProj(''); setFMS('all') }}>Reset filters</button>
              </div>
            </div>
          </Card>

          {/* 1 · Portfolio health */}
          <SectionHeader n="1" title="Portfolio health" />
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px,1.05fr) minmax(380px,1.6fr)', gap: 12 }}>
            <Card>
              <CardTitle>Health score</CardTitle>
              <CardNote>Healthy share of scoreable SKUs</CardNote>
              <Donut visible={visible} healthy={healthy} healthPct={healthPct} scored={scored} />
            </Card>
            <Card>
              <CardTitle>Main vs sub</CardTitle>
              <CardNote>Band mix by SKU class</CardNote>
              <BandBars visible={visible} />
            </Card>
          </div>

          {mismatches.length > 0 && <MismatchCard mismatches={mismatches} />}

          {/* 2 · When it hurts */}
          <SectionHeader n="2" title="When it hurts" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Card>
              <CardTitle>Run-out timeline</CardTitle>
              <CardNote>SKUs hitting zero, by week</CardNote>
              <RunoutChart visible={visible} />
            </Card>
            <Card>
              <CardTitle>Weeks of cover</CardTitle>
              <CardNote>Left tail firefights, right tail ties up cash</CardNote>
              <WocChart visible={visible} />
            </Card>
          </div>

          {/* 3 · Counts */}
          <SectionHeader n="3" title="Counts" span="SKUs, not units — UoM differs" />
          <Kpis visible={visible} />

          {/* 4 · Action queue */}
          <SectionHeader n="4" title="Action queue" span="click any header to re-sort" />
          <ActionQueue rows={sortedRows} sortKey={sortKey} onSort={onSort} fProj={fProj} fMS={fMS} projNames={projNames} />

          {/* 5 · Project rollup */}
          <SectionHeader n="5" title="Project rollup" span="where to spend your week" />
          <ProjectRollup all={allClassified} projNames={projNames} onPick={p => setFProj(fProj === p ? '' : p)} />

          {/* 6 · Supply reliability & data trust */}
          <SectionHeader n="6" title="Supply reliability & data trust" span="a health score built on stale inputs is a false negative" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            <Card>
              <CardTitle>Overdue purchase orders</CardTitle>
              <CardNote>Open POs with a delivery date already in the past. These are inflating your inbound cover.</CardNote>
              <LatePos all={allClassified} pulledAt={pulledAt} />
            </Card>
            <Card>
              <CardTitle>Data readiness</CardTitle>
              <CardNote>Each gap below silently biases the health score. Closing them is the cheapest accuracy win available.</CardNote>
              <DataQuality all={allClassified} />
            </Card>
            <Card>
              <CardTitle>Structural / policy risk</CardTitle>
              <CardNote>Not a stock problem — a parameter problem. Fix these once and the health score stops lying.</CardNote>
              <Policy all={allClassified} />
            </Card>
          </div>

          {/* 7 · Main vs sub config */}
          <SectionHeader n="7" title="Main vs sub SKU classification" span="provisional — awaiting your list" warn />
          <Card>
            <CardNote>
              There is no main/sub field in <span className="mono">master_sku</span> today, so the split below is inferred:
              a SKU is treated as <b>sub</b> if it appears as a component of an active BOM, or if its description matches an
              accessory / packaging / sample pattern. Everything else is <b>main</b>. Paste your list below to override — one
              SKU per line — and the whole dashboard reclassifies instantly. When your list is final it should become a
              column on <span className="mono">master_sku</span>, not a rule in the UI.
            </CardNote>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Force to SUB (one SKU per line)</label>
                <textarea value={ovSubText} onChange={e => setOvSubText(e.target.value)} style={textareaStyle} placeholder={'SDCNYBS01S\nSDSDB10S'} />
              </div>
              <div>
                <label style={labelStyle}>Force to MAIN (one SKU per line)</label>
                <textarea value={ovMainText} onChange={e => setOvMainText(e.target.value)} style={textareaStyle} placeholder="IPILHL050" />
              </div>
            </div>
            <div style={{ marginTop: 9, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button style={btnStyle} onClick={applyOverrides}>Apply classification</button>
              <button style={ghostBtnStyle} onClick={clearOverrides}>Clear overrides</button>
              <span style={{ fontSize: 11, color: '#8B948F' }}>
                {allClassified.filter(r => r.cls === 'main').length} main · {allClassified.filter(r => r.cls === 'sub').length} sub
                {(ovSub.size + ovMain.size) ? ` (${ovSub.size + ovMain.size} overridden)` : ' (all inferred)'}
              </span>
            </div>
          </Card>

          {/* 8 · Recommendations (static backlog) */}
          <SectionHeader n="8" title="What else you should be looking at" span="ranked by decision value, with what it needs from the data model" />
          <Backlog />

          <div style={{ marginTop: 34, fontSize: 11, color: '#8B948F', borderTop: '1px solid #E4DDD3', paddingTop: 12 }}>
            Live data from the CTGSupplyChain S&amp;D database, pulled {pulledAt}. Health bands are relative to each SKU's
            lead time; order-window buffer (4 wks) and excess line (26 wks) are fixed constants.
          </div>
        </div>
      </div>
    </div>
  )
}

// ── mismatch detection ──────────────────────────────────────────────────────
// Same product, two pack SKUs: forecast sitting on one, stock on the other.
// Produces a fake "critical" on one SKU and fake "excess" on its sibling.
const FORM = /,\s*(Bottle|Box|Pcs|Pack|Pouch)\b/i
function findMismatches(all: SkuComputed[]): Mismatch[] {
  const g: Record<string, SkuComputed[]> = {}
  all.forEach(r => {
    const key = (r.proj + '|' + r.desc.split(FORM)[0]).toLowerCase().trim()
    if (!g[key]) g[key] = []
    g[key].push(r)
  })
  const out: Mismatch[] = []
  Object.values(g).forEach(set => {
    if (set.length < 2) return
    const starved = set.filter(r => r.dmdTot > 0 && r.woc !== null && r.woc < 2)
    const idle = set.filter(r => r.dmdTot === 0 && r.usable > 0)
    if (starved.length && idle.length) out.push({ starved, idle, group: set[0].desc.split(FORM)[0] })
  })
  return out
}

// ── small building blocks ───────────────────────────────────────────────────

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#4B5563', display: 'block', marginBottom: 3 }
const inputStyle: React.CSSProperties = { fontFamily: 'inherit', fontSize: 12, padding: '5px 7px', border: '1px solid #E4DDD3', borderRadius: 4, background: '#fff', color: '#1F2937' }
const textareaStyle: React.CSSProperties = { ...inputStyle, width: '100%', minHeight: 56, resize: 'vertical', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11 }
const btnStyle: React.CSSProperties = { fontFamily: 'inherit', fontSize: 11.5, padding: '5px 11px', border: '1px solid #0F6E56', background: '#0F6E56', color: '#fff', borderRadius: 4, cursor: 'pointer' }
const ghostBtnStyle: React.CSSProperties = { ...btnStyle, background: '#fff', color: '#4B5563', borderColor: '#E4DDD3' }

function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background: '#fff', border: '1px solid #E4DDD3', borderRadius: 6, padding: '14px 16px', marginBottom: 12 }}>{children}</div>
}
function CardTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 13.5, marginBottom: 2, fontFamily: 'Cambria, Georgia, serif' }}>{children}</h2>
}
function CardNote({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: '#8B948F', marginBottom: 12 }}>{children}</div>
}
function SectionHeader({ n, title, span, warn }: { n: string; title: string; span?: string; warn?: boolean }) {
  return (
    <div style={{ margin: '22px 0 9px', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      <h2 style={{ fontSize: 14.5, fontFamily: 'Cambria, Georgia, serif' }}>{n} · {title}</h2>
      {span && <span style={{ fontSize: 11.5, color: '#8B948F' }}>{span}</span>}
      {warn && <Pill tone="warn">provisional — awaiting your list</Pill>}
    </div>
  )
}
function Pill({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  const styles: Record<string, React.CSSProperties> = {
    ok: { background: '#EAF6F0', borderColor: '#C6E4D6', color: '#0F6E56' },
    warn: { background: '#FDF6E7', borderColor: '#E8D5A8', color: '#7A5B14' },
    bad: { background: '#FBEDEB', borderColor: '#E8B6AF', color: '#8C2A1E' },
    neutral: { background: '#fff', borderColor: '#E4DDD3', color: '#4B5563' },
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 9px', border: '1px solid', borderRadius: 999, whiteSpace: 'nowrap', ...styles[tone] }}>
      {children}
    </span>
  )
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      style={{ fontSize: 11, padding: '3px 9px', border: '1px solid', borderRadius: 999, cursor: 'pointer', userSelect: 'none', background: on ? '#2E2A24' : '#fff', borderColor: on ? '#2E2A24' : '#E4DDD3', color: on ? '#fff' : '#4B5563' }}
    >
      {children}
    </div>
  )
}

function FeedPill({ feed }: { feed: FeedHealth | null }) {
  if (!feed) return <Pill tone="neutral">WMS feed unknown</Pill>
  const tone = { healthy: 'ok', degraded: 'warn', error: 'bad', down: 'bad' }[feed.status] as 'ok' | 'warn' | 'bad'
  const label = { healthy: 'WMS feed live', degraded: 'WMS feed delayed', error: 'WMS feed error', down: 'WMS feed disconnected' }[feed.status]
  return (
    <span title={`${feed.status_detail}\nLast pull: ${feed.pull_minutes_ago ?? '?'} min ago · last stock event: ${feed.event_minutes_ago ?? '?'} min ago · ${feed.events_last_hour} events in the last hour`}>
      <Pill tone={tone}>
        {label}{feed.status === 'healthy' ? ` · ${feed.skus_live}/${feed.skus_total} SKUs live` : ''}
      </Pill>
    </span>
  )
}

// ── donut ────────────────────────────────────────────────────────────────────
function Donut({ visible, healthy, healthPct, scored }: { visible: SkuComputed[]; healthy: number; healthPct: number; scored: SkuComputed[] }) {
  const col = healthPct >= 80 ? '#1D9E75' : healthPct >= 60 ? '#C08A2E' : '#C0392B'
  const R = 74, r0 = 52, cx = 92, cy = 92, C = 2 * Math.PI * ((R + r0) / 2), SW = R - r0
  let off = 0
  const arcs: React.ReactNode[] = []
  BANDS.forEach(b => {
    const n = visible.filter(x => x.band === b.k).length
    if (!n) return
    const frac = n / (visible.length || 1)
    const len = C * frac
    arcs.push(
      <circle key={b.k} cx={cx} cy={cy} r={(R + r0) / 2} fill="none" stroke={b.c} strokeWidth={SW}
        strokeDasharray={`${len - 1.5} ${C - len + 1.5}`} strokeDashoffset={-off}
        transform={`rotate(-90 ${cx} ${cy})`}>
        <title>{b.l}: {n} SKUs</title>
      </circle>
    )
    off += len
  })
  const kvs: [string, number, string][] = [
    ['Scoreable SKUs', scored.length, '#4B5563'],
    ['Healthy', healthy, '#1D9E75'],
    ['Need action', scored.filter(x => ['stockout', 'critical', 'risk'].includes(x.band)).length, '#C0392B'],
    ['Excess', scored.filter(x => x.band === 'excess').length, '#2C6E9B'],
    ['No forecast', visible.filter(x => x.band === 'nosignal').length, '#8A8578'],
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <svg viewBox="0 0 184 184" style={{ width: 184, height: 184, flex: '0 0 auto' }}>
        {arcs}
        <text x={cx} y={cy + 4} textAnchor="middle" fontFamily="Cambria,Georgia,serif" fontSize="42" fontWeight={600} fill={col}>{healthPct}%</text>
        <text x={cx} y={cy + 24} textAnchor="middle" fontFamily="Calibri,sans-serif" fontSize="11" fill="#8B948F">healthy</text>
      </svg>
      <div style={{ flex: 1, minWidth: 170 }}>
        {kvs.map(([l, v, c]) => (
          <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '5px 0', borderBottom: '1px solid #EFEAE2' }}>
            <span>{l}</span><span style={{ color: c, fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function BandBars({ visible }: { visible: SkuComputed[] }) {
  const groups: [string, SkuComputed[]][] = [['Main', visible.filter(r => r.cls === 'main')], ['Sub', visible.filter(r => r.cls === 'sub')]]
  return (
    <div>
      {groups.map(([lbl, set]) => {
        const tot = set.length || 1
        const sc = set.filter(r => r.band !== 'nosignal')
        const p = sc.length ? Math.round(100 * sc.filter(r => r.band === 'healthy').length / sc.length) : 0
        const pColor = p >= 80 ? '#0F6E56' : p >= 60 ? '#7A5B14' : '#8C2A1E'
        return (
          <div key={lbl} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#4B5563', marginBottom: 4 }}>
              <span><b style={{ fontSize: 13, color: '#1F2937' }}>{lbl}</b> · {set.length} SKUs</span>
              <span style={{ color: pColor, fontWeight: 600 }}>{p}% healthy</span>
            </div>
            <div style={{ display: 'flex', height: 26, borderRadius: 4, overflow: 'hidden', background: '#F2F0EB' }}>
              {BANDS.map(b => {
                const n = set.filter(r => r.band === b.k).length
                if (!n) return null
                const w = 100 * n / tot
                return (
                  <div key={b.k} title={`${b.l}: ${n} SKUs`} style={{ width: `${w}%`, background: b.c, position: 'relative' }}>
                    {w > 7 && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 600 }}>{n}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, fontSize: 11, color: '#4B5563' }}>
        {BANDS.map(b => (
          <span key={b.k} title={b.d}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 5, verticalAlign: -1, background: b.c }} />{b.l}</span>
        ))}
      </div>
    </div>
  )
}

function MismatchCard({ mismatches }: { mismatches: Mismatch[] }) {
  const nS = mismatches.reduce((a, m) => a + m.starved.length, 0)
  return (
    <div style={{ background: '#FFFCFB', border: '1px solid #E4DDD3', borderLeft: '3px solid #C0392B', borderRadius: 6, padding: '14px 16px', marginTop: 12, marginBottom: 12 }}>
      <CardTitle>Read this before you act on the critical list</CardTitle>
      <CardNote>
        {mismatches.length} product{mismatches.length > 1 ? 's' : ''} have demand forecast on one pack SKU and physical
        stock on a sibling pack SKU. {nS} of the critical/at-risk SKUs above are therefore false alarms — and their
        siblings are false excess. This is what a pack cutover looks like when the forecast has not followed the SKU.
      </CardNote>
      {mismatches.map((m, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '5px 0', borderBottom: '1px solid #EFEAE2' }}>
          <span>
            <b>{esc(m.group)}</b><br />
            <span style={{ color: '#8C2A1E', fontSize: 10.5 }}>demand, no stock: {m.starved.map(r => `${r.sku} (${fmt(r.usable)} on hand, ${fmt(r.avgWk)}/wk)`).join(' · ')}</span><br />
            <span style={{ color: '#1E5478', fontSize: 10.5 }}>stock, no demand: {m.idle.map(r => `${r.sku} (${fmt(r.usable)} on hand)`).join(' · ')}</span>
          </span>
          <span style={{ whiteSpace: 'nowrap', color: '#8C2A1E', fontWeight: 600 }}>reconcile</span>
        </div>
      ))}
    </div>
  )
}

function RunoutChart({ visible }: { visible: SkuComputed[] }) {
  const W = 26
  const cnt = new Array(W).fill(0), cntSub = new Array(W).fill(0)
  visible.forEach(r => { if (r.runout !== null && r.runout <= W) { cnt[r.runout - 1]++; if (r.cls === 'sub') cntSub[r.runout - 1]++ } })
  const max = Math.max(...cnt, 1)
  const w = 560, h = 190, pl = 30, pb = 26, pt = 10
  const bw = (w - pl - 8) / W
  const bars: React.ReactNode[] = []
  let cum = 0
  const totRun = cnt.reduce((a: number, b: number) => a + b, 0) || 1
  const line: string[] = []
  for (let i = 0; i < W; i++) {
    const x = pl + i * bw
    const bh = (h - pb - pt) * cnt[i] / max
    const sh = (h - pb - pt) * cntSub[i] / max
    if (cnt[i]) bars.push(<rect key={`b${i}`} x={x + 1} y={h - pb - bh} width={bw - 2} height={bh} fill={i + 1 <= 4 ? '#C0392B' : i + 1 <= 8 ? '#D9A13B' : '#1D9E75'} opacity={0.85}><title>wk {i + 1}: {cnt[i]} SKUs run out</title></rect>)
    if (cntSub[i]) bars.push(<rect key={`s${i}`} x={x + 1} y={h - pb - sh} width={bw - 2} height={sh} fill="#2E2A24" opacity={0.3} />)
    cum += cnt[i]
    line.push(`${x + bw / 2},${h - pb - (h - pb - pt) * cum / totRun}`)
    if ((i + 1) % 4 === 0 || i === 0) bars.push(<text key={`t${i}`} x={x + bw / 2} y={h - pb + 13} fontSize="9" fill="#8B948F" textAnchor="middle">{i + 1}</text>)
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto' }}>
      <line x1={pl} y1={h - pb} x2={w - 4} y2={h - pb} stroke="#E4DDD3" />
      <line x1={pl} y1={pt} x2={pl} y2={h - pb} stroke="#E4DDD3" />
      <text x={pl - 5} y={pt + 8} fontSize="9" fill="#8B948F" textAnchor="end">{max}</text>
      <text x={pl - 5} y={h - pb} fontSize="9" fill="#8B948F" textAnchor="end">0</text>
      {bars}
      <polyline points={line.join(' ')} fill="none" stroke="#2C6E9B" strokeWidth="1.4" strokeDasharray="3 3" />
      <text x={w / 2} y={h - 2} fontSize="9.5" fill="#8B948F" textAnchor="middle">cumulative share of run-outs (dashed) · dark overlay = sub SKUs</text>
    </svg>
  )
}

function WocChart({ visible }: { visible: SkuComputed[] }) {
  const B: [number, number, string][] = [[0, 0, '0'], [0, 2, '0–2'], [2, 4, '2–4'], [4, 8, '4–8'], [8, 13, '8–13'], [13, 26, '13–26'], [26, 52, '26–52'], [52, 1e9, '52+']]
  const rows = B.map(([lo, hi, l]) => {
    const set = visible.filter(r => {
      if (r.woc === null) return false
      if (lo === 0 && hi === 0) return r.usable <= 0
      return r.woc > lo && r.woc <= hi && r.usable > 0
    })
    const c = hi <= 4 ? '#C0392B' : hi <= 8 ? '#D9A13B' : hi <= 26 ? '#1D9E75' : '#2C6E9B'
    return { l, n: set.length, main: set.filter(r => r.cls === 'main').length, sub: set.filter(r => r.cls === 'sub').length, c }
  })
  const max = Math.max(...rows.map(r => r.n), 1)
  const noSignal = visible.filter(r => r.woc === null).length
  return (
    <div>
      {rows.map(r => (
        <div key={r.l} style={{ marginBottom: 7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#4B5563', marginBottom: 4 }}>
            <span>{r.l} wks cover</span>
            <span>{r.n ? <><b>{r.n}</b> · {r.main} main / {r.sub} sub</> : '—'}</span>
          </div>
          <div style={{ height: 9, background: '#F2F0EB', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: 9, width: `${100 * r.n / max}%`, background: r.c, borderRadius: 4 }} />
          </div>
        </div>
      ))}
      <div style={{ fontSize: 11, color: '#8B948F', marginTop: 8 }}>{noSignal} SKUs have no demand signal and are not plotted.</div>
    </div>
  )
}

function Kpis({ visible }: { visible: SkuComputed[] }) {
  const c = (k: Band) => visible.filter(r => r.band === k).length
  const runoutWks = visible.filter(r => r.runout !== null).map(r => r.runout as number)
  const firstRunout = runoutWks.length ? Math.min(...runoutWks) : null
  const exposedNoPo = visible.filter(r => (r.band === 'critical' || r.band === 'stockout') && r.inbound === 0).length
  const t: [string, string | number, string, string][] = [
    ['Stocked out', c('stockout'), 'zero usable', c('stockout') ? 'red' : 'green'],
    ['Critical', c('critical'), 'out inside lead time', c('critical') ? 'red' : 'green'],
    ['At risk', c('risk'), 'order window', c('risk') ? 'amber' : 'green'],
    ['Healthy', c('healthy'), 'no action', 'green'],
    ['Excess', c('excess'), `over ${EXC} wks cover`, c('excess') ? 'blue' : 'green'],
    ['No forecast', c('nosignal'), 'unscoreable', c('nosignal') ? 'amber' : 'green'],
    ['Nothing on order', exposedNoPo, 'exposed, no inbound', exposedNoPo ? 'red' : 'green'],
    ['First run-out', firstRunout === null ? '—' : `wk ${firstRunout}`, 'earliest zero', (firstRunout ?? 99) <= 4 ? 'red' : 'amber'],
  ]
  const borderColors: Record<string, string> = { red: '#C0392B', amber: '#C08A2E', green: '#1D9E75', blue: '#2C6E9B' }
  const textColors: Record<string, string> = { red: '#8C2A1E', amber: '#7A5B14', green: '#0F6E56', blue: '#1E5478' }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
      {t.map(([k, v, h, cl]) => (
        <div key={k} style={{ background: '#fff', border: '1px solid #E4DDD3', borderLeft: `3px solid ${borderColors[cl]}`, borderRadius: 5, padding: '12px 14px' }}>
          <div style={{ fontSize: 11.5, color: '#4B5563', fontWeight: 600 }}>{k}</div>
          <div style={{ fontFamily: 'Cambria,Georgia,serif', fontSize: 36, lineHeight: 1.05, margin: '4px 0 2px', fontWeight: 600, color: textColors[cl] }}>{v}</div>
          <div style={{ fontSize: 10.5, color: '#8B948F' }}>{h}</div>
        </div>
      ))}
    </div>
  )
}

function ActionQueue({ rows, sortKey, onSort, fProj, fMS, projNames }: { rows: SkuComputed[]; sortKey: string; onSort: (k: string) => void; fProj: string; fMS: string; projNames: Record<string, string> }) {
  const cols: [string, string][] = [
    ['sku', 'SKU'], ['desc', 'Description'], ['proj', 'Proj'], ['cls', 'M/S'], ['band', 'Band'],
    ['usable', 'On hand'], ['avgWk', 'Wkly dmd'], ['woc', 'WoC'], ['runout', 'Run-out wk'], ['lt', 'L/T wk'],
    ['wocIn', 'WoC +inbound'], ['inbound', 'Inbound'], ['poNext', 'PO due'], ['moq', 'MOQ'], ['action', 'Suggested action'], ['flags', 'Flags'],
  ]
  return (
    <div>
      <div style={{ overflow: 'auto', border: '1px solid #E4DDD3', borderRadius: 6, background: '#fff', maxHeight: 620 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
          <thead>
            <tr>
              {cols.map(([k, l]) => (
                <th key={k} onClick={() => onSort(k)} style={{ position: 'sticky', top: 0, background: '#FAF8F5', borderBottom: '1px solid #E4DDD3', textAlign: ['usable', 'avgWk', 'woc', 'runout', 'lt', 'wocIn', 'inbound', 'moq'].includes(k) ? 'right' : 'left', padding: '7px 8px', fontWeight: 600, color: '#4B5563', whiteSpace: 'nowrap', cursor: 'pointer', zIndex: 2 }}>
                  {l}{sortKey === k ? ' ▾' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const b = BM[r.band]
              return (
                <tr key={r.sku}>
                  <td style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11, padding: '6px 8px', borderBottom: '1px solid #EFEAE2' }}>{r.sku}</td>
                  <td style={{ maxWidth: 290, overflow: 'hidden', textOverflow: 'ellipsis', padding: '6px 8px', borderBottom: '1px solid #EFEAE2', whiteSpace: 'nowrap' }}>{esc(r.desc)}</td>
                  <td style={tdStyle}>{r.proj}</td>
                  <td style={tdStyle}><span style={{ fontSize: 10, color: r.cls === 'main' ? '#1E5478' : '#8B948F', border: '1px solid', borderColor: r.cls === 'main' ? '#CBDCE8' : '#E4DDD3', background: r.cls === 'main' ? '#EDF3F8' : 'transparent', borderRadius: 3, padding: '1px 5px' }}>{r.cls}</span></td>
                  <td style={tdStyle}><span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, fontWeight: 600, background: r.band === 'stockout' ? '#2E2A24' : r.band === 'critical' ? '#FBEDEB' : r.band === 'risk' ? '#FDF6E7' : r.band === 'healthy' ? '#EAF6F0' : r.band === 'excess' ? '#EDF3F8' : '#F2F0EB', color: r.band === 'stockout' ? '#fff' : r.band === 'critical' ? '#8C2A1E' : r.band === 'risk' ? '#7A5B14' : r.band === 'healthy' ? '#0F6E56' : r.band === 'excess' ? '#1E5478' : '#5C5749' }}>{b.l}</span></td>
                  <td style={numTdStyle}>{fmt(r.usable)}</td>
                  <td style={numTdStyle}>{fmt(r.avgWk)}</td>
                  <td style={{ ...numTdStyle, color: r.woc !== null && r.woc < r.lt ? '#8C2A1E' : undefined, fontWeight: r.woc !== null && r.woc < r.lt ? 600 : undefined }}>{woc(r.woc)}</td>
                  <td style={{ ...numTdStyle, color: r.runout !== null && r.runout <= r.lt ? '#8C2A1E' : undefined, fontWeight: r.runout !== null && r.runout <= r.lt ? 600 : undefined }}>{r.runout ?? `>${r.nwk || 0}`}</td>
                  <td style={numTdStyle}>{r.lt}</td>
                  <td style={numTdStyle}>{woc(r.wocIn)}</td>
                  <td style={numTdStyle}>{fmt(r.inbound)}</td>
                  <td style={{ ...tdStyle, color: r.poLate > 0 ? '#8C2A1E' : undefined, fontWeight: r.poLate > 0 ? 600 : undefined, fontFamily: 'ui-monospace,Menlo,monospace' }}>{r.poNext || '—'}</td>
                  <td style={numTdStyle}>{r.moq || '—'}</td>
                  <td style={tdStyle}>{r.action}</td>
                  <td style={{ ...tdStyle, color: '#8B948F', fontSize: 10.5 }}>{r.flags.join(' · ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: '#8B948F' }}>
        {rows.length} SKUs{fProj ? ` · ${fProj} ${projNames[fProj] || ''}` : ''}{fMS !== 'all' ? ` · ${fMS} only` : ''}
      </div>
    </div>
  )
}
const tdStyle: React.CSSProperties = { borderBottom: '1px solid #EFEAE2', padding: '6px 8px', whiteSpace: 'nowrap' }
const numTdStyle: React.CSSProperties = { ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace,Menlo,monospace' }

function ProjectRollup({ all, projNames, onPick }: { all: SkuComputed[]; projNames: Record<string, string>; onPick: (p: string) => void }) {
  const map: Record<string, any> = {}
  all.forEach(r => {
    if (!map[r.proj]) map[r.proj] = { proj: r.proj, name: projNames[r.proj] || r.proj, n: 0, nMain: 0, nSub: 0, nStockout: 0, nCritical: 0, nRisk: 0, nExcess: 0, nNoSignal: 0, nHealthy: 0, earliest: null, srcs: new Set() }
    const m = map[r.proj]
    m.n++
    m.srcs.add(r.demandSource)
    m[r.cls === 'main' ? 'nMain' : 'nSub']++
    if (r.band === 'stockout') m.nStockout++
    if (r.band === 'critical') m.nCritical++
    if (r.band === 'risk') m.nRisk++
    if (r.band === 'excess') m.nExcess++
    if (r.band === 'nosignal') m.nNoSignal++
    if (r.band === 'healthy') m.nHealthy++
    if (r.runout !== null && (m.earliest === null || r.runout < m.earliest)) m.earliest = r.runout
  })
  const rows = Object.values(map).map((m: any) => {
    const scored = m.n - m.nNoSignal
    m.health = scored ? Math.round(100 * m.nHealthy / scored) : null
    m.src = [...m.srcs].join(' + ')
    return m
  }).sort((a: any, b: any) => {
    const sa = (a.nStockout + a.nCritical) * 10 + a.nRisk, sb = (b.nStockout + b.nCritical) * 10 + b.nRisk
    if (sb - sa) return sb - sa
    return (a.earliest ?? 99) - (b.earliest ?? 99)
  })
  const cols = ['Project', 'Demand method', 'SKUs', 'Main', 'Sub', 'Health %', 'Out', 'Critical', 'At risk', 'Excess', 'No fcst', 'Earliest run-out']
  return (
    <div style={{ overflow: 'auto', border: '1px solid #E4DDD3', borderRadius: 6, background: '#fff', maxHeight: 460 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
        <thead>
          <tr>
            {cols.map(c => <th key={c} style={{ position: 'sticky', top: 0, background: '#FAF8F5', borderBottom: '1px solid #E4DDD3', textAlign: ['SKUs', 'Main', 'Sub', 'Health %', 'Out', 'Critical', 'At risk', 'Excess', 'No fcst', 'Earliest run-out'].includes(c) ? 'right' : 'left', padding: '7px 8px', fontWeight: 600, color: '#4B5563', whiteSpace: 'nowrap' }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((m: any) => {
            const hc = m.health == null ? '#8B948F' : m.health >= 80 ? '#0F6E56' : m.health >= 60 ? '#7A5B14' : '#8C2A1E'
            return (
              <tr key={m.proj} style={{ cursor: 'pointer' }} onClick={() => onPick(m.proj)}>
                <td style={{ ...tdStyle, fontFamily: 'ui-monospace,Menlo,monospace' }}>{m.proj} · {m.name}</td>
                <td style={{ ...tdStyle, fontSize: 10.5, color: '#8B948F' }}>{m.src}</td>
                <td style={numTdStyle}>{m.n}</td>
                <td style={numTdStyle}>{m.nMain}</td>
                <td style={numTdStyle}>{m.nSub}</td>
                <td style={{ ...numTdStyle, color: hc, fontWeight: 600 }}>{m.health == null ? '—' : `${m.health}%`}</td>
                <td style={{ ...numTdStyle, color: m.nStockout ? '#8C2A1E' : undefined, fontWeight: m.nStockout ? 600 : undefined }}>{m.nStockout || ''}</td>
                <td style={{ ...numTdStyle, color: m.nCritical ? '#8C2A1E' : undefined, fontWeight: m.nCritical ? 600 : undefined }}>{m.nCritical || ''}</td>
                <td style={numTdStyle}>{m.nRisk || ''}</td>
                <td style={numTdStyle}>{m.nExcess || ''}</td>
                <td style={numTdStyle}>{m.nNoSignal || ''}</td>
                <td style={numTdStyle}>{m.earliest == null ? '—' : `wk ${m.earliest}`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LatePos({ all, pulledAt }: { all: SkuComputed[]; pulledAt: string }) {
  const late = all.filter(r => r.poLate > 0).sort((a, b) => (a.poNext || '').localeCompare(b.poNext || ''))
  if (!late.length) return <div style={{ fontSize: 11, color: '#8B948F' }}>No overdue POs.</div>
  const today = new Date(pulledAt)
  const total = late.reduce((a, r) => a + r.poLate, 0)
  return (
    <div>
      {late.map(r => {
        const days = r.poNext ? Math.round((today.getTime() - new Date(r.poNext).getTime()) / 864e5) : 0
        return (
          <div key={r.sku} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '5px 0', borderBottom: '1px solid #EFEAE2' }}>
            <span><span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>{r.sku}</span> · {esc(r.desc.split(',')[0])}<br /><span style={{ color: '#8B948F', fontSize: 10.5 }}>{fmt(r.poLate)} units · due {r.poNext}</span></span>
            <span style={{ color: '#8C2A1E', fontWeight: 600, whiteSpace: 'nowrap' }}>{days}d late</span>
          </div>
        )
      })}
      <div style={{ fontSize: 11, color: '#8B948F', marginTop: 10 }}>
        Total {fmt(total)} units across {late.length} SKUs are being counted as inbound cover but have already missed their date. Until these are re-promised, "cover + inbound" is optimistic.
      </div>
    </div>
  )
}

function DataQuality({ all }: { all: SkuComputed[] }) {
  const n = all.length
  const items: [string, number, number, string][] = [
    ['SKUs with a demand forecast', all.filter(r => r.hasSignal).length, n, 'no forecast = cannot be scored'],
    ['On attach-rate method', all.filter(r => r.demandSource === 'Attach Rate' || r.demandSource === 'Att').length, n, 'target method for all SKUs'],
    ['Live WMS stock feed', all.filter(r => r.stockSrc === 'L').length, n, 'rest fall back to the daily snapshot'],
    ['Full 26-week forecast horizon', all.filter(r => r.nwk >= 26).length, n, 'short horizons overstate cover'],
    ['Batch expiry date present', all.filter(r => r.hasExpiry).length, n, 'blocks shelf-life risk reporting'],
  ]
  return (
    <div>
      {items.map(([l, v, t, h]) => {
        const p = Math.round(100 * v / t)
        const c = p >= 90 ? '#1D9E75' : p >= 60 ? '#C08A2E' : '#C0392B'
        return (
          <div key={l} style={{ marginBottom: 9 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#4B5563' }}>
              <span>{l}</span><span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}><b>{v}</b>/{t} · {p}%</span>
            </div>
            <div style={{ height: 6, background: '#F2F0EB', borderRadius: 4, overflow: 'hidden', marginTop: 3 }}>
              <div style={{ height: 6, width: `${p}%`, background: c, borderRadius: 4 }} />
            </div>
            <div style={{ fontSize: 10.5, color: '#8B948F', marginTop: 2 }}>{h}</div>
          </div>
        )
      })}
    </div>
  )
}

function Policy({ all }: { all: SkuComputed[] }) {
  const moq = all.filter(r => r.moq > 0 && r.dmdTot > 0 && r.moq > r.dmdTot).sort((a, b) => (b.moq / b.dmdTot) - (a.moq / a.dmdTot))
  const unus = all.filter(r => r.unusable > 0 && (r.unusable / (r.usable + r.unusable)) > 0.05).sort((a, b) => (b.unusable / (b.usable + b.unusable)) - (a.unusable / (a.usable + a.unusable)))
  const short = all.filter(r => r.hasSignal && r.nwk > 0 && r.nwk < 26).length
  return (
    <div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#4B5563', marginBottom: 5 }}>MOQ larger than 26-week demand</div>
      {moq.length ? moq.slice(0, 6).map(r => (
        <div key={r.sku} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '5px 0', borderBottom: '1px solid #EFEAE2' }}>
          <span><span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>{r.sku}</span><br /><span style={{ color: '#8B948F', fontSize: 10.5 }}>MOQ {fmt(r.moq)} vs {fmt(r.dmdTot)} units of 26-wk demand</span></span>
          <span style={{ whiteSpace: 'nowrap' }}>{(r.moq / r.dmdTot).toFixed(1)}×</span>
        </div>
      )) : <div style={{ fontSize: 11, color: '#8B948F', marginBottom: 8 }}>None.</div>}
      <div style={{ fontSize: 11.5, fontWeight: 600, color: '#4B5563', margin: '14px 0 5px' }}>Unusable stock &gt; 5% of on-hand</div>
      {unus.length ? unus.slice(0, 6).map(r => (
        <div key={r.sku} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '5px 0', borderBottom: '1px solid #EFEAE2' }}>
          <span><span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>{r.sku}</span><br /><span style={{ color: '#8B948F', fontSize: 10.5 }}>{fmt(r.unusable)} unusable vs {fmt(r.usable)} usable</span></span>
          <span style={{ color: '#8C2A1E', whiteSpace: 'nowrap' }}>{Math.round(100 * r.unusable / (r.usable + r.unusable))}%</span>
        </div>
      )) : <div style={{ fontSize: 11, color: '#8B948F' }}>None.</div>}
      <div style={{ fontSize: 11, color: '#8B948F', marginTop: 14 }}>
        {short} SKUs have a forecast horizon shorter than 26 weeks. Their cover looks better than it is, because demand simply stops in the data — the calendar gap, not the market.
      </div>
    </div>
  )
}

function Backlog() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Card>
        <CardTitle>Add next — high value, data mostly present</CardTitle>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          <li style={{ marginBottom: 7 }}><b>Cover including inbound, time-phased.</b> A second projected-balance line that lands each PO on its promised week tells you whether a critical SKU is genuinely exposed or just waiting. Already in the table as an approximation.</li>
          <li style={{ marginBottom: 7 }}><b>Expiry / shelf-life exposure.</b> <span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>wms_stock_live.available_batches</span> carries batch-level expiry dates. Blocked today because only a minority of live SKUs return an expiry date.</li>
          <li style={{ marginBottom: 7 }}><b>Forecast bias, not just error.</b> Bias (signed mean error) tells you which direction you are consistently wrong, which drives stockouts vs excess.</li>
          <li style={{ marginBottom: 7 }}><b>Kit / bundle buildable quantity.</b> Parent SKUs are only as available as their scarcest child. Compute min(child on-hand ÷ qty_per) per parent.</li>
          <li style={{ marginBottom: 7 }}><b>Unusable, blocked and reserved as a share of on-hand.</b> Already in the feed. Stock that exists but cannot ship is the most common reason a "healthy" SKU short-ships.</li>
        </ul>
      </Card>
      <Card>
        <CardTitle>Add later — needs a data or process input first</CardTitle>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          <li style={{ marginBottom: 7 }}><b>Inventory value and excess in RM.</b> Deliberately excluded here: pricing coverage too thin. Populate <span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>landed_price</span> before this goes on a dashboard.</li>
          <li style={{ marginBottom: 7 }}><b>Inventory turns and days of inventory outstanding.</b> Needs landed cost plus a clean 12-month shipped-units series.</li>
          <li style={{ marginBottom: 7 }}><b>Fill rate / OTIF to the brand owner.</b> Needs order-line demand vs shipped, not just stock.</li>
          <li style={{ marginBottom: 7 }}><b>Supplier lead-time actuals vs <span style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>lead_time_wk</span>.</b> Bands are computed off the master lead time. Derive from PO order date vs receipt date.</li>
          <li style={{ marginBottom: 7 }}><b>Ageing buckets by receipt date.</b> Distinguishes slow-moving stock from recently landed stock.</li>
          <li style={{ marginBottom: 7 }}><b>Attach-rate migration coverage.</b> Track % of active SKUs on the attach-rate method as a leading indicator of forecast quality. Tracked in the data-readiness panel above.</li>
        </ul>
      </Card>
    </div>
  )
}
