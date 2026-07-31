'use client'

// ============================================================
// Sales forecast submission
// Replaces the standalone GitHub Pages form + Apps Script +
// Google Sheet chain. Writes straight to Supabase through the
// submit_forecast() RPC, which derives brand, company, week code
// and totals server-side.
// Amounts are RM'000 throughout: 300 means RM 300,000.
// ============================================================

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import {
  Send, Eraser, AlertCircle, CheckCircle2, History, Copy, Loader2,
} from 'lucide-react'

const HORIZON = 12
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface Project {
  id: string
  project_name: string
  brand: string
  company: string
}

interface PriorSubmission {
  id: string
  week_code: string
  submitted_at: string
  owner_email: string
  total_rm_k: number
  notes: string | null
  months: { period: string; forecast_rm_k: number }[]
}

interface SessionRow {
  project: string
  brand: string
  weekCode: string
  total: number
  at: string
}

/** Rolling HORIZON months starting from the current month. */
function rollingMonths(): { label: string; period: string }[] {
  const now = new Date()
  const out = []
  for (let i = 0; i < HORIZON; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    out.push({
      label: `${MONTH_ABBR[d.getMonth()]}'${String(d.getFullYear()).slice(2)}`,
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
    })
  }
  return out
}

/** ISO-8601 week number, matching the server's to_char(ts,'IW'). */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const wk = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `W${wk}/${t.getUTCFullYear()}`
}

const fmt = (n: number) => n.toLocaleString('en-MY')

export default function ForecastSubmitPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState('')
  const [profile, setProfile] = useState<{ email?: string; full_name?: string; role?: string } | null>(null)
  const [navBrands, setNavBrands] = useState<string[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [values, setValues] = useState<string[]>(Array(HORIZON).fill(''))
  const [notes, setNotes] = useState('')
  const [prior, setPrior] = useState<PriorSubmission | null>(null)
  const [priorLoading, setPriorLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [log, setLog] = useState<SessionRow[]>([])

  const months = useMemo(rollingMonths, [])
  const weekCode = useMemo(() => isoWeek(new Date()), [])
  const project = projects.find(p => p.id === projectId) || null

  // ── Session + project list (RLS scopes the list to the user's brands) ──────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const [{ data, error }, { data: prof }] = await Promise.all([
        supabase.from('projects')
          .select('id, project_name, brand, company')
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

  // ── Previous submission for the chosen project ────────────────────────────
  useEffect(() => {
    if (!projectId) { setPrior(null); return }
    let cancelled = false
    setPriorLoading(true)
    ;(async () => {
      const { data } = await supabase
        .from('forecast_submissions')
        .select('id, week_code, submitted_at, owner_email, total_rm_k, notes, forecast_monthly(period, forecast_rm_k)')
        .eq('project_id', projectId)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      setPrior(data
        ? {
            id: data.id,
            week_code: data.week_code,
            submitted_at: data.submitted_at,
            owner_email: data.owner_email,
            total_rm_k: Number(data.total_rm_k),
            notes: data.notes,
            months: ((data as unknown as { forecast_monthly: { period: string; forecast_rm_k: number }[] }).forecast_monthly || [])
              .slice()
              .sort((a, b) => a.period.localeCompare(b.period)),
          }
        : null)
      setPriorLoading(false)
    })()
    return () => { cancelled = true }
  }, [projectId, supabase])

  const numeric = useMemo(
    () => values.map(v => { const n = parseFloat(v); return isNaN(n) || n < 0 ? 0 : n }),
    [values]
  )
  const total = numeric.reduce((a, b) => a + b, 0)
  const filled = values.filter(v => v.trim() !== '').length
  const peak = Math.max(...numeric, 1)
  const deltaPct = prior && prior.total_rm_k > 0
    ? ((total - prior.total_rm_k) / prior.total_rm_k) * 100
    : null

  const setMonth = useCallback((i: number, v: string) => {
    if (v !== '' && !/^\d*\.?\d*$/.test(v)) return
    setValues(prev => { const next = [...prev]; next[i] = v; return next })
  }, [])

  /** Carry the previous submission forward, aligned by calendar month. */
  function copyPrior() {
    if (!prior) return
    const byPeriod = new Map(prior.months.map(m => [m.period, Number(m.forecast_rm_k)]))
    setValues(months.map(m => {
      const v = byPeriod.get(m.period)
      return v === undefined || v === 0 ? '' : String(v)
    }))
    setNotes(prior.notes || '')
    setBanner({ kind: 'ok', text: `Copied ${prior.week_code} — overlapping months only, review before submitting.` })
  }

  function clearAll() {
    setProjectId(''); setValues(Array(HORIZON).fill('')); setNotes('')
    setPrior(null); setBanner(null)
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

    setLog(prev => [{
      project: project.project_name,
      brand: project.brand,
      weekCode,
      total,
      at: new Date().toLocaleString('en-MY'),
    }, ...prev])
    setBanner({ kind: 'ok', text: `${project.project_name} submitted — ${weekCode}, RM ${fmt(total)}k over ${filled} month${filled === 1 ? '' : 's'}.` })
    setProjectId(''); setValues(Array(HORIZON).fill('')); setNotes(''); setPrior(null)
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
      <div className="max-w-6xl mx-auto px-6 py-7">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>
              Sales Forecast Submission
            </h1>
            <p className="text-sm mt-1" style={{ color: '#4B5563' }}>
              Enter your rolling 12-month forecast in <strong>RM&rsquo;000</strong> — type <code style={{ fontFamily: 'DM Mono, monospace' }}>300</code> for RM 300,000.
              Submissions are stamped {weekCode}.
            </p>
          </div>
        </div>

        {banner && (
          <div className="mb-5 flex items-start gap-2 px-4 py-3 rounded-xl text-sm border"
               style={{
                 background: banner.kind === 'ok' ? '#ECF5F1' : '#FDF2F0',
                 borderColor: banner.kind === 'ok' ? '#BFDDD3' : '#F3C9C2',
                 color: banner.kind === 'ok' ? '#0E5C56' : '#9B2C1E',
               }}>
            {banner.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
            <span>{banner.text}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5">

          {/* ── Left: project details ───────────────────────────────────── */}
          <div className="bg-white rounded-2xl p-5 h-fit" style={{ border: '1px solid #E4DDD3' }}>
            <div className="text-xs uppercase tracking-widest font-medium mb-4" style={{ color: '#9CA3AF' }}>
              Project details
            </div>

            <label className="block text-sm font-medium mb-1" style={{ color: '#1F2937' }}>Project</label>
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm mb-4 bg-white focus:outline-none focus:ring-2 focus:ring-[#0E5C56]"
              style={{ borderColor: '#E4DDD3', color: '#1F2937' }}
            >
              <option value="">Select project&hellip;</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
            </select>
            {projects.length === 0 && (
              <p className="text-xs -mt-3 mb-4" style={{ color: '#9B2C1E' }}>
                No projects are assigned to your account. Ask supply chain to grant brand access.
              </p>
            )}

            <label className="block text-sm font-medium mb-1" style={{ color: '#1F2937' }}>Submitting as</label>
            <input readOnly value={email}
                   className="w-full px-3 py-2 border rounded-lg text-sm mb-4"
                   style={{ borderColor: '#E4DDD3', background: '#F9F7F4', color: '#4B5563' }} />

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#1F2937' }}>Brand</label>
                <input readOnly value={project?.brand || ''} placeholder="&mdash;"
                       className="w-full px-3 py-2 border rounded-lg text-sm"
                       style={{ borderColor: '#E4DDD3', background: '#F9F7F4', color: '#4B5563' }} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#1F2937' }}>Company</label>
                <input readOnly value={project?.company || ''} placeholder="&mdash;"
                       className="w-full px-3 py-2 border rounded-lg text-sm"
                       style={{ borderColor: '#E4DDD3', background: '#F9F7F4', color: '#4B5563' }} />
              </div>
            </div>

            <label className="block text-sm font-medium mb-1" style={{ color: '#1F2937' }}>
              Justification / message to supply chain
            </label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)} rows={4}
              placeholder="Events, campaigns, channel mix, anything that explains the shape of this forecast."
              className="w-full px-3 py-2 border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0E5C56]"
              style={{ borderColor: '#E4DDD3', color: '#1F2937' }}
            />

            {/* Previous submission */}
            {projectId && (
              <div className="mt-4 pt-4" style={{ borderTop: '1px solid #E4DDD3' }}>
                <div className="flex items-center gap-1.5 text-xs uppercase tracking-widest font-medium mb-2" style={{ color: '#9CA3AF' }}>
                  <History size={12} /> Previous submission
                </div>
                {priorLoading ? (
                  <div className="text-sm" style={{ color: '#9CA3AF' }}>Loading&hellip;</div>
                ) : prior ? (
                  <>
                    <div className="text-sm" style={{ color: '#1F2937' }}>
                      <span style={{ fontFamily: 'DM Mono, monospace' }}>{prior.week_code}</span>
                      {' · '}RM {fmt(prior.total_rm_k)}k
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: '#9CA3AF' }}>
                      {new Date(prior.submitted_at).toLocaleDateString('en-MY')} by {prior.owner_email}
                    </div>
                    <button onClick={copyPrior}
                            className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors hover:bg-[#E4DDD3]"
                            style={{ borderColor: '#E4DDD3', color: '#4B5563', background: '#F4F2EE' }}>
                      <Copy size={12} /> Copy forward
                    </button>
                  </>
                ) : (
                  <div className="text-sm" style={{ color: '#9CA3AF' }}>No prior submission on record.</div>
                )}
              </div>
            )}
          </div>

          {/* ── Right: monthly grid ─────────────────────────────────────── */}
          <div className="bg-white rounded-2xl p-5" style={{ border: '1px solid #E4DDD3' }}>
            <div className="flex items-baseline justify-between mb-4">
              <div className="text-xs uppercase tracking-widest font-medium" style={{ color: '#9CA3AF' }}>
                Monthly forecast &mdash; RM&rsquo;000
              </div>
              <div className="text-xs" style={{ color: '#9CA3AF' }}>
                {filled} of {HORIZON} months filled
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-5">
              {months.map((m, i) => (
                <div key={m.period}>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#4B5563', fontFamily: 'DM Mono, monospace' }}>
                    {m.label}
                  </label>
                  <input
                    inputMode="decimal"
                    value={values[i]}
                    onChange={e => setMonth(i, e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-2 border rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0E5C56]"
                    style={{
                      borderColor: values[i] ? '#0E5C56' : '#E4DDD3',
                      color: '#1F2937',
                      fontFamily: 'DM Mono, monospace',
                    }}
                  />
                  <div className="h-1 rounded-full mt-1.5" style={{ background: '#F0EDE8' }}>
                    <div className="h-1 rounded-full transition-all"
                         style={{ width: `${(numeric[i] / peak) * 100}%`, background: '#0E5C56' }} />
                  </div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <Stat label="12-month total" value={total > 0 ? `RM ${fmt(total)}k` : '—'}
                    sub={total > 0 ? `RM ${fmt(total * 1000)}` : 'Enter forecast above'} />
              <Stat label="Monthly average" value={total > 0 ? `RM ${fmt(Math.round(total / HORIZON))}k` : '—'}
                    sub={`across ${HORIZON} months`} />
              <Stat label="vs previous"
                    value={deltaPct === null ? '—' : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`}
                    sub={prior ? `was RM ${fmt(prior.total_rm_k)}k` : 'no prior submission'}
                    tone={deltaPct === null ? undefined : Math.abs(deltaPct) >= 25 ? 'warn' : 'ok'} />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={submit}
                disabled={submitting || !projectId || total <= 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity disabled:opacity-40"
                style={{ background: '#0E5C56' }}
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {submitting ? 'Submitting…' : 'Submit forecast'}
              </button>
              <button
                onClick={clearAll}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm border transition-colors hover:bg-[#E4DDD3]"
                style={{ borderColor: '#E4DDD3', color: '#4B5563' }}
              >
                <Eraser size={14} /> Clear
              </button>
              {deltaPct !== null && Math.abs(deltaPct) >= 25 && (
                <span className="text-xs ml-1" style={{ color: '#9B2C1E' }}>
                  {Math.abs(deltaPct).toFixed(0)}% swing vs your last submission — worth a note.
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Session log */}
        {log.length > 0 && (
          <div className="bg-white rounded-2xl p-5 mt-5" style={{ border: '1px solid #E4DDD3' }}>
            <div className="text-xs uppercase tracking-widest font-medium mb-3" style={{ color: '#9CA3AF' }}>
              Submitted this session
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: '#9CA3AF' }} className="text-xs text-left">
                  <th className="pb-2 font-medium">Project</th>
                  <th className="pb-2 font-medium">Brand</th>
                  <th className="pb-2 font-medium">Week</th>
                  <th className="pb-2 font-medium text-right">Total</th>
                  <th className="pb-2 font-medium text-right">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #F0EDE8', color: '#1F2937' }}>
                    <td className="py-2">{r.project}</td>
                    <td className="py-2" style={{ color: '#4B5563' }}>{r.brand}</td>
                    <td className="py-2" style={{ fontFamily: 'DM Mono, monospace', color: '#4B5563' }}>{r.weekCode}</td>
                    <td className="py-2 text-right" style={{ fontFamily: 'DM Mono, monospace' }}>RM {fmt(r.total)}k</td>
                    <td className="py-2 text-right text-xs" style={{ color: '#9CA3AF' }}>{r.at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub: string; tone?: 'ok' | 'warn'
}) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: '#F9F7F4', border: '1px solid #F0EDE8' }}>
      <div className="text-xs mb-1" style={{ color: '#9CA3AF' }}>{label}</div>
      <div className="text-lg font-semibold"
           style={{
             color: tone === 'warn' ? '#9B2C1E' : '#1F2937',
             fontFamily: 'DM Mono, monospace',
           }}>
        {value}
      </div>
      <div className="text-xs mt-0.5" style={{ color: '#9CA3AF' }}>{sub}</div>
    </div>
  )
}
