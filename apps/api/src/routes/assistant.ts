/**
 * The dashboard's chat surface. Same orchestrator, registry and gateway as the
 * bots, so there is no second, weaker path to the AI (CLAUDE.md §13).
 */

import { object, parse, str } from '@corpus/shared'
import { Hono } from 'hono'
import type { AppBindings } from '../context.js'
import { readJsonBody } from '../middleware/body.js'
import { identityOf } from './helpers.js'

const askBody = object({ message: str({ min: 1, max: 2000 }) })

export const assistantRoutes = new Hono<AppBindings>()

assistantRoutes.post('/ask', async (c) => {
  const container = c.get('container')
  const identity = identityOf(c)
  const body = parse(askBody, await readJsonBody(c))

  const reply = await container.orchestrator.handle({
    identity,
    message: body.message,
    requestId: c.get('requestId'),
  })

  return c.json({
    reply: reply.text,
    intent: reply.intent,
    citations: reply.citations,
    // Lets the dashboard show why an answer was limited.
    toolCalls: reply.toolCalls,
    refused: reply.refused,
    usage: reply.usage,
  })
})
