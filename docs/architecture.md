# CORPUS — System Architecture

This document describes how CORPUS is actually built: the hosted topology, the
monorepo layout, how a request travels from the edge to the database, how an AI
request travels from a chat channel to a filtered answer, and how the code
satisfies the stateless-Worker and zero-cost constraints set out in
[`CLAUDE.md`](../CLAUDE.md) §3–§6 and §13. Every non-obvious statement cites the
file that implements it (paths are relative to the repository root).

The governing invariant, which nothing in this document weakens:

> The AI may understand the question, but the backend decides what the user is
> allowed to know or do.

In code terms: every protected operation — whether it originates from a
dashboard route, a Telegram message or an AI tool request — is authorised by
`PolicyGateway` (`packages/security/src/policy-gateway.ts`) before any
repository is touched.

---

## 1. Hosted topology

Production runs entirely on Cloudflare's free tier plus an external LLM API.

```text
   Telegram users                        HR / admin staff (browser)
 (candidates, employees)                           │
        │                                          │  HTTPS (cookie session + CSRF header)
        │  webhook POST                            ▼
        │  X-Telegram-Bot-Api-Secret-Token   ┌──────────────────────────┐
        │                                    │ Next.js 14 dashboard     │
        │                                    │ Cloudflare Pages         │
        │                                    │ (apps/web)               │
        │                                    └────────────┬─────────────┘
        │                                                 │  fetch(NEXT_PUBLIC_API_BASE_URL)
        ▼                                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker  —  Hono API  (apps/api)                            │
│                                                                        │
│  /telegram/external  /telegram/internal   /public/*   /auth/*  /...    │
│                                                                        │
│  middleware → identity → PolicyGateway → repositories → response       │
│  AI: channel adapter → IdentityResolver → IntentClassifier →           │
│      PolicyGateway → AIOrchestrator → ToolRegistry → response filter   │
└───────┬───────────────────────┬───────────────────────┬────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐      ┌────────────────┐      ┌────────────────────┐
│ D1  (binding  │      │ R2  (binding   │      │ KV  (binding       │
│ DB)           │      │ DOCUMENTS)     │      │ RATE_LIMIT)        │
│ all structured│      │ uploaded       │      │ rate-limit counters│
│ data + FTS5   │      │ document bytes │      │ + webhook replay   │
│ chunks index  │      │                │      │   guard            │
└───────────────┘      └────────────────┘      └────────────────────┘
                                │
                                ▼   (outbound HTTPS only; keys are Worker secrets)
                       ┌────────────────────┐
                       │ LLM provider       │
                       │ Anthropic / OpenAI │
                       │ / compatible / mock│
                       └────────────────────┘
```

| Component | Implementation | Where configured |
|---|---|---|
| API runtime | Cloudflare Worker exporting `fetch` only (`apps/api/src/index.ts`) | `apps/api/wrangler.toml` (`main`, `compatibility_flags = ["nodejs_compat"]`) |
| HTTP framework | Hono 4 (`apps/api/src/app.ts`) | `apps/api/package.json` |
| Structured data | D1 (SQLite) via binding `DB`; migrations in `migrations/*.sql` | `[[d1_databases]]` with `migrations_dir = "../../migrations"` |
| Document bytes | R2 via binding `DOCUMENTS` | `[[r2_buckets]]` |
| Rate-limit counters, replay guard | KV via binding `RATE_LIMIT` | `[[kv_namespaces]]` |
| Admin dashboard | Next.js 14 client of the API; built with `@cloudflare/next-on-pages`, deployed with `wrangler pages deploy` | `apps/web/package.json` (`pages:build`, `pages:deploy`), `.github/workflows/ci.yml` |
| Telegram | Two bots, two webhook paths, two tokens, two webhook secrets | `apps/api/src/routes/telegram.ts`, `scripts/telegram-setup.ts` |
| LLM | `createAIProvider(config)` selects `mock`, `anthropic`, `openai` or `compatible` | `packages/ai/src/providers/index.ts`; `AI_PROVIDER` var |

The `wrangler.toml` ships with `TODO_*` placeholders for the D1 database id, KV
namespace id and public URL; the operator fills them in (see
`docs/deployment.md`). No account id, token or secret is committed. Secrets
(`SESSION_SECRET`, bot tokens, webhook secrets, `AI_API_KEY`) are set with
`wrangler secret put` and read through `loadConfig()`
(`packages/shared/src/config.ts`), which also exposes a secret-free
`describeConfig()` for `/health`.

Nothing that is not free-tier is introduced: there is no Redis, no queue, no
container, no vector database and no PostgreSQL. Where CLAUDE.md §3 forbids a
component, the code substitutes a D1 table or a KV key (see §7 and §8 below).

---

## 2. Monorepo layout and package responsibilities

npm workspaces (`package.json` → `apps/*`, `packages/*`), TypeScript
throughout, one root `tsconfig.json` with `@corpus/*` path aliases and one
root `vitest.config.ts` with matching aliases.

```text
corpus/
├── apps/
│   ├── api/                    Cloudflare Worker (Hono). Thin: routing, middleware, DI container.
│   │   ├── src/
│   │   │   ├── index.ts        Worker entrypoint (fetch handler only)
│   │   │   ├── app.ts          Route mounting = security-zone boundaries
│   │   │   ├── container.ts    Per-request dependency container, adapter selection
│   │   │   ├── context.ts      Hono context typing (requestId, container, session, identity)
│   │   │   ├── env.ts          WorkerEnv: bindings + vars, mirrors wrangler.toml
│   │   │   ├── middleware/     request-context, auth, body, errors, security-headers
│   │   │   └── routes/         auth, employees, leave, recruitment, knowledge, reports,
│   │   │                       security, telegram, assistant, health, helpers
│   │   └── wrangler.toml
│   └── web/                    Next.js 14 dashboard (client of the API; no secrets)
│       ├── app/                layout, page (dashboard), login, people, recruitment, leave,
│       │                       knowledge, assistant, reports, security, settings
│       ├── components/         session (context), shell (nav + auth gate), ui
│       └── lib/                api.ts (fetch client, CSRF), use-api.ts
├── packages/                   All business, security and AI logic lives here
│   ├── shared/                 errors, ids, logger (redacting), validate, dates, config, pagination, crypto, text
│   ├── domain/                 classification, roles/permissions, identity, intents, entities,
│   │                           application-flow, leave-flow, leave-calculation, security-events, resources
│   ├── db/                     SqlDatabase interface, D1 + better-sqlite3 adapters, DatabaseService/UnitOfWork,
│   │                           migrations runner, TenantScope, StorageService (R2/Memory), repositories
│   ├── auth/                   passwords, sessions (+CSRF), telegram-identity (link/verify), identity-resolver, login
│   ├── security/               policy-rules (declarative table), PolicyGateway, security-events,
│   │                           prompt-injection scanner, response-filter, rate-limit (KV/D1/Memory)
│   ├── knowledge/              extraction, chunking, D1KnowledgeSearchService (FTS5 + LIKE), ingestion
│   ├── ai/                     AIProvider + providers (anthropic, openai, mock), tool contracts, ToolRegistry,
│   │                           tools (external / internal-self / internal-management), prompts,
│   │                           IntentClassifier, AIOrchestrator
│   └── telegram/               webhook verification + normalisation, replay guard, Bot API client,
│                               ExternalBot, InternalBot
├── migrations/                 0001_core_identity … 0006_rbac_reference (SQLite/D1 SQL)
├── scripts/                    migrate, seed, reset, prune, local-db, check-secrets, telegram-setup,
│                               generate-rbac-migration
├── tests/                      unit/, integration/, security/, e2e/, helpers/ (full-stack harness)
├── docs/
└── .github/workflows/ci.yml
```

**Deviation from CLAUDE.md §6, deliberately.** The suggested layout places
`services/`, `security/`, `ai/`, `telegram/`, `knowledge/` and `repositories/`
under `apps/api/src/`. Those directories exist there but are empty; the
implementations live in the workspace packages so that the same code is
exercised by the Worker, the Node scripts and the test suite without a bundler
boundary between them. `apps/api` is intentionally a thin shell.

### Package dependency direction

```text
shared ◄── domain ◄── db ◄── auth ◄── security ◄── knowledge ◄── ai ◄── telegram ◄── apps/api
```

Lower packages never import higher ones. `packages/db/src/index.ts` exports
only the Worker-safe surface; the Node-only pieces (`sqlite-adapter.ts`,
`migration-files.ts`, `test-support.ts`) are reachable only via subpath
imports (`@corpus/db/sqlite-adapter`), so they can never be pulled into the
Worker bundle.

### What each package owns

| Package | Owns | Must never |
|---|---|---|
| `shared` | `AppError` + `toAppError` (public JSON without internals), redacting `createLogger`, validators, `loadConfig`/`validateConfig`/`describeConfig`, pagination, WebCrypto helpers | hold business rules |
| `domain` | Pure types and tables: `CLASSIFICATIONS`, `ROLES`/`PERMISSIONS`/`ROLE_PERMISSIONS`, `Identity` union, `INTENTS`/`INTENT_DEFINITIONS`, `RESOURCE_TYPES`/`ACTIONS`, leave-day calculation, application stage transitions | perform I/O |
| `db` | The only SQL in the codebase. `DatabaseService` (parameterised only), `UnitOfWork` (batched atomic writes), repositories keyed by `TenantScope`, `StorageService` | decide authorisation |
| `auth` | Session issue/resolve/revoke, CSRF, password hashing, Telegram link/verify, `IdentityResolver` — the only constructor of `Identity` | trust a claim from a request body or an LLM |
| `security` | `POLICY_RULES` table, `PolicyGateway`, `SecurityEventService`, injection scanner, `filterAiResponse`, rate limiters | be bypassed: routes and tools call it, never re-implement it |
| `knowledge` | upload → extract → clean → chunk → index; permission-filtered search | return a chunk outside the caller's classification set |
| `ai` | Provider abstraction, tool contracts and registry, prompts, classifier, orchestrator | execute a tool without `ToolRegistry.execute`, or reach the database directly |
| `telegram` | Webhook secret check, update normalisation, replay guard, Bot API client, the two bot adapters | derive identity from a username, display name or message text |

---

## 3. Runtime composition: the per-request container

Workers are stateless (`CLAUDE.md` §4), so CORPUS builds its whole object
graph per request and holds nothing important in module scope.

```text
fetch(request, env)                         apps/api/src/index.ts
  └─ app.fetch                              apps/api/src/app.ts
       └─ requestContext middleware         apps/api/src/middleware/request-context.ts
            └─ createContainer(env, id)     apps/api/src/container.ts
                 ├─ loadConfig(env) + validateConfig
                 ├─ DatabaseService(fromD1(env.DB)) → createRepositories
                 ├─ SecurityEventService, PolicyGateway({ audit, securityEvents, logger })
                 ├─ StorageService   : R2StorageService  | MemoryStorageService
                 ├─ RateLimiter      : KvRateLimiter     | D1RateLimiter | MemoryRateLimiter
                 ├─ ReplayGuard      : KvReplayGuard     | MemoryReplayGuard
                 ├─ SessionService, LoginService, IdentityResolver, TelegramIdentityService
                 ├─ D1KnowledgeSearchService, DocumentIngestionService
                 ├─ createAIProvider(config), ToolRegistry(gateway).registerAll(ALL_TOOLS)
                 ├─ IntentClassifier, AIOrchestrator({ …, limits })
                 └─ TelegramClient × 2 (external, internal)
```

The container's own header comment states the rule: "Nothing is cached in
module scope except pure functions, so no request can observe another
request's state." The three module-level singletons that do exist
(`memoryRateLimiter`, `memoryReplayGuard`, `memoryStorage`) are
*fallbacks only*, used when the corresponding binding is absent; `/health`
reports the degradation (`documentStorage: "ephemeral"`) rather than hiding
it (`apps/api/src/routes/health.ts`).

Binding detection is duck-typed (`isR2`: has `put` and `head`; `isKv`: has
`get` and `put` but not `head`) so that tests can pass an in-memory SQLite
handle as `DB` and omit the others (`tests/helpers/harness.ts`).

| Binding / var | Required? | Used for | Fallback when absent |
|---|---|---|---|
| `DB` (D1) | Yes — `fromD1()` throws without it | All structured data, FTS5 index, `rate_limit_counters` | none (request fails) |
| `DOCUMENTS` (R2) | No | Original bytes of uploaded documents | `MemoryStorageService` (per-isolate, non-durable, reported by `/health`) |
| `RATE_LIMIT` (KV) | No | Fixed-window counters, Telegram `update_id` replay guard | `D1RateLimiter` (table) and `MemoryReplayGuard` |
| `SESSION_SECRET` | Yes in prod (≥32 chars, `validateConfig`) | Subject-key HMAC, IP hashing | warning in development |
| `TELEGRAM_*_BOT_TOKEN` / `*_WEBHOOK_SECRET` | Optional; secret is *required* if token is set | Bot API calls; webhook authentication | bot disabled / webhook rejected with `NO_SECRET_CONFIGURED` |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | key required unless `mock` | LLM calls | `MockAIProvider` (must not be used in production — `validateConfig` errors) |

---

## 4. HTTP request lifecycle

### 4.1 Route mounting defines the security zones

`apps/api/src/app.ts` is where CLAUDE.md §8's two zones become concrete:

```text
app
 ├─ onError(errorHandler) / notFound(notFoundHandler)          middleware/errors.ts
 ├─ use('*', requestContext)   request id, container, access log
 ├─ use('*', securityHeaders)  CSP default-src 'none', nosniff, DENY framing, no-store, HSTS in prod
 ├─ use('*', cors)             explicit origin allowlist; preflight 204 only for allowed origins
 │
 ├─ /health          liveness + readiness (no auth)
 ├─ /telegram/:bot   webhook-secret authenticated; zone fixed by path in code
 ├─ /auth            login (no auth) · logout, me, telegram/link, telegram/verify (requireSession)
 │
 ├─ /public/*        publicIdentity → ANONYMOUS / EXTERNAL identity, per-IP rate limit
 │     └─ jobs, jobs/:jobCode, applications, applications/:reference
 │
 └─ /*               requireSession → USER / INTERNAL identity
       └─ employees, departments, positions, leave, holidays, jobs, candidates,
          applications, policies, reports, audit, security, assistant
```

### 4.2 The path of one internal request

```text
 client ── HTTPS ──► Worker
   1. requestContext      x-request-id (echo only if /^[A-Za-z0-9_-]{6,64}$/), createContainer
   2. securityHeaders     (applied on the way out)
   3. cors                origin ∈ config.corsOrigins, else no ACAO header / 403 preflight
   4. requireSession      middleware/auth.ts
        a. token from `corpus_session` cookie or `Authorization: Bearer`
        b. SessionService.resolve: SHA-256(token) lookup, not revoked, not expired,
           user ACTIVE, roles loaded from user_roles  → permissions via ROLE_PERMISSIONS
           (packages/auth/src/sessions.ts)
        c. non-GET/HEAD/OPTIONS → assertCsrf(x-corpus-csrf) (double-submit, constant time)
        d. per-user API budget: rateLimiter.consume(`api:{tenant}:{user}`, adminApiPerUser)
        e. identity = IdentityResolver.fromSession(session, 'WEB')  — loads managedEmployeeIds
   5. route handler       routes/*.ts
        a. parse(validator, await readJsonBody(c))       — 512 KiB cap, JSON object only
        b. scope = tenantScope(identity.tenantId)         — throws if blank
        c. resource = { type, id, ownerEmployeeId (from DB), tenantId, classification }
        d. decision = await gateway.require({ identity, action, resource, businessRules })
        e. repos.*.method(scope, …)                        — every query filtered by tenant_id
        f. c.json(dto)                                      — only authorised fields
   6. errorHandler        AppError → { error: { code, message, requestId } }; 5xx logged server-side,
                          SQL/driver text never leaves the Worker (DatabaseService.wrap)
   7. access log          route, method, status, latencyMs, userId, tenantId — no bodies, no secrets
```

The public branch differs only in step 4: `publicIdentity` resolves the tenant
by `DEFAULT_TENANT_SLUG`, rate-limits by `cf-connecting-ip`, and produces an
`AnonymousIdentity` carrying just `PUBLIC_PERMISSIONS`, so the PolicyGateway
still runs for every public route (`middleware/auth.ts`,
`packages/auth/src/identity-resolver.ts`).

### 4.3 What the PolicyGateway does, in order

`PolicyGateway.authorize()` (`packages/security/src/policy-gateway.ts`) walks
exactly the ladder CLAUDE.md §11 prescribes, failing closed at each rung:

```text
identity ─► 1 tenant      resource.tenantId must equal identity.tenantId       → TENANT_MISMATCH
         ─► 2 rule        POLICY_RULES[`${resource.type}:${action}`] must exist  → MISSING_PERMISSION
         ─► 3 zone        rule.zones must include identity.zone                  → WRONG_SECURITY_ZONE
         ─► 4 intent      intent (if any) must be allowed in this zone           → INTENT_NOT_ALLOWED_IN_ZONE
         ─► 5 risk        on Telegram channels, risk ≤ rule.maxRiskInChat        → RISK_TOO_HIGH
         ─► 6 grants      first grant where permission ∈ identity.permissions
                          AND ownership (ANY | SELF | TEAM | SELF_OR_TEAM) holds
                          AND grant ceiling covers resource.classification       → NOT_OWNER /
                                                                                   NOT_MANAGER_OF_TARGET /
                                                                                   CLASSIFICATION_TOO_HIGH
         ─► 7 business    every BusinessRule.satisfied                           → BUSINESS_RULE
         ─► 8 ceiling     for knowledge.* resources, intersect grant ceiling with
                          the identity's policy.read.* ceiling                   → CLASSIFICATION_TOO_HIGH
         ─► ALLOW { allowedClassifications, maxClassification, viaPermission, ownership, risk }
         ─► AUDIT         every ALLOW and DENY → audit_logs; every DENY → security_events
```

Rules are declarative data in `packages/security/src/policy-rules.ts`
("absence of a key is a DENY"), so authorisation is auditable by reading one
file and no route can invent its own rule. Ownership is never copied from
input: routes and tools look up the owning employee/candidate in the database
before calling the gateway. Roles come from `user_roles`; permissions from
`ROLE_PERMISSIONS` (`packages/domain/src/roles.ts`), which migration
`0006_rbac_reference.sql` mirrors and CI asserts is in sync
(`.github/workflows/ci.yml`, `scripts/generate-rbac-migration.ts`).

### 4.4 Telegram webhook path

`apps/api/src/routes/telegram.ts` registers `/telegram/external` and
`/telegram/internal` in a loop; which handler runs is decided by the path, in
code, never by payload content.

```text
Telegram ─► POST /telegram/{external|internal}
   1. verifyWebhookSecret(header, configured secret)   constant-time; unconfigured secret = reject
   2. normaliseUpdate(payload)                          only numeric from.id is meaningful; bots ignored
   3. ExternalBot.handle | InternalBot.handle           packages/telegram/src/*-bot.ts
        replayGuard.seen(bot, update_id) → drop duplicates
        private chats only
        per-user rate limit (`tg:ext:` / `tg:int:`)
        identity:
          external → IdentityResolver.anonymous(...) (+ candidateId if the Telegram id is linked)
          internal → IdentityResolver.fromTelegramInternal → requires a verified, non-revoked
                     INTERNAL link in telegram_accounts, an active employee, an ACTIVE user
        /verify and /code run the e-mail one-time-code flow (TelegramIdentityService)
        everything else → AIOrchestrator.handle (section 5)
   4. always answer 200 once the secret is verified (Telegram retries non-200)
```

---

## 5. AI request lifecycle

Three surfaces feed the same pipeline — `POST /assistant/ask`
(`apps/api/src/routes/assistant.ts`), `ExternalBot` and `InternalBot` — so
there is no second, weaker path to the model. The orchestrator
(`packages/ai/src/orchestrator.ts`) sequences and budgets; it "holds no
authority: every data access goes through ToolRegistry → PolicyGateway".

```text
 User
  │
  ▼
 Channel adapter        Telegram bots / assistant route: rate limit, replay guard, private-chat check
  │
  ▼
 Identity resolver      packages/auth/src/identity-resolver.ts — the ONLY constructor of Identity
  │                     (session or verified telegram_accounts row; roles from DB)
  ▼
 AIOrchestrator.handle
  │  1. AI budget          rateLimiter.consume(`ai:{tenant}:{subjectKey}`, aiPerUser)        → RATE_LIMIT event
  │  2. Injection scan     scanForInjection(message) → PROMPT_INJECTION / IDENTITY_SPOOF_ATTEMPT event
  │                        (records the attempt; does NOT decide access — §55)
  │  3. Conversation       conversations / messages rows (optional persistence)
  ▼
 Intent classifier      packages/ai/src/intent-classifier.ts
  │                     stage 1: deterministic regex rules (free)
  │                     stage 2: one 60-token JSON LLM call, only if rules miss
  │                     canonicaliseIntent(): only the intent NAME is accepted; zone/target/risk
  │                     are re-read from INTENT_DEFINITIONS (packages/domain/src/intents.ts)
  ▼
 PolicyGateway (pre-check)  4. if intent is out of zone OR RESTRICTED-risk (e.g. EMPLOYEE_SALARY):
  │                            gateway.authorize(...) BEFORE the model sees any tool list, so the
  │                            refusal is an audited decision, not an unanswered question
  ▼
 AIOrchestrator          5. planning call: provider.generateResponse({ system, messages, tools })
  │                          tools = ToolRegistry.describeFor(identity) — filtered by zone AND
  │                          permission, so the external bot is never shown internal tool names
  │                          history ≤ 4 turns, each message truncated to 600 chars, temperature 0
  ▼
 ToolRegistry.execute    6. for each of at most 3 requested tools (packages/ai/src/tool-registry.ts):
  │                          a. unknown name → TOOL_NOT_FOUND (does not reveal what exists)
  │                          b. tool.scope must equal identity.zone
  │                          c. safeParse(tool.validator, arguments)  — model input is untrusted
  │                          d. tool.resolveResource(ctx, input)      — ownership/classification from DB
  │                          e. gateway.authorize({ identity, action, resource })   ← the decision point
  │                          f. tool.handler({ …ctx, allowedClassifications }, input)
  │                          every call recorded in tool_calls with decision + reasonCode
  ▼
 Authorised tools /      handlers use ctx.repos (TenantScope) and ctx.knowledgeSearch only;
 knowledge               search_hr_policy passes decision.allowedClassifications into the SQL
  │                      (packages/knowledge/src/search-service.ts, packages/db/src/repositories/knowledge.ts)
  ▼
 Response generator      7. second call: "AUTHORISED CONTEXT" (passages wrapped by wrapUntrusted)
  │                          + "TOOL RESULTS"; instructed to use only that material
  │                      8. if no tool succeeded → the tools' own refusal messages; HR_POLICY_QUESTION
  │                          with no answer → unanswered_questions row
  │                      9. empty answer → INSUFFICIENT_KNOWLEDGE_REPLY (never a guess — §30)
  ▼
 Security filter        10. filterAiResponse (packages/security/src/response-filter.ts):
  │                         strip injected-instruction lines, system-prompt markers, SQL echo,
  │                         ungrounded currency (only tool-returned numbers survive), bulk PII
  │                         findings → BLOCKED_REQUEST security event
  ▼
 User                    Telegram sendMessage (≤4096 chars) or JSON { reply, intent, citations, toolCalls, refused }
```

Points that make the invariant structural rather than conventional:

* **Identity is never an input.** `AssistantRequest.identity` is produced by
  `IdentityResolver`; the orchestrator, classifier and tools cannot mutate it.
  `ToolRegistry.register` throws at start-up for any self-service tool whose
  JSON schema declares `employee_id`, `user_id`, `tenant_id`, `role`,
  `permission`, `classification`, `sql`, … (`FORBIDDEN_PARAMETER_NAMES`,
  `packages/ai/src/tool-types.ts`), and for any tool named like `execute`,
  `sql`, `query_database`, `eval`. Manager/HR tools that legitimately address
  another subject are enumerated in `TOOLS_ALLOWED_TO_TARGET_OTHERS` and the
  gateway still enforces the TEAM/ANY ownership relation.
* **The model proposes; the table decides.** An LLM reply of
  `{"intent":"EMPLOYEE_SALARY","risk":"LOW"}` is reduced to the intent name and
  the risk is re-read as `RESTRICTED` (`canonicaliseIntent`).
* **Retrieval is filtered in SQL, before the prompt.** `searchChunks` filters
  on `tenant_id`, `classification IN (…allowed…)`, `d.status = 'ACTIVE'` and
  the effective-date window; an empty allowed set returns nothing rather than
  everything (`D1KnowledgeSearchService.search`, "Fail closed").
* **Prompts are defence in depth only.** `packages/ai/src/prompts.ts` says so
  in its header; they are short because they are billed every turn.

### 5.1 Registered tools

All tools are registered from `ALL_TOOLS` (`packages/ai/src/tools/index.ts`).
Each carries `scope`, `permission`, `risk`, `resource`, `action`, a JSON
schema, a backend validator, `resolveResource` and `handler`.

| Zone | Tools (file) |
|---|---|
| EXTERNAL | `search_jobs`, `get_job_details`, `get_job_requirements`, `get_hiring_process`, `submit_application`, `get_application_status` (`packages/ai/src/tools/external.ts`) |
| INTERNAL — self-service | `get_my_profile`, `get_my_leave_balance`, `get_my_leave_requests`, `get_my_leave_history`, `get_holidays`, `create_leave_request`, `cancel_leave_request`, `search_hr_policy`, `raise_hr_ticket` (`packages/ai/src/tools/internal-self.ts`) |
| INTERNAL — manager / HR | `get_team_leave_requests`, `approve_leave_request`, `reject_leave_request`, `search_employees`, `get_employee_profile`, `search_candidates`, `get_candidate`, `update_application_stage`, `create_job`, `close_job` (`packages/ai/src/tools/internal-management.ts`) |

`get_application_status` is the one tool with `bearerCredential:
'application_reference'`: for an anonymous caller with no stronger linkage, the
registry binds the identity to the candidate the reference resolved to and
records `credential` in the audit metadata (`tool-registry.ts`, step 4).
Compensation is reachable by no tool at all, and
`employee.compensation:read` carries `maxRiskInChat: 'LOW'` so it is refused on
any Telegram channel even for a user who holds the permission
(`policy-rules.ts`).

### 5.2 Provider abstraction

`AIProvider.generateResponse(AIRequest): Promise<AIResponse>`
(`packages/ai/src/provider.ts`). Providers receive a system prompt, messages and
tool *descriptions* (name, description, JSON schema) — never handlers,
credentials or database access. `AIResponse.toolRequests` are raw, unvalidated
requests; "requesting is not the same as executing". Implementations:

| `AI_PROVIDER` | Class | Default model / endpoint | Notes |
|---|---|---|---|
| `anthropic` | `AnthropicProvider` | `claude-haiku-4-5-20251001`, `api.anthropic.com/v1/messages`, 20 s timeout | production default in `wrangler.toml [env.production]` |
| `openai` | `OpenAiProvider` | `gpt-4o-mini`, `api.openai.com/v1` | |
| `compatible` | `OpenAiProvider` with `AI_BASE_URL` | operator-supplied | any OpenAI-compatible endpoint |
| `mock` | `MockAIProvider` | offline, deterministic | keyword routing that requests the tool a real model would; the whole test suite including security tests runs without an API key |

`fetchJson` gives every provider call a hard `AbortController` timeout so a
Worker never hangs on the LLM.

---

## 6. Stateless-Worker constraints and the persistence abstractions

CLAUDE.md §4 forbids relying on the filesystem, process memory or in-memory
sessions. How the code complies:

| Concern | Where state lives | Code |
|---|---|---|
| Dashboard sessions | `sessions` table: SHA-256 of an opaque token, CSRF token, expiry, revocation; looked up on every request | `packages/auth/src/sessions.ts` |
| Telegram identity | `telegram_accounts` (+ `verification_codes`) | `packages/auth/src/telegram-identity.ts`, `migrations/0001_core_identity.sql` |
| Conversation history | `conversations`, `messages`, `tool_calls`, `unanswered_questions`, `hr_tickets` | `packages/db/src/repositories/conversations.ts`, `migrations/0005_security_conversations.sql` |
| Rate-limit windows | KV (`rl:{key}:{windowStart}` with TTL) or `rate_limit_counters` table | `packages/security/src/rate-limit.ts` |
| Webhook replay guard | KV (`tg:update:{bot}:{update_id}`, 1 h TTL) | `packages/telegram/src/webhook.ts` |
| Uploaded documents | R2 under `tenants/{tenant}/documents/{doc}/v{n}/{file}`; only extracted text is chunked into D1 | `packages/db/src/storage.ts`, `packages/knowledge/src/ingestion.ts` |
| Audit and security events | `audit_logs`, `security_events` | `packages/db/src/repositories/audit.ts` |

### 6.1 Database abstraction (CLAUDE.md §5)

```text
Business logic / routes / AI tools
        │  only ever call
        ▼
Repositories (packages/db/src/repositories/*)        one class per aggregate; every method takes TenantScope
        │
        ▼
DatabaseService (packages/db/src/database-service.ts) one(), many(), run(), count(), transaction(uow)
        │  parameterised SQL only; driver errors wrapped so SQL text never reaches a client
        ▼
SqlDatabase interface (packages/db/src/sql.ts)        prepare().bind().first()/all()/run(), batch(), exec()
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
fromD1(env.DB)                openSqlite(path)
(d1-adapter.ts — a cast +     (sqlite-adapter.ts — better-sqlite3 behind the
 runtime guard; D1 already     same shape; batch() runs in a real transaction;
 has this shape)               dynamic import so it never enters the Worker bundle)
```

* `DatabaseService.transaction()` collects statements into a `UnitOfWork` and
  commits them with `batch()`, which D1 runs in an implicit transaction and the
  SQLite adapter wraps in an explicit one — leave approval and application
  stage transitions rely on this.
* `TenantScope` (`packages/db/src/tenant.ts`) is a branded object, not a
  string: a blank tenant throws `forbidden` before any SQL runs, and
  `assertSameTenant` re-checks rows fetched by primary key.
* The `SqlDatabase` interface was chosen to be "the shape Cloudflare D1
  already exposes", so the future D1 → PostgreSQL move (CLAUDE.md §51) is one
  new adapter plus SQL dialect review, not a rewrite of business logic.
* Migrations are plain SQL in `migrations/`. Production applies them with
  `wrangler d1 migrations apply`; scripts and tests apply *the same files* with
  `runMigrations` (`packages/db/src/migrations.ts`), which splits statements
  while respecting `BEGIN…END` trigger bodies.

### 6.2 Storage abstraction

`StorageService { put, get, delete, exists }` (`packages/db/src/storage.ts`)
has two implementations: `R2StorageService` over the `DOCUMENTS` binding and
`MemoryStorageService` for tests and as the no-binding fallback. Keys are
tenant-prefixed (`documentKey`, `cvKey`) so objects cannot collide across
tenants. Ingestion continues indexing even if the byte store fails, logging
the missing original rather than failing the upload (`ingestion.ts`, step 5).

---

## 7. Local-versus-production adapters

Selection happens in one place, `apps/api/src/container.ts`, purely from which
bindings are present. Local development (`npm run dev` → `wrangler dev`,
`npm run db:migrate` / `db:seed` → `scripts/local-db.ts`) and the test harness
(`tests/helpers/harness.ts`) exercise the *same* Hono app, middleware,
PolicyGateway and repositories; only the adapters differ.

| Concern | Production (bindings present) | Local `wrangler dev` / scripts / tests | Selected by |
|---|---|---|---|
| SQL engine | D1 via `fromD1(env.DB)` | better-sqlite3 via `openSqlite()` — file `data/corpus.sqlite` (`LOCAL_DB_PATH`) for scripts, `:memory:` for tests; same pragmas (`foreign_keys = ON`) | what is passed as `DB` |
| Object storage | `R2StorageService(env.DOCUMENTS)` | `MemoryStorageService` | `isR2(env.DOCUMENTS)` |
| Rate limiter | `KvRateLimiter(env.RATE_LIMIT)` | `D1RateLimiter(db)` if a DB exists, else `MemoryRateLimiter` | `isKv(env.RATE_LIMIT)`, then `env.DB` |
| Webhook replay guard | `KvReplayGuard(env.RATE_LIMIT)` | `MemoryReplayGuard` (bounded to 5 000 ids) | `isKv(env.RATE_LIMIT)` |
| LLM | `AnthropicProvider` / `OpenAiProvider` | `MockAIProvider` (`AI_PROVIDER=mock`) | `config.ai.provider` |
| Verification-code delivery | `NullCodeDelivery` — discards the code and logs that no transport is configured; `/health` reports `VERIFICATION_CODE_TRANSPORT` | `LogOnlyCodeDelivery` prints the code to the server console, never back over Telegram | `selectCodeDelivery(config.environment, logger)` in `packages/telegram/src/internal-bot.ts` |
| Outbound Telegram | `TelegramClient` → `api.telegram.org` | same class; `configured === false` when token empty → send skipped and logged | `TELEGRAM_*_BOT_TOKEN` |
| Migrations | `wrangler d1 migrations apply --remote` | `runMigrations()` over `loadMigrationsFromDir()` | — |

`.env.example` documents every variable; copy it to `.dev.vars` for
`wrangler dev` or `.env` for scripts. `validateConfig` turns missing
production secrets into `/health` errors (HTTP 503) and missing development
values into warnings, so the project runs with no external accounts.

---

## 8. Free-tier limits and how the design respects them

CLAUDE.md §37, §45 and §52 ask for bounded work per request. Every bound is
either configuration (`packages/shared/src/config.ts`) or a named constant, and
the enforcement point is in backend code, never in a prompt.

### 8.1 Rate limits (fixed windows; all overridable per deployment)

| Surface | Default | Env var | Enforced in |
|---|---|---|---|
| Telegram messages per user | 30 / minute | `RATE_LIMIT_TELEGRAM_PER_MINUTE` | `ExternalBot`, `InternalBot` |
| AI requests per subject | 60 / hour | `AI_REQUESTS_PER_HOUR` | `AIOrchestrator.handle` step 1 |
| Login attempts per e-mail *and* per IP | 10 / 15 min | `RATE_LIMIT_LOGIN_PER_15M` | `routes/auth.ts` |
| Telegram verification requests | 5 / 15 min | `RATE_LIMIT_VERIFY_PER_15M` | `InternalBot.handleVerifyRequest` |
| Public application submissions | 5 / hour | `RATE_LIMIT_APPLICATIONS_PER_HOUR` | `routes/recruitment.ts` |
| Authenticated API calls per user | 600 / minute | `RATE_LIMIT_ADMIN_API_PER_MINUTE` | `requireSession` |
| Public API calls per IP | 120 / minute | `RATE_LIMIT_PUBLIC_API_PER_MINUTE` | `publicIdentity` |

KV is eventually consistent, so a cold edge may admit a few extra requests;
the code comments accept this because "the authorisation layer, not the
limiter, is what protects data" (`rate-limit.ts`).

### 8.2 Size, count and time bounds

| Bound | Value | Where |
|---|---|---|
| JSON request body | 512 KiB (`MAX_REQUEST_BODY_BYTES`) | `middleware/body.ts` (checks `content-length` and actual length) |
| Document upload | 8 MiB (`MAX_UPLOAD_BYTES`) | `routes/knowledge.ts` |
| Page size | default 25, max 100 (`DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`) | `routes/helpers.ts` → `resolvePage` |
| User message to the assistant | 2 000 chars | `orchestrator.ts` `MAX_MESSAGE_CHARS`; `routes/assistant.ts` validator |
| Conversation history sent to the model | 4 turns × 600 chars | `container.ts` `maxHistoryTurns`, `orchestrator.ts` |
| Tools executed per turn | 3 | `orchestrator.ts` step 7 |
| Tool payload forwarded to the model | 2 000 chars of JSON per tool | `orchestrator.ts` |
| Retrieved knowledge chunks | 5 (`AI_MAX_CONTEXT_CHUNKS`) | `container.ts` → `ToolContext.limits` |
| Model output | 600 tokens (`AI_MAX_OUTPUT_TOKENS`); classifier 60 tokens | `container.ts`, `intent-classifier.ts` |
| Provider call timeout | classifier 8 s; Anthropic 20 s default | `intent-classifier.ts`, `providers/anthropic.ts` |
| Telegram API call timeout / message length | 10 s / 4 096 chars | `packages/telegram/src/client.ts` |
| Public job search results per tool call | 8 | `tools/external.ts` `MAX_PUBLIC_RESULTS` |
| Chunking | target 220 tokens, max 320, overlap 30, max 400 chunks per document | `packages/knowledge/src/chunking.ts` |
| Session lifetime | 12 h | `packages/auth/src/sessions.ts` |
| Retention | `audit_logs` 730 d, `security_events` 730 d, `tool_calls` 180 d, `messages` 90 d, `verification_codes` 1 d, `rate_limit_counters` 1 d | `migrations/0005_security_conversations.sql` `retention_policies`; `scripts/prune.ts` |

### 8.3 AI cost controls

* Intent classification is rules-first; the LLM is consulted only when the
  regex table misses, and then for at most 60 output tokens.
* Out-of-zone and RESTRICTED-risk intents are refused by the gateway *before*
  a planning call is made.
* Only the tools the identity may use are described to the model, keeping the
  per-turn tool schema small.
* The second (answer) call is skipped entirely when the model requested no
  tools; the planning text is used as the answer.
* System prompts are a few sentences (`prompts.ts`).

CLAUDE.md §52 warns that `$0 hosting does not mean $0 AI API cost`. CORPUS's
answer is to default to a provider that is free: `AI_PROVIDER=workers-ai` uses
Cloudflare's `[ai]` binding, so inference sits inside the same free tier as the
Worker, D1 and R2 with no API key and no second account. `google` (free tier,
key but no billing) is the alternative; `anthropic` and `openai` remain
configurable for anyone who wants a stronger model and will pay for it. The
provider is chosen entirely by configuration behind the `AIProvider` interface,
so switching is an environment change, not a code change.


---

## 9. Cross-cutting services

| Concern | Implementation |
|---|---|
| Configuration | `loadConfig(env)` from bindings/`process.env`; `validateConfig` (errors fatal in prod); `describeConfig` (secret-free) — `packages/shared/src/config.ts` |
| Errors | `AppError` with stable `code`, safe `message`, optional `internal` detail; `toAppError` normalises anything; `errorHandler` returns `{ error: { code, message, requestId } }` — `packages/shared/src/errors.ts`, `apps/api/src/middleware/errors.ts` |
| Logging | Structured JSON logger that redacts keys matching `pass|secret|token|api_key|authorization|cookie|code|otp|hash|…` before writing — `packages/shared/src/logger.ts`; access log fields per CLAUDE.md §47 in `request-context.ts` |
| Audit | Every gateway decision → `audit_logs` (tenant, user, telegram id, channel, intent, resource, action, decision, reason, risk, source, requestId, redacted metadata) |
| Security events | `SecurityEventService.record` with per-type default severity; never throws into the triggering request — `packages/security/src/security-events.ts`; surfaced at `GET /security/events` |
| Input validation | Small typed validators (`object`, `str`, `email`, `optional`, …) used by routes and tool schemas alike — `packages/shared/src/validate.ts` |
| Health | `GET /health` (DB reachability, migrations count, storage durability, config problems → 200/503) and `GET /health/live` |

---

## 10. Migration path

The abstractions above are what keep CLAUDE.md §51's route open without
building it now:

```text
today                                         later (one adapter each)
────────────────────────────────────────────  ─────────────────────────────────────
SqlDatabase ← D1 / better-sqlite3             SqlDatabase ← PostgreSQL driver
StorageService ← R2 / Memory                  StorageService ← S3-compatible
RateLimiter ← KV / D1 / Memory                RateLimiter ← Redis (only if actually required)
KnowledgeSearchService ← FTS5 + LIKE          KnowledgeSearchService ← pgvector / hybrid
AIProvider ← Anthropic / OpenAI / mock        unchanged
PolicyGateway, ToolRegistry, repositories     unchanged
```

---

## 11. Limitations / Roadmap

The following are places where the code deliberately stops short of the full
specification. They are stated here so the architecture is not over-described.

   `VerificationCodeDelivery` has no transport implementation. In development
   `LogOnlyCodeDelivery` prints the code to the server console; in production and staging
   `selectCodeDelivery()` returns `NullCodeDelivery`, which discards it. Internal Telegram
   verification therefore cannot complete in production until a mail provider is added, and
   `/health` reports `VERIFICATION_CODE_TRANSPORT` as a configuration error.

Related documents: `docs/security.md` (threat model and controls),
`docs/database.md` (schema), `docs/rbac.md` (roles, permissions, policy table),
`docs/ai.md` (orchestrator, tools, prompts), `docs/rag.md` (ingestion and
retrieval), `docs/telegram.md` (bots and verification), `docs/deployment.md`,
`docs/testing.md`, `docs/roadmap.md`.
