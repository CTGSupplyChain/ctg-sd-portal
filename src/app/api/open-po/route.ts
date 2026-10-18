import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { canEdit } from '@/lib/roles'

// Manual open-PO entry from the S&D grid (superadmin / admin only).
// One row per SKU per arrival week: po_number = OPEN-<sku>-<wk_label>.
// qty = 0 marks the row Cancelled (kept for audit, ignored by the grid).

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const token = authHeader.replace('Bearer ', '')
    const db = getSupabase()
    const { data: { user }, error: authError } = await db.auth.getUser(token)
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await db.from('profiles').select('role').eq('id', user.id).single()
    if (!canEdit(profile?.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { sku, receipt_wk, qty } = await req.json()
    const q = Math.round(Number(qty))
    if (!sku || !receipt_wk || !Number.isFinite(q) || q < 0) {
      return NextResponse.json({ error: 'sku, receipt_wk and a non-negative qty are required' }, { status: 400 })
    }

    const { data: m } = await db.from('master_sku')
      .select('sku, brand, company, project_id, uom, lead_time_wk').eq('sku', sku).single()
    if (!m) return NextResponse.json({ error: 'Unknown SKU' }, { status: 404 })

    const { data: wk } = await db.from('week_calendar')
      .select('monday_date').eq('wk_label', receipt_wk).limit(1).single()
    if (!wk) return NextResponse.json({ error: 'Unknown week' }, { status: 400 })

    const now = new Date().toISOString()
    const record = {
      po_number: `OPEN-${sku}-${receipt_wk}`,
      sku,
      brand: m.brand,
      company: m.company,
      project_id: m.project_id,
      uom: m.uom,
      lead_time_wk: m.lead_time_wk,
      qty: q,
      qty_shipped: 0,
      balance_qty: q,
      unit_price: 0, subtotal: 0, tax_pct: 0, tax_amount: 0, po_total: 0,
      delivery_date: wk.monday_date,
      receipt_wk,
      commit_status: 'Commit',
      status: q > 0 ? 'Open' : 'Cancelled',
      notes: 'Manual entry from S&D grid',
      supplier_name: 'Manual entry',
      uploaded_by: user.email ?? null,
      uploaded_at: now,
      updated_at: now,
    }

    const { error } = await db.from('purchase_orders').upsert(record, { onConflict: 'po_number,sku' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, po_number: record.po_number, qty: q })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 })
  }
}
