/** Hono context typing shared by every route and middleware. */

import type { Identity } from '@corpus/domain'
import type { SessionContext } from '@corpus/auth'
import type { Container } from './container.js'
import type { WorkerEnv } from './env.js'

export interface AppVariables {
  requestId: string
  container: Container
  /** Present only after `requireSession`. */
  session?: SessionContext
  /** Present only after `requireSession` / `resolvePublicIdentity`. */
  identity?: Identity
  startedAt: number
}

export interface AppBindings {
  Bindings: WorkerEnv
  Variables: AppVariables
}
