/**
 * Storage abstraction (CLAUDE.md §4).
 *
 * Production uses R2. Local development uses the filesystem. Production code
 * paths must never assume a local filesystem, so the interface is the only
 * thing services depend on.
 */

export interface StoredObject {
  key: string
  size: number
  contentType: string | null
}

export interface StorageService {
  put(key: string, body: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<StoredObject>
  get(key: string): Promise<{ body: ArrayBuffer; contentType: string | null } | null>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

/** Minimal shape of an R2 bucket binding, so we do not depend on the SDK. */
interface R2Like {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>
  delete(key: string): Promise<void>
  head(key: string): Promise<unknown | null>
}

export class R2StorageService implements StorageService {
  constructor(private readonly bucket: R2Like) {}

  async put(
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    contentType?: string,
  ): Promise<StoredObject> {
    await this.bucket.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined)
    const size =
      typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength
    return { key, size, contentType: contentType ?? null }
  }

  async get(key: string): Promise<{ body: ArrayBuffer; contentType: string | null } | null> {
    const object = await this.bucket.get(key)
    if (!object) return null
    return { body: await object.arrayBuffer(), contentType: object.httpMetadata?.contentType ?? null }
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    return (await this.bucket.head(key)) !== null
  }
}

/**
 * In-memory storage. Used by tests and as the fallback when no R2 bucket is
 * bound, so the API still runs (uploads simply do not survive a restart, which
 * `/health` reports).
 */
export class MemoryStorageService implements StorageService {
  private readonly objects = new Map<string, { body: ArrayBuffer; contentType: string | null }>()

  async put(
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    contentType?: string,
  ): Promise<StoredObject> {
    const buffer =
      typeof body === 'string'
        ? (new TextEncoder().encode(body).buffer as ArrayBuffer)
        : body instanceof Uint8Array
          ? (body.slice().buffer as ArrayBuffer)
          : body
    this.objects.set(key, { body: buffer, contentType: contentType ?? null })
    return { key, size: buffer.byteLength, contentType: contentType ?? null }
  }

  async get(key: string): Promise<{ body: ArrayBuffer; contentType: string | null } | null> {
    return this.objects.get(key) ?? null
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key)
  }
}

/** Namespaced storage keys. Tenant-prefixed so objects cannot collide. */
export function documentKey(tenantId: string, documentId: string, version: number, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `tenants/${tenantId}/documents/${documentId}/v${version}/${safe}`
}

export function cvKey(tenantId: string, candidateId: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `tenants/${tenantId}/cvs/${candidateId}/${safe}`
}
