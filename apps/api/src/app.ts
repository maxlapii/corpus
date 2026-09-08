/**
 * Hono application wiring.
 *
 * Route mounting is where the security zones become concrete:
 *   • `/public/*`     — ANONYMOUS identity (EXTERNAL zone)
 *   • `/telegram/*`   — webhook-secret authenticated, zone fixed per path
 *   • everything else — requires a verified session (INTERNAL zone)
 */

import { Hono } from 'hono'
import type { AppBindings } from './context.js'
import { requireSession, publicIdentity } from './middleware/auth.js'
import { readJsonBody } from './middleware/body.js'
import { errorHandler, notFoundHandler } from './middleware/errors.js'
import { requestContext } from './middleware/request-context.js'
import { cors, securityHeaders } from './middleware/security-headers.js'
import { assistantRoutes } from './routes/assistant.js'
import { authRoutes } from './routes/auth.js'
import { employeeRoutes, orgRoutes } from './routes/employees.js'
import { healthRoutes } from './routes/health.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { knowledgeAnswerRoutes } from './routes/knowledge-answers.js'
import { holidayRoutes, leaveRoutes } from './routes/leave.js'
import {
  applicationRoutes,
  candidateRoutes,
  jobRoutes,
  publicRecruitmentRoutes,
} from './routes/recruitment.js'
import { reportRoutes } from './routes/reports.js'
import { auditRoutes, securityRoutes } from './routes/security.js'
import { telegramRoutes } from './routes/telegram.js'

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.onError(errorHandler)
  app.notFound(notFoundHandler)

  app.use('*', requestContext)
  app.use('*', securityHeaders)
  app.use('*', cors)

  // --- Unauthenticated
  app.route('/health', healthRoutes)
  app.route('/telegram', telegramRoutes)
  app.route('/auth', authRoutes)

  // --- Public (EXTERNAL zone)
  const publicApi = new Hono<AppBindings>()
  publicApi.use('*', publicIdentity)
  publicApi.route('/', publicRecruitmentRoutes)
  app.route('/public', publicApi)

  // --- Internal (INTERNAL zone, session required)
  const internal = new Hono<AppBindings>()
  internal.use('*', requireSession)
  internal.route('/employees', employeeRoutes)
  internal.route('/', orgRoutes)
  internal.route('/leave', leaveRoutes)
  internal.route('/holidays', holidayRoutes)
  internal.route('/jobs', jobRoutes)
  internal.route('/candidates', candidateRoutes)
  internal.route('/applications', applicationRoutes)
  internal.route('/policies', knowledgeRoutes)
  internal.route('/knowledge/answers', knowledgeAnswerRoutes)
  internal.route('/reports', reportRoutes)
  internal.route('/audit', auditRoutes)
  internal.route('/security', securityRoutes)
  internal.route('/assistant', assistantRoutes)
  app.route('/', internal)

  return app
}

// `readJsonBody` is used by the route modules; re-exported for tests.
export { readJsonBody }
