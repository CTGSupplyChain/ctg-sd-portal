import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateAttachRateForecast } from '@/lib/attach-rate-forecast'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

const SHEET_ID = '1ptI1gnMWdaxzYHQEVGjILgEpwqjCtDeYpj7hvY9R104'
const SHEET_RANGE = 'Sheet1'

const MONTH_COL_MAP: Record<string, string> = {
  "Apr'26": 'apr_26', "May'26": 'may_26', "Jun'26": 'jun_26',
  "Jul'26": 'jul_26', "Aug'26": 'aug_26', "Sep'26": 'sep_26',
  "Oct'26": 'oct_26', "Nov'26": 'nov_26', "Dec'26": 'dec_26',
  "Jan'27": 'jan_27', "Feb'27": 'feb_27', "Mar'27": 'mar_27',
  "Apr'27": 'apr_27', "May'27": 'may_27', "Jun'27": 'jun_27',
}

// Get Google OAuth2 access token using service account JWT
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

  // Import private key
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

  // Exchange JWT for access token
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

// Fetch sheet data using Sheets API v4
async function fetchSheetData(accessToken: string): Promise<Record<string, string>[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_RANGE}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Sheets API error: ${res.status} ${await res.text()}`)

  const data = await res.json()
  const rows: string[][] = data.values || []
  if (rows.length < 2) return []

  const headers = rows[0]
  return rows.slice(1).map(row => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h.trim()] = (row[i] || '').trim() })
    return obj
  }).filter(r => r['Project']?.trim())
}

function getPreviousWk(): string {
  const now = new Date()
  const startOfYear = new Date(now.getFullYear(), 0, 1)
  const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7)
  return `W${weekNum - 1}/${now.getFullYear()}`
}

function safeDate(ts: string): number {
  try { const d = new Date(ts); return isNaN(d.getTime()) ? 0 : d.getTime() } catch { return 0 }
}

function getLatestRow(rows: Record<string, string>[], project: string, targetWk: string) {
  const wkRows = rows.filter(r => r['Project']?.trim() === project && r['Week']?.trim() === targetWk)
  if (wkRows.length) return wkRows.sort((a, b) => safeDate(b['Timestamp']) - safeDate(a['Timestamp']))[0]
  const all = rows.filter(r => r['Project']?.trim() === project)
  return all.length ? all.sort((a, b) => safeDate(b['Timestamp']) - safeDate(a['Timestamp']))[0] : null
}

function applyCarryForward(monthly: Record<string, number>): Record<string, number> {
  const keys = Object.values(MONTH_COL_MAP)
  let last = 0
  const result: Record<string, number> = {}
  keys.forEach(k => {
    if (monthly[k] > 0) { last = monthly[k]; result[k] = monthly[k] }
    else { result[k] = last }
  })
  return result
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

    // Get Google access token
    const accessToken = await getAccessToken()

    // Fetch sheet data
    const rows = await fetchSheetData(accessToken)
    if (!rows.length) return NextResponse.json({ error: 'No data in sheet' }, { status: 400 })

    // Load projects
    const { data: projects } = await getSupabase().from('projects').select('id, project_name')

    const targetWk = getPreviousWk()
    const sheetProjects = [...new Set(rows.map(r => r['Project']?.trim()).filter(Boolean))]
    const results = []

    for (const projectName of sheetProjects) {
      const row = getLatestRow(rows, projectName, targetWk)
      if (!row) continue

      const projectRecord = projects?.find(p => p.project_name.toLowerCase() === projectName.toLowerCase())

      const monthly: Record<string, number> = {}
      Object.entries(MONTH_COL_MAP).forEach(([col, key]) => {
        const v = parseFloat(row[col] || '0'); monthly[key] = isNaN(v) ? 0 : v
      })
      const carried = applyCarryForward(monthly)

      const wkStr = row['Week']?.trim() || targetWk
      const yearMatch = wkStr.match(/(\d{4})/); const year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear()

      const { error: upsertErr } = await getSupabase().from('sales_forecast').upsert({
        brand: row['Brand']?.trim(),
        project: projectName,
        project_id: projectRecord?.id || null,
        submission_wk: wkStr,
        year,
        ...carried,
        submitted_at: safeDate(row['Timestamp']) > 0 ? new Date(row['Timestamp']).toISOString() : new Date().toISOString(),
      }, { onConflict: 'brand,project,submission_wk,year' })  // ← FIXED: added project to conflict key

      results.push({
        project: projectName,
        brand: row['Brand']?.trim(),
        project_id: projectRecord?.id || null,
        submission_wk: wkStr,
        synced: !upsertErr,
        error: upsertErr?.message,
      })
    }

    // Attach-rate brands: re-explode latest RM forecast -> weekly SKU demand
    const { data: arBrands } = await getSupabase().from('brand_planning_config').select('brand')
    const attachRate: Record<string, unknown> = {}
    for (const b of arBrands || []) {
      attachRate[b.brand] = await generateAttachRateForecast(getSupabase(), b.brand)
    }

    return NextResponse.json({ success: true, results, attachRate })

  } catch (err: any) {
    console.error('Forecast sync error:', err)
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 })
  }
}
