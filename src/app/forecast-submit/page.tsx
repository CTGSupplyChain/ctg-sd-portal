'use client'

// ============================================================
// Sales forecast submission — v2
// Row-per-month layout (was a 2-4 col tile grid). Same data layer
// as before: writes through the submit_forecast() RPC into
// forecast_submissions / forecast_monthly. This revision adds:
//   - 12 rows in calendar sequence with quarter separators
//   - Enter/ArrowDown row navigation, paste-a-column autofill
//   - inline bar + prior-submission tick + delta + running total
//   - quick-fill tools (copy last, flat, growth %, clear)
//   - a compare chart + last-6-submissions panel (click = overlay,
//     double-click = pull values into the form)
//   - footer KPIs, Submit / Save draft (draft is local-only —
//     there is no drafts table in the schema, see notes below)
// Amounts are RM'000 throughout: 300 means RM 300,000.
// ============================================================

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import {
  Send, Eraser, AlertCircle, CheckCircle2, Copy, Loader2, Save, Sparkles, TrendingUp,
} from 'lucide-react'

const HORIZON = 12
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const HISTORY_LIMIT = 6
const DRAFT_KEY_PREFIX = 'forecastDraft:'

interface Project {
  id: string
  project_name: string
  brand: string
  company: string
}

interface Submission {
  id: string
  week_code: string
  submitted_at: string
  owner_email: string
  total_rm_k: number
  notes: string | null
  monthsByPeriod: Map<string, number>
}

/** Rolling HORIZON months starting from the current month. */
function rollingMonths(): { label: string; yr: string; period: string; quarter: string }[] {
  const now = new Date()
  const out = []
  for (let i = 0; i < HORIZON; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    out.push({
      label: MONTH_ABBR[d.getMonth()],
      yr: String(d.getFullYear()).slice(2),
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
      quarter: `Q${Math.floor(d.getMonth() / 3) + 1}`,
    })
  }
  return out
}

/** ISO-8601 week number, matching the server's to_char(ts,'IW'/'IYYY'). */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const wk = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `W${wk}/${t.getUTCFullYear()}`
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-MY')
const nf1 = (n: number) => n.toLocaleString('en-MY', { maximumFractionDigits: 1, minimumFractionDigits: 1 })

export default function ForecastSubmitPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState('')
  const [profile, setProfile] = useState<{ email?: string; full_name?: string; role?: string } | null>(null)
  const [navBrands, setNavBrands] = useState<string[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [values, setValues] = useState<(number | null)[]>(Array(HORIZON).fill(null))
  const [notes, setNotes] = useState('')
  const [history, setHistory] = useState<Submission[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [cmpIdx, setCmpIdx] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [horizonWarning, setHorizonWarning] = useState<string | null>(null)

  const months = useMemo(rollingMonths, [])
  const weekCode = useMemo(() => isoWeek(new Date()), [])
  const project = projects.find(p => p.id === projectId) || null
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  // ── Session + project list (RLS scopes the list to the user's brands) ──────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const [{ data, error }, { data: prof }] = await Promise.all([
        supabase.from('projects')
          .select('id, project_name, brand, cPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_DownPage_Downompany')
          .eq('status', 'Active')
          .order('project_name'),
        supabase.from('profiles').select('email, full_name, role').eq('id', session.user.id).single(),
      ])
      if (cancelled) return
      setEmail(session.user.email || '')
      setProfile(prof)
      setNavBrands([...new Set((data || []).map(p => p.brand))].sort())
      if (error) setBanner({ kind: 'err', text: `Could not load projects: ${error.message}` })
      setProjects(data || [])
      setReady(true)
    })()
    return () => { cancelled = true }
  }, [supabase, router])

  // ── Horizon check: does week_calendar cover the full rolling window? ───────
  useEffect(() => {
    ;(async () => {
      const lastPeriod = months[months.length - 1].period
      const { data } = await supabase
        .from('week_calendar')
        .select('monday_date')
        .order('monday_date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data?.monday_date && data.monday_date < lastPeriod) {
        setHorizonWarning(
          `week_calendar ends ${data.monday_date} — before this forecast's last month (${lastPeriod}). ` +
          `Submission still saves fine, but downstream week-level demand translation may drop that month until the calendar is extended.`
        )
      }
    })()
  }, [supabase, months])

  // ── Submission history for the chosen project (last 6, newest first) ──────
  useEffect(() => {
    if (!projectId) { setHistory([]); setCmpIdx(0); return }
    let cancelled = false
    setHistoryLoading(true)
    ;(async () => {
      const { data, error } = await supabase
        .from('forecast_submissions')
        .select('id, week_code, submitted_at, owner_email, total_rm_k, notes, forecast_monthly(period, forecast_rm_k)')
        .eq('project_id', projectId)
        .order('submitted_at', { ascending: false })
        .limit(HISTORY_LIMIT)
      if (cancelled) return
      if (error) { setBanner({ kind: 'err', text: `Could not load history: ${error.message}` }); setHistory([]) }
      else {
        setHistory((data || []).map(d => ({
          id: d.id,
          week_code: d.week_code,
          submitted_at: d.submitted_at,
          owner_email: d.owner_email,
          total_rm_k: Number(d.total_rm_k),
          notes: d.notes,
          monthsByPeriod: new Map(
            ((d as unknown as { forecast_monthly: { period: string; forecast_rm_k: number }[] }).forecast_monthly || [])
              .map(m => [m.period, Number(m.forecast_rm_k)])
          ),
        })))
      }
      setCmpIdx(0)
      setHistoryLoading(false)
    })()
    return () => { cancelled = true }
  }, [projectId, supabase])

  // Load any local draft for this project once history/months are known.
  useEffect(() => {
    if (!projectId || typeof window === 'undefined') return
    const raw = window.localStorage.getItem(DRAFT_KEY_PREFIX + projectId)
    if (!raw) { setValues(Array(HORIZON).fill(null)); setNotes(''); return }
    try {
      const parsed = JSON.parse(raw) as { values: (number | null)[]; notes: string }
      setValues(parsed.values?.length === HORIZON ? parsed.values : Array(HORIZON).fill(null))
      setNotes(parsed.notes || '')
      setBanner({ kind: 'ok', text: 'Loaded your saved draft for this project.' })
    } catch { /* ignore malformed draft */ }
  }, [projectId])

  // Prior submission aligned to the current rolling horizon, per month index.
  const cmpAligned = useMemo(() => {
    if (!history.length) return Array(HORIZON).fill(0)
    const cmp = history[Math.min(cmpIdx, history.length - 1)]
    return months.map(m => cmp.monthsByPeriod.get(m.period) ?? 0)
  }, [history, cmpIdx, months])

  const latest = history[0] || null

  const numeric = useMemo(() => values.map(v => v ?? 0), [values])
  const total = numeric.reduce((a, b) => a + b, 0)
  const filled = values.filter(v => v !== null).length
  const peak = Math.max(...numeric, ...cmpAligned, 1)
  const latestTotal = latest ? latest.total_rm_k : null
  const deltaAbs = latestTotal !== null ? total - latestTotal : null
  const deltaPct = latestTotal && latestTotal > 0 ? ((total - latestTotal) / latestTotal) * 100 : null

  // ── Row input handling: type, Enter/Arrow navigation, paste-fill ──────────
  const setMonth = useCallback((i: number, raw: string) => {
    if (raw === '') { setValues(prev => { const next = [...prev]; next[i] = null; return next }); return }
    if (!/^-?\d*\.?\d*$/.test(raw)) return
    const n = parseFloat(raw)
    setValues(prev => { const next = [...prev]; next[i] = isNaN(n) ? null : Math.max(0, n); return next })
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault()
      inputRefs.current[Math.min(HORIZON - 1, i + 1)]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      inputRefs.current[Math.max(0, i - 1)]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>, i: number) {
    const txt = e.clipboardData.getData('text')
    const parts = txt.split(/[\r\n\t,]+/).map(s => s.replace(/[^\d.\-]/g, '')).filter(s => s !== '')
    if (parts.length > 1) {
      e.preventDefault()
      setValues(prev => {
        const next = [...prev]
        parts.forEach((p, k) => { if (i + k < HORIZON) next[i + k] = Math.round(parseFloat(p)) })
        return next
      })
    }
  }

  // ── Quick-fill tools ────────────────────────────────────────────────────
  function copyLatest() {
    if (!latest) return
    setValues(months.map(m => {
      const v = latest.monthsByPeriod.get(m.period)
      return v === undefined ? null : v
    }))
    setBanner({ kind: 'ok', text: `Copied ${latest.week_code} submission — review before submitting.` })
  }
  function fillFlat() {
    const v = window.prompt('Flat monthly value (RM’000)?', '400')
    const n = v ? parseFloat(v) : NaN
    if (!isNaN(n) && n >= 0) setValues(Array(HORIZON).fill(Math.round(n)))
  }
  function applyGrowth() {
    const baseStr = window.prompt('Starting month value (RM’000)?', String(values[0] ?? 300))
    const base = baseStr ? parseFloat(baseStr) : NaN
    if (isNaN(base) || base < 0) return
    const gStr = window.prompt('Month-on-month growth %?', '3')
    const g = gStr ? parseFloat(gStr) : NaN
    if (isNaN(g)) return
    setValues([...Array(HORIZON)].map((_, i) => Math.round(base * Math.pow(1 + g / 100, i))))
  }
  function clearAll() {
    setValues(Array(HORIZON).fill(null))
    setNotes('')
    setBanner(null)
  }

  // ── History panel interactions ─────────────────────────────────────────
  function pickCompare(i: number) { setCmpIdx(i) }
  function pullSubmission(i: number) {
    const h = history[i]
    setValues(months.map(m => {
      const v = h.monthsByPeriod.get(m.period)
      return v === undefined ? null : v
    }))
    setNotes(h.notes || '')
    setBanner({ kind: 'ok', text: `Pulled values from ${h.week_code} into the form — review before submitting.` })
  }

  // ── Save draft (local-only: no drafts table in the schema yet) ─────────
  function saveDraft() {
    if (!projectId) { setBanner({ kind: 'err', text: 'Select a project first.' }); return }
    setSavingDraft(true)
    window.localStorage.setItem(DRAFT_KEY_PREFIX + projectId, JSON.stringify({ values, notes }))
    setSavingDraft(false)
    setBanner({ kind: 'ok', text: 'Draft saved on this device — it is not yet visible to anyone else.' })
  }

  async function submit() {
    if (!project) { setBanner({ kind: 'err', text: 'Select a project first.' }); return }
    if (total <= 0) { setBanner({ kind: 'err', text: 'Enter at least one month with a value above zero.' }); return }

    setSubmitting(true); setBanner(null)
    const { error } = await supabase.rpc('submit_forecast', {
      p_project_id: project.id,
      p_notes: notes,
      p_months: numeric,
    })
    setSubmitting(false)

    if (error) { setBanner({ kind: 'err', text: `Submission failed: ${error.message}` }); return }

    if (typeof window !== 'undefined') window.localStorage.removeItem(DRAFT_KEY_PREFIX + project.id)
    setBanner({ kind: 'ok', text: `${project.project_name} submitted — ${weekCode}, RM ${fmt(total)}k over ${filled} month${filled === 1 ? '' : 's'}.` })

    // Refresh history so the new submission appears immediately.
    setHistoryLoading(true)
    const { data } = await supabase
      .from('forecast_submissions')
      .select('id, week_code, submitted_at, owner_email, total_rm_k, notes, forecast_monthly(period, forecast_rm_k)')
      .eq('project_id', project.id)
      .order('submitted_at', { ascending: false })
      .limit(HISTORY_LIMIT)
    setHistory((data || []).map(d => ({
      id: d.id,
      week_code: d.week_code,
      submitted_at: d.submitted_at,
      owner_email: d.owner_email,
      total_rm_k: Number(d.total_rm_k),
      notes: d.notes,
      monthsByPeriod: new Map(
        ((d as unknown as { forecast_monthly: { period: string; forecast_rm_k: number }[] }).forecast_monthly || [])
          .map(m => [m.period, Number(m.forecast_rm_k)])
      ),
    })))
    setHistoryLoading(false)
    setValues(Array(HORIZON).fill(null))
    setNotes('')
    setCmpIdx(0)
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F4F2EE' }}>
        <Loader2 size={20} className="animate-spin" style={{ color: '#0E5C56' }} />
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE' }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name}
        userRole={profile?.role} brands={navBrands} />
      <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1320px] mx-auto px-6 py-7">

        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>
              Sales Forecast Submission
            </h1>
            <p className="text-sm mt-1" style={{ color: '#4B5563' }}>
              Rolling 12 months in <strong>RM&rsquo;000</strong> — type <code style={{ fontFamily: 'DM Mono, monospace' }}>300</code> for RM 300,000.
              Paste a column straight from Excel into any month.
            </p>
          </div>
        </div>

        {banner && (
          <div className="mb-4 flex items-start gap-2 px-4 py-3 rounded-xl text-sm border"
               style={{
                 background: banner.kind === 'ok' ? '#ECF5F1' : '#FDF2F0',
                 borderColor: banner.kind === 'ok' ? '#BFDDD3' : '#F3C9C2',
                 color: banner.kind === 'ok' ? '#0E5C56' : '#9B2C1E',
               }}>
            {banner.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
            <span>{banner.text}</span>
          </div>
        )}

        {horizonWarning && (
          <div className="mb-4 flex items-start gap-2 px-4 py-3 rounded-xl text-sm border"
               style={{ background: '#FBF6E9', borderColor: '#E9D9A6', color: '#8A6A16' }}>
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{horizonWarning}</span>
          </div>
        )}

        {/* Context bar */}
        <div className="bg-white rounded-2xl p-4 mb-4 flex items-center gap-6 flex-wrap"
             style={{ border: '1px solid #E4DDD3' }}>
          <Field label="Project">
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="border rounded-lg text-sm px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-[#0E5C56] min-w-[160px]"
              style={{ borderColor: '#E4DDD3', color: '#1F2937' }}
            >
              <option value="">Select project&hellip;</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
            </select>
          </Field>
          <Field label="Brand"><ReadOnly value={project?.brand || '—'} /></Field>
          <Field label="Company"><ReadOnly value={project?.company || '—'} /></Field>
          <Field label="Submitting as"><ReadOnly value={email} /></Field>
          <div className="ml-auto text-right">
            <div className="text-[10.5px] uppercase tracking-widest font-medium" style={{ color: '#9CA3AF' }}>Stamped</div>
            <div className="text-base font-semibold" style={{ fontFamily: 'DM Mono, monospace', color: '#1F2937' }}>{weekCode}</div>
          </div>
        </div>

        {projects.length === 0 && (
          <p className="text-xs mb-4" style={{ color: '#9B2C1E' }}>
            No projects are assigned to your account. Ask supply chain to grant brand access.
          </p>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-4 items-start">

          {/* ── Entry table ──────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E4DDD3' }}>
            <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid #E4DDD3' }}>
              <div className="text-[11px] uppercase tracking-widest font-medium" style={{ color: '#9CA3AF' }}>
                Monthly forecast &mdash; RM&rsquo;000
              </div>
              <div className="ml-auto text-xs" style={{ color: '#9CA3AF' }}>{filled} of {HORIZON} filled</div>
            </div>

            <div className="flex items-center gap-1.5 px-4 py-2.5 flex-wrap" style={{ borderBottom: '1px solid #E4DDD3', background: '#FAF8F5' }}>
              <ToolBtn onClick={copyLatest} disabled={!latest} icon={<Copy size={12} />}>
                {latest ? `Copy ${latest.week_code} submission` : 'Copy last submission'}
              </ToolBtn>
              <ToolBtn onClick={fillFlat} icon={<Sparkles size={12} />}>Fill flat</ToolBtn>
              <ToolBtn onClick={applyGrowth} icon={<TrendingUp size={12} />}>Apply growth %</ToolBtn>
              <ToolBtn onClick={clearAll} icon={<Eraser size={12} />}>Clear</ToolBtn>
              <span className="ml-auto text-[11.5px]" style={{ color: '#9CA3AF' }}>
                Enter / &darr; moves down &middot; paste a column to fill
              </span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: '#9CA3AF' }} className="text-[10.5px] uppercase tracking-wide">
                  <th className="text-left font-medium px-3.5 py-2" style={{ borderBottom: '1px solid #E4DDD3' }}>Month</th>
                  <th className="text-right font-medium px-3.5 py-2" style={{ borderBottom: '1px solid #E4DDD3' }}>RM&rsquo;000</th>
                  <th className="text-left font-medium px-3.5 py-2 w-[34%]" style={{ borderBottom: '1px solid #E4DDD3' }}>Shape</th>
                  <th className="text-right font-medium px-3.5 py-2" style={{ borderBottom: '1px solid #E4DDD3' }}>
                    vs {latest ? latest.week_code : '—'}
                  </th>
                  <th className="text-right font-medium px-3.5 py-2" style={{ borderBottom: '1px solid #E4DDD3' }}>Cum.</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  let cum = 0
                  return months.map((m, i) => {
                    const v = values[i]
                    cum += v ?? 0
                    const cmpV = cmpAligned[i]
                    const diff = v !== null ? v - cmpV : null
                    const pct = diff !== null && cmpV ? (diff / cmpV) * 100 : null
                    const tone = diff === null ? undefined
                      : Math.abs(pct ?? 0) < 0.5 ? 'flat'
                      : diff > 0 ? 'up' : 'down'
                    const isQStart = i % 3 === 0
                    return (
                      <tr key={m.period} style={isQStart && i > 0 ? { borderTop: '1px solid #E4DDD3' } : undefined}>
                        <td className="px-3.5 h-11 font-semibold whitespace-nowrap" style={{ color: '#1F2937' }}>
                          {m.label}<span className="font-normal" style={{ color: '#9CA3AF' }}>&rsquo;{m.yr}</span>
                          {isQStart && (
                            <span className="ml-1.5 text-[10px] rounded px-1 py-px" style={{ border: '1px solid #E4DDD3', color: '#9CA3AF' }}>
                              {m.quarter}
                            </span>
                          )}
                        </td>
                        <td className="px-3.5 text-right">
                          <input
                            ref={el => { inputRefs.current[i] = el }}
                            inputMode="decimal"
                            value={v ?? ''}
                            placeholder="—"
                            onChange={e => setMonth(i, e.target.value)}
                            onKeyDown={e => handleKeyDown(e, i)}
                            onPaste={e => handlePaste(e, i)}
                            className="w-[104px] text-right border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0E5C56]"
                            style={{
                              borderColor: v !== null ? '#0E5C56' : '#E4DDD3',
                              background: v === null ? '#FFFDF5' : '#fff',
                              color: '#1F2937',
                              fontFamily: 'DM Mono, monospace',
                            }}
                          />
                        </td>
                        <td className="px-3.5">
                          <div className="relative h-[9px] rounded-full overflow-hidden" style={{ background: '#EEEAE3', minWidth: 90 }}>
                            <div className="absolute left-0 top-0 bottom-0 rounded-full transition-all"
                                 style={{ width: `${((v ?? 0) / peak) * 100}%`, background: '#0E5C56' }} />
                            {cmpV > 0 && (
                              <div className="absolute -top-0.5 -bottom-0.5" style={{ width: 2, left: `${(cmpV / peak) * 100}%`, background: '#B9B1A4' }} />
                            )}
                          </div>
                        </td>
                        <td className="px-3.5 text-right text-[12.5px] whitespace-nowrap"
                            style={{ color: tone === 'up' ? '#0E5C56' : tone === 'down' ? '#9B2C1E' : '#9CA3AF', fontFamily: 'DM Mono, monospace' }}>
                          {diff === null ? '' : `${diff > 0 ? '+' : ''}${fmt(diff)} (${pct !== null ? `${diff > 0 ? '+' : ''}${pct.toFixed(0)}%` : '—'})`}
                        </td>
                        <td className="px-3.5 text-right text-[12.5px]" style={{ color: '#9CA3AF', fontFamily: 'DM Mono, monospace' }}>
                          {fmt(cum)}
                        </td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>

            <div className="px-4 py-3" style={{ borderTop: '1px solid #E4DDD3' }}>
              <label className="block text-[10.5px] uppercase tracking-widest font-medium mb-1.5" style={{ color: '#9CA3AF' }}>
                Justification / message to supply chain
              </label>
              <textarea
                value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                placeholder="Events, campaigns, channel mix, anything that explains the shape of this forecast."
                className="w-full px-3 py-2 border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0E5C56]"
                style={{ borderColor: '#E4DDD3', color: '#1F2937' }}
              />
            </div>

            <div className="flex items-center gap-5 px-4 py-3.5 flex-wrap" style={{ borderTop: '1px solid #E4DDD3', background: '#FAF8F5' }}>
              <Kpi label="12-month total" value={`RM ${fmt(total)}k`} sub={`RM ${fmt(total * 1000)}`} />
              <Kpi label="Monthly average" value={`RM ${fmt(total / HORIZON)}k`} sub={`across ${HORIZON} months`} />
              <Kpi label={`vs ${latest ? latest.week_code : 'last'} submission`}
                   value={deltaPct === null ? '—' : `${deltaPct >= 0 ? '+' : ''}${nf1(deltaPct)}%`}
                   sub={deltaAbs === null ? 'no prior submission' : `RM ${deltaAbs >= 0 ? '+' : ''}${fmt(deltaAbs)}k`}
                   tone={deltaPct === null ? undefined : Math.abs(deltaPct) >= 25 ? 'warn' : undefined} />
              <div className="ml-auto flex items-center gap-2">
                <button onClick={saveDraft} disabled={!projectId || savingDraft}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm border transition-colors hover:bg-[#E4DDD3] disabled:opacity-40"
                        style={{ borderColor: '#E4DDD3', color: '#4B5563' }}>
                  {savingDraft ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save draft
                </button>
                <button onClick={submit} disabled={submitting || !projectId || total <= 0}
                        className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium text-white transition-opacity disabled:opacity-40"
                        style={{ background: '#0E5C56' }}>
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {submitting ? 'Submitting…' : 'Submit forecast'}
                </button>
              </div>
            </div>
          </div>

          {/* ── Right column: chart + history ───────────────────────── */}
          <div className="flex flex-col gap-4">

            <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E4DDD3' }}>
              <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #E4DDD3' }}>
                <div className="text-[11px] uppercase tracking-widest font-medium" style={{ color: '#9CA3AF' }}>Draft vs history</div>
                <div className="ml-auto text-xs" style={{ color: '#9CA3AF' }}>
                  compare: {history[cmpIdx]?.week_code || '—'}
                </div>
              </div>
              <div className="px-3.5 pt-3 pb-1">
                <CompareChart months={months} values={numeric} cmp={cmpAligned} filled={values.map(v => v !== null)} />
              </div>
              <div className="flex items-center gap-3.5 px-4 pb-3 text-[11.5px] flex-wrap" style={{ color: '#9CA3AF' }}>
                <span className="flex items-center gap-1.5"><i style={{ width: 14, borderTop: '2px solid #0E5C56' }} /> This draft</span>
                <span className="flex items-center gap-1.5"><i style={{ width: 14, borderTop: '2px dashed #9AA5A2' }} /> {history[cmpIdx]?.week_code || 'history'}</span>
              </div>
            </div>

            <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E4DDD3' }}>
              <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #E4DDD3' }}>
                <div className="text-[11px] uppercase tracking-widest font-medium" style={{ color: '#9CA3AF' }}>Previous submissions</div>
                <div className="ml-auto text-xs" style={{ color: '#9CA3AF' }}>last {HISTORY_LIMIT}</div>
              </div>
              <div>
                {historyLoading ? (
                  <div className="flex items-center justify-center py-8"><Loader2 size={16} className="animate-spin" style={{ color: '#0E5C56' }} /></div>
                ) : !projectId ? (
                  <div className="px-4 py-5 text-sm" style={{ color: '#9CA3AF' }}>Select a project to see its submission history.</div>
                ) : history.length === 0 ? (
                  <div className="px-4 py-5 text-sm" style={{ color: '#9CA3AF' }}>No prior submissions on record.</div>
                ) : (
                  history.map((h, i) => {
                    const prevTotal = history[i + 1]?.total_rm_k
                    const chg = prevTotal ? ((h.total_rm_k - prevTotal) / prevTotal) * 100 : null
                    return (
                      <div key={h.id}
                           onClick={() => pickCompare(i)}
                           onDoubleClick={() => pullSubmission(i)}
                           className="grid gap-2.5 items-center px-3.5 py-2.5 cursor-pointer transition-colors"
                           style={{
                             gridTemplateColumns: 'auto 1fr auto',
                             borderBottom: '1px solid #F0EDE8',
                             background: i === cmpIdx ? '#E4EDE9' : undefined,
                           }}>
                        <div>
                          <div className="text-[13px] font-semibold flex items-center gap-1.5" style={{ fontFamily: 'DM Mono, monospace', color: '#1F2937' }}>
                            {h.week_code}
                            {i === 0 && <span className="text-[9.5px] uppercase tracking-wide rounded px-1 py-px" style={{ border: '1px solid #0E5C56', color: '#0E5C56' }}>latest</span>}
                          </div>
                          <div className="text-[11px] mt-0.5" style={{ color: '#9CA3AF' }}>
                            {new Date(h.submitted_at).toLocaleDateString('en-MY')} &middot; {h.owner_email}
                          </div>
                        </div>
                        <div><Spark values={months.map(m => h.monthsByPeriod.get(m.period) ?? 0)} /></div>
                        <div>
                          <div className="text-[13.5px] font-semibold text-right" style={{ fontFamily: 'DM Mono, monospace', color: '#1F2937' }}>
                            RM {fmt(h.total_rm_k)}k
                          </div>
                          <div className="text-[11px] text-right" style={{ color: chg === null ? '#9CA3AF' : chg > 0 ? '#0E5C56' : '#9B2C1E' }}>
                            {chg === null ? '—' : `${chg > 0 ? '+' : ''}${chg.toFixed(1)}% vs prior`}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                {projectId && (
                  <div className="grid gap-2.5 items-center px-3.5 py-2.5" style={{ gridTemplateColumns: 'auto 1fr auto', background: '#FBFAF7' }}>
                    <div>
                      <div className="text-[13px] font-semibold flex items-center gap-1.5" style={{ fontFamily: 'DM Mono, monospace', color: '#1F2937' }}>
                        {weekCode}
                        <span className="text-[9.5px] uppercase tracking-wide rounded px-1 py-px" style={{ border: '1px solid #E4DDD3', color: '#9CA3AF' }}>draft</span>
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: '#9CA3AF' }}>now &middot; {email}</div>
                    </div>
                    <div><Spark values={numeric} /></div>
                    <div>
                      <div className="text-[13.5px] font-semibold text-right" style={{ fontFamily: 'DM Mono, monospace', color: '#1F2937' }}>RM {fmt(total)}k</div>
                      <div className="text-[11px] text-right" style={{ color: '#9CA3AF' }}>unsubmitted</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="px-4 py-2.5 text-[11.5px]" style={{ background: '#FAF8F5', color: '#9CA3AF' }}>
                Click a row to overlay it on the chart. Double-click to copy its values into the form.
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10.5px] uppercase tracking-widest font-medium" style={{ color: '#9CA3AF' }}>{label}</label>
      {children}
    </div>
  )
}
function ReadOnly({ value }: { value: string }) {
  return (
    <input readOnly value={value}
           className="border rounded-lg text-sm px-3 py-1.5 min-w-[150px]"
           style={{ borderColor: '#E4DDD3', background: '#F9F7F4', color: '#4B5563', borderStyle: 'dashed' }} />
  )
}
function ToolBtn({ onClick, disabled, icon, children }: {
  onClick: () => void; disabled?: boolean; icon: React.ReactNode; children: React.ReactNode
}) {
  return (
    <button onClick={onClick} disabled={disabled}
            className="inline-flex items-center gap-1.5 border rounded-md px-2.5 py-1.5 text-xs bg-white transition-colors hover:bg-[#FBFAF7] disabled:opacity-40"
            style={{ borderColor: '#E4DDD3', color: '#334' }}>
      {icon}{children}
    </button>
  )
}
function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warn' }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-widest font-medium" style={{ color: '#9CA3AF' }}>{label}</div>
      <div className="text-[19px] font-semibold" style={{ color: tone === 'warn' ? '#9B2C1E' : '#1F2937', fontFamily: 'DM Mono, monospace' }}>{value}</div>
      <div className="text-[11.5px]" style={{ color: '#9CA3AF' }}>{sub}</div>
    </div>
  )
}

function Spark({ values }: { values: number[] }) {
  const w = 104, h = 22
  const max = Math.max(...values, 1)
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${(i * w / Math.max(1, values.length - 1)).toFixed(1)} ${(h - (v / max) * (h - 3)).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h}>
      <path d={path} fill="none" stroke="#8C9794" strokeWidth={1.4} />
    </svg>
  )
}

function CompareChart({ months, values, cmp, filled }: {
  months: { label: string }[]; values: number[]; cmp: number[]; filled: boolean[]
}) {
  const W = 380, H = 190, L = 34, R = 8, T = 12, B = 26
  const max = Math.max(...values, ...cmp, 1) * 1.15
  const x = (i: number) => L + (i * (W - L - R)) / 11
  const y = (v: number) => H - B - (v / max) * (H - B - T)
  const path = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v || 0).toFixed(1)}`).join(' ')
  const gridFracs = [0, 0.5, 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={190}>
      {gridFracs.map(f => {
        const yy = y(max * f)
        return (
          <g key={f}>
            <line x1={L} x2={W - R} y1={yy} y2={yy} stroke="#EAE5DC" />
            <text x={L - 6} y={yy + 3.5} fontSize={8.5} fill="#9AA5A2" textAnchor="end">{Math.round(max * f)}</text>
          </g>
        )
      })}
      {months.map((m, i) => i % 2 === 0 && (
        <text key={i} x={x(i)} y={H - 9} fontSize={8.5} fill="#9AA5A2" textAnchor="middle">{m.label}</text>
      ))}
      <path d={path(cmp)} fill="none" stroke="#9AA5A2" strokeWidth={1.6} strokeDasharray="4 3" />
      <path d={path(values)} fill="none" stroke="#0E5C56" strokeWidth={2.2} />
      {values.map((v, i) => filled[i] && <circle key={i} cx={x(i)} cy={y(v)} r={2.6} fill="#0E5C56" />)}
    </svg>
  )
}
