import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

const SHEET_ID = '19pLa5cKc1eCyxc9MeycAEjqj6pJrGNZUUEt8ulncdQs'
const SHEET_RANGE = 'PO_Data'

// NOTE: The live PO_Data tab has no "Brand", "Remark", or "Currency" columns
// (verified against the sheet on 2026-06-19 — confirmed with JiaJie):
//   - brand: not in sheet → derived via SKU join against master_sku.brand
//   - notes: not in sheet → left null (no substitute column used)
//   - currency: not in sheet → all rows treated as MYR, no skip filter applied
//     (skipped_non_myr is kept in the response shape for forward-compat but
//     will always be 0 until a currency column is added upstream)

// ── Google auth (service-account JWT for the PO sheet) ────────────────────
async function getAccessToken(): Promise<string> {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!)

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')

  const signingInput = `${encode(header)}.${encode(payload)}`

  const pemKey = serviceAccount.private_key
  const keyData = pemKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\n/g, '')

  const binaryKey = Buffer.from(keyData, 'base64')
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(signingInput)
  )

  const jwt = `${signingInput}.${Buffer.from(signature).toString('base64url')}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(tokenData)}`)
  }
  return tokenData.access_token
}

async function fetchSheetRows(accessToken: string): Promise<Record<string, string>[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_RANGE}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Sheets API error: ${res.status} ${await res.text()}`)

  const data = await res.json()
  const rows: string[][] = data.values || []
  if (rows.length < 2) return []

  const headers = rows[0].map(h => h.trim())
  return rows.slice(1).map(row => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = (row[i] ?? '').trim() })
    return obj
  })
}

// ── Helpers (mirrors /api/supply-input) ────────────────────────────────────
function parseDate(val: any): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString().split('T')[0]
  const str = String(val).trim()
  if (!str) return null
  const ddmm = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (ddmm) return `${ddmm[3]}-${ddmm[2].padStart(2, '0')}-${ddmm[1].padStart(2, '0')}`
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
  const num = parseFloat(str)
  if (!isNaN(num) && num > 40000) {
    const d = new Date(Math.round((num - 25569) * 86400 * 1000))
    return d.toISOString().split('T')[0]
  }
  return null
}

function dateToWkLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const dayOfWeek = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek)
  // d is now the Thursday of the week, so its year IS the ISO year.
  const isoYear = d.getUTCFullYear()
  const jan1 = new Date(Date.UTC(isoYear, 0, 1))
  const isoWeek = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7)
  // Year-qualified: week_calendar.wk_label is unique per ISO year, so a bare
  // 'WK01' is ambiguous across the 2026-W53 / 2027-W01 boundary.
  return `${isoYear}-WK${String(isoWeek).padStart(2, '0')}`
}

function num(val: string | undefined): number {
  if (val === undefined || val === null || val === '') return 0
  const cleaned = String(val).replace(/,/g, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : n
}

function deriveStatus(qty: number, balanceQty: number): string {
  if (balanceQty <= 0) return 'Closed'
  if (balanceQty < qty) return 'Received'
  return 'Open'
}

interface MappedRow {
  po_number: string
  sku: string
  brand: string | null
  supplier_name: string | null
  qty: number
  qty_shipped: number
  balance_qty: number
  uom: string | null
  unit_price: number
  subtotal: number
  tax_pct: number
  tax_amount: number
  po_total: number
  order_date: string | null
  delivery_date: string | null
  receipt_wk: string | null
  commit_status: string
  lead_time_wk: number
  status: string
  company: string | null
  notes: string | null
}

interface SyncPreview {
  toUpsert: MappedRow[]
  skippedNaSku: number
  skippedNonMyr: number
  skippedUnknownSku: number
  unknownSkus: string[]
  totalRows: number
}

function buildPreview(rows: Record<string, string>[], brandBySku: Record<string, string>): SyncPreview {
  let skippedNaSku = 0
  let skippedUnknownSku = 0
  const unknownSkuSet = new Set<string>()
  const skippedNonMyr = 0 // no currency column in sheet — always 0 for now
  const toUpsert: MappedRow[] = []

  for (const row of rows) {
    const skuRaw = (row['SKU'] || '').trim()
    if (!skuRaw || skuRaw.toUpperCase() === 'N/A') { skippedNaSku++; continue }

    // SKU must exist in master_sku — purchase_orders.sku has an FK constraint
    // against master_sku.sku. Skip unmapped SKUs here instead of letting the
    // whole upsert batch fail on a single FK violation.
    if (!(skuRaw in brandBySku)) {
      skippedUnknownSku++
      unknownSkuSet.add(skuRaw)
      continue
    }

    const qty = num(row['Order Qty'])
    const qtyShipped = num(row['Delivered Qty'])
    const balanceQty = num(row['Outstanding Qty']) || (qty - qtyShipped)

    const unitPrice = num(row['Unit Price'])
    const subtotal = row['Subtotal'] !== undefined && row['Subtotal'] !== ''
      ? num(row['Subtotal']) : qty * unitPrice
    const taxPct = num(row['Tax'])
    const taxAmount = row['Tax Amount'] !== undefined && row['Tax Amount'] !== ''
      ? num(row['Tax Amount']) : subtotal * taxPct / 100
    const poTotal = row['PO Total'] !== undefined && row['PO Total'] !== ''
      ? num(row['PO Total']) : subtotal + taxAmount

    const orderDate = parseDate(row['PO Date'])

    // ETA: Manual wins if present, else Auto, else null
    const etaManual = parseDate(row['ETA (Manual)'])
    const etaAuto = parseDate(row['ETA (Auto)'])
    const deliveryDate = etaManual || etaAuto || null

    const receiptWk = deliveryDate ? dateToWkLabel(deliveryDate) : null
    const commitStatus = deliveryDate ? 'Commit' : 'Uncommit'

    // Lead time: sheet value wins always; only fall back to nothing if blank.
    const leadTimeWk = num(row['Lead Time (Weeks)'])

    const status = deriveStatus(qty, balanceQty)

    toUpsert.push({
      po_number: (row['PO No.'] || '').trim(),
      sku: skuRaw,
      brand: brandBySku[skuRaw] || null,
      supplier_name: (row['Supplier'] || '').trim() || null,
      qty,
      qty_shipped: qtyShipped,
      balance_qty: balanceQty,
      uom: (row['UOM'] || '').trim() || null,
      unit_price: unitPrice,
      subtotal,
      tax_pct: taxPct,
      tax_amount: taxAmount,
      po_total: poTotal,
      order_date: orderDate,
      delivery_date: deliveryDate,
      receipt_wk: receiptWk,
      commit_status: commitStatus,
      lead_time_wk: leadTimeWk,
      status,
      company: (row['Account'] || '').trim() || null,
      notes: null,
    })
  }

  return {
    toUpsert,
    skippedNaSku,
    skippedNonMyr,
    skippedUnknownSku,
    unknownSkus: Array.from(unknownSkuSet).sort(),
    totalRows: rows.length,
  }
}

// ── Route ───────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await getSupabase().auth.getUser(token)
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getSupabase().from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'supply_chain') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await req.json().catch(() => ({}))
    const mode: 'preview' | 'commit' = body?.mode === 'commit' ? 'commit' : 'preview'

    const accessToken = await getAccessToken()
    const rows = await fetchSheetRows(accessToken)
    if (!rows.length) return NextResponse.json({ error: 'No data in sheet' }, { status: 400 })

    // Brand isn't in the sheet — derive it from master_sku via SKU join
    const { data: skuRows } = await getSupabase().from('master_sku').select('sku, brand')
    const brandBySku: Record<string, string> = {}
    skuRows?.forEach((s: any) => { if (s.sku) brandBySku[s.sku] = s.brand })

    const preview = buildPreview(rows, brandBySku)

    if (mode === 'preview') {
      return NextResponse.json({
        success: true,
        mode: 'preview',
        total_rows: preview.totalRows,
        to_upsert: preview.toUpsert.length,
        skipped_na_sku: preview.skippedNaSku,
        skipped_non_myr: preview.skippedNonMyr,
        skipped_unknown_sku: preview.skippedUnknownSku,
        unknown_skus: preview.unknownSkus,
        sample: preview.toUpsert.slice(0, 10),
      })
    }

    // Commit mode — upsert into purchase_orders
    if (!preview.toUpsert.length) {
      return NextResponse.json({ error: 'No valid rows to sync' }, { status: 400 })
    }

    const records = preview.toUpsert.map(r => ({
      ...r,
      uploaded_by: user.email,
      uploaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    const { error: upsertErr, count } = await getSupabase()
      .from('purchase_orders')
      .upsert(records, { onConflict: 'po_number,sku', count: 'exact' })

    if (upsertErr) {
      console.error('PO sync upsert error:', upsertErr)
      return NextResponse.json({ error: upsertErr.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      mode: 'commit',
      total_rows: preview.totalRows,
      upserted: count ?? records.length,
      skipped_na_sku: preview.skippedNaSku,
      skipped_non_myr: preview.skippedNonMyr,
      skipped_unknown_sku: preview.skippedUnknownSku,
      unknown_skus: preview.unknownSkus,
    })

  } catch (err: any) {
    console.error('PO sync error:', err)
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 })
  }
}
