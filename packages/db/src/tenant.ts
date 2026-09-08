import { forbidden } from '@corpus/shared'

/**
 * Tenant isolation (CLAUDE.md §7). Repositories take this rather than a bare
 * string so a missing tenant is an error, not a query spanning every tenant.
 */
export interface TenantScope {
  readonly tenantId: string
}

export function tenantScope(tenantId: string | null | undefined): TenantScope {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw forbidden('The requested resource is not available.', {
      internal: 'tenantScope() called without a tenant id',
    })
  }
  return { tenantId }
}

/** Defence in depth for rows fetched by a global key, e.g. an application reference. */
export function assertSameTenant(
  scope: TenantScope,
  row: { tenant_id?: string | null } | null | undefined,
): void {
  if (row?.tenant_id && row.tenant_id !== scope.tenantId) {
    throw forbidden('The requested resource is not available.', {
      internal: `tenant mismatch: row=${row.tenant_id} scope=${scope.tenantId}`,
      details: { reason: 'TENANT_MISMATCH' },
    })
  }
}
