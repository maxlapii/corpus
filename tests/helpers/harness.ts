/**
 * Full-stack test harness.
 *
 * Boots the *real* Hono app against a real SQLite engine with the real
 * migrations and the real seed fixtures. Nothing is stubbed except the LLM
 * (MockAIProvider) and outbound Telegram HTTP, so the tests exercise the
 * genuine middleware → PolicyGateway → repository path.
 */

import { createApp } from '@corpus/api/app'
import { createContainer, type Container } from '@corpus/api/container'
import { CSRF_HEADER, SESSION_COOKIE } from '@corpus/auth'
import { MemoryStorageService } from '@corpus/db'
import { DocumentIngestionService } from '@corpus/knowledge'
import { SecurityEventService } from '@corpus/security'
import { nullLogger } from '@corpus/shared'
import { createTestDatabase, type TestDatabase } from '@corpus/db/test-support'
import { SEED_DOCUMENT_TEXTS, seedDatabase, type SeedResult } from '../../scripts/seed-data.js'

export const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long'
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-value-0123456789abcdef'

export interface HarnessOptions {
  /** Index the seed policy documents. Off by default for speed. */
  withKnowledge?: boolean
  /**
   * Extra environment overrides. Values are usually strings (vars), but may be
   * objects when injecting a Worker binding such as `AI`.
   */
  env?: Record<string, unknown>
  /** Seed a second tenant, for isolation tests. */
  secondTenant?: boolean
}

export interface Harness {
  database: TestDatabase
  seed: SeedResult
  /** Present only when `secondTenant` was requested. */
  seedB?: SeedResult
  env: Record<string, unknown>
  request(path: string, init?: RequestInit): Promise<Response>
  json<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>
  login(email: string, password?: string): Promise<AuthedClient>
  /**
   * The app's own container, built from the same env. Lets a test reach a
   * service directly — storing a CV, say — without going through HTTP, while
   * still sharing the module-scoped memory storage the routes use.
   */
  container: Container
  close(): void
}

export interface AuthedClient {
  token: string
  csrfToken: string
  userId: string
  get<T = any>(path: string): Promise<{ status: number; body: T }>
  post<T = any>(path: string, body?: unknown): Promise<{ status: number; body: T }>
  put<T = any>(path: string, body?: unknown): Promise<{ status: number; body: T }>
  del<T = any>(path: string): Promise<{ status: number; body: T }>
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database = await createTestDatabase()
  const seed = await seedDatabase(database.repos, { tenantSlug: 'default', tenantName: 'Tenant A' })

  let seedB: SeedResult | undefined
  if (options.secondTenant) {
    seedB = await seedDatabase(database.repos, { tenantSlug: 'tenant-b', tenantName: 'Tenant B' })
  }

  if (options.withKnowledge) {
    await indexSeedDocuments(database, seed)
    if (seedB) await indexSeedDocuments(database, seedB)
  }

  const env: Record<string, unknown> = {
    DB: database.handle,
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'error',
    SESSION_SECRET: TEST_SESSION_SECRET,
    DEFAULT_TENANT_SLUG: 'default',
    CORS_ORIGINS: 'http://localhost:3000',
    AI_PROVIDER: 'mock',
    AI_REQUESTS_PER_HOUR: '1000',
    // Rate limits are exercised by their own dedicated test, which sets them
    // low explicitly. Everywhere else they must not throttle the suite.
    RATE_LIMIT_LOGIN_PER_15M: '500',
    RATE_LIMIT_VERIFY_PER_15M: '500',
    RATE_LIMIT_APPLICATIONS_PER_HOUR: '500',
    RATE_LIMIT_TELEGRAM_PER_MINUTE: '500',
    RATE_LIMIT_PUBLIC_API_PER_MINUTE: '2000',
    TELEGRAM_EXTERNAL_BOT_TOKEN: '',
    TELEGRAM_INTERNAL_BOT_TOKEN: '',
    TELEGRAM_EXTERNAL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    TELEGRAM_INTERNAL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    ...options.env,
  }

  const app = createApp()

  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    app.request(`http://api.test${path}`, init, env) as unknown as Promise<Response>

  const json = async <T>(path: string, init: RequestInit = {}) => {
    const response = await request(path, init)
    const text = await response.text()
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as T,
    }
  }

  const login = async (email: string, password = seed.password): Promise<AuthedClient> => {
    const response = await request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (response.status !== 200) {
      throw new Error(`login failed for ${email}: ${response.status} ${await response.text()}`)
    }
    const body = (await response.json()) as { csrfToken: string; user: { id: string } }
    const setCookie = response.headers.get('set-cookie') ?? ''
    const token = /corpus_session=([^;]+)/.exec(setCookie)?.[1]
    if (!token) throw new Error('login response did not set a session cookie')

    const call = async <T>(method: string, path: string, payload?: unknown) => {
      const headers: Record<string, string> = {
        cookie: `${SESSION_COOKIE}=${token}`,
        [CSRF_HEADER]: body.csrfToken,
      }
      if (payload !== undefined) headers['content-type'] = 'application/json'
      const result = await request(path, {
        method,
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      })
      const text = await result.text()
      return { status: result.status, body: (text ? JSON.parse(text) : null) as T }
    }

    return {
      token,
      csrfToken: body.csrfToken,
      userId: body.user.id,
      get: (path) => call('GET', path),
      post: (path, payload) => call('POST', path, payload ?? {}),
      put: (path, payload) => call('PUT', path, payload ?? {}),
      del: (path) => call('DELETE', path),
    }
  }

  const container = createContainer(env as never, 'test-harness')

  return {
    database,
    seed,
    ...(seedB ? { seedB } : {}),
    env,
    request,
    json,
    login,
    container,
    close: () => database.close(),
  }
}

async function indexSeedDocuments(database: TestDatabase, seed: SeedResult): Promise<void> {
  const ingestion = new DocumentIngestionService({
    knowledge: database.repos.knowledge,
    storage: new MemoryStorageService(),
    securityEvents: new SecurityEventService(database.repos.securityEvents, nullLogger),
    logger: nullLogger,
  })
  const scope = { tenantId: seed.tenantId }
  const year = new Date().getUTCFullYear()

  for (const [key, documentId] of Object.entries(seed.documentIds)) {
    const source = SEED_DOCUMENT_TEXTS[key]
    if (!source) continue
    const document = await database.repos.knowledge.findDocumentById(scope, documentId)
    if (!document) continue
    await ingestion.ingestText({
      tenantId: seed.tenantId,
      documentId,
      classification: document.classification,
      effectiveFrom: `${year}-01-01`,
      filename: `${source.name}.txt`,
      text: source.text,
      uploadedByUserId: null,
      supersedePrevious: true,
    })
  }
}

/** Convenience: the seeded e-mail for a fixture key. */
export function seedEmail(seed: SeedResult, key: string): string {
  const employee = seed.employees[key]
  if (!employee) throw new Error(`no seeded employee for key "${key}"`)
  return employee.email
}
