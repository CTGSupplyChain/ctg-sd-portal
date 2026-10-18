import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { canEdit } from '@/lib/roles'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

const SKU_BRAND_MAP: Record<string, string> = {
  SD: 'SkinDae',
}

function resolveBrand(sku: string, wmsBrand: string | null): string {
  if (wmsBrand && wmsBrand.trim()) return wmsBrand.trim()
  const prefix = sku.slice(0, 2).toUpperCase()
  return SKU_BRAND_MAP[prefix] ?? ''
}

const SKINDAE_SKUS = [
  'SDSDCA030',
  'SDSDCA05S',
  'SDDLSC030',
  'SDSDPD01S',
  'SDSDPM01S',
  'SDSDSH01S',
]

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.replace('Bearer ', '')

    // Parallel: auth check + body parse
    const [authResult, body] = await Promise.all([
      getSupabase().auth.getUser(token),
      req.json().catch(() => null),
    ])

    const { data: { user }, error: authError } = authResult

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { data: profile } = await getSupabase()
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!canEdit(profile?.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { rows, snapshot_date: snapshotDate } = body

    if (!rows?.length || !snapshotDate) {
      return NextResponse.json({ error: 'Missing rows or snapshot_date' }, { status: 400 })
    }

    const mapped = rows
      .filter((row: any) => row['SKU'] && typeof row['SKU'] === 'string' && String(row['SKU']).trim())
      .map((row: any) => {
        const sku = String(row['SKU']).trim()
        const wmsBrand = row['Brand'] ?? null
        return {
          snapshot_date:      snapshotDate,
          company_name:       row['Company Name']            ?? null,
          warehouse_code:     row['Warehouse Code']          ?? null,
          product_name_en:    row['Product Name English']    ?? null,
          product_name_local: row['Product Name Local']      ?? null,
          sku,
          mfupc:              row['Mfupc/Upc/Ean']           ?? null,
          base_uom:           row['Base Uom']                ?? null,
          atp:                Number(row['ATP'])              || 0,
          usable:             Number(row['Usable'])           || 0,
          unusable:           Number(row['Unusable'])         || 0,
          incoming:           Number(row['Incoming'])         || 0,
          picking:            Number(row['Picking'])          || 0,
          in_process:         Number(row['In-Process'])       || 0,
          problem_order:      Number(row['Problem Order'])    || 0,
          blocked_usable:     Number(row['Blocked Usable'])   || 0,
          blocked_unusable:   Number(row['Blocked Unusable']) || 0,
          buffer:             Number(row['Buffer'])           || 0,
          in_transfer:        Number(row['In-transfer'])      || 0,
          in_stock_take:      Number(row['In-stock take'])    || 0,
          in_adjustment:      Number(row['In-adjustment'])    || 0,
          total_cbm:          Number(row['Total CBM'])        || 0,
          brand:              resolveBrand(sku, wmsBrand),
          product_category:   row['Product Category']        ?? null,
          uploaded_by:        user.email,
          uploaded_at:        new Date().toISOString(),
        }
      })

    const seen = new Set<string>()
    const deduped = mapped.filter((row: any) => {
      if (seen.has(row.sku)) return false
      seen.add(row.sku)
      return true
    })

    const uploadedSkus = new Set(deduped.map((r: any) => r.sku))
    const missingSkinDae = SKINDAE_SKUS.filter(s => !uploadedSkus.has(s))

    // Single Postgres function — one DB round trip for all rows
    const { data: upsertCount, error: upsertError } = await getSupabase()
      .rpc('bulk_upsert_wms_snapshots', { rows: deduped })

    if (upsertError) {
      console.error('Upsert error:', upsertError)
      return NextResponse.json({ error: upsertError.message }, { status: 500 })
    }

    // Fire-and-forget desc sync — Promise.resolve() ensures full Promise interface
    const descRows = deduped
      .filter((r: any) => r.sku && r.product_name_en)
      .map((r: any) => ({ sku: r.sku, description: r.product_name_en }))

    if (descRows.length > 0) {
      Promise.resolve(getSupabase().rpc('sync_wms_descriptions', { updates: descRows })).catch(() => {})
    }

    return NextResponse.json({
      success: true,
      total_rows: rows.length,
      upserted: upsertCount,
      duplicates_removed: mapped.length - deduped.length,
      missing_skindae_skus: missingSkinDae,
    })

  } catch (err: any) {
    console.error('Upload error:', err)
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 })
  }
}
