import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

// ============================================================
// Component (RM/PK/SA/WIP) Purchase Orders — mirrors
// /api/supply-input, keyed by part_number instead of sku.
// Same purchase_orders table (part_number column, previously
// unused), same commit/uncommit + balance_qty conventions.
// ============================================================

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Convert DD/MM/YYYY string to ISO date or null
function parseDate(val: any): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const str = String(val).trim()
  if (!str) return null
  // DD/MM/YYYY
  const ddmm = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (ddmm) return `${ddmm[3]}-${ddmm[2].padStart(2,'0')}-${ddmm[1].padStart(2,'0')}`
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str
  // D-Mon-YYYY or DD-Mon-YYYY (e.g. "9-Jan-2026", "22-Jan-2026")
  const MONTHS: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  }
  const dmonY = str.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{4})$/)
  if (dmonY) {
    const mon = MONTHS[dmonY[2].slice(0, 3).toLowerCase()]
    if (mon) return `${dmonY[3]}-${mon}-${dmonY[1].padStart(2, '0')}`
  }
  // Excel serial number
  const num = parseFloat(str)
  if (!isNaN(num) && num > 40000) {
    const d = new Date(Math.round((num - 25569) * 86400 * 1000))
    return d.toISOString().split('T')[0]
  }
  return null
}

// Convert delivery_date to WK label matching portal's ISO week_calendar e.g. "WK22"
function dateToWkLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const dayOfWeek = d.getUTCDay() || 7          // Sun=7, Mon=1
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek)  // shift to Thursday
  // d is now the Thursday of the week, so its year IS the ISO year.
  const isoYear = d.getUTCFullYear()
  const jan1 = new Date(Date.UTC(isoYear, 0, 1))
  const isoWeek = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7)
  // Year-qualified: week_calendar.wk_label is unique per ISO year, so a bare
  // 'WK01' is ambiguous across the 2026-W53 / 2027-W01 boundary.
  return `${isoYear}-WK${String(isoWeek).padStart(2, '0')}`
}

// Add weeks to a date string
function addWeeks(dateStr: string, weeks: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + weeks * 7)
  return d.toISOString().split('T')[0]
}

export async function PATCH(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await getSupabase().auth.getUser(token)
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getSupabase().from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'supply_chain') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await req.json()
    const { id, ...fields } = body
    if (!id) return NextResponse.json({ error: 'PO id is required' }, { status: 400 })
    if (!Object.keys(fields).length) return NextResponse.json({ error: 'No fields to update' }, { status: 400 })

    const { data: existing } = await getSupabase()
      .from('purchase_orders').select('*').eq('id', id).single()
    if (!existing) return NextResponse.json({ error: 'PO not found' }, { status: 404 })
    if (!existing.part_number) return NextResponse.json({ error: 'Not a component PO' }, { status: 400 })

    const merged = { ...existing, ...fields }
    const qty = Number(merged.qty) || 0
    const qtyShipped = Number(merged.qty_shipped) || 0
    fields.balance_qty = qty - qtyShipped

    if ('qty' in fields || 'unit_price' in fields || 'tax_pct' in fields) {
      const unitPrice = Number(merged.unit_price) || 0
      const taxPct = Number(merged.tax_pct) || 0
      const subtotal = qty * unitPrice
      const taxAmount = subtotal * taxPct / 100
      fields.subtotal = subtotal
      fields.tax_amount = taxAmount
      fields.po_total = subtotal + taxAmount
    }

    if ('delivery_date' in fields) {
      if (fields.delivery_date) {
        fields.receipt_wk = dateToWkLabel(fields.delivery_date)
        fields.commit_status = 'Commit'
      } else {
        fields.receipt_wk = null
        fields.commit_status = 'Uncommit'
      }
    }

    fields.updated_at = new Date().toISOString()

    const { error: updateErr } = await getSupabase()
      .from('purchase_orders')
      .update(fields)
      .eq('id', id)

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    return NextResponse.json({ success: true, id, updated: fields })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await getSupabase().auth.getUser(token)
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getSupabase().from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'supply_chain') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Parse file
    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

    const arrayBuffer = await file.arrayBuffer()
    const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '', range: 2 })

    if (!rows.length) return NextResponse.json({ error: 'No data in file' }, { status: 400 })

    // Load part master for validation + lead time fallback + brand/project resolution
    const { data: partsData } = await getSupabase()
      .from('parts').select('part_number, brand, project_id')
    const partMap = new Map((partsData || []).map((p: any) => [p.part_number, p]))

    // part_supplier lead times (preferred supplier), same fallback role master_sku plays for FG
    const { data: psData } = await getSupabase()
      .from('part_supplier').select('part_number, lead_time_wk').eq('is_preferred', true)
    const leadTimeMap: Record<string, number> = {}
    psData?.forEach((p: any) => { leadTimeMap[p.part_number] = p.lead_time_wk || 0 })

    const mapped = rows
      .filter(row => row['PO Number *'] && row['Part Number *'])
      .map(row => {
        const partNumber = String(row['Part Number *']).trim().toUpperCase()
        const deliveryDate = parseDate(row['Delivery Date'])
        const orderDate = parseDate(row['Order Date *'])
        const leadTime = Number(row['Lead Time (wks)']) || leadTimeMap[partNumber] || 0

        let receiptWk: string | null = null
        let commitStatus: string = 'Uncommit'

        if (deliveryDate) {
          receiptWk = dateToWkLabel(deliveryDate)
          commitStatus = 'Commit'
        } else if (orderDate && leadTime > 0) {
          const estimatedDelivery = addWeeks(orderDate, leadTime)
          receiptWk = dateToWkLabel(estimatedDelivery)
          commitStatus = 'Uncommit'
        }

        const qtyOrdered = Number(row['Qty Ordered *']) || 0
        const qtyShipped = Number(row['Qty Shipped']) || 0
        const unitPrice = Number(row['Unit Price (RM)*']) || 0
        const taxPct = Number(row['Tax %']) || 0
        const subtotal = qtyOrdered * unitPrice
        const taxAmount = subtotal * taxPct / 100
        const poTotal = subtotal + taxAmount

        const part = partMap.get(partNumber)

        return {
          po_number:     String(row['PO Number *']).trim(),
          part_number:   partNumber,
          sku:           null,
          project_id:    part?.project_id ?? null,
          brand:         part?.brand ?? null,
          supplier_name: String(row['Supplier Name *'] || '').trim() || null,
          uom:           String(row['UOM *'] || '').trim() || null,
          qty:           qtyOrdered,
          qty_shipped:   qtyShipped,
          balance_qty:   qtyOrdered - qtyShipped,
          unit_price:    unitPrice,
          subtotal,
          tax_pct:       taxPct,
          tax_amount:    taxAmount,
          po_total:      poTotal,
          lead_time_wk:  leadTime,
          order_date:    orderDate,
          delivery_date: deliveryDate,
          receipt_wk:    receiptWk,
          commit_status: commitStatus,
          status:        String(row['Status *'] || 'Open').trim(),
          notes:         String(row['Notes'] || '').trim() || null,
          uploaded_by:   user.email,
          uploaded_at:   new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        }
      })

    if (!mapped.length) return NextResponse.json({ error: 'No valid rows found. Check PO Number and Part Number columns.' }, { status: 400 })

    // Check for unrecognized part numbers (FK on purchase_orders.part_number -> parts.part_number)
    const uploadedPns = [...new Set(mapped.map(r => r.part_number))]
    const validPnSet = new Set(uploadedPns.filter(pn => partMap.has(pn)))
    const invalidPns = uploadedPns.filter(pn => !validPnSet.has(pn))

    const valid = mapped.filter(r => validPnSet.has(r.part_number))
    const skipped = mapped.filter(r => !validPnSet.has(r.part_number))

    if (!valid.length) {
      return NextResponse.json({
        error: `No valid part numbers found. Unrecognized: ${invalidPns.join(', ')}`,
      }, { status: 400 })
    }

    // Upsert
    const { error: upsertErr, count } = await getSupabase()
      .from('purchase_orders')
      .upsert(valid, { onConflict: 'po_number,part_number', count: 'exact' })

    if (upsertErr) {
      console.error('Component PO upsert error:', upsertErr)
      return NextResponse.json({ error: upsertErr.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      total_rows: rows.length,
      upserted: count,
      skipped: skipped.length,
      invalid_part_numbers: invalidPns,
    })

  } catch (err: any) {
    console.error('Component PO upload error:', err)
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 })
  }
}
