'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { Part, PartCategory } from '@/lib/plm-types'
import {
  Search, SlidersHorizontal, ArrowLeft, Boxes, GitBranch, Truck, BarChart3, X,
} from 'lucide-react'

/* ---------- Duro-inspired Item Library: search-first, no navigation panels ----------
   Search understands:
     - free text            → matches part number / description / master SKU
     - where used <term>    → traces every parent up to top-level FG
     - brand:iLady type:FG status:active → inline filter tokens                */

interface BomLine { parent_pn: string; child_pn: string; qty_per: number; uom: string }

const CAT_STYLE: Record<string, { color: string; bg: string }> = {
  FG:  { color: '#7c3aed', bg: '#f3ecfe' },
  SA:  { color: '#0d9488', bg: '#e4f5f3' },
  PK:  { color: '#d97706', bg: '#fcf2e2' },
  RM:  { color: '#be123c', bg: '#fceaef' },
  WIP: { color: '#64748b', bg: '#eef1f5' },
}
const LC_DOT: Record<string, string> = {
  Active: '#12B76A', NPI: '#0E5C56', EOL: '#F79009', Obsolete: '#9CA3AF',
}

function CatChip({ cat }: { cat: PartCategory }) {
  const s = CAT_STYLE[cat] ?? CAT_STYLE.WIP
  return (
    <span className="inline-flex items-center text-xs font-semibold rounded-md px-2 py-0.5"
      style={{ color: s.color, background: s.bg }}>{cat}</span>
  )
}

function LcStatus({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[#4B5563] whitespace-nowrap">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: LC_DOT[status] ?? '#9CA3AF' }} />
      {status}
    </span>
  )
}

interface ParsedQuery { text: string; brand: string; cat: string; status: string; whereUsed: boolean }

function parseQuery(raw: string, fBrand: string, fCat: string, fStatus: string, brands: string[]): ParsedQuery {
  let q = raw.trim()
  const out: ParsedQuery = { text: '', brand: fBrand, cat: fCat, status: fStatus, whereUsed: false }
  const wu = q.match(/^(where\s*used|wu)\s+(.+)$/i)
  if (wu) { out.whereUsed = true; q = wu[2] }
  q = q.replace(/(brand|type|cat|status):(\S+)/gi, (_m, k: string, v: string) => {
    const key = k.toLowerCase()
    if (key === 'brand') out.brand = brands.find(b => b.toLowerCase().startsWith(v.toLowerCase())) ?? v
    if (key === 'type' || key === 'cat') out.cat = v.toUpperCase()
    if (key === 'status') out.status = ['Active', 'NPI', 'EOL', 'Obsolete'].find(s => s.toLowerCase().startsWith(v.toLowerCase())) ?? v
    return ''
  })
  out.text = q.trim().toLowerCase()
  return out
}

const RECENT_KEY = 'plm-recent-items'

export default function PlmLibraryPage() {
  const router = useRouter()
  const [parts, setParts] = useState<Part[]>([])
  const [bom, setBom] = useState<BomLine[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [fBrand, setFBrand] = useState('')
  const [fCat, setFCat] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [popOpen, setPopOpen] = useState(false)
  const [sugOpen, setSugOpen] = useState(false)
  const [sortKey, setSortKey] = useState<keyof Part>('part_number')
  const [sortDir, setSortDir] = useState(1)
  const [recents, setRecents] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.from('parts').select('*').order('part_number'),
      supabase.from('bom_lines').select('parent_pn,child_pn,qty_per,uom').eq('is_active', true),
    ]).then(([{ data: p }, { data: b }]) => {
      setParts((p ?? []) as Part[])
      setBom((b ?? []) as BomLine[])
      setLoading(false)
    })
    try { setRecents(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select()
      }
      if (e.key === 'Escape') { setSugOpen(false); setPopOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const byPn = useMemo(() => Object.fromEntries(parts.map(p => [p.part_number, p])), [parts])
  const brands = useMemo(() => [...new Set(parts.map(p => p.brand ?? 'Other'))].sort(), [parts])
  const childCount = useMemo(() => {
    const m: Record<string, number> = {}
    bom.forEach(b => { m[b.parent_pn] = (m[b.parent_pn] ?? 0) + 1 })
    return m
  }, [bom])
  const parentCount = useMemo(() => {
    const m: Record<string, number> = {}
    bom.forEach(b => { m[b.child_pn] = (m[b.child_pn] ?? 0) + 1 })
    return m
  }, [bom])

  const parentsOf = (pn: string) => bom.filter(b => b.child_pn === pn)
  const topFGs = (pn: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>()
    for (const b of parentsOf(pn)) {
      if (seen.has(b.parent_pn)) continue
      seen.add(b.parent_pn)
      const p = byPn[b.parent_pn]
      if (p && p.category === 'FG') out.add(b.parent_pn)
      topFGs(b.parent_pn, seen).forEach(x => out.add(x))
    }
    return out
  }

  const pq = useMemo(
    () => parseQuery(q, fBrand, fCat, fStatus, brands),
    [q, fBrand, fCat, fStatus, brands],
  )

  const rows = useMemo(() => {
    const matched = parts.filter(p =>
      (!pq.brand || (p.brand ?? 'Other').toLowerCase() === pq.brand.toLowerCase()) &&
      (!pq.cat || p.category === pq.cat) &&
      (!pq.status || p.lifecycle_status.toLowerCase() === pq.status.toLowerCase()) &&
      (!pq.text
        || p.part_number.toLowerCase().includes(pq.text)
        || p.description.toLowerCase().includes(pq.text)
        || (p.master_sku_ref ?? '').toLowerCase().includes(pq.text)),
    )
    return [...matched].sort((a, b) => {
      const av = String(a[sortKey] ?? ''); const bv = String(b[sortKey] ?? '')
      return av.localeCompare(bv) * sortDir
    })
  }, [parts, pq, sortKey, sortDir])

  const suggestions = useMemo(() => {
    if (pq.whereUsed || pq.text.length < 2) return []
    return parts.filter(p =>
      p.part_number.toLowerCase().includes(pq.text) || p.description.toLowerCase().includes(pq.text),
    ).slice(0, 7)
  }, [parts, pq])

  const goto = (pn: string) => {
    const next = [pn, ...recents.filter(x => x !== pn)].slice(0, 8)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    router.push(`/plm/${encodeURIComponent(pn)}`)
  }

  const setSort = (key: keyof Part) => {
    if (sortKey === key) setSortDir(d => -d)
    else { setSortKey(key); setSortDir(1) }
  }
  const arrow = (key: keyof Part) => sortKey === key ? (sortDir > 0 ? ' ▲' : ' ▼') : ''

  const chips: [string, string, () => void][] = []
  if (fBrand) chips.push(['brand', fBrand, () => setFBrand('')])
  if (fCat) chips.push(['type', fCat, () => setFCat('')])
  if (fStatus) chips.push(['status', fStatus, () => setFStatus('')])

  /* ---------- where-used search blocks ---------- */
  const wuBlocks = useMemo(() => {
    if (!pq.whereUsed) return []
    return parts
      .filter(p => p.part_number.toLowerCase().includes(pq.text) || p.description.toLowerCase().includes(pq.text))
      .filter(p => parentsOf(p.part_number).length > 0)
      .slice(0, 10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pq, parts, bom])

  const th = 'text-left text-[10.5px] uppercase tracking-wider text-[#9CA3AF] font-bold px-4 py-2.5 border-b border-[#E4DDD3] bg-[#FAF9F7] whitespace-nowrap select-none'

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE' }}>

      {/* ---------- slim icon rail ---------- */}
      <div className="w-[58px] flex-shrink-0 flex flex-col items-center py-3 gap-1" style={{ background: '#1F2937' }}>
        <div className="w-[34px] h-[34px] rounded-lg flex items-center justify-center text-white font-extrabold text-xs mb-3"
          style={{ background: 'linear-gradient(135deg,#12897F,#0E5C56)' }}>CT</div>
        <button title="Back to Portal" onClick={() => router.push('/dashboard')}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors">
          <ArrowLeft size={18} />
        </button>
        <button title="Library" className="w-10 h-10 rounded-xl flex items-center justify-center text-white relative"
          style={{ background: 'rgba(255,255,255,0.14)' }}>
          <span className="absolute -left-[9px] w-[3px] h-5 rounded" style={{ background: '#12897F' }} />
          <Boxes size={18} />
        </button>
        <button title="Changes (ECO) — coming soon" className="w-10 h-10 rounded-xl flex items-center justify-center text-white/25 cursor-not-allowed">
          <GitBranch size={18} />
        </button>
        <button title="Suppliers — coming soon" className="w-10 h-10 rounded-xl flex items-center justify-center text-white/25 cursor-not-allowed">
          <Truck size={18} />
        </button>
        <button title="Reports — coming soon" className="w-10 h-10 rounded-xl flex items-center justify-center text-white/25 cursor-not-allowed">
          <BarChart3 size={18} />
        </button>
      </div>

      {/* ---------- content ---------- */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1120px] mx-auto px-8 py-7">

          <div className="flex items-baseline gap-3 mb-4">
            <h1 className="text-xl font-bold text-[#1F2937] tracking-tight">Library</h1>
            <span className="text-xs text-[#9CA3AF]">
              {loading ? 'loading…' : `${parts.length} items · ${brands.length} brand${brands.length !== 1 ? 's' : ''}`}
            </span>
          </div>

          {/* hero search */}
          <div className="relative mb-3">
            <Search size={18} className="absolute left-4 top-[15px] text-[#9CA3AF] pointer-events-none" />
            <input
              ref={inputRef}
              value={q}
              onChange={e => { setQ(e.target.value); setSugOpen(true) }}
              onFocus={() => setSugOpen(true)}
              onBlur={() => setTimeout(() => setSugOpen(false), 150)}
              placeholder='Search anything… try "booster 120ml", "where used SA-EYE-007", "type:FG brand:iLady"'
              className="w-full h-12 rounded-xl border border-[#D6D0C6] bg-white pl-12 pr-24 text-sm text-[#1F2937] outline-none focus:border-[#0E5C56] shadow-sm"
              style={{ boxShadow: '0 1px 2px rgba(31,41,55,.04)' }}
              autoComplete="off" spellCheck={false}
            />
            <span className="absolute right-4 top-[14px] text-[11px] text-[#9CA3AF]">
              <kbd className="bg-[#F4F2EE] border border-[#E4DDD3] rounded px-1.5 py-0.5">/</kbd> to focus
            </span>

            {sugOpen && suggestions.length > 0 && (
              <div className="absolute top-[52px] left-0 right-0 bg-white border border-[#E4DDD3] rounded-xl z-40 overflow-hidden"
                style={{ boxShadow: '0 12px 32px rgba(31,41,55,.12)' }}>
                <div className="text-[10.5px] uppercase tracking-wider text-[#9CA3AF] font-bold px-4 pt-2.5 pb-1">Jump to item</div>
                {suggestions.map(p => (
                  <div key={p.part_number}
                    onMouseDown={() => goto(p.part_number)}
                    className="flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-[#DCEAE8] text-[13px]">
                    <span className="font-mono font-semibold text-[#0E5C56] min-w-[110px]">{p.part_number}</span>
                    <span className="text-[#4B5563] truncate flex-1">{p.description}</span>
                    <CatChip cat={p.category} />
                  </div>
                ))}
                <div className="px-4 py-2 text-xs text-[#9CA3AF] border-t border-[#E4DDD3] bg-[#FAF9F7]">
                  {rows.length} matches shown below · <b className="text-[#4B5563]">where used {pq.text}</b> traces parents
                </div>
              </div>
            )}
          </div>

          {/* toolbar */}
          <div className="relative flex items-center gap-2 mb-4 flex-wrap">
            <button onClick={() => setPopOpen(v => !v)}
              className="h-8 px-3 rounded-lg border border-[#D6D0C6] bg-white text-xs font-medium text-[#1F2937] inline-flex items-center gap-1.5 hover:bg-[#FAF9F7]">
              <SlidersHorizontal size={13} /> Filter
            </button>
            {chips.map(([k, v, clear]) => (
              <span key={k} className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full text-xs font-semibold"
                style={{ background: '#DCEAE8', color: '#0E5C56', border: '1px solid rgba(14,92,86,.25)' }}>
                {v}
                <button onClick={clear} className="w-4 h-4 rounded-full inline-flex items-center justify-center hover:bg-[#c8ddd9]">
                  <X size={11} />
                </button>
              </span>
            ))}
            <div className="flex-1" />
            {recents.length > 0 && (
              <>
                <span className="text-xs text-[#9CA3AF]">Recent:</span>
                {recents.slice(0, 5).map(pn => (
                  <button key={pn} onClick={() => goto(pn)}
                    className="h-[26px] px-2.5 rounded-full border border-dashed border-[#D6D0C6] text-[11px] font-mono text-[#4B5563] hover:border-[#0E5C56] hover:text-[#0E5C56] hover:border-solid">
                    {pn}
                  </button>
                ))}
              </>
            )}
            {!pq.whereUsed && <span className="text-xs text-[#9CA3AF]">{rows.length} items</span>}

            {popOpen && (
              <div className="absolute top-9 left-0 bg-white border border-[#E4DDD3] rounded-xl p-4 z-40 min-w-[250px]"
                style={{ boxShadow: '0 12px 32px rgba(31,41,55,.14)' }}>
                {([
                  ['Brand', fBrand, setFBrand, ['', ...brands]],
                  ['Item type', fCat, setFCat, ['', 'FG', 'SA', 'PK', 'RM']],
                  ['Lifecycle', fStatus, setFStatus, ['', 'Active', 'NPI', 'EOL', 'Obsolete']],
                ] as [string, string, (v: string) => void, string[]][]).map(([label, val, set, opts]) => (
                  <div key={label} className="mb-2.5">
                    <div className="text-[10.5px] uppercase tracking-wider text-[#9CA3AF] font-bold mb-1">{label}</div>
                    <select value={val} onChange={e => set(e.target.value)}
                      className="w-full h-8 border border-[#D6D0C6] rounded-lg bg-white text-[13px] px-2 outline-none text-[#1F2937]">
                      {opts.map(o => <option key={o} value={o}>{o === '' ? `All` : o}</option>)}
                    </select>
                  </div>
                ))}
                <div className="flex justify-between mt-3">
                  <button className="text-xs text-[#4B5563] hover:text-[#1F2937]"
                    onClick={() => { setFBrand(''); setFCat(''); setFStatus('') }}>Reset</button>
                  <button className="h-8 px-3 rounded-lg text-xs font-medium text-white"
                    style={{ background: '#0E5C56' }} onClick={() => setPopOpen(false)}>Done</button>
                </div>
              </div>
            )}
          </div>

          {/* results */}
          {loading ? (
            <div className="bg-white rounded-2xl border border-[#E4DDD3] p-12 text-center text-sm text-[#4B5563]">Loading library…</div>
          ) : pq.whereUsed ? (
            wuBlocks.length === 0 ? (
              <div className="bg-white rounded-2xl border border-[#E4DDD3] p-12 text-center">
                <div className="text-[15px] font-semibold text-[#1F2937] mb-1.5">No where-used results for “{pq.text}”</div>
                <div className="text-sm text-[#4B5563]">The part either doesn&apos;t exist or isn&apos;t used in any BOM.</div>
              </div>
            ) : wuBlocks.map(p => (
              <div key={p.part_number} className="bg-white rounded-2xl border border-[#E4DDD3] overflow-hidden mb-4">
                <div className="px-4 py-2.5 border-b border-[#E4DDD3] bg-[#FAF9F7] text-xs">
                  <span className="uppercase tracking-wider text-[#9CA3AF] font-bold">Where used — </span>
                  <span className="font-mono font-semibold text-[#0E5C56]">{p.part_number}</span>
                  <span className="text-[#4B5563]"> · {p.description}</span>
                </div>
                <table className="w-full text-[13px]">
                  <tbody>
                    {parentsOf(p.part_number).map(b => {
                      const pp = byPn[b.parent_pn]
                      if (!pp) return null
                      const fgs = pp.category === 'FG' ? [b.parent_pn] : [...topFGs(b.parent_pn)]
                      return (
                        <tr key={b.parent_pn + b.child_pn} onClick={() => goto(b.parent_pn)}
                          className="cursor-pointer hover:bg-[#F7F6F3] border-b border-[#F0EEE9] last:border-b-0">
                          <td className="px-4 py-2.5 w-40"><span className="font-mono font-semibold text-[#0E5C56] text-xs">{b.parent_pn}</span></td>
                          <td className="px-4 py-2.5 text-[#1F2937]">{pp.description}</td>
                          <td className="px-4 py-2.5 w-16"><CatChip cat={pp.category} /></td>
                          <td className="px-4 py-2.5 w-24 text-right font-mono text-[#4B5563]">{Number(b.qty_per)} {b.uom}</td>
                          <td className="px-4 py-2.5 w-60">
                            {fgs.length === 0 ? <span className="text-[#9CA3AF]">—</span> : fgs.map(f => (
                              <button key={f} onClick={e => { e.stopPropagation(); goto(f) }}
                                className="font-mono font-semibold text-[#0E5C56] text-xs mr-2 hover:underline">{f}</button>
                            ))}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))
          ) : rows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-[#E4DDD3] p-12 text-center">
              <div className="text-[15px] font-semibold text-[#1F2937] mb-1.5">No items match</div>
              <div className="text-sm text-[#4B5563]">Try a different keyword, or clear the filter chips above.</div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-[#E4DDD3] overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th + ' cursor-pointer'} onClick={() => setSort('part_number')}>Part Number{arrow('part_number')}</th>
                    <th className={th + ' cursor-pointer'} onClick={() => setSort('description')}>Description{arrow('description')}</th>
                    <th className={th + ' cursor-pointer'} onClick={() => setSort('category')}>Type{arrow('category')}</th>
                    <th className={th + ' cursor-pointer'} onClick={() => setSort('brand')}>Brand{arrow('brand')}</th>
                    <th className={th}>Rev</th>
                    <th className={th}>Lifecycle</th>
                    <th className={th + ' text-right'}>BOM</th>
                    <th className={th + ' text-right'}>Where Used</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(p => {
                    const nc = childCount[p.part_number] ?? 0
                    const np = parentCount[p.part_number] ?? 0
                    return (
                      <tr key={p.part_number} onClick={() => goto(p.part_number)}
                        className="cursor-pointer hover:bg-[#F7F6F3] border-b border-[#F0EEE9] last:border-b-0">
                        <td className="px-4 py-2.5"><span className="font-mono font-semibold text-[#0E5C56] text-xs whitespace-nowrap">{p.part_number}</span></td>
                        <td className="px-4 py-2.5 text-[#1F2937]">{p.description}</td>
                        <td className="px-4 py-2.5"><CatChip cat={p.category} /></td>
                        <td className="px-4 py-2.5 text-[#4B5563]">{p.brand ?? '—'}</td>
                        <td className="px-4 py-2.5"><span className="font-mono text-xs text-[#4B5563] bg-[#F4F2EE] rounded px-1.5 py-0.5">{p.current_revision}</span></td>
                        <td className="px-4 py-2.5"><LcStatus status={p.lifecycle_status} /></td>
                        <td className="px-4 py-2.5 text-right font-mono text-[#4B5563]">{nc > 0 ? nc : <span className="text-[#D6D0C6]">—</span>}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="inline-flex items-center text-[11.5px] rounded-full px-2 py-0.5"
                            style={np > 0
                              ? { color: '#0E5C56', background: '#DCEAE8', fontWeight: 600 }
                              : { color: '#9CA3AF', background: '#F4F2EE' }}>{np}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="text-xs text-[#9CA3AF] mt-3">
            Search understands <b className="text-[#4B5563]">where used &lt;part&gt;</b> and inline filters like{' '}
            <b className="text-[#4B5563]">type:FG</b>, <b className="text-[#4B5563]">brand:iLady</b>,{' '}
            <b className="text-[#4B5563]">status:active</b> — no navigation panels needed.
          </div>
        </div>
      </div>
    </div>
  )
}
