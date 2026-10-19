'use client'
// Forecast Accuracy — weekly attach-rate forecast vs actual, WMAPE and bias.
// Reads v_attach_rate_accuracy_weekly / _sku (security_invoker → RLS scopes brand owners to their brand).
// The log is written by log_attach_rate_accuracy() (daily pg_cron + before every regenerate); it is insert-only.
// WMAPE = Σ|F−A| / ΣA.  Bias = (ΣF−ΣA) / ΣA  (positive = over-forecast).
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import { isStaff, isBrandOwner } from '@/lib/roles'

interface WeekRow {
  project_id: string; brand: string; week_start_date: string; iso_year: number; iso_week: number
  skus: number; forecast_qty: number; actual_b2c: number; actual_b2b: number
  abs_err: number; abs_err_total: number
}
interface SkuRow {
  project_id: string; brand: string; sku: string; weeks: number; forecast_qty: number
  actual_b2c: number; actual_b2b: number; abs_err: number; abs_err_total: number
}
type Basis = 'total' | 'b2c'

const WINDOW = 8
const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(Number(v)).toLocaleString())
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const signedPct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)

function metrics(forecast: number, actual: number, absErr: number) {
  return {
    wmape: actual > 0 ? absErr / actual : null,
    bias: actual > 0 ? (forecast - actual) / actual : null,
  }
}

export default function ForecastAccuracyPage() {
  const supabase = createClient()
  const router = useRouter()
  const [profile, setProfile] = useState<any>(null)
  const [brands, setBrands] = useState<string[]>([])
  const [weeks, setWeeks] = useState<WeekRow[]>([])
  const [skus, setSkus] = useState<SkuRow[]>([])
  const [projectId, setProjectId] = useState('')
  const [basis, setBasis] = useState<Basis>('total')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)
    if (!isStaff(prof?.role) && !isBrandOwner(prof?.role)) { router.push('/forecast-submit'); return }
    const { data: access } = await supabase.from('user_brand_access').select('brand').eq('user_id', user.id)
    setBrands((access ?? []).map((a: any) => a.brand))
    const [{ data: w, error: e1 }, { data: s, error: e2 }] = await Promise.all([
      supabase.from('v_attach_rate_accuracy_weekly').select('*').order('week_start_date'),
      supabase.from('v_attach_rate_accuracy_sku').select('*'),
    ])
    if (e1 || e2) setError((e1 ?? e2)!.message)
    const wl = (w ?? []) as WeekRow[]
    setWeeks(wl)
    setSkus((s ?? []) as SkuRow[])
    const ids = Array.from(new Set(wl.map(r => r.project_id)))
    const pref = wl.find(r => r.brand === 'iLady')?.project_id ?? ids[0] ?? ''
    setProjectId(pref)
    setLoading(false)
  }

  const projects = useMemo(() => {
    const m = new Map<string, string>()
    weeks.forEach(r => m.set(r.project_id, r.brand))
    const dup = new Set<string>()
    const seen = new Set<string>()
    m.forEach(b => { if (seen.has(b)) dup.add(b); seen.add(b) })
    return Array.from(m.entries())
      .map(([id, brand]) => ({ id, label: dup.has(brand) ? `${brand} (${id})` : brand }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [weeks])

  const actualOf = (r: { actual_b2c: number; actual_b2b: number }) => basis === 'total' ? r.actual_b2c + r.actual_b2b : r.actual_b2c
  const errOf = (r: { abs_err: number; abs_err_total: number }) => basis === 'total' ? r.abs_err_total : r.abs_err

  const projWeeks = useMemo(() => weeks.filter(r => r.project_id === projectId), [weeks, projectId])
  const chartData = useMemo(() => projWeeks.map(r => ({
    week: r.week_start_date.slice(5), Forecast: r.forecast_qty, Actual: actualOf(r),
  })), [projWeeks, basis])

  const recent = projWeeks.slice(-WINDOW)
  const agg = (rows: WeekRow[]) => {
    const f = rows.reduce((a, r) => a + r.forecast_qty, 0)
    const act = rows.reduce((a, r) => a + actualOf(r), 0)
    const err = rows.reduce((a, r) => a + errOf(r), 0)
    return { f, act, ...metrics(f, act, err) }
  }
  const last8 = agg(recent)
  const all = agg(projWeeks)

  const skuRows = useMemo(() => skus.filter(r => r.project_id === projectId)
    .map(r => { const act = actualOf(r); return { ...r, act, ...metrics(r.forecast_qty, act, errOf(r)) } })
    .sort((a, b) => errOf(b) - errOf(a)), [skus, projectId, basis])

  function exportCsv() {
    const head = ['week_start', 'forecast', basis === 'total' ? 'actual_b2c_b2b' : 'actual_b2c', 'abs_error', 'wmape', 'bias']
    const lines = projWeeks.map(r => {
      const act = actualOf(r); const m = metrics(r.forecast_qty, act, errOf(r))
      return [r.week_start_date, r.forecast_qty, act, errOf(r), m.wmape?.toFixed(4) ?? '', m.bias?.toFixed(4) ?? ''].join(',')
    })
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `forecast_accuracy_${projectId}_${basis}.csv`
    a.click()
  }

  const sample = projWeeks.length
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE', fontFamily: 'Calibri, "Segoe UI", sans-serif', fontSize: 13 }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name} userRole={profile?.role} brands={brands} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div style={{ background: '#fff', borderBottom: '1px solid #E4DDD3', padding: '10px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>Forecast Accuracy</div>
          <div style={{ fontSize: 11.5, color: '#4B5563', marginTop: 2 }}>
            Weekly attach-rate forecast vs actual orders · WMAPE and bias · frozen once a week closes
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ padding: '16px 20px 48px' }}>
          {loading ? <div style={{ color: '#8B948F' }}>Loading…</div> : error ? (
            <Card><div style={{ color: '#8C2A1E' }}>Could not load accuracy data: {error}</div></Card>
          ) : projects.length === 0 ? (
            <Card><div style={{ color: '#4B5563' }}>No accuracy history yet. Weeks are logged once they close and sales for that week are loaded.</div></Card>
          ) : (
            <>
              <Card>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <label style={labelStyle}>Brand</label>
                    <select value={projectId} onChange={e => setProjectId(e.target.value)} style={inputStyle}>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Actuals</label>
                    <div style={{ display: 'flex', gap: 5 }}>
                      <Chip on={basis === 'total'} onClick={() => setBasis('total')}>B2C + B2B</Chip>
                      <Chip on={basis === 'b2c'} onClick={() => setBasis('b2c')}>B2C only</Chip>
                    </div>
                  </div>
                  <button onClick={exportCsv} style={{ ...ghostBtn, marginLeft: 'auto' }}>Export CSV</button>
                </div>
              </Card>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 12 }}>
                <Kpi label={`WMAPE · last ${recent.length} wk`} value={pct(last8.wmape)} sub={`all ${sample} wk: ${pct(all.wmape)}`} />
                <Kpi label={`Bias · last ${recent.length} wk`} value={signedPct(last8.bias)} sub={`all ${sample} wk: ${signedPct(all.bias)} · + = over-forecast`} />
                <Kpi label="Forecast vs actual · last wks" value={`${n0(last8.f)} / ${n0(last8.act)}`} sub="units" />
                <Kpi label="Weeks logged" value={String(sample)} sub={sample ? `${projWeeks[0].week_start_date} → ${projWeeks[sample - 1].week_start_date}` : ''} />
              </div>

              <Card>
                <div style={{ fontWeight: 600, color: '#1F2937', marginBottom: 8 }}>Forecast vs actual, units per week</div>
                <div style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer>
                    <LineChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#EFEAE2" />
                      <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="Forecast" stroke="#2C6E9B" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Actual" stroke="#0F6E56" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              <Card>
                <div style={{ fontWeight: 600, color: '#1F2937', marginBottom: 8 }}>Weekly log</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: '#4B5563', fontSize: 11 }}>
                        {['Week commencing', 'SKUs', 'Forecast', 'Actual', 'Abs error', 'WMAPE', 'Bias'].map((h, i) => (
                          <th key={h} style={{ ...th, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...projWeeks].reverse().map(r => {
                        const act = actualOf(r); const m = metrics(r.forecast_qty, act, errOf(r))
                        return (
                          <tr key={r.week_start_date} style={{ borderTop: '1px solid #EFEAE2' }}>
                            <td style={{ ...td, textAlign: 'left' }}>{r.week_start_date} <span style={{ color: '#8B948F' }}>· {r.iso_year}-W{String(r.iso_week).padStart(2, '0')}</span></td>
                            <td style={td}>{r.skus}</td>
                            <td style={td}>{n0(r.forecast_qty)}</td>
                            <td style={td}>{n0(act)}</td>
                            <td style={td}>{n0(errOf(r))}</td>
                            <td style={td}>{pct(m.wmape)}</td>
                            <td style={{ ...td, color: (m.bias ?? 0) > 0.25 ? '#8C2A1E' : (m.bias ?? 0) < -0.25 ? '#7A5B14' : '#1F2937' }}>{signedPct(m.bias)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card>
                <div style={{ fontWeight: 600, color: '#1F2937', marginBottom: 2 }}>By SKU · last {WINDOW} logged weeks</div>
                <div style={{ fontSize: 11, color: '#8B948F', marginBottom: 8 }}>Sorted by absolute error, largest first.</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: '#4B5563', fontSize: 11 }}>
                        {['SKU', 'Weeks', 'Forecast', 'Actual', 'Abs error', 'WMAPE', 'Bias'].map((h, i) => (
                          <th key={h} style={{ ...th, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {skuRows.map(r => (
                        <tr key={r.sku} style={{ borderTop: '1px solid #EFEAE2' }}>
                          <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{r.sku}</td>
                          <td style={td}>{r.weeks}</td>
                          <td style={td}>{n0(r.forecast_qty)}</td>
                          <td style={td}>{n0(r.act)}</td>
                          <td style={td}>{n0(errOf(r))}</td>
                          <td style={td}>{pct(r.wmape)}</td>
                          <td style={{ ...td, color: (r.bias ?? 0) > 0.25 ? '#8C2A1E' : (r.bias ?? 0) < -0.25 ? '#7A5B14' : '#1F2937' }}>{signedPct(r.bias)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div style={{ fontSize: 11, color: '#8B948F' }}>
                Only weeks on or after the latest forecast submission are logged, so every row compares a forecast that existed at the time.
                B2C + B2B is the outflow the S&amp;D balance has to cover; B2C only is the channel the attach rates were derived from.
              </div>
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
function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E4DDD3', borderRadius: 6, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: '#4B5563' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: '#1F2937', fontFamily: 'Cambria, Georgia, serif', marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 11, color: '#8B948F', marginTop: 2 }}>{sub}</div>
    </div>
  )
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClick} style={{ fontSize: 11, padding: '4px 10px', border: '1px solid', borderRadius: 999, cursor: 'pointer', userSelect: 'none', background: on ? '#2E2A24' : '#fff', borderColor: on ? '#2E2A24' : '#E4DDD3', color: on ? '#fff' : '#4B5563' }}>
      {children}
    </div>
  )
}
