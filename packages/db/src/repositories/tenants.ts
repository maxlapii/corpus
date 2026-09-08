import { nowIso, prefixedId } from '@corpus/shared'
import type { Tenant } from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { mapTenant, type Row } from './mappers.js'

export class TenantRepository {
  constructor(private readonly db: DatabaseService) {}

  async findBySlug(slug: string): Promise<Tenant | null> {
    const row = await this.db.one<Row>('SELECT * FROM tenants WHERE slug = ?', [slug])
    return row ? mapTenant(row) : null
  }

  async findById(id: string): Promise<Tenant | null> {
    const row = await this.db.one<Row>('SELECT * FROM tenants WHERE id = ?', [id])
    return row ? mapTenant(row) : null
  }

  async listActive(): Promise<Tenant[]> {
    const rows = await this.db.many<Row>(
      "SELECT * FROM tenants WHERE status = 'ACTIVE' ORDER BY name",
    )
    return rows.map(mapTenant)
  }

  async create(input: { slug: string; name: string }): Promise<Tenant> {
    const id = prefixedId('ten')
    const ts = nowIso()
    await this.db.run(
      'INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.slug, input.name, 'ACTIVE', ts, ts],
    )
    return { id, slug: input.slug, name: input.name, status: 'ACTIVE', createdAt: ts, updatedAt: ts }
  }
}
