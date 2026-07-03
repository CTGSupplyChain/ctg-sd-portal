'use client'
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ComponentMrpResult } from '@/lib/bom-mrp'
import type { WeekInfo } from '@/lib/sd-compute'

interface ComponentSDProps {
  results: ComponentMrpResult[]
  weeks: WeekInfo[]
  currentWk: string
  fgSku: string
  fgDescription: string
}

const CAT_COLORS: Record<string, string> = {
  RM:  'bg-orange-50 text-orange-700 border-orange-200',
  PK:  'bg-blue-50 text-blue-700 border-blue-200',
  SA:  'bg-purple-50 text-purple-700 border-purple-200',
  WIP: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  FG:  'bg-green-50 text-green-700 border-green-200',
}

const FLAG_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  OVERDUE: { bg: 'bg-red-600',    text: 'text-white',      label: 'OVERDUE' },
  URGENT:  { bg: 'bg-orange-500', text: 'text-white',      label: 'URGENT'  },
  PLAN:    { bg: 'bg-yellow-400', text: 'text-yellow-900', label: 'PLAN PO' },
  OK:      { bg: 'bg-green-100',  text: 'text-green-800',  label: 'OK'      },
}

function fmt(n: number): string {
  if (n === 0) return '—'
  return n.toLocaleString()
}

function fmtBalance(n: number): string {
  if (n === 0) return '0'
  if (n < 0) return `(${Math.abs(n).toLocaleString()})`
  return n.toLocaleString()
}

// Row styles matching SDTable
type MrpRowType = 'gross' | 'net' | 'po' | 'balance'

const ROW_META: Record<MrpRowType, { bg: string; labelColor: string; cellColor: string }> = {
  gross:   { bg: 'bg-[#DCEAE8]', labelColor: 'text-[#4B5563]', cellColor: 'text-[#1F2937]' },
  net:     { bg: 'bg-[#F4F2EE]', labelColor: 'text-[#4B5563]', cellColor: 'text-[#1F2937]' },
  po:      { bg: 'bg-[#E4DDD3]', labelColor: 'text-[#4B5563]', cellColor: 'text-[#1F2937] font-medium' },
  balance: { bg: 'bg-[#1F2937]', labelColor: 'text-[#E4DDD3]', cellColor: 'text-white font-semibold' },
}

export default function ComponentSD({ results, weeks, currentWk, fgSku, fgDescription }: ComponentSDProps) {
  const [collapsed, setCollapsed] = useState(false)

  const monthSpans = useMemo(() => {
    const spans: { label: string; count: number }[] = []
    let cur = ''; let count = 0
    weeks.forEach(w => {
      if (w.monthLabel !== cur) {
        if (cur) spans.push({ label: cur, count })
        cur = w.monthLabel; count = 1
      } else count++
    })
    if (cur) spans.push({ label: cur, count })
    return spans
  }, [weeks])

  if (results.length === 0) return (
    <div className="bg-white rounded-xl border border-[#EAECF0] p-5 mt-4">
      <p className="text-sm text-[#98A2B3]">No BOM components found for {fgSku}. Add BOM lines in PLM to enable MRP.</p>
    </div>
  )

  const overdueCount   = results.filter(r => r.earliestPoReleaseFlag === 'OVERDUE').length
  const urgentCount    = results.filter(r => r.earliestPoReleaseFlag === 'URGENT').length
  const planCount      = results.filter(r => r.earliestPoReleaseFlag === 'PLAN').length
  const missingLtCount = results.filter(r => r.component.leadTimeWk == null).length

  return (
    <div className="bg-white rounded-xl border border-[#EAECF0] mt-4 overflow-hidden">

      {/* ── Section header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[#EAECF0] bg-[#F9FAFB]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="text-[#667085] hover:text-[#344054] transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d={collapsed ? 'M4 6l4 4 4-4' : 'M4 10l4-4 4 4'}
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-sm font-semibold text-[#101828]">BOM Component Orders</span>
          <span className="text-xs text-[#667085]">{fgSku} — {fgDescription}</span>
          <span className="text-xs bg-[#F2F4F7] text-[#344054] px-2 py-0.5 rounded-full border border-[#EAECF0]">
            {results.length} components
          </span>
        </div>
        <div className="flex items-center gap-2">
          {overdueCount > 0 && (
            <span className="text-xs font-medium bg-red-600 text-white px-2 py-0.5 rounded-full">{overdueCount} Overdue</span>
          )}
          {urgentCount > 0 && (
            <span className="text-xs font-medium bg-orange-500 text-white px-2 py-0.5 rounded-full">{urgentCount} Urgent</span>
          )}
          {planCount > 0 && (
            <span className="text-xs font-medium bg-yellow-400 text-yellow-900 px-2 py-0.5 rounded-full">{planCount} Plan PO</span>
          )}
          {missingLtCount > 0 && (
            <span className="text-xs font-medium bg-[#F2F4F7] text-[#667085] px-2 py-0.5 rounded-full border border-[#EAECF0]">{missingLtCount} missing LT</span>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="divide-y divide-[#EAECF0]">
          {results.map(r => (
            <ComponentTable
              key={r.component.partNumber}
              result={r}
              weeks={weeks}
              currentWk={currentWk}
              monthSpans={monthSpans}
            />
          ))}
        </div>
      )}

      {/* Legend */}
      {!collapsed && (
        <div className="px-5 py-2.5 border-t border-[#EAECF0] bg-[#F9FAFB] flex items-center gap-4 text-[10px] text-[#667085]">
          <span><strong>Gross Req</strong> = FG demand × qty/FG</span>
          <span><strong>Net Req</strong> = Gross − on-hand (rolling)</span>
          <span><strong>Planned PO</strong> = Net req rounded to MOQ</span>
          <span className="ml-auto"><strong>Balance</strong> = on-hand − demand + supply (commit)</span>
        </div>
      )}
    </div>
  )
}

// ── Per-component mini S&D table ──────────────────────────────────────────────

function ComponentTable({
  result, weeks, currentWk, monthSpans,
}: {
  result: ComponentMrpResult
  weeks: WeekInfo[]
  currentWk: string
  monthSpans: { label: string; count: number }[]
}) {
  const [open, setOpen] = useState(true)
  const comp = result.component
  const catStyle = CAT_COLORS[comp.category] || 'bg-gray-50 text-gray-600 border-gray-200'
  const flagBadge = result.earliestPoReleaseFlag ? FLAG_BADGE[result.earliestPoReleaseFlag] : null
  const missingLt = comp.leadTimeWk == null

  return (
    <div>
      {/* Component header row */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 bg-[#F9FAFB] cursor-pointer hover:bg-[#F2F4F7] transition-colors border-b border-[#EAECF0]"
        onClick={() => setOpen(o => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-[#98A2B3] flex-shrink-0">
          <path
            d={open ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
        <span className={clsx('text-[10px] font-semibold px-1.5 py-0.5 rounded border flex-shrink-0', catStyle)}>
          {comp.category}
        </span>
        <span className="font-mono text-xs font-semibold text-[#344054]">{comp.partNumber}</span>
        <span className="text-xs text-[#667085] truncate">{comp.description}</span>
        {comp.supplier && (
          <span className="text-[11px] text-[#98A2B3] truncate hidden md:block">· {comp.supplier}</span>
        )}
        <div className="ml-auto flex items-center gap-3 flex-shrink-0 text-[11px] text-[#667085]">
          <span>Qty/FG: <strong className="text-[#344054]">{result.extendedQtyPerFg % 1 === 0 ? result.extendedQtyPerFg : result.extendedQtyPerFg.toFixed(2)}</strong></span>
          <span>LT: <strong className={missingLt ? 'text-orange-500' : 'text-[#344054]'}>{missingLt ? '—' : `${comp.leadTimeWk}wk`}</strong></span>
          <span>MOQ: <strong className="text-[#344054]">{comp.moq != null ? comp.moq.toLocaleString() : '—'}</strong></span>
          <span>On Hand: <strong className="text-[#344054]">{comp.onHandQty > 0 ? comp.onHandQty.toLocaleString() : '0'}</strong></span>
          {missingLt ? (
            <span className="text-[10px] text-orange-500 font-medium bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full">Set LT in Part Master</span>
          ) : flagBadge ? (
            <span className={clsx('text-[10px] font-semibold px-2 py-0.5 rounded-full', flagBadge.bg, flagBadge.text)}>
              {flagBadge.label} {result.earliestPoReleaseWk}
            </span>
          ) : null}
        </div>
      </div>

      {open && (
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse" style={{ minWidth: `${140 + weeks.length * 70}px` }}>
            <thead>
              {/* Month header — matches SDTable teal */}
              <tr>
                <th className="bg-[#F9FAFB] border-b border-r border-[#EAECF0] px-3 py-1.5 text-left text-[#667085] font-medium w-32 sticky left-0 z-10">Row</th>
                {monthSpans.map(span => (
                  <th
                    key={span.label}
                    colSpan={span.count}
                    className="bg-[#0E5C56] text-white text-center px-2 py-1.5 font-semibold border-r border-white/20 text-xs tracking-wide"
                  >
                    {span.label}
                  </th>
                ))}
              </tr>
              {/* Week label row — matches SDTable dark */}
              <tr>
                <th className="bg-[#F9FAFB] border-b border-r border-[#EAECF0] px-3 py-1 sticky left-0 z-10" />
                {weeks.map(w => (
                  <th
                    key={w.label}
                    className={clsx(
                      'text-center px-2 py-1.5 font-semibold text-xs border-b border-r border-[#EAECF0] min-w-[68px]',
                      w.label === currentWk ? 'bg-[#FEF3C7] text-[#92400E]' : 'bg-[#2E4057] text-white'
                    )}
                  >
                    <div>{w.label}</div>
                    <div className="font-normal text-[10px] opacity-70">{w.mondayDate.slice(5)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Gross Req */}
              <MrpRow
                label="Gross Req"
                rowType="gross"
                values={result.weeks.map(w => w.grossReq)}
                weeks={weeks}
                currentWk={currentWk}
              />
              {/* Net Req */}
              <MrpRow
                label="Net Req"
                rowType="net"
                values={result.weeks.map(w => w.netReq)}
                weeks={weeks}
                currentWk={currentWk}
              />
              {/* Planned PO */}
              <MrpRow
                label="Planned PO"
                rowType="po"
                values={result.weeks.map(w => w.plannedOrderQty)}
                flags={result.weeks.map(w => w.poReleaseFlag)}
                weeks={weeks}
                currentWk={currentWk}
              />
              {/* Balance — running S&D balance: on-hand − demand + supply (commit) */}
              <MrpRow
                label="Balance"
                rowType="balance"
                values={result.weeks.map(w => w.balance)}
                weeks={weeks}
                currentWk={currentWk}
              />
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Individual row ────────────────────────────────────────────────────────────

function MrpRow({
  label, rowType, values, flags, weeks, currentWk,
}: {
  label: string
  rowType: MrpRowType
  values: number[]
  flags?: (string | null)[]
  weeks: WeekInfo[]
  currentWk: string
}) {
  const meta = ROW_META[rowType]

  return (
    <tr>
      <td className={clsx(
        'px-3 py-1.5 font-medium text-xs border-b border-r border-[#EAECF0] sticky left-0 z-10 w-32',
        meta.bg, meta.labelColor
      )}>
        {label}
      </td>
      {weeks.map((w, i) => {
        const val = values[i] ?? 0
        const flag = flags?.[i] ?? null
        const isCurrent = w.label === currentWk

        // Balance row: running S&D balance (on-hand − demand + supply commit)
        if (rowType === 'balance') {
          const isNeg = val < 0
          const cellBg = isCurrent ? 'bg-[#0E5C56]' : meta.bg

          return (
            <td
              key={w.label}
              className={clsx(
                'text-center px-1.5 py-1.5 border-b border-r border-[#EAECF0] text-xs tabular-nums font-semibold',
                cellBg,
                isNeg ? 'text-[#F87171]' : 'text-white'
              )}
            >
              {fmtBalance(val)}
            </td>
          )
        }

        // Planned PO row: color by urgency flag
        if (rowType === 'po' && val > 0 && flag) {
          return (
            <td
              key={w.label}
              className={clsx(
                'text-center px-1.5 py-1.5 border-b border-r border-[#EAECF0] text-xs tabular-nums font-medium',
                isCurrent && 'opacity-90',
                flag === 'OVERDUE' ? 'bg-red-50 text-red-700' :
                flag === 'URGENT'  ? 'bg-orange-50 text-orange-700' :
                flag === 'PLAN'    ? 'bg-yellow-50 text-yellow-700' :
                                     'bg-blue-50 text-[#1849A9]'
              )}
            >
              {fmt(val)}
            </td>
          )
        }

        return (
          <td
            key={w.label}
            className={clsx(
              'text-center px-1.5 py-1.5 border-b border-r border-[#EAECF0] text-xs tabular-nums',
              meta.bg,
              meta.cellColor,
              isCurrent && 'bg-[#FFFBEB]',
              val === 0 && '!text-[#D0D5DD]'
            )}
          >
            {fmt(val)}
          </td>
        )
      })}
    </tr>
  )
}
