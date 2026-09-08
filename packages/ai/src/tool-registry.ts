/**
 * The only path from an AI tool request to execution (CLAUDE.md §15):
 * request → registry → PolicyGateway → handler → audit → result.
 *
 * `assertToolIsSafe` also refuses, at construction, any tool named like an
 * execution primitive or declaring a subject-identifier parameter.
 */

import { safeParse, type Logger } from '@corpus/shared'
import type { Identity, SecurityZone } from '@corpus/domain'
import { DENY_MESSAGES } from '@corpus/domain'
import type { PolicyGateway, SecurityEventService } from '@corpus/security'
import type { AIToolDescription } from './provider.js'
import {
  FORBIDDEN_PARAMETER_NAMES,
  TOOLS_ALLOWED_TO_TARGET_OTHERS,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
} from './tool-types.js'

const SQL_LIKE_NAME = /(sql|execute|raw_query|query_database|eval|exec)/i

export interface ToolExecution {
  toolName: string
  decision: 'ALLOW' | 'DENY'
  reasonCode: string | null
  outcome: ToolOutcome
  latencyMs: number
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any>>()

  constructor(
    private readonly gateway: PolicyGateway,
    private readonly logger: Logger,
    /** Records TOOL_DENIED for refusals that never reach the gateway. */
    private readonly securityEvents?: SecurityEventService,
  ) {}

  register<T>(tool: ToolDefinition<T>): void {
    assertToolIsSafe(tool)
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: readonly ToolDefinition<any>[]): void {
    for (const tool of tools) this.register(tool)
  }

  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name)
  }

  /**
   * Filtered by zone and permission, so the external bot is never told that
   * internal tools exist (CLAUDE.md §16).
   */
  describeFor(identity: Identity): AIToolDescription[] {
    return [...this.tools.values()]
      .filter((tool) => tool.scope === identity.zone)
      .filter((tool) => identity.permissions.has(tool.permission))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
  }

  availableNames(identity: Identity): string[] {
    return this.describeFor(identity).map((t) => t.name)
  }

  namesForZone(zone: SecurityZone): string[] {
    return [...this.tools.values()].filter((t) => t.scope === zone).map((t) => t.name)
  }

  /** The only way to run a handler. */
  async execute(
    name: string,
    rawArguments: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecution> {
    const started = Date.now()
    const deny = async (reasonCode: string, message: string): Promise<ToolExecution> => {
      // These happen before the gateway, so nothing else would record them.
      await this.securityEvents?.record({
        tenantId: ctx.identity.tenantId,
        eventType: 'TOOL_DENIED',
        userId: ctx.identity.kind === 'USER' ? ctx.identity.userId : null,
        telegramId: ctx.identity.telegramUserId ?? null,
        subjectKey: ctx.identity.subjectKey,
        channel: ctx.identity.channel,
        summary: `Tool request refused before authorisation (${reasonCode})`,
        detail: { tool: name, reasonCode, zone: ctx.identity.zone },
        requestId: ctx.requestId,
      })
      return {
        toolName: name,
        decision: 'DENY',
        reasonCode,
        outcome: { ok: false, reasonCode, message },
        latencyMs: Date.now() - started,
      }
    }

    const tool = this.tools.get(name)
    if (!tool) {
      // A hallucinated name must not reveal what does exist.
      this.logger.warn('unknown tool requested', {
        action: 'ai.tool',
        result: 'unknown_tool',
        requestId: ctx.requestId,
        tool: name,
      })
      return await deny('TOOL_NOT_FOUND', DENY_MESSAGES.TOOL_NOT_AVAILABLE_IN_ZONE)
    }

    // Before validation, before anything touches the database.
    if (tool.scope !== ctx.identity.zone) {
      return await deny('TOOL_NOT_AVAILABLE_IN_ZONE', DENY_MESSAGES.TOOL_NOT_AVAILABLE_IN_ZONE)
    }

    const parsed = safeParse(tool.validator, rawArguments ?? {})
    if (!parsed.ok) {
      return await deny(
        'INVALID_ARGUMENTS',
        'I could not use that information. Please rephrase your request.',
      )
    }

    // Ownership, tenant and classification come from the backend.
    let resource
    try {
      resource = await tool.resolveResource(ctx, parsed.value)
    } catch (e) {
      this.logger.error('tool resource resolution failed', {
        action: 'ai.tool',
        result: 'resolve_error',
        tool: name,
        requestId: ctx.requestId,
        error: e instanceof Error ? e.message : String(e),
      })
      return await deny('RESOURCE_NOT_FOUND', DENY_MESSAGES.RESOURCE_NOT_FOUND)
    }

    // The decision point; the AI has no vote. A bearer-credential tool binds the
    // caller to the resolved candidate first, and the binding is audited.
    const bound =
      tool.bearerCredential &&
      ctx.identity.kind === 'ANONYMOUS' &&
      !ctx.identity.candidateId &&
      resource.ownerCandidateId
        ? { ...ctx.identity, candidateId: resource.ownerCandidateId }
        : ctx.identity

    const decision = await this.gateway.authorize({
      identity: bound,
      action: tool.action,
      resource,
      requestId: ctx.requestId,
      metadata: {
        tool: name,
        ...(bound !== ctx.identity ? { credential: tool.bearerCredential } : {}),
      },
    })

    if (!decision.allowed) {
      return {
        toolName: name,
        decision: 'DENY',
        reasonCode: decision.reason,
        outcome: { ok: false, reasonCode: decision.reason, message: decision.message },
        latencyMs: Date.now() - started,
      }
    }

    try {
      const outcome = await tool.handler(
        { ...ctx, allowedClassifications: decision.allowedClassifications },
        parsed.value,
      )
      return {
        toolName: name,
        decision: outcome.ok ? 'ALLOW' : 'DENY',
        reasonCode: outcome.ok ? decision.viaPermission : outcome.reasonCode,
        outcome,
        latencyMs: Date.now() - started,
      }
    } catch (e) {
      this.logger.error('tool handler failed', {
        action: 'ai.tool',
        result: 'handler_error',
        tool: name,
        requestId: ctx.requestId,
        error: e instanceof Error ? e.message : String(e),
      })
      return await deny('TOOL_ERROR', 'Something went wrong retrieving that. Please try again.')
    }
  }
}

/** Throws at start-up rather than letting a dangerous tool reach production. */
export function assertToolIsSafe(tool: ToolDefinition<any>): void {
  if (SQL_LIKE_NAME.test(tool.name)) {
    throw new Error(
      `Tool "${tool.name}" is named like a generic execution primitive. ` +
        'CORPUS forbids execute_sql/query_database style tools (CLAUDE.md §53).',
    )
  }

  const properties = extractPropertyNames(tool.parameters)
  if (!TOOLS_ALLOWED_TO_TARGET_OTHERS.includes(tool.name)) {
    for (const property of properties) {
      if (FORBIDDEN_PARAMETER_NAMES.includes(property)) {
        throw new Error(
          `Tool "${tool.name}" declares parameter "${property}". Self-service tools must ` +
            'derive the subject from the authenticated identity (CLAUDE.md §17).',
        )
      }
    }
  }
  for (const property of properties) {
    if (['tenant_id', 'tenantId', 'role', 'roles', 'permission', 'permissions'].includes(property)) {
      throw new Error(
        `Tool "${tool.name}" declares parameter "${property}". Tenancy and authorisation are ` +
          'never inputs to a tool (CLAUDE.md §19).',
      )
    }
  }
}

function extractPropertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties
  if (typeof properties !== 'object' || properties === null) return []
  return Object.keys(properties as Record<string, unknown>)
}
