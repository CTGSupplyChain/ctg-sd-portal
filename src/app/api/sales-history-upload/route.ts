// ============================================================
// POST /api/sales-history-upload
// Accepts pre-parsed weekly rows as JSON (parsed client-side)
// Bypasses Vercel's hard 4.5MB body limit for file uploads.
// Input: { channel, rows: WeeklyRow[], filename }
//
// NOTE: Forecast regeneration is intentionally NOT done here.
// The route upserts sales_history and returns skusToRegenerate.
// The client then calls /api/regenerate-forecast separately —
// this keeps the upload route fast and avoids Vercel 504s on
// large B2C files with many SKUs.
// ============================================================

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { canEdit } from '@/lib/roles'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

interface WeeklyRow {
  brand: string; company: string; sku: string; channel: string
  isoYear: number; isoWeek: number; weekStart: string
  qty: number; orderCount: number
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: { user }, error: authErr } = await getSupabase().auth.getUser(token)
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await getSupabase().from('profiles').select('role').eq('id', user.id).single()
    if (!canEdit(profile?.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await req.json()
    const { channel, rows } = body as { channel: string; rows: WeeklyRow[] }

    if (!channel || !['B2B', 'B2C'].includes(channel))
      return NextResponse.json({ error: 'channel must be B2B or B2C' }, { status: 400 })
    if (!Array.isArray(rows) || rows.length === 0)
      return NextResponse.json({ error: 'No rows provided' }, { status: 400 })

    const { data: masterSkus } = await getSupabase().from('master_sku').select('sku, brand, avg_selling_price')
    const masterSkuSet = new Set((masterSkus ?? []).map((m: any) => m.sku))
    const skuBrandMap = new Map((masterSkus ?? []).map((m: any) => [m.sku, m.brand]))

    const validRows = rows.filter(r => masterSkuSet.has(r.sku))
    const unknownSkus = [...new Set(rows.filter(r => !masterSkuSet.has(r.sku)).map(r => r.sku))]

    if (validRows.length === 0)
      return NextResponse.json({ error: 'No rows matched known master SKUs', unknownSkus }, { status: 422 })

    const historyRecords = validRows.map(r => ({
      brand: skuBrandMap.get(r.sku) ?? r.brand,
      company: r.company,
      sku: r.sku,
      channel: r.channel,
      iso_year: r.isoYear,
      iso_week: r.isoWeek,
      week_start_date: r.weekStart,
      qty: r.qty,
      order_count: r.orderCount,
      source: 'WMS Upload',
      uploaded_by: user.email,
      uploaded_at: new Date().toISOString(),
    }))

    const { error: upsertErr, count: upsertedCount } = await getSupabase()
      .from('sales_history')
      .upsert(historyRecords, { onConflict: 'sku,channel,iso_year,iso_week', count: 'exact' })

    if (upsertErr) {
      console.error('sales_history upsert error:', upsertErr)
      return NextResponse.json({ error: upsertErr.message }, { status: 500 })
    }

    const affectedSkus = [...new Set(validRows.map(r => r.sku))]

    return NextResponse.json({
      success: true,
      channel,
      parseStats: {
        totalLineItems: rows.length,
        validLineItems: validRows.length,
        skippedLineItems: rows.length - validRows.length,
        dateRange: null,
      },
      salesHistory: {
        weeklyRowsProcessed: validRows.length,
        upserted: upsertedCount,
      },
      skusToRegenerate: affectedSkus,
      warnings: { unknownSkus },
    })

  } catch (err: any) {
    console.error('sales-history-upload error:', err)
    return NextResponse.json({ error: err.message ?? 'Unknown error' }, { status: 500 })
  }
    }
