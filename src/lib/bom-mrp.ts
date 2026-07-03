// ============================================================
// CTG BOM-MRP Engine
// Explodes BOM for a FG SKU and computes weekly component
// requirements, planned order qty, and PO release week.
// ============================================================

export interface BomLine {
  partNumber: string
  parentPn: string
  description: string
  category: 'FG' | 'SA' | 'PK' | 'RM' | 'WIP'
  bomLevel: number
  qtyPer: number        // qty per immediate parent
  uom: string
}

export interface PartSupplierInfo {
  partNumber: string
  supplier: string | null
  moq: number | null
  spq: number | null    // standard pack qty — order in multiples of this
  leadTimeWk: number | null
}

export interface ComponentMaster {
  partNumber: string
  description: string
  category: string
  uom: string
  onHandQty: number     // current stock at OEM, default 0
  supplier: string | null
  moq: number | null
  spq: number | null
  leadTimeWk: number | null
}

export interface ComponentWeekRow {
  wkLabel: string
  grossReq: number      // FG demand × extended qty_per
  netReq: number        // grossReq − remaining on-hand (rolling, net of real supply commit)
  plannedOrderQty: number  // net req rounded up to MOQ multiple
  poReleaseWk: string | null  // wkLabel of when PO must be released
  poReleaseFlag: 'OVERDUE' | 'URGENT' | 'PLAN' | 'OK' | null
  supplyUncommit: number  // component POs placed but not yet confirmed (no delivery date)
  supplyCommit: number    // component POs confirmed for this receipt week (real, from purchase_orders)
  balance: number       // projected on-hand: prior balance − grossReq + supplyCommit (real committed supply)
}

export interface ComponentMrpResult {
  component: ComponentMaster
  extendedQtyPerFg: number   // total qty needed per 1 FG unit (all levels rolled up)
  totalGrossReq: number      // sum across all weeks
  totalPlannedOrderQty: number
  earliestPoReleaseWk: string | null
  earliestPoReleaseFlag: 'OVERDUE' | 'URGENT' | 'PLAN' | 'OK' | null
  weeks: ComponentWeekRow[]
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Round qty up to nearest MOQ multiple.
 * If moq is null/0, return qty as-is.
 */
export function roundUpToMoq(qty: number, moq: number | null, spq: number | null): number {
  if (qty <= 0) return 0
  const effectiveMoq = moq && moq > 0 ? moq : 1
  const effectiveSpq = spq && spq > 0 ? spq : effectiveMoq
  if (qty < effectiveMoq) return effectiveMoq
  // Round up to nearest SPQ multiple above MOQ
  return Math.ceil(qty / effectiveSpq) * effectiveSpq
}

/**
 * Given a wk_label and a lead time in weeks, find the release week label
 * by subtracting leadTimeWk from the week index in the provided week list.
 * Returns null if out of range.
 */
export function calcPoReleaseWk(
  demandWkLabel: string,
  leadTimeWk: number,
  allWkLabels: string[],  // ordered list of all available week labels
  currentWkLabel: string
): { wkLabel: string | null; flag: 'OVERDUE' | 'URGENT' | 'PLAN' | 'OK' | null } {
  const demandIdx = allWkLabels.indexOf(demandWkLabel)
  if (demandIdx < 0) return { wkLabel: null, flag: null }

  const releaseIdx = demandIdx - leadTimeWk
  const currentIdx = allWkLabels.indexOf(currentWkLabel)

  let releaseWkLabel: string | null = null
  if (releaseIdx >= 0 && releaseIdx < allWkLabels.length) {
    releaseWkLabel = allWkLabels[releaseIdx]
  } else if (releaseIdx < 0) {
    // PO release date is before the calendar horizon start — likely overdue
    releaseWkLabel = allWkLabels[0]
  }

  if (!releaseWkLabel) return { wkLabel: null, flag: null }

  const releaseIdx2 = allWkLabels.indexOf(releaseWkLabel)
  let flag: 'OVERDUE' | 'URGENT' | 'PLAN' | 'OK' = 'OK'
  if (releaseIdx2 < currentIdx) flag = 'OVERDUE'
  else if (releaseIdx2 - currentIdx <= 2) flag = 'URGENT'
  else if (releaseIdx2 - currentIdx <= 8) flag = 'PLAN'

  return { wkLabel: releaseWkLabel, flag }
}

// ── main engine ───────────────────────────────────────────────────────────────

/**
 * Explode BOM and compute MRP for all leaf/procured components.
 *
 * @param bomLines      All BOM lines for this FG (all levels, flat)
 * @param components    Component master data (on-hand, MOQ, LT, SPQ)
 * @param fgWeeklyDemand  Map of wkLabel → FG demand qty (from S&D output)
 * @param weeks         Ordered week list
 * @param currentWkLabel  Current week label
 * @param componentSupplyCommits    partNumber → wkLabel → committed qty (real component POs with a delivery date)
 * @param componentSupplyUncommits  partNumber → wkLabel → uncommitted qty (real component POs with no delivery date yet)
 */
export function computeMRP(params: {
  fgPartNumber: string
  bomLines: BomLine[]
  components: ComponentMaster[]
  fgWeeklyDemand: Map<string, number>  // wkLabel → FG demand units
  weeks: Array<{ label: string }>
  currentWkLabel: string
  componentSupplyCommits?: Record<string, Record<string, number>>
  componentSupplyUncommits?: Record<string, Record<string, number>>
}): ComponentMrpResult[] {
  const {
    fgPartNumber, bomLines, components, fgWeeklyDemand, weeks, currentWkLabel,
    componentSupplyCommits = {}, componentSupplyUncommits = {},
  } = params

  const allWkLabels = weeks.map(w => w.label)
  const compMap = new Map(components.map(c => [c.partNumber, c]))

  // ── Step 1: Build adjacency map parent → children ─────────────────────────
  const children = new Map<string, BomLine[]>()
  for (const line of bomLines) {
    if (!children.has(line.parentPn)) children.set(line.parentPn, [])
    children.get(line.parentPn)!.push(line)
  }

  // ── Step 2: Recursive explosion — compute extended qty per FG unit ─────────
  // Returns Map<partNumber, extendedQtyPerFg>
  function explode(pn: string, multiplier: number, visited = new Set<string>()): Map<string, number> {
    const result = new Map<string, number>()
    if (visited.has(pn)) return result  // guard against circular refs
    visited.add(pn)

    const kids = children.get(pn) || []
    if (kids.length === 0) {
      // Leaf node (RM/PK with no further children) — record it
      result.set(pn, multiplier)
      return result
    }

    for (const kid of kids) {
      const kidQty = multiplier * kid.qtyPer
      const subResult = explode(kid.partNumber, kidQty, new Set(visited))

      if (subResult.size === 0) {
        // kid is a leaf
        result.set(kid.partNumber, (result.get(kid.partNumber) || 0) + kidQty)
      } else {
        // merge sub-explosion
        for (const [subPn, subQty] of subResult) {
          result.set(subPn, (result.get(subPn) || 0) + subQty)
        }
      }
    }
    return result
  }

  const extendedQtyMap = explode(fgPartNumber, 1)

  // If explosion produced nothing (no children in DB yet), fall back to L1 children
  if (extendedQtyMap.size === 0) {
    const l1 = children.get(fgPartNumber) || []
    for (const kid of l1) extendedQtyMap.set(kid.partNumber, kid.qtyPer)
  }

  // ── Step 3: Per component, compute weekly MRP ──────────────────────────────
  const results: ComponentMrpResult[] = []

  for (const [compPn, extQty] of extendedQtyMap) {
    const comp = compMap.get(compPn)
    if (!comp) continue  // skip if no master data

    const commitsByWk = componentSupplyCommits[compPn] || {}
    const uncommitsByWk = componentSupplyUncommits[compPn] || {}

    // Rolling on-hand — starts at component's current stock. Net requirement
    // is computed against on-hand + real committed supply for that week, so a
    // component PO already placed reduces (or clears) the suggested Planned PO.
    let rollingBalance = comp.onHandQty
    // Projected balance for display — mirrors the FG S&D pattern exactly:
    // balance = prior balance − demand + supply (commit, real placed POs).
    let displayBalance = comp.onHandQty

    let totalGross = 0
    let totalPlanned = 0
    let earliestPoReleaseWk: string | null = null
    let earliestPoReleaseFlag: 'OVERDUE' | 'URGENT' | 'PLAN' | 'OK' | null = null

    const weekRows: ComponentWeekRow[] = []

    for (const wk of weeks) {
      const fgDemand = fgWeeklyDemand.get(wk.label) || 0
      const grossReq = fgDemand * extQty
      const supplyCommit = commitsByWk[wk.label] || 0
      const supplyUncommit = uncommitsByWk[wk.label] || 0

      // Net requirement after consuming available stock + real committed supply
      const availableThisWeek = rollingBalance + supplyCommit
      const netReq = Math.max(0, grossReq - availableThisWeek)
      rollingBalance = Math.max(0, availableThisWeek - grossReq)

      const plannedOrderQty = netReq > 0
        ? roundUpToMoq(netReq, comp.moq, comp.spq)
        : 0

      let poReleaseWk: string | null = null
      let poReleaseFlag: 'OVERDUE' | 'URGENT' | 'PLAN' | 'OK' | null = null

      if (plannedOrderQty > 0 && comp.leadTimeWk != null) {
        const r = calcPoReleaseWk(wk.label, comp.leadTimeWk, allWkLabels, currentWkLabel)
        poReleaseWk = r.wkLabel
        poReleaseFlag = r.flag
        // Track the most urgent PO release needed
        if (!earliestPoReleaseWk) {
          earliestPoReleaseWk = poReleaseWk
          earliestPoReleaseFlag = poReleaseFlag
        } else if (poReleaseFlag === 'OVERDUE' || (poReleaseFlag === 'URGENT' && earliestPoReleaseFlag === 'PLAN')) {
          earliestPoReleaseWk = poReleaseWk
          earliestPoReleaseFlag = poReleaseFlag
        }
      }

      totalGross += grossReq
      totalPlanned += plannedOrderQty

      // Balance = prior balance − demand (gross req) + supply (commit, real placed component POs)
      displayBalance = displayBalance - grossReq + supplyCommit

      weekRows.push({
        wkLabel: wk.label,
        grossReq: Math.round(grossReq),
        netReq: Math.round(netReq),
        plannedOrderQty,
        poReleaseWk,
        poReleaseFlag,
        supplyUncommit: Math.round(supplyUncommit),
        supplyCommit: Math.round(supplyCommit),
        balance: Math.round(displayBalance),
      })
    }

    results.push({
      component: comp,
      extendedQtyPerFg: extQty,
      totalGrossReq: Math.round(totalGross),
      totalPlannedOrderQty: totalPlanned,
      earliestPoReleaseWk,
      earliestPoReleaseFlag,
      weeks: weekRows,
    })
  }

  // Sort: most urgent first, then by part number
  const flagOrder = { OVERDUE: 0, URGENT: 1, PLAN: 2, OK: 3, null: 4 }
  results.sort((a, b) => {
    const fa = flagOrder[a.earliestPoReleaseFlag as keyof typeof flagOrder] ?? 4
    const fb = flagOrder[b.earliestPoReleaseFlag as keyof typeof flagOrder] ?? 4
    if (fa !== fb) return fa - fb
    return a.component.partNumber.localeCompare(b.component.partNumber)
  })

  return results
}
