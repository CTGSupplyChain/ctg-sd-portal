import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { canBuy } from '@/lib/roles'

export const maxDuration = 30

// PO release list actions: refresh | save | convert | dismiss. Staff (superadmin/admin/buyer) only.
const NEEDS_ORDER = ['Stocked out', 'Below safety stock', 'Order now']

const db = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const iso = (d: Date) => d.toISOString().slice(0, 10)
// Next Monday 00:00 Malaysia time (UTC+8), as an ISO timestamp. On a Monday it means the following Monday.
function nextMondayMyt(from = new Date()): string {
  const my = new Date(from.getTime() + 8 * 3600 * 1000)          // wall clock in MYT, read via UTC getters
  const dow = my.getUTCDay() || 7                                  // Mon=1 .. Sun=7
  const days = 8 - dow
  const target = new Date(Date.UTC(my.getUTCFullYear(), my.getUTCMonth(), my.getUTCDate() + days) - 8 * 3600 * 1000)
  return target.toISOString()
}
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x }

export async function POST(req: NextRequest) {
  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const s = db()
    const { data: { user }, error } = await s.auth.getUser(token)
    if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: prof } = await s.from('profiles').select('role').eq('id', user.id).single()
    if (!canBuy(prof?.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await req.json()
    const now = new Date().toISOString()
    const by = user.email ?? null

    if (body.action === 'refresh') {
      const today = new Date()
      const [{ data: params }, { data: open }, { data: covered }, { data: snoozed }] = await Promise.all([
        s.from('v_inventory_params').select('sku, brand, moq, lead_time_wk, suggested_order_qty, status').in('status', NEEDS_ORDER).gt('suggested_order_qty', 0),
        s.from('po_release_lines').select('id, sku, suggested_qty, reason').eq('status', 'open'),
        // Converted lines whose ETA is still ahead are treated as covered: don't re-suggest.
        s.from('po_release_lines').select('sku').eq('status', 'converted').gte('eta', iso(today)),
        // Dismissed lines stay hidden until their snooze (next Monday 00:00 MYT) has passed.
        s.from('po_release_lines').select('sku').eq('status', 'dismissed').gt('snooze_until', now),
      ])
      const openBySku = new Map((open || []).map((o: any) => [o.sku, o]))
      const coveredSkus = new Set([...(covered || []), ...(snoozed || [])].map((c: any) => c.sku))
      const inserts: any[] = []
      const updates: PromiseLike<any>[] = []
      for (const p of params || []) {
        const sug = Math.round(Number(p.suggested_order_qty))
        const ex: any = openBySku.get(p.sku)
        if (ex) {
          if (ex.suggested_qty !== sug || ex.reason !== p.status) {
            updates.push(s.from('po_release_lines').update({ suggested_qty: sug, reason: p.status, updated_at: now }).eq('id', ex.id).then(r => r))
          }
        } else if (!coveredSkus.has(p.sku)) {
          const moq = Number(p.moq) || 0
          inserts.push({
            sku: p.sku, brand: p.brand, suggested_qty: sug, order_qty: moq > 0 ? Math.ceil(sug / moq) * moq : sug, reason: p.status,
            order_date: iso(today), eta: iso(addDays(today, (Number(p.lead_time_wk) || 0) * 7)), updated_by: by,
          })
        }
      }
      let added = 0
      if (inserts.length) {
        const { error: ie } = await s.from('po_release_lines').insert(inserts)
        if (ie) return NextResponse.json({ error: ie.message }, { status: 500 })
        added = inserts.length
      }
      await Promise.all(updates)
      return NextResponse.json({ success: true, added, updated: updates.length })
    }

    if (body.action === 'import') {
      // Buyer re-uploads the exported CSV with PO numbers filled in: match the open line by SKU.
      const rows: { sku?: string; po_ref?: string; qty?: any; eta?: string }[] = Array.isArray(body.rows) ? body.rows : []
      const { data: open } = await s.from('po_release_lines').select('id, sku').eq('status', 'open')
      const bySku = new Map((open || []).map((o: any) => [String(o.sku).toUpperCase(), o.id]))
      let converted = 0, skippedNoPo = 0
      const notFound: string[] = []
      for (const r of rows) {
        const sku = String(r.sku || '').trim().toUpperCase()
        const ref = String(r.po_ref || '').trim()
        if (!sku) continue
        if (!ref) { skippedNoPo++; continue }
        const id = bySku.get(sku)
        if (!id) { notFound.push(sku); continue }
        const patch: Record<string, any> = { po_ref: ref, status: 'converted', updated_at: now, updated_by: by }
        const q = Math.round(Number(r.qty))
        if (r.qty !== undefined && r.qty !== '' && Number.isFinite(q) && q >= 0) patch.order_qty = q
        if (r.eta && /^\d{4}-\d{2}-\d{2}$/.test(r.eta)) patch.eta = r.eta
        const { error: ie } = await s.from('po_release_lines').update(patch).eq('id', id)
        if (ie) notFound.push(sku); else { converted++; bySku.delete(sku) }
      }
      return NextResponse.json({ success: true, converted, skippedNoPo, notFound })
    }

    const { id } = body
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    let patch: Record<string, any> = { updated_at: now, updated_by: by }
    if (body.action === 'save') {
      if (body.order_qty !== undefined) {
        const q = Math.round(Number(body.order_qty)); if (!Number.isFinite(q) || q < 0) return NextResponse.json({ error: 'Bad qty' }, { status: 400 })
        patch.order_qty = q
      }
      if (body.order_date !== undefined) patch.order_date = body.order_date
      if (body.eta !== undefined) patch.eta = body.eta || null
      if (body.notes !== undefined) patch.notes = body.notes
    } else if (body.action === 'convert') {
      const ref = String(body.po_ref || '').trim()
      if (!ref) return NextResponse.json({ error: 'PO number required' }, { status: 400 })
      patch = { ...patch, po_ref: ref, status: 'converted' }
    } else if (body.action === 'dismiss') {
      patch = { ...patch, status: 'dismissed', snooze_until: nextMondayMyt() }
    } else return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

    const { error: ue } = await s.from('po_release_lines').update(patch).eq('id', id)
    if (ue) return NextResponse.json({ error: ue.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Unknown error' }, { status: 500 })
  }
}
