'use client'
// Inventory Parameters — min/max, reorder point, safety stock, EOQ per SKU.
// Reads v_inventory_params (security_invoker → RLS scopes brand owners to their brand).
// Policy knobs: inventory_policy_config (id=1) is the default; inventory_policy_brand holds per-brand overrides.
// Only superadmin/admin can change them.
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import { canEdit, isStaff, isBrandOwner } from '@/lib/roles'

interface Row {
  sku: string; brand: string; project_id: string | null; description: string | null
  lead_time_wk: number; moq: number; landed_price: number | null
  run_rate_wk: number | null; forecast_wk: number | null; planning_wk: number; planning_basis: string
  cv_lt: number; cv_source: string; segment: string; z: number
  safety_stock: number; rop_min: number; max_level: number; eoq: number
  usable: number; incoming: number; stock_position: number; snapshot_date: string | null
  woc_usable: number | null; suggested_order_qty: number; status: string; sales_through: string | null
}
interface Policy {
  z_a: number; z_b: number; z_c: number; cv_cap: number; default_cv: number; min_history_wk: number
  run_rate_weeks: number; review_wk: number; lt_sigma_wk: number; order_cost_rm: number
  holding_rate: number; planning_basis: 'run_rate' | 'forecast' | 'max'
}

const STATUS_ORDER = ['Stocked out', 'Below safety stock', 'Order now', 'OK', 'Excess', 'No demand', 'No signal']
const STATUS_TONE: Record<string, { bg: string; bd: string; fg: string }> = {
  'Stocked out': { bg: '#2E2A24', bd: '#2E2A24', fg: '#fff' },
  'Below safety stock': { bg: '#FBEDEB', bd: '#E8B6AF', fg: '#8C2A1E' },
  'Order now': { bg: '#FDF6E7', bd: '#E8D5A8', fg: '#7A5B14' },
  'OK': { bg: '#EAF6F0', bd: '#C6E4D6', fg: '#0F6E56' },
  'Excess': { bg: '#EAF1F7', bd: '#BFD3E4', fg: '#2C6E9B' },
  'No demand': { bg: '#fff', bd: '#E4DDD3', fg: '#8B948F' },
  'No signal': { bg: '#fff', bd: '#E4DDD3', fg: '#8B948F' },
}
const BASIS_LABEL = { run_rate: 'Run rate', forecast: 'Forecast', max: 'Max of both' } as const

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(Number(v)).toLocaleString())
const n1 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toFixed(1))

export default function InventoryParamsPage() {
  const supabase = createClient()
  const router = useRouter()
  const [profile, setProfile] = useState<any>(null)
  const [brands, setBrands] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [defaults, setDefaults] = useState<Policy | null>(null)
  const [overrides, setOverrides] = useState<Record<string, Partial<Policy>>>({})
  const [draft, setDraft] = useState<Policy | null>(null)
  const [fBrand, setFBrand] = useState('iLady')
  const [fStatus, setFStatus] = useState('')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)
    if (!isStaff(prof?.role) && !isBrandOwner(prof?.role)) { router.push('/forecast-submit'); return }
    const { data: access } = await supabase.from('user_brand_access').select('brand').eq('user_id', user.id)
    setBrands((access ?? []).map((a: any) => a.brand))
    await refresh()
    setLoading(false)
  }

  async function refresh() {
    const [{ data: r }, { data: p }, { data: ov }] = await Promise.all([
      supabase.from('v_inventory_params').select('*'),
      supabase.from('inventory_policy_config').select('*').eq('id', 1).single(),
      supabase.from('inventory_policy_brand').select('*'),
    ])
    const list = (r ?? []) as Row[]
    setRows(list)
    setDefaults(p as Policy)
    const om: Record<string, Partial<Policy>> = {}
    ;(ov ?? []).forEach((o: any) => { om[String(o.brand).toLowerCase()] = o })
    setOverrides(om)
    const bs = Array.from(new Set(list.map(x => x.brand)))
    if (bs.length && !bs.includes(fBrand)) setFBrand(bs.includes('iLady') ? 'iLady' : bs[0])
  }

  // Effective policy for the selected brand = default + that brand's overrides (All brands = the default itself).
  useEffect(() => {
    if (!defaults) return
    const o = fBrand ? overrides[fBrand.toLowerCase()] : undefined
    const eff = { ...defaults } as any
    if (o) Object.entries(o).forEach(([k, v]) => { if (v !== null && v !== undefined && k in defaults) eff[k] = v })
    setPolicy(eff as Policy); setDraft(eff as Policy)
  }, [defaults, overrides, fBrand])

  async function savePolicy() {
    if (!draft || !defaults) return
    setSaving(true); setMsg('')
    const now = new Date().toISOString()
    let error: any
    if (!fBrand) {
      ;({ error } = await supabase.from('inventory_policy_config').update({ ...draft, updated_at: now }).eq('id', 1))
    } else {
      // Store only the values that differ from the default as this brand's overrides.
      const row: any = { brand: fBrand, updated_at: now }
      const KEYS = ['z_a', 'z_b', 'z_c', 'abc_a_cut', 'abc_b_cut', 'cv_cap', 'default_cv', 'min_history_wk', 'run_rate_weeks', 'review_wk', 'lt_sigma_wk', 'order_cost_rm', 'holding_rate', 'planning_basis']
      KEYS.forEach(k => { row[k] = (draft as any)[k] !== (defaults as any)[k] ? (draft as any)[k] : null })
      ;({ error } = await supabase.from('inventory_policy_brand').upsert(row, { onConflict: 'brand' }))
    }
    setSaving(false)
    if (error) { setMsg(`Not saved: ${error.message}`); return }
    setMsg('Saved — parameters recalculated.')
    await refresh()
  }

  const allBrands = useMemo(() => Array.from(new Set(rows.map(r => r.brand))).sort(), [rows])
  const visible = useMemo(() => rows
    .filter(r => !fBrand || r.brand === fBrand)
    .filter(r => !fStatus || r.status === fStatus)
    .filter(r => !q || (r.sku + ' ' + (r.description ?? '')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.planning_wk - a.planning_wk),
  [rows, fBrand, fStatus, q])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    rows.filter(r => !fBrand || r.brand === fBrand).forEach(r => { c[r.status] = (c[r.status] ?? 0) + 1 })
    return c
  }, [rows, fBrand])

  const editor = canEdit(profile?.role)
  const salesThrough = rows[0]?.sales_through
  const stockDate = rows.find(r => r.snapshot_date)?.snapshot_date

  function exportCsv() {
    const cols: (keyof Row)[] = ['sku', 'description', 'segment', 'lead_time_wk', 'moq', 'run_rate_wk', 'forecast_wk', 'planning_wk', 'cv_lt', 'safety_stock', 'rop_min', 'max_level', 'eoq', 'usable', 'incoming', 'woc_usable', 'suggested_order_qty', 'status']
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const csv = [cols.join(','), ...visible.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `inventory_parameters_${fBrand || 'all'}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE', fontFamily: 'Calibri, "Segoe UI", sans-serif', fontSize: 13 }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name} userRole={profile?.role} brands={brands} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div style={{ background: '#fff', borderBottom: '1px solid #E4DDD3', padding: '10px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>Inventory Parameters</div>
            <div style={{ fontSize: 11.5, color: '#4B5563', marginTop: 2 }}>
              Min / max, reorder point and safety stock per SKU · planning on {policy ? BASIS_LABEL[policy.planning_basis] : '—'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Pill>Sales through w/c {salesThrough ?? '—'}</Pill>
            <Pill>Stock as of {stockDate ?? '—'}</Pill>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ padding: '16px 20px 48px' }}>
          {loading ? <div style={{ color: '#8B948F' }}>Loading…</div> : (
            <>
              <Card>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <label style={labelStyle}>Brand</label>
                    <select value={fBrand} onChange={e => setFBrand(e.target.value)} style={inputStyle}>
                      {allBrands.length > 1 && <option value="">All brands</option>}
                      {allBrands.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Search</label>
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder="SKU or name" style={{ ...inputStyle, width: 200 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <Chip on={!fStatus} onClick={() => setFStatus('')}>All · {Object.values(counts).reduce((a, b) => a + b, 0)}</Chip>
                    {STATUS_ORDER.filter(s => counts[s]).map(s => (
                      <Chip key={s} on={fStatus === s} onClick={() => setFStatus(fStatus === s ? '' : s)}>{s} · {counts[s]}</Chip>
                    ))}
                  </div>
                  <button onClick={exportCsv} style={{ ...ghostBtn, marginLeft: 'auto' }}>Export CSV</button>
                </div>
              </Card>

              <Card>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ textAlign: 'right', color: '#4B5563', fontSize: 11 }}>
                        {['SKU', 'Seg', 'LT wk', 'MOQ', 'Run rate /wk', 'Forecast /wk', 'Plan /wk', 'CV (LT)', 'Safety stock', 'ROP (min)', 'Max', 'EOQ', 'Usable', 'Incoming', 'WOC', 'Suggested order', 'Status'].map((h, i) => (
                          <th key={h} style={{ ...th, textAlign: i < 2 || i === 16 ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(r => {
                        const tone = STATUS_TONE[r.status] ?? STATUS_TONE['No signal']
                        return (
                          <tr key={r.sku} style={{ borderTop: '1px solid #EFEAE2' }}>
                            <td style={{ ...td, textAlign: 'left', minWidth: 220 }}>
                              <div style={{ fontWeight: 600, color: '#1F2937' }}>{r.sku}</div>
                              <div style={{ fontSize: 11, color: '#8B948F' }}>{(r.description ?? '').replace(/^I-ProCare,\s*/i, '')}</div>
                            </td>
                            <td style={{ ...td, textAlign: 'left' }}>{r.segment}</td>
                            <td style={td}>{r.lead_time_wk}</td>
                            <td style={td}>{n0(r.moq)}</td>
                            <td style={td}>{n0(r.run_rate_wk)}</td>
                            <td style={td}>{n0(r.forecast_wk)}</td>
                            <td style={{ ...td, fontWeight: 600 }}>{n0(r.planning_wk)}</td>
                            <td style={td} title={r.cv_source === 'default' ? 'Too little history — default CV used' : 'Measured on lead-time buckets'}>
                              {Number(r.cv_lt).toFixed(2)}{r.cv_source === 'default' ? '*' : ''}
                            </td>
                            <td style={td}>{n0(r.safety_stock)}</td>
                            <td style={td}>{n0(r.rop_min)}</td>
                            <td style={td}>{n0(r.max_level)}</td>
                            <td style={td}>{n0(r.eoq)}</td>
                            <td style={td}>{n0(r.usable)}</td>
                            <td style={td}>{n0(r.incoming)}</td>
                            <td style={td}>{r.woc_usable == null ? '—' : r.woc_usable > 99 ? '99+' : n1(r.woc_usable)}</td>
                            <td style={{ ...td, fontWeight: r.suggested_order_qty > 0 ? 600 : 400 }}>{r.suggested_order_qty > 0 ? n0(r.suggested_order_qty) : '—'}</td>
                            <td style={{ ...td, textAlign: 'left' }}>
                              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${tone.bd}`, background: tone.bg, color: tone.fg, whiteSpace: 'nowrap' }}>{r.status}</span>
                            </td>
                          </tr>
                        )
                      })}
                      {visible.length === 0 && (
                        <tr><td colSpan={17} style={{ ...td, textAlign: 'center', color: '#8B948F', padding: 24 }}>No SKUs match.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 11, color: '#8B948F', marginTop: 10, lineHeight: 1.5 }}>
                  SS = √((z·CV<sub>LT</sub>·μ·LT)² + (z·μ·σ<sub>LT</sub>)²) · ROP = μ·LT + SS · Max = μ·(LT + review) + SS · EOQ floored at MOQ.
                  Service level by ABC (A {policy?.z_a} · B {policy?.z_b} · C {policy?.z_c} z). * = default CV (fewer than {policy?.min_history_wk} weeks with sales).
                  Stock position = usable + incoming in WMS. Suggested order rounds up to MOQ and is zero above ROP.
                  Retired pack SKUs (bottle → box) are excluded; they remain kit components.
                </div>
              </Card>

              {editor && draft && (
                <Card>
                  <h2 style={{ fontSize: 13.5, fontFamily: 'Cambria, Georgia, serif', marginBottom: 4 }}>Policy settings · {fBrand || 'default for all brands'}</h2>
                  <div style={{ fontSize: 11, color: '#667085', marginBottom: 8 }}>{fBrand ? `Applies to ${fBrand} only. Values left at the default follow the default for all brands.` : 'Default used by every brand without its own override. Pick a brand above to set brand-specific values.'}</div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div>
                      <label style={labelStyle}>Planning basis</label>
                      <select value={draft.planning_basis} onChange={e => setDraft({ ...draft, planning_basis: e.target.value as Policy['planning_basis'] })} style={inputStyle}>
                        <option value="max">Max of run rate and forecast</option>
                        <option value="run_rate">Run rate</option>
                        <option value="forecast">Forecast</option>
                      </select>
                    </div>
                    {([
                      ['z_a', 'z · A'], ['z_b', 'z · B'], ['z_c', 'z · C'], ['cv_cap', 'CV cap'], ['default_cv', 'Default CV'],
                      ['run_rate_weeks', 'Run-rate weeks'], ['review_wk', 'Review (wk)'], ['lt_sigma_wk', 'LT σ (wk)'],
                      ['order_cost_rm', 'Order cost (RM)'], ['holding_rate', 'Holding rate'],
                    ] as [keyof Policy, string][]).map(([k, l]) => (
                      <div key={k}>
                        <label style={labelStyle}>{l}</label>
                        <input type="number" step="any" value={draft[k] as number} style={{ ...inputStyle, width: 90 }}
                          onChange={e => setDraft({ ...draft, [k]: Number(e.target.value) })} />
                      </div>
                    ))}
                    <button onClick={savePolicy} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save & recalculate'}</button>
                    {msg && <span style={{ fontSize: 11.5, color: msg.startsWith('Not') ? '#8C2A1E' : '#0F6E56' }}>{msg}</span>}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#4B5563', display: 'block', marginBottom: 3 }
const inputStyle: React.CSSProperties = { fontFamily: 'inherit', fontSize: 12, padding: '5px 7px', border: '1px solid #E4DDD3', borderRadius: 4, background: '#fff', color: '#1F2937' }
const primaryBtn: React.CSSProperties = { fontFamily: 'inherit', fontSize: 11.5, padding: '5px 11px', border: '1px solid #0F6E56', background: '#0F6E56', color: '#fff', borderRadius: 4, cursor: 'pointer' }
const ghostBtn: React.CSSProperties = { ...primaryBtn, background: '#fff', color: '#4B5563', borderColor: '#E4DDD3' }
const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid #E4DDD3' }
const td: React.CSSProperties = { padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap', color: '#1F2937', fontVariantNumeric: 'tabular-nums' }

function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background: '#fff', border: '1px solid #E4DDD3', borderRadius: 6, padding: '14px 16px', marginBottom: 12 }}>{children}</div>
}
function Pill({ children }: { children: React.ReactNode }) {
  return <span style={{ display: 'inline-flex', fontSize: 11, padding: '3px 9px', border: '1px solid #E4DDD3', borderRadius: 999, color: '#4B5563', background: '#fff', whiteSpace: 'nowrap' }}>{children}</span>
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClick} style={{ fontSize: 11, padding: '3px 9px', border: '1px solid', borderRadius: 999, cursor: 'pointer', userSelect: 'none', background: on ? '#2E2A24' : '#fff', borderColor: on ? '#2E2A24' : '#E4DDD3', color: on ? '#fff' : '#4B5563' }}>
      {children}
    </div>
  )
}
