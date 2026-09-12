/**
 * Telegram webhook routes (CLAUDE.md §36).
 *
 * Two separate paths with separate secrets and separate handlers. The zone is
 * decided by which path was hit, in code — never by anything in the payload.
 *
 * Both endpoints always answer 200 once the secret is verified: Telegram
 * retries any non-200, and a retry storm on a handler error would amplify the
 * problem. Failures are logged and recorded as security events instead.
 */

import { Hono } from 'hono'
import {
  ExternalBot,
  InternalBot,
  WEBHOOK_SECRET_HEADER,
  normaliseUpdate,
  selectCodeDelivery,
  verifyWebhookSecret,
} from '@corpus/telegram'
import { clientIpKey } from '../client-ip.js'
import type { AppBindings } from '../context.js'

export const telegramRoutes = new Hono<AppBindings>()

for (const bot of ['external', 'internal'] as const) {
  telegramRoutes.post(`/${bot}`, async (c) => {
    const container = c.get('container')
    const requestId = c.get('requestId')

    const expected =
      bot === 'external'
        ? container.config.telegram.externalWebhookSecret
        : container.config.telegram.internalWebhookSecret

    // The secret is checked before ANY database access, so an unauthenticated
    // flood cannot be turned into write amplification against D1.
    const verification = verifyWebhookSecret(c.req.header(WEBHOOK_SECRET_HEADER), expected)
    if (!verification.ok) {
      // A bad or missing secret is an unauthenticated caller pretending to be
      // Telegram. Do not process, do not describe what was wrong.
      //
      // The rejection is still worth recording, but one row per forged request
      // would itself be a denial-of-service vector, so recording is throttled
      // per client: the first few in each window are kept, the rest dropped.
      const ip = clientIpKey(c.req)
      const budget = await container.rateLimiter.consume(`tghook:${bot}:${ip}`, {
        limit: 5,
        windowSeconds: 300,
      })
      if (budget.allowed) {
        const rejectedFor = await container.repos.tenants.findBySlug(
          container.config.defaultTenantSlug,
        )
        await container.securityEvents.record({
          tenantId: rejectedFor?.id ?? null,
          eventType: 'AUTH_FAILURE',
          severity: verification.reason === 'NO_SECRET_CONFIGURED' ? 'MEDIUM' : 'HIGH',
          channel: bot === 'external' ? 'TELEGRAM_EXTERNAL' : 'TELEGRAM_INTERNAL',
          summary: `Telegram webhook rejected (${verification.reason})`,
          detail: { recordsRemainingInWindow: budget.remaining },
          requestId,
        })
      }
      return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Rejected.' } }, 401)
    }

    const tenant = await container.repos.tenants.findBySlug(container.config.defaultTenantSlug)
    if (!tenant) {
      container.logger.error('telegram webhook received before tenant initialisation', {
        action: 'telegram.webhook',
        result: 'no_tenant',
        requestId,
      })
      return c.json({ ok: true })
    }

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ ok: true })
    }

    const update = normaliseUpdate(payload)
    if (!update) return c.json({ ok: true })

    try {
      if (bot === 'external') {
        await new ExternalBot({
          client: container.externalBotClient,
          orchestrator: container.orchestrator,
          identityResolver: container.identityResolver,
          repos: container.repos,
          securityEvents: container.securityEvents,
          rateLimiter: container.rateLimiter,
          replayGuard: container.replayGuard,
          logger: container.logger,
          cvIntake: container.cvIntake,
          tenantId: tenant.id,
          messageRule: container.rateLimits.telegramPerUser,
          uploadRule: container.rateLimits.applicationPerSubject,
        }).handle(update)
      } else {
        await new InternalBot({
          client: container.internalBotClient,
          orchestrator: container.orchestrator,
          identityResolver: container.identityResolver,
          telegramIdentity: container.telegramIdentity,
          codeDelivery: selectCodeDelivery(container.config.environment, container.logger),
          repos: container.repos,
          securityEvents: container.securityEvents,
          rateLimiter: container.rateLimiter,
          replayGuard: container.replayGuard,
          logger: container.logger,
          gateway: container.gateway,
          cvIntake: container.cvIntake,
          tenantId: tenant.id,
          messageRule: container.rateLimits.telegramPerUser,
          uploadRule: container.rateLimits.applicationPerSubject,
          verificationRule: container.rateLimits.verificationPerUser,
        }).handle(update)
      }
    } catch (e) {
      container.logger.error('telegram handler failed', {
        action: 'telegram.webhook',
        result: 'handler_error',
        channel: bot,
        requestId,
        error: e instanceof Error ? e.message : String(e),
      })
    }

    return c.json({ ok: true })
  })
}
