'use client'

// ============================================================
// Forecast Log
// Replaces the old "Forecast Sync" screen. That page pulled from
// the Google Sheet via a service account and rendered a hardcoded
// trend snapshot; submissions now land directly in Supabase, so
// everything here is queried live.
// ============================================================

import { useState, useEffect, useMemo, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import BackToSD from '@/components/layout/BackToSD'
import { Loader2, AlertTriangle, FileWarning, Send } from 'lucide-react'

const STALE_WEEKS = 4

interface SubRow {
  id: string
  project_id: string
  project_name: string
  brand: string
  company: string | null
  owner_email: string
  submitted_at: string
  week_code: string
  total_rm_k: number
  notes: string | null
  is_latest: boolean
  source: string
}

interface Trend {
  project: string
  brand: string
  company: string | null
  subs: number
  latest: SubRow
  prevTotal: number | null
  deltaPct: number | null
  status: 'up' | 'down' | 'volatile' | 'single'
  spark: number[]
  weeksSince: number
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-MY')

function weeksBetween(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (7 * 86400000))
}

export default function ForecastLogPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<SubRow[]>([])
  const [activeProjects, setActiveProjects] = useState<{ id: string; project_name: string; brand: string }[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [subs, projs] = await Promise.all([
        supabase.from('forecast_submissions')
          .select('id, project_id, project_name, brand, company, owner_email, submitted_at, week_code, total_rm_k, notes, is_latest, source')
          .order('submitted_at', { ascending: true }),
        supabase.from('projects').select('id, project_name, brand').eq('status', 'Active'),
      ])
      if (subs.error) setError(subs.error.message)
      setRows((subs.data || []).map(r => ({ ...r, total_rm_k: Number(r.total_rm_k) })))
      setActiveProjects(projs.data || [])
      setLoading(false)
    })()
  }, [supabase, router])

  const trends: Trend[] = useMemo(() => {
    const byProject = new Map<string, SubRow[]>()
    for (const r of rows) {
      if (!byProject.has(r.project_id)) byProject.set(r.project_id, [])
      byProject.get(r.project_id)!.push(r)
    }
    const out: Trend[] = []
    byProject.forEach(list => {
      const latest = list[list.length - 1]
      const prevTotal = list.length > 1 ? list[list.length - 2].total_rm_k : null
      const deltaPct = prevTotal && prevTotal > 0
        ? ((latest.total_rm_k - prevTotal) / prevTotal) * 100 : null
      const status: Trend['status'] =
        list.length === 1 ? 'single'
        : deltaPct === null ? 'single'
        : Math.abs(deltaPct) >= 25 ? 'volatile'
        : deltaPct >= 0 ? 'up' : 'down'
      out.push({
        project: latest.project_name, brand: latest.brand, company: latest.company,
        subs: list.length, latest, prevTotal, deltaPct, status,
        spark: list.map(r => r.total_rm_k),
        weeksSince: weeksBetween(latest.submitted_at),
      })
    })
    return out.sort((a, b) => b.latest.total_rm_k - a.latest.total_rm_k)
  }, [rows])

  const submitted = new Set(rows.map(r => r.project_id))
  const missing = activeProjects.filter(p => !submitted.has(p.id))
  const stale = trends.filter(t => t.weeksSince >= STALE_WEEKS)
  const bookRmK = trends.reduce((a, t) => a + t.latest.total_rm_k, 0)

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F4F2EE' }}>
        <Loader2 size={20} className="animate-spin" style={{ color: '#0E5C56' }} />
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#F4F2EE' }}>
      <div className="max-w-6xl mx-auto px-6 py-7">

        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>
              Forecast Log
            </h1>
            <p className="text-sm mt-1" style={{ color: '#4B5563' }}>
              Every forecast submission, live from the portal database. Amounts in RM&rsquo;000.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.push('/forecast-submit')}
                    className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg text-white"
                    style={{ background: '#0E5C56' }}>
              <Send size={13} /> New submission
            </button>
            <BackToSD />
          </div>
        </div>

        {error && (
          <div className="mb-5 px-4 py-3 rounded-xl text-sm border"
               style={{ background: '#FDF2F0', borderColor: '#F3C9C2', color: '#9B2C1E' }}>
            {error}
          </div>
        )}

        {/* Coverage */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <Stat label="Projects forecasting" value={String(trends.length)} sub={`of ${activeProjects.length} active`} />
          <Stat label="Submissions on record" value={String(rows.length)} sub="all time" />
          <Stat label="Latest book" value={`RM ${fmt(bookRmK)}k`} sub="sum of latest per project" />
          <Stat label="Needs attention" value={String(stale.length + missing.length)}
                sub={`${stale.length} stale · ${missing.length} never submitted`}
                tone={stale.length + missing.length > 0 ? 'warn' : undefined} />
        </div>

        {(stale.length > 0 || missing.length > 0) && (
          <div className="rounded-2xl p-4 mb-5" style={{ background: '#FDF8EE', border: '1px solid #F0DFC0' }}>
            <div className="flex items-center gap-1.5 text-sm font-medium mb-2" style={{ color: '#85530B' }}>
              <AlertTriangle size={14} /> Forecast coverage gaps
            </div>
            {stale.length > 0 && (
              <p className="text-sm mb-1" style={{ color: '#85530B' }}>
                <strong>Stale ({STALE_WEEKS}+ weeks):</strong>{' '}
                {stale.map(t => `${t.project} (${t.weeksSince}w)`).join(', ')}
              </p>
            )}
            {missing.length > 0 && (
              <p className="text-sm" style={{ color: '#85530B' }}>
                <strong>Never submitted:</strong> {missing.map(p => p.project_name).join(', ')}
              </p>
            )}
          </div>
        )}

        {/* Trend table */}
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E4DDD3' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#F9F7F4', borderBottom: '1px solid #E4DDD3' }}>
                {['Project', 'Brand', 'Subs', 'Trend', 'Previous', 'Latest', 'Δ', 'Week', 'Age'].map((h, i) => (
                  <th key={h}
                      className={`px-3 py-2.5 text-xs font-medium ${i >= 4 && i <= 6 ? 'text-right' : 'text-left'}`}
                      style={{ color: '#9CA3AF' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trends.map(t => (
                <Fragment key={t.latest.project_id}>
                  <tr
                      onClick={() => setExpanded(expanded === t.latest.project_id ? null : t.latest.project_id)}
                      className="cursor-pointer hover:bg-[#F9F7F4]"
                      style={{ borderBottom: '1px solid #F4F2EE' }}>
                    <td className="px-3 py-2.5 font-medium" style={{ color: '#1F2937' }}>{t.project}</td>
                    <td className="px-3 py-2.5" style={{ color: '#4B5563' }}>{t.brand}</td>
                    <td className="px-3 py-2.5" style={{ color: '#4B5563', fontFamily: 'DM Mono, monospace' }}>{t.subs}</td>
                    <td className="px-3 py-2.5"><Sparkline values={t.spark} status={t.status} /></td>
                    <td className="px-3 py-2.5 text-right" style={{ color: '#9CA3AF', fontFamily: 'DM Mono, monospace' }}>
                      {t.prevTotal === null ? '—' : fmt(t.prevTotal)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium" style={{ color: '#1F2937', fontFamily: 'DM Mono, monospace' }}>
                      {fmt(t.latest.total_rm_k)}
                    </td>
                    <td className="px-3 py-2.5 text-right" style={{ fontFamily: 'DM Mono, monospace', color: deltaColor(t.deltaPct) }}>
                      {t.deltaPct === null ? '—' : `${t.deltaPct >= 0 ? '+' : ''}${t.deltaPct.toFixed(1)}%`}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: '#4B5563', fontFamily: 'DM Mono, monospace' }}>{t.latest.week_code}</td>
                    <td className="px-3 py-2.5 text-xs" style={{ color: t.weeksSince >= STALE_WEEKS ? '#C5453F' : '#9CA3AF' }}>
                      {t.weeksSince}w
                    </td>
                  </tr>
                  {expanded === t.latest.project_id && (
                    <tr style={{ background: '#F9F7F4', borderBottom: '1px solid #F4F2EE' }}>
                      <td colSpan={9} className="px-3 py-3">
                        <div className="text-xs mb-1" style={{ color: '#9CA3AF' }}>
                          Submitted {new Date(t.latest.submitted_at).toLocaleString('en-MY')} by {t.latest.owner_email}
                          {t.latest.source === 'gsheet_migration' && ' · migrated from Google Sheet'}
                        </div>
                        {t.latest.notes
                          ? <div className="text-sm" style={{ color: '#1F2937' }}>{t.latest.notes}</div>
                          : <div className="flex items-center gap-1.5 text-sm" style={{ color: '#9CA3AF' }}>
                              <FileWarning size={13} /> No justification given.
                            </div>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {trends.length === 0 && (
            <div className="px-4 py-10 text-center text-sm" style={{ color: '#9CA3AF' }}>
              No forecast submissions yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function deltaColor(d: number | null) {
  if (d === null) return '#9CA3AF'
  if (Math.abs(d) >= 25) return '#C5453F'
  return d >= 0 ? '#085041' : '#85530B'
}

function Sparkline({ values, status }: { values: number[]; status: Trend['status'] }) {
  if (values.length < 2) return <span className="text-xs" style={{ color: '#9CA3AF' }}>&mdash;</span>
  const w = 70, h = 22, pad = 2
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / span) * (h - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const stroke = status === 'volatile' ? '#C5453F' : status === 'down' ? '#85530B' : '#085041'
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub: string; tone?: 'warn'
}) {
  return (
    <div className="bg-white rounded-2xl px-4 py-3" style={{ border: '1px solid #E4DDD3' }}>
      <div className="text-xs mb-1" style={{ color: '#9CA3AF' }}>{label}</div>
      <div className="text-lg font-semibold"
           style={{ color: tone === 'warn' ? '#9B2C1E' : '#1F2937', fontFamily: 'DM Mono, monospace' }}>
        {value}
      </div>
      <div className="text-xs mt-0.5" style={{ color: '#9CA3AF' }}>{sub}</div>
    </div>
  )
}
