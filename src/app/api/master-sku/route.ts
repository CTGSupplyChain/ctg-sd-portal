import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { canEdit } from '@/lib/roles'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function PATCH(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await getSupabase().auth.getUser(token)
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getSupabase().from('profiles').select('role').eq('id', user.id).single()
    if (!canEdit(profile?.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await req.json()
    const { sku, ...fields } = body
    if (!sku) return NextResponse.json({ error: 'SKU is required' }, { status: 400 })
    if (!Object.keys(fields).length) return NextResponse.json({ error: 'No fields to update' }, { status: 400 })

    const { error: updateErr } = await getSupabase()
      .from('master_sku')
      .update(fields)
      .eq('sku', sku)

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    return NextResponse.json({ success: true, sku, updated: fields })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await getSupabase().auth.getUser(token)
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getSupabase().from('profiles').select('role').eq('id', user.id).single()
    if (!canEdit(profile?.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

    const arrayBuffer = await file.arrayBuffer()
    const workbook = XLSX.read(arrayBuffer, { type: 'array' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    // Skip title row (row 1) and instructions row (row 2) — headers on row 3
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: null, range: 2 })

    if (!rows.length) return NextResponse.json({ error: 'No data found in file' }, { status: 400 })

    // Load existing SKUs for partial update logic
    const { data: existingSkus } = await getSupabase().from('master_sku').select('sku')
    const existingSkuSet = new Set(existingSkus?.map((s: any) => s.sku) || [])

    const toUpsert: any[] = []
    const skipped: string[] = []
    const inserted: string[] = []
    const updated: string[] = []

    for (const row of rows) {
      const sku = String(row['SKU *'] || '').trim()
      if (!sku) continue

      const isNew = !existingSkuSet.has(sku)

      // For new SKUs, Brand is required
      const brand = String(row['Brand *'] || '').trim()
      if (isNew && !brand) {
        skipped.push(`${sku} (new SKU missing Brand)`)
        continue
      }

      // Build record — only include non-null/non-empty values
      const record: any = { sku }

if (isNew) {
  // New SKUs — set brand and description
  if (brand) record.brand = brand
  if (row['Description'] != null && String(row['Description']).trim()) record.description = String(row['Description']).trim()
} else {
  // Existing SKUs — must include brand to satisfy not-null constraint
  record.brand = brand || undefined
}
      if (row['UOM'] != null && String(row['UOM']).trim()) record.uom = String(row['UOM']).trim()
      if (row['MOQ'] != null && row['MOQ'] !== '') record.moq = parseInt(row['MOQ']) || 0
      if (row['Lead Time (wks)'] != null && row['Lead Time (wks)'] !== '') record.lead_time_wk = parseInt(row['Lead Time (wks)']) || 0
      if (row['ASP (RM)'] != null && row['ASP (RM)'] !== '') record.avg_selling_price = parseFloat(row['ASP (RM)']) || 0
      if (row['Safety Stock'] != null && row['Safety Stock'] !== '') record.safety_stock = parseInt(row['Safety Stock']) || 0
      if (row['Buffer Stock'] != null && row['Buffer Stock'] !== '') record.buffer_stock = parseInt(row['Buffer Stock']) || 0
      if (row['Status'] != null && String(row['Status']).trim()) record.status = String(row['Status']).trim()
      if (row['Category'] != null && String(row['Category']).trim()) record.demand_source = String(row['Category']).trim()
      if (row['Notes'] != null && String(row['Notes']).trim()) record.remarks = String(row['Notes']).trim()

      toUpsert.push(record)
      if (isNew) inserted.push(sku)
      else updated.push(sku)
    }

    if (!toUpsert.length) {
      return NextResponse.json({ error: 'No valid rows to process.' }, { status: 400 })
    }
    // Separate inserts and updates
const newRecords = toUpsert.filter(r => inserted.includes(r.sku))
const updateRecords = toUpsert.filter(r => updated.includes(r.sku))

// Insert new SKUs
if (newRecords.length > 0) {
  const { error: insertErr } = await getSupabase().from('master_sku').insert(newRecords)
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 })
}

// Update existing SKUs one by one (partial update — only changed fields)
for (const rec of updateRecords) {
  const { sku, ...fields } = rec
  const { error: updateErr } = await getSupabase()
    .from('master_sku')
    .update(fields)
    .eq('sku', sku)
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })
}
    

    return NextResponse.json({
      success: true,
      total_rows: rows.length,
      inserted: inserted.length,
      updated: updated.length,
      skipped: skipped.length,
      inserted_skus: inserted,
      updated_skus: updated,
      skipped_details: skipped,
    })

  } catch (err: any) {
    console.error('Master SKU upload error:', err)
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 })
  }
}
