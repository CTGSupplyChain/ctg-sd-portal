// Single source of truth for portal roles (SOW v2, 18 Oct 2026).
//
// Two views:
//   CTG Supply Chain — superadmin, admin, buyer  (all brands)
//   Brand owner      — read-only, own brand(s) via user_brand_access
//
// The database enforces the same split in RLS (ctg_global_role / ctg_is_staff);
// these helpers only decide what the UI shows. Legacy profile values are mapped:
//   supply_chain -> admin, project_owner -> brand_owner.

export type PortalRole = 'superadmin' | 'admin' | 'buyer' | 'brand_owner' | 'none'

export function normalizeRole(raw?: string | null): PortalRole {
  switch ((raw ?? '').toLowerCase()) {
    case 'superadmin': return 'superadmin'
    case 'admin':
    case 'supply_chain': return 'admin'
    case 'buyer': return 'buyer'
    case 'brand_owner':
    case 'project_owner': return 'brand_owner'
    default: return 'none'
  }
}

/** CTG Supply Chain view (sees every brand). */
export const isStaff = (raw?: string | null) =>
  ['superadmin', 'admin', 'buyer'].includes(normalizeRole(raw))

/** Can edit master data, uploads, forecasts regeneration, PLM. */
export const canEdit = (raw?: string | null) =>
  ['superadmin', 'admin'].includes(normalizeRole(raw))

/** Can raise / edit purchase orders and supply inputs. */
export const canBuy = (raw?: string | null) =>
  ['superadmin', 'admin', 'buyer'].includes(normalizeRole(raw))

export const isBrandOwner = (raw?: string | null) => normalizeRole(raw) === 'brand_owner'

export const roleLabel = (raw?: string | null) => ({
  superadmin: 'Superadmin',
  admin: 'Admin',
  buyer: 'Buyer',
  brand_owner: 'Brand owner',
  none: 'No access',
}[normalizeRole(raw)])
