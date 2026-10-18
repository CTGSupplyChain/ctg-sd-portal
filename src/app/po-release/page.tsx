'use client'
// PO Release — reference list for the buyer. Suggested lines come from v_inventory_params;
// buyer edits qty / dates, places the PO in the procurement/finance system, then pastes the PO number here.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import { canBuy, isStaff } from '@/lib/roles'
import * as XLSX from 'xlsx'

interface Line {
  id: string; sku: string; brand: string | null; suggested_qty: number; order_qty: number
  order_date: string; eta: string | null; reason: string | null; notes: string | null
  po_ref: string | null; status: 'open' | 'converted' | 'dismissed'; updated_at: string
}
interface Ctx { description: string | null; usable: number; incoming: number; woc_usable: number | null; planning_wk: number; target_woc: number | null; moq: number; status: string }

const inputStyle: React.CSSProperties = { border: '1px solid #D0D5DD', borderRadius: 6, padding: '3px 6px', fontSize: 12, background: '#fff' }
const TONE: Record<string, string> = { 'Stocked out': '#2E2A24', 'Below safety stock': '#8C2A1E', 'Order now': '#7A5B14' }

export default function PoReleasePage() {
  const supabase = createClient()
  const router = useRouter()
  const [profile, setProfile] = useState<any>(null)
  const [brands, setBrands] = useState<string[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [ctx, setCtx] = useState<Record<string, Ctx>>({})
  const [tab, setTab] = useState<'open' | 'converted'>('open')
  const [fBrand, setFBrand] = useState('iLady')
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const autoRefreshed = useRef(false)

  useEffect(() => { load() }, [])

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)
    if (!isStaff(prof?.role)) { router.push('/dashboard'); return }

    const { data: b } = await supabase.from('master_sku').select('brand').neq('brand', '')
    setBrands([...new Set((b || []).map((x: any) => x.brand))] as string[])
    const { data: l } = await supabase.from('po_release_lines').select('*').in('status', ['open', 'converted']).order('order_date', { ascending: false })
    setLines((l || []) as Line[])
    const { data: p } = await supabase.from('v_inventory_params').select('sku, description, usable, incoming, woc_usable, planning_wk, target_woc, moq, status')
    const m: Record<string, Ctx> = {}
    ;(p || []).forEach((r: any) => { m[r.sku] = r })
    setCtx(m)
    setLoading(false)
    // Show the latest suggestions on open: refresh once per visit in the background, then reload the list.
    if (canBuy(prof?.role) && !autoRefreshed.current) {
      autoRefreshed.current = true
      setMsg('Updating suggestions…')
      try {
        await call({ action: 'refresh' })
        const { data: l2 } = await supabase.from('po_release_lines').select('*').in('status', ['open', 'converted']).order('order_date', { ascending: false })
        setLines((l2 || []) as Line[])
        setMsg('')
      } catch (e: any) { setMsg(`Could not update suggestions: ${e.message}`) }
    }
  }

  async function call(payload: any) {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/po-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify(payload),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || 'Failed')
    return j
  }
  const act = async (payload: any, ok?: string) => {
    setBusy(true); setMsg('')
    try { const j = await call(payload); await load(); if (ok) setMsg(ok.replace('{added}', j.added).replace('{updated}', j.updated)) }
    catch (e: any) { setMsg(e.message) }
    setBusy(false)
  }

  // Open lines for SKUs no longer in v_inventory_params (e.g. hidden SKUs) are not shown.
  const inScope = (l: Line) => l.status !== 'open' || !!ctx[l.sku]
  const shown = useMemo(() => lines.filter(l => inScope(l) && l.status === tab && (!fBrand || (l.brand || '').toLowerCase() === fBrand.toLowerCase())), [lines, tab, fBrand, ctx])
  const openCount = lines.filter(l => inScope(l) && l.status === 'open' && (!fBrand || (l.brand || '').toLowerCase() === fBrand.toLowerCase())).length
  const editable = canBuy(profile?.role)

  async function importCsv(file: File) {
    setBusy(true); setMsg('')
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true })
      const raw: any[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      const pick = (r: any, names: string[]) => {
        const k = Object.keys(r).find(x => names.includes(x.trim().toLowerCase()))
        return k ? r[k] : ''
      }
      const normDate = (v: any) => {
        const t = String(v || '').trim(); if (!t) return ''
        if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
        const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
        return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''
      }
      const rows = raw.map(r => ({
        sku: pick(r, ['sku']), po_ref: pick(r, ['po number', 'po no', 'po no.', 'po', 'po_ref']),
        qty: pick(r, ['quantity', 'qty']), eta: normDate(pick(r, ['eta'])),
      })).filter(r => String(r.sku).trim())
      if (!rows.length) { setMsg('No SKU column found in the file.'); setBusy(false); return }
      const j = await call({ action: 'import', rows })
      await load()
      setMsg(`Import: ${j.converted} marked converted` + (j.skippedNoPo ? `, ${j.skippedNoPo} without PO number` : '') + (j.notFound?.length ? `, not matched: ${j.notFound.join(', ')}` : ''))
    } catch (e: any) { setMsg(e.message || 'Import failed') }
    setBusy(false)
  }

  function exportCsv() {
    const head = ['Order date', 'SKU', 'Description', 'Quantity', 'ETA', 'Notes', 'PO number']
    const rows = shown.map(l => [l.order_date, l.sku, ctx[l.sku]?.description ?? '', l.order_qty, l.eta ?? '', l.notes ?? '', l.po_ref ?? ''])
    const csv = [head, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `po-release-${tab}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: '#667085', fontWeight: 600, borderBottom: '1px solid #E4DDD3', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #EEE9E1', verticalAlign: 'middle' }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE', fontFamily: 'Calibri, "Segoe UI", sans-serif', fontSize: 13 }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name} userRole={profile?.role} brands={brands} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div style={{ background: '#fff', borderBottom: '1px solid #E4DDD3', padding: '10px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>PO Release</div>
          <div style={{ fontSize: 11.5, color: '#4B5563', marginTop: 2 }}>Reference list for the buyer. Place the PO in the procurement system, then paste the PO number to close the line.</div>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ padding: '16px 20px 48px' }}>
          {loading ? <div style={{ color: '#8B948F' }}>Loading…</div> : (
            <div style={{ background: '#fff', border: '1px solid #E4DDD3', borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <select value={fBrand} onChange={e => setFBrand(e.target.value)} style={inputStyle}>
                  {brands.length > 1 && <option value="">All brands</option>}
                  {brands.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                {(['open', 'converted'] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)} style={{ ...inputStyle, cursor: 'pointer', background: tab === t ? '#0E5C56' : '#fff', color: tab === t ? '#fff' : '#1F2937' }}>
                    {t === 'open' ? `To action · ${openCount}` : 'Converted'}
                  </button>
                ))}
                {msg && <span style={{ fontSize: 12, color: '#4B5563' }}>{msg}</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  {editable && <button disabled={busy} onClick={() => act({ action: 'refresh' }, 'Refreshed: {added} new, {updated} updated')} style={{ ...inputStyle, cursor: 'pointer' }}>Refresh suggestions</button>}
                  <button onClick={exportCsv} style={{ ...inputStyle, cursor: 'pointer' }}>Export CSV</button>
                  {editable && (
                    <label style={{ ...inputStyle, cursor: 'pointer' }} title="Upload the exported CSV with the PO number column filled in">
                      Import PO numbers
                      <input type="file" accept=".csv,.xlsx" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = '' }} />
                    </label>
                  )}
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={th}>Order date</th><th style={th}>SKU</th><th style={th}>Description</th>
                    <th style={th}>Quantity</th><th style={th}>ETA</th><th style={th} title="Usable stock · incoming PO/inbound">Stock · incoming</th><th style={th} title="Weeks of cover on usable stock today (excludes incoming)">WOC now</th><th style={th} title="(usable + incoming + this order) / weekly planning rate">WOC after PO</th><th style={th} title="Order-up-to level in weeks of demand: lead time + review + safety stock">Target WOC</th>
                    <th style={th}>Notes</th><th style={th}>PO number</th><th style={th}></th>
                  </tr></thead>
                  <tbody>
                    {shown.length === 0 && <tr><td style={td} colSpan={11}>{tab === 'open' ? 'Nothing to action. Use "Refresh suggestions".' : 'No converted lines yet.'}</td></tr>}
                    {shown.map(l => {
                      const c = ctx[l.sku]
                      const ro = !editable || l.status !== 'open'
                      return (
                        <tr key={l.id}>
                          <td style={td}><input type="date" defaultValue={l.order_date} disabled={ro} style={inputStyle} onBlur={e => e.target.value !== l.order_date && act({ action: 'save', id: l.id, order_date: e.target.value })} /></td>
                          <td style={td}><div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{l.sku}</div>{l.reason && <div style={{ fontSize: 10.5, color: TONE[l.reason] || '#667085' }}>{l.reason}</div>}</td>
                          <td style={{ ...td, maxWidth: 260 }}>{c?.description ?? ''}</td>
                          <td style={td}>
                            <input type="number" min={0} defaultValue={l.order_qty} disabled={ro} style={{ ...inputStyle, width: 84 }} onBlur={e => Number(e.target.value) !== l.order_qty && act({ action: 'save', id: l.id, order_qty: e.target.value })} />
                            <div style={{ fontSize: 10.5, color: '#98A2B3' }}>suggested {l.suggested_qty.toLocaleString()}{c?.moq ? ` · MOQ ${c.moq.toLocaleString()}` : ''}</div>
                          </td>
                          <td style={td}><input type="date" defaultValue={l.eta ?? ''} disabled={ro} style={inputStyle} onBlur={e => e.target.value !== (l.eta ?? '') && act({ action: 'save', id: l.id, eta: e.target.value })} /></td>
                          <td style={{ ...td, whiteSpace: 'nowrap', fontSize: 12 }}>{c ? `${Math.round(c.usable).toLocaleString()} · ${Math.round(c.incoming).toLocaleString()}` : '—'}</td>
                          <td style={{ ...td, fontSize: 12 }}>{c?.woc_usable == null ? '—' : Number(c.woc_usable).toFixed(1)}</td>
                          <td style={{ ...td, fontSize: 12 }}>{c && Number(c.planning_wk) > 0 ? ((Number(c.usable) + Number(c.incoming) + Number(l.order_qty)) / Number(c.planning_wk)).toFixed(1) : '—'}</td>
                          <td style={{ ...td, fontSize: 12 }}>{c?.target_woc == null ? '—' : Number(c.target_woc).toFixed(1)}</td>
                          <td style={td}><input defaultValue={l.notes ?? ''} disabled={ro} style={{ ...inputStyle, width: 140 }} onBlur={e => e.target.value !== (l.notes ?? '') && act({ action: 'save', id: l.id, notes: e.target.value })} /></td>
                          <td style={td}>
                            {l.status === 'converted' ? <b>{l.po_ref}</b> : (
                              <input value={refs[l.id] ?? ''} disabled={!editable} placeholder="Paste PO no." style={{ ...inputStyle, width: 130 }} onChange={e => setRefs(r => ({ ...r, [l.id]: e.target.value }))} />
                            )}
                          </td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>
                            {l.status === 'open' && editable && (<>
                              <button disabled={busy || !(refs[l.id] || '').trim()} onClick={() => act({ action: 'convert', id: l.id, po_ref: refs[l.id] })} style={{ ...inputStyle, cursor: 'pointer', background: '#0E5C56', color: '#fff', opacity: (refs[l.id] || '').trim() ? 1 : 0.4 }}>Mark converted</button>{' '}
                              <button disabled={busy} title="Hide until next Monday 00:00; returns then if the SKU still needs ordering" onClick={() => act({ action: 'dismiss', id: l.id })} style={{ ...inputStyle, cursor: 'pointer' }}>Dismiss</button>
                            </>)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
