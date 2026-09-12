# CORPUS Security Model

This document describes the security controls that exist in the CORPUS codebase today, where each one is implemented, and which test proves it. It is written against the source, not the specification: where `CLAUDE.md` asks for something the code does not yet do, that is listed under [Limitations / Roadmap](#limitations--roadmap).

Paths are relative to the repository root. Section references (`§n`) point at `CLAUDE.md`.

## Contents

1. [Core invariant](#core-invariant)
2. [Threat model](#threat-model)
3. [Enforcement architecture](#enforcement-architecture)
4. [Security zones](#security-zones)
5. [Data classification](#data-classification)
6. [Identity](#identity)
7. [PolicyGateway](#policygateway)
8. [AI tool system](#ai-tool-system)
9. [Bearer credentials for application references](#bearer-credentials-for-application-references)
10. [RAG permission filtering](#rag-permission-filtering)
11. [Curated bot answers](#curated-bot-answers)
12. [Candidate CVs](#candidate-cvs)
13. [Prompt-injection detection](#prompt-injection-detection)
14. [Response filter](#response-filter)
15. [Rate limiting](#rate-limiting)
16. [Audit log and security events](#audit-log-and-security-events)
17. [Transport and HTTP hardening](#transport-and-http-hardening)
18. [Secrets](#secrets)
19. [Final security review checklist (§62)](#final-security-review-checklist-62)
20. [Security test suite](#security-test-suite)
21. [Limitations / Roadmap](#limitations--roadmap)

---

## Core invariant

> The AI may understand the question, but the backend decides what the user is allowed to know or do. (§2, §63)

Concretely, in this codebase:

| Rule | Where it is enforced |
| --- | --- |
| An `Identity` is only ever built from database state, never from a request body, a Telegram display name, or model output. | `packages/auth/src/identity-resolver.ts` is the only constructor of `Identity`; `packages/domain/src/identity.ts` documents the contract. |
| Every protected operation goes through one authorisation service. | `PolicyGateway.authorize()` / `.require()` in `packages/security/src/policy-gateway.ts`; routes call it before touching repositories (for example `apps/api/src/routes/employees.ts`, `apps/api/src/routes/security.ts`). |
| The AI cannot execute anything except a registered tool, and every registered tool is authorised by the gateway before its handler runs. | `ToolRegistry.execute()` in `packages/ai/src/tool-registry.ts`, step 4. |
| The AI's own view of scope, risk and permission is discarded. | `canonicaliseIntent()` in `packages/domain/src/intents.ts` re-reads `scope`/`target`/`risk` from `INTENT_DEFINITIONS`; the classifier prompt in `packages/ai/src/prompts.ts` asks only for an intent name. |
| Unauthorised knowledge never enters a prompt. | Classification filtering is in the SQL `WHERE` clause of `KnowledgeRepository.searchChunks()` (`packages/db/src/repositories/knowledge.ts`), and the allowed set comes from a gateway `AllowDecision`. |
| Prompts are defence in depth only. | `packages/ai/src/prompts.ts` header comment; the security tests never assert on model wording, only on which tools ran and what data appeared (`tests/security/prompt-attacks.test.ts`). |

The invariant is exercised end to end by `tests/security/acceptance.test.ts` (the eight §44 tests) over the real Hono app, real migrations, real seed data and the `MockAIProvider`.

---

## Threat model

### Actors and capabilities

| Actor | Channel | What they control | What they must not achieve |
| --- | --- | --- | --- |
| Anonymous member of the public / job candidate | External Telegram bot, `/public/*` API | Free text to the model; slash commands; a Telegram numeric id (not verified as anyone); an application reference if they have one | Read any employee, policy, candidate or internal data; read another candidate's application; reach any INTERNAL tool |
| Verified employee | Internal Telegram bot, dashboard, `/assistant/ask` | Free text to the model; their own session; requests that name other people or ids | Read another employee's records, compensation, CONFIDENTIAL/RESTRICTED documents; act on another employee's leave; escalate role |
| Manager | Same as employee | Same, plus legitimate team operations | Reach non-reports; reach compensation; reach organisation-wide data |
| HR / HR_ADMIN | Same | Broad legitimate access | Cross tenant boundaries; reach RESTRICTED without `policy.read.restricted`; reach compensation over chat |
| Compromised or forged session | Dashboard API | A stolen cookie or bearer token; a CSRF token from another session | Act without a valid server-side session; perform writes without the matching CSRF token; exceed the per-user API budget |
| Impersonator of Telegram | `POST /telegram/{external,internal}` | Arbitrary webhook payloads | Have updates processed without the per-bot webhook secret; replay an update |
| Malicious document author | Knowledge upload (HR/HR_ADMIN) | Document text containing instructions | Turn document text into model instructions; alter what any reader may see |
| The model itself | Inside the orchestrator | Which tool to request, with which arguments; the wording of the answer | Choose whose data a tool reads; call unregistered or out-of-zone tools; disclose data it was never given; invent figures that survive to the user |

### Mitigation summary

| Threat | Primary control | Defence in depth |
| --- | --- | --- |
| Talking the AI into a role or identity | Identity from database only (`identity-resolver.ts`); PolicyGateway checks permissions, not role labels (`tests/unit/policy-gateway.test.ts` "permissions cannot be self-asserted") | `scanForInjection()` raises `IDENTITY_SPOOF_ATTEMPT` / `PROMPT_INJECTION` events |
| Cross-user data access | Ownership in the grant ladder (`SELF` / `TEAM` / `ANY`) with owner ids resolved from the database in `resolveResource()` | Self-service tools have no subject parameter (construction-time check in `assertToolIsSafe()`) |
| Cross-tenant access | `TENANT_MISMATCH` is the first gateway check; every repository query is scoped by `tenantScope()` (`packages/db/src/tenant.ts`) | `assertSameTenant()` re-check on rows fetched by opaque key |
| Restricted data over chat | `maxRiskInChat` on the policy rule (compensation, offers, audit, security, system) | No tool exists for `employee.compensation` at all (`tests/unit/tool-registry.test.ts` "exposes no compensation tool") |
| Leaking classified knowledge via RAG | Classification `IN (...)` filter in SQL, allowed set from the gateway | Result re-check in `D1KnowledgeSearchService` logs a regression as an error; response filter |
| Document prompt injection | Extracted text is never treated as instructions; passages are wrapped with `wrapUntrusted()` | `DOCUMENT_INJECTION` event at ingest; response filter strips echoed instruction lines |
| Forged Telegram webhooks | Constant-time secret check, refuse when no secret configured (`packages/telegram/src/webhook.ts`) | `AUTH_FAILURE` event; replay guard on `update_id` |
| Session theft / CSRF | Opaque token, only its SHA-256 stored; HttpOnly cookie; double-submit CSRF header compared in constant time | Per-user admin API rate limit; immediate revocation on logout |
| Brute force | Login limited per e-mail and per IP; account lockout after 8 failures; verification codes limited to 5 attempts and 10 minutes | Uniform error messages and equalised timing |
| Fabricated facts | Answers are generated only from tool results and authorised context | `filterAiResponse()` redacts monetary values not returned by a tool |
| Error and log leakage | `AppError.toPublicJSON()` returns code + safe message only; `redact()` strips credential-like keys from logs and audit metadata | `describeConfig()` is the only configuration view exposed by `/health` |

---

## Enforcement architecture

```text
                     Telegram                          Browser (Next.js dashboard)
                        │                                        │
       ┌────────────────┴────────────────┐          ┌────────────┴────────────┐
       │ POST /telegram/external         │          │ POST /auth/login        │
       │ POST /telegram/internal         │          │ cookie + x-corpus-csrf │
       └────────────────┬────────────────┘          └────────────┬────────────┘
                        ▼                                        ▼
   verifyWebhookSecret (constant time)             requireSession (server-side lookup,
   normaliseUpdate, ReplayGuard                     CSRF on writes, per-user rate limit)
                        │                                        │
                        └──────────────┬─────────────────────────┘
                                       ▼
                           IdentityResolver  ──  users, user_roles, telegram_accounts,
                           (only source of      employees, employee_managers
                            Identity)
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 ▼                     ▼                     ▼
          REST route handler     AIOrchestrator        Telegram bot handler
                 │                     │                     │
                 │        IntentClassifier (rules → 1 short LLM call → canonicalise)
                 │                     │
                 │              ToolRegistry.describeFor / execute
                 │                     │
                 └──────────┬──────────┘
                            ▼
                      PolicyGateway  ── POLICY_RULES (declarative table)
                            │
              ALLOW ────────┼──────── DENY ──► audit row + security event
                            ▼
          Repositories (tenant-scoped SQL) / KnowledgeSearch (classification in SQL)
                            │
                            ▼
                 Response filter (AI answers only) ──► user
```

The dashboard chat (`apps/api/src/routes/assistant.ts`) and both bots use the same orchestrator, registry and gateway; there is no second, weaker path to the model.

---

## Security zones

Two zones exist, `EXTERNAL` and `INTERNAL` (`SECURITY_ZONES` in `packages/domain/src/identity.ts`). The zone is decided in code, never from anything in the request:

| Surface | Zone | How the zone is fixed |
| --- | --- | --- |
| `/public/*` | EXTERNAL | `publicIdentity` middleware attaches an `AnonymousIdentity` (`apps/api/src/middleware/auth.ts`) |
| `POST /telegram/external` | EXTERNAL | `ExternalBot` always builds an anonymous identity (`packages/telegram/src/external-bot.ts`) |
| `POST /telegram/internal` | INTERNAL | `InternalBot` requires `IdentityResolver.fromTelegramInternal()` to succeed; otherwise only `/verify` and `/code` are handled (`packages/telegram/src/internal-bot.ts`) |
| Everything else | INTERNAL | Mounted under `requireSession` in `apps/api/src/app.ts` |

The zone is enforced at three independent layers:

1. **Policy rules** declare `zones` per `(resource, action)`; the gateway denies `WRONG_SECURITY_ZONE` before any permission check (`packages/security/src/policy-rules.ts`, `policy-gateway.ts` step 3). Only `job`, `job.requirement`, `candidate:create`, `application:create` and `application:read` are reachable from both zones.
2. **Intents** carry a `zone` (`INTENT_DEFINITIONS`); an intent that is not `ANY` or the caller's zone is denied `INTENT_NOT_ALLOWED_IN_ZONE` (gateway step 4; also pre-checked by the orchestrator).
3. **Tools** carry a `scope`; `ToolRegistry.describeFor()` never lists a tool from another zone, and `execute()` denies `TOOL_NOT_AVAILABLE_IN_ZONE` before argument validation (`packages/ai/src/tool-registry.ts`).

The external bot is offered exactly six tools: `search_jobs`, `get_job_details`, `get_job_requirements`, `get_hiring_process`, `submit_application`, `get_application_status` (`packages/ai/src/tools/external.ts`; asserted in `tests/unit/tool-registry.test.ts` "offers an external caller only the recruitment tools" and "never describes an internal tool to an external caller").

Both bots refuse group chats and ignore messages from other bots (`external-bot.ts`, `internal-bot.ts`, `webhook.ts` `normaliseUpdate`).

---

## Data classification

Classifications are `PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED` (`packages/domain/src/classification.ts`). Classification is a backend property of a resource: routes and tools set `resource.classification` from the stored document or from a constant, never from caller input.

| Enforcement point | Mechanism |
| --- | --- |
| Per-grant ceiling | Each `Grant` in `POLICY_RULES` has `maxClassification` (default `INTERNAL`). A grant is skipped when `classificationCovers(ceiling, resource.classification)` is false → `CLASSIFICATION_TOO_HIGH` (`policy-gateway.ts` step 6). |
| Knowledge reading ceiling | `maxReadableClassification(permissions)` maps `policy.read` → INTERNAL, `policy.read.confidential` → CONFIDENTIAL, `policy.read.restricted` → RESTRICTED, otherwise PUBLIC (`packages/domain/src/roles.ts`). For `knowledge.*` resources the gateway intersects this with the grant ceiling (step 8, `lowerOf()`), so holding `policy.create` cannot create a RESTRICTED document the caller could not read. |
| Retrieval | `AllowDecision.allowedClassifications` is passed into `KnowledgeSearchRequest.allowedClassifications` and becomes the SQL `IN` list (see [RAG permission filtering](#rag-permission-filtering)). |
| Compensation | Modelled as its own resource type `employee.compensation`, always `RESTRICTED`, permission `employee.read.compensation` (HR_ADMIN and SYSTEM_ADMIN only), `maxRiskInChat: 'LOW'` so it is never served over Telegram. |
| Public job data | `job:read`/`job:search` grants for `job.read.public` have `maxClassification: 'PUBLIC'`; tool handlers additionally hard-code `statuses: ['PUBLISHED']` (`tools/external.ts`). |
| Chunk denormalisation | `document_chunks.classification`, `effective_from` and `effective_to` are copied onto every chunk (`migrations/0004_knowledge.sql`) so the filter runs inside the retrieval query. |

Role ceilings for knowledge, as tested in `tests/integration/rag-permission-filtering.test.ts`: EMPLOYEE and MANAGER → INTERNAL; HR → CONFIDENTIAL; HR_ADMIN and SYSTEM_ADMIN → RESTRICTED; anonymous → PUBLIC.

---

## Identity

### Identity construction

`IdentityResolver` (`packages/auth/src/identity-resolver.ts`) produces one of two shapes (`packages/domain/src/identity.ts`):

- `AnonymousIdentity` — `zone: 'EXTERNAL'`, `roles: []`, `permissions = PUBLIC_PERMISSIONS` (`job.read.public`, `candidate.create.public`, `application.create.public`, `application.read.self`), optional `telegramUserId` / `candidateId`.
- `UserIdentity` — `zone: 'INTERNAL'`, roles from `user_roles`, permissions from `permissionsForRoles()`, `employeeId` from the user or Telegram link, `managedEmployeeIds` from `employees.manager_id` / `employee_managers` via `listDirectReportIds()`.

`subjectKey` is an HMAC-SHA256 of `channel:rawSubject` under the session secret, truncated to 22 chars. It is a pseudonymous handle for rate limiting, conversation threading and audit, never a claim about who the subject is.

### Dashboard sessions

| Control | Implementation |
| --- | --- |
| Password storage | PBKDF2-SHA256, 210 000 iterations, 16-byte salt, encoded `pbkdf2-sha256$iterations$salt$hash`; `needsRehash()` upgrades weaker hashes on next login (`packages/auth/src/passwords.ts`). |
| Password policy | ≥ 12 chars, ≤ 200, ≥ 3 character classes, small common-password denylist (`checkPasswordPolicy()`). |
| Login | `LoginService.login()` (`packages/auth/src/login.ts`): unknown e-mail, wrong password and disabled account all return the same public message; a dummy PBKDF2 verification is spent on the unknown-account path to equalise timing; 8 failures lock the account for 15 minutes (`MAX_LOGIN_ATTEMPTS`, `LOCK_MINUTES`). |
| Login rate limit | Per e-mail and per IP (`loginPerIdentifier`, default 10 / 15 min) in `apps/api/src/routes/auth.ts`, independent of the lockout. |
| Session token | 32 random bytes (`randomToken(32)`); only `sha256Hex(token)` is stored in `sessions.token_hash` (`migrations/0001_core_identity.sql`); TTL 12 hours (`DEFAULT_SESSION_TTL_SECONDS`). |
| Cookie | `corpus_session`; `HttpOnly; Path=/`. `SameSite` is chosen per request by `cookiePolicyFor()` (`packages/auth/src/sessions.ts`): `Lax` when the dashboard and the API share a registrable domain, `None; Secure` when they do not — the default Cloudflare topology (`*.pages.dev` calling `*.workers.dev`) is cross-site, and a `Lax` cookie would never be sent on the dashboard's XHR. `Secure` is always set outside `development` and whenever `SameSite=None`. Widening to `None` is safe here because CSRF is defended by the double-submit token and the CORS origin allowlist, not by `SameSite`. The API also accepts `Authorization: Bearer <token>` (`readToken()` in `apps/api/src/middleware/auth.ts`). |
| Resolution | `SessionService.resolve()` looks the hash up on every request, rejects revoked or expired rows, rejects a non-`ACTIVE` user, and reloads roles from the database each time. Logout revokes immediately (`POST /auth/logout`). |
| CSRF | Double-submit: a 24-byte `csrfToken` is issued at login and returned in the JSON body (not the cookie); every non-`GET/HEAD/OPTIONS` request must present it in `x-corpus-csrf`; `assertCsrf()` compares in constant time and fails as `UNAUTHENTICATED` (`requireSession`). |
| Per-user budget | `adminApiPerUser` (default 600 / min) consumed in `requireSession` so a stolen session cannot be used to scrape. |
| IP handling | Client IPs are never stored raw; `hashIp()` HMACs them under the session secret for `sessions.ip_hash`. |

Proof: `tests/integration/api-smoke.test.ts` (login, generic failure message, CSRF required, logout revokes) and `tests/security/prompt-attacks.test.ts` "identity spoofing attacks" (forged token → 401, revoked session → 401, CSRF token from another session → 401).

### Telegram verification flow

Nothing in a Telegram update is identity. `normaliseUpdate()` keeps `first_name`/`username` for logging only; the numeric `from.id` grants nothing until a verified `INTERNAL` link exists in `telegram_accounts` (`packages/telegram/src/webhook.ts`).

```text
 Telegram user                      InternalBot                     TelegramIdentityService / DB
 ─────────────                      ───────────                     ────────────────────────────
 /verify name@company.example  ──►  rate limit tg:verify:<id>
                                    validate e-mail syntax     ──►  requestLink():
                                                                     • consume any outstanding code for this Telegram id
                                                                     • employees.findByEmail (backend resolves the subject)
                                                                     • if ACTIVE/ON_LEAVE: code = 6 random digits
                                                                       store sha256(telegramUserId:code), TTL 10 min,
                                                                       max 5 attempts, employee_id from the lookup
                              ◄──   same reply whether or not the e-mail matched
                                    deliver code out of band   ──►  VerificationCodeDelivery (see Limitations)

 /code 123456                  ──►  6 digits only              ──►  verifyLink():
                                                                     • findActive(); attempts ≥ max → consume, refuse
                                                                     • recordAttempt(); constant-time hash compare
                                                                     • markConsumed(); telegram_accounts.link(INTERNAL,
                                                                       employee_id from the code row, user_id)
                              ◄──   "Your account is verified"

 any later message             ──►  fromTelegramInternal():  verified non-revoked INTERNAL link
                                    → employee not TERMINATED/SUSPENDED → user ACTIVE → roles from user_roles
                                    (an employee with no user account gets EMPLOYEE only)
```

Properties of this flow (`packages/auth/src/telegram-identity.ts`, `packages/telegram/src/internal-bot.ts`):

- The user never supplies an employee id; the e-mail is a lookup key only, and the code row carries the backend-resolved `employee_id`.
- Enumeration is prevented: the reply and the code-invalidation step are identical whether or not the address matched.
- Codes are single use, hashed with the Telegram id (a code issued to one Telegram id cannot be redeemed by another), and never logged (`redact()` strips any key matching `code`).
- The dashboard equivalents `POST /auth/telegram/link` and `/verify` (`apps/api/src/routes/auth.ts`) additionally require the body e-mail to equal the session's e-mail and the code's employee to equal the session's employee, raising `IDENTITY_SPOOF_ATTEMPT` otherwise.
- Every unverified contact is recorded as `UNKNOWN_USER`; failed codes as `AUTH_FAILURE`.

Proof: `tests/e2e/flows.test.ts` "links an account only after a backend-issued code, then serves own data" and "does not reveal whether an e-mail belongs to an employee"; `tests/security/prompt-attacks.test.ts` "refuses an unverified Telegram user any HR capability" (asserts zero `tool_calls` rows) and "cannot link a Telegram account to another employee".

### Telegram webhook authentication

`verifyWebhookSecret()` compares the `x-telegram-bot-api-secret-token` header against the per-bot secret in constant time and refuses when no secret is configured rather than accepting everything. Each bot has its own token and webhook secret (`TELEGRAM_{EXTERNAL,INTERNAL}_{BOT_TOKEN,WEBHOOK_SECRET}`); `validateConfig()` treats a bot token without a webhook secret as a fatal configuration error (`packages/shared/src/config.ts`). A rejected webhook returns 401 and records `AUTH_FAILURE` (`apps/api/src/routes/telegram.ts`).

Replay: `ReplayGuard.seen(botKey, updateId)` de-duplicates `update_id` via KV (`KvReplayGuard`, 1 hour TTL) or an in-memory bounded map when KV is not bound (`packages/telegram/src/webhook.ts`). Proof: `tests/e2e/flows.test.ts` "ignores a duplicate Telegram update (replay protection)"; `tests/security/prompt-attacks.test.ts` "rejects a Telegram webhook with a wrong or missing secret".

---

## PolicyGateway

`PolicyGateway.authorize(request)` in `packages/security/src/policy-gateway.ts` is the single authority. Routes use `require()`, which throws a `FORBIDDEN` `AppError` carrying only the deny reason; tools go through `ToolRegistry.execute()`.

### Inputs

`AuthorizationRequest = { identity, action, resource: ResourceRef, intent?, businessRules?, requestId?, metadata?, skipAudit? }`. `skipAudit` is a *request*, not a guarantee: `maySkipAudit()` refuses it for any mutating action (`create`, `update`, `delete`, `approve`, `reject`, `export`) and for any resource classified CONFIDENTIAL or RESTRICTED, so neither a state change nor a classified read can create an audit blind spot. `ResourceRef` (`packages/domain/src/resources.ts`) carries `type`, optional `id`, `ownerEmployeeId`, `ownerCandidateId`, `tenantId` and `classification`, all populated by the caller from database lookups or constants, never from user input.

### Decision flow

```text
 request
   │
   ├─ 1. resource.tenantId ≠ identity.tenantId ─────────────► DENY TENANT_MISMATCH
   │
   ├─ 2. findRule(resource.type, action) missing ────────────► DENY MISSING_PERMISSION
   │      (no rule = no access; there is no permissive default)
   │
   ├─ 3. identity.zone ∉ rule.zones ─────────────────────────► DENY WRONG_SECURITY_ZONE
   │
   ├─ 4. intent given and not allowed in zone ───────────────► DENY INTENT_NOT_ALLOWED_IN_ZONE
   │
   ├─ 5. chat channel and risk > rule.maxRiskInChat ─────────► DENY RISK_TOO_HIGH
   │
   ├─ 6. grant ladder, first satisfied grant wins:
   │      permission ∈ identity.permissions
   │        → ownership (ANY | SELF | TEAM | SELF_OR_TEAM) holds
   │          → classificationCovers(grant.maxClassification ?? INTERNAL, resource.classification)
   │      none satisfied ──────────────────────────────────► DENY closest miss:
   │                                                          CLASSIFICATION_TOO_HIGH >
   │                                                          NOT_MANAGER_OF_TARGET > NOT_OWNER >
   │                                                          MISSING_PERMISSION
   │
   ├─ 7. businessRules: first unsatisfied rule ──────────────► DENY BUSINESS_RULE (rule's own message)
   │
   ├─ 8. knowledge.* only: effective ceiling =
   │      lower(grant ceiling, maxReadableClassification(permissions))
   │      resource above effective ceiling ──────────────────► DENY CLASSIFICATION_TOO_HIGH
   │
   └─ ALLOW { allowedClassifications, maxClassification, viaPermission, ownership, risk }

 every ALLOW and DENY ► audit_logs row (skipAudit honoured only for
                             unclassified, non-mutating reads)
 every DENY except BUSINESS_RULE ► security_events row
```

Ownership semantics (`checkOwnership()`): `SELF` matches when `identity.employeeId === resource.ownerEmployeeId`, or for an anonymous caller when `identity.candidateId === resource.ownerCandidateId`; a `SELF` grant against a resource with no owner is a denial, not an implicit match. `TEAM` matches when `resource.ownerEmployeeId ∈ identity.managedEmployeeIds`. Internal users never "own" a candidate resource.

Risk is taken from `INTENT_DEFINITIONS[intent].risk` when an intent is supplied, otherwise inferred from the resource (`inferRisk()`: RESTRICTED classification, compensation or offers → RESTRICTED; CONFIDENTIAL → SENSITIVE; jobs/holidays → LOW; else PERSONAL_DATA).

### Deny reasons

All reason codes and their user-facing messages live in `packages/domain/src/security-events.ts` (`DENY_REASONS`, `DENY_MESSAGES`). Messages never describe internal structure.

| Reason | Emitted by | Security event raised |
| --- | --- | --- |
| `TENANT_MISMATCH` | gateway step 1 | `TENANT_ACCESS_VIOLATION` (CRITICAL) |
| `MISSING_PERMISSION` | gateway steps 2, 6 | `BLOCKED_REQUEST` |
| `WRONG_SECURITY_ZONE` | gateway step 3 | `SCOPE_VIOLATION` |
| `INTENT_NOT_ALLOWED_IN_ZONE` | gateway step 4; orchestrator defensive check | `SCOPE_VIOLATION` |
| `RISK_TOO_HIGH` | gateway step 5 | `RESTRICTED_DATA_REQUEST` |
| `NOT_OWNER`, `NOT_MANAGER_OF_TARGET` | gateway step 6 | `CROSS_USER_ACCESS` |
| `CLASSIFICATION_TOO_HIGH` | gateway steps 6, 8 | `RESTRICTED_DATA_REQUEST` |
| `BUSINESS_RULE` | gateway step 7 | none (audit row only) |
| `TOOL_NOT_AVAILABLE_IN_ZONE`, `RESOURCE_NOT_FOUND` | `ToolRegistry.execute()` (also reason codes `TOOL_NOT_FOUND`, `INVALID_ARGUMENTS`, `TOOL_ERROR`) | none from the registry itself; the gateway decision, when reached, is audited as above |
| `RATE_LIMITED` | orchestrator AI budget | `RATE_LIMIT` |
| `NOT_AUTHENTICATED`, `IDENTITY_NOT_LINKED`, `NO_EMPLOYEE_RECORD`, `ACCOUNT_DISABLED` | defined for tool/route messages; not produced by the gateway | — |

### The policy table

`POLICY_RULES` in `packages/security/src/policy-rules.ts` is the whole authorisation policy: roughly 60 `(resource, action)` keys, each with `zones`, an ordered `grants` ladder and optional `maxRiskInChat`. Notable entries:

- `leave.request:create` and `:delete` have only a `SELF` grant; there is deliberately no "create on behalf of".
- `employee.compensation:*`, `offer:*`, `audit:read`, `security.event:*`, `system:update` set `maxRiskInChat: 'LOW'`, so RESTRICTED-risk operations are refused on Telegram even for HR_ADMIN (`tests/unit/policy-gateway.test.ts` "refuses compensation over Telegram even for HR_ADMIN").
- `knowledge.document:read|list` and `knowledge.chunk:search` have a three-rung ladder (`policy.read` → INTERNAL, `policy.read.confidential` → CONFIDENTIAL, `policy.read.restricted` → RESTRICTED) that implements §9.

Roles and permissions are enumerated in `packages/domain/src/roles.ts` (`ROLE_PERMISSIONS`); SYSTEM_ADMIN receives every permission explicitly rather than a wildcard. `migrations/0006_rbac_reference.sql` mirrors the table and `tests/integration/rbac-consistency.test.ts` asserts the two agree; CI regenerates the migration and fails on drift (`.github/workflows/ci.yml`). See `docs/rbac.md` for the full matrix.

### Business rules

Deterministic backend checks (leave state, balance, overlaps, stage transitions) are passed as `businessRules` and evaluated only after permissions pass, so a business message never leaks whether an unauthorised resource exists. State machines live in `packages/domain/src/leave-flow.ts` and `application-flow.ts`.

---

## AI tool system

### Registration-time guarantees

`ToolRegistry.register()` calls `assertToolIsSafe()` (`packages/ai/src/tool-registry.ts`) and throws at start-up if:

- the tool name matches `/(sql|execute|raw_query|query_database|eval|exec)/i` (§53: no `execute_sql`, no `query_database`);
- a tool not in `TOOLS_ALLOWED_TO_TARGET_OTHERS` declares any parameter in `FORBIDDEN_PARAMETER_NAMES` (`employee_id`, `employeeId`, `employee_no`, `user_id`, `tenant_id`, `role`, `permission`, `classification`, `sql`, `table`, …) (`packages/ai/src/tool-types.ts`);
- any tool, allowlisted or not, declares `tenant_id`, `tenantId`, `role(s)` or `permission(s)`.

`TOOLS_ALLOWED_TO_TARGET_OTHERS` names the manager/HR tools whose target is a business input (`get_employee_profile`, `search_employees`, `approve_leave_request`, `reject_leave_request`, `get_team_leave_requests`, `search_candidates`, `get_candidate`, `update_application_stage`, `create_job`, `update_job`, `close_job`); the gateway still enforces `TEAM`/`ANY` ownership for them.

Self-service tools (`packages/ai/src/tools/internal-self.ts`) take no subject at all: `resolveResource()` sets `ownerEmployeeId: requireEmployeeId(ctx)` from the identity. `cancel_leave_request` reads the owner from the stored request so a foreign request id fails the `SELF` check.

`ToolContext` exposes repositories, the gateway, the knowledge search service, a logger and limits; no raw SQL handle or D1 binding is reachable from a handler (`tool-types.ts`).

### Offer and execution

- `describeFor(identity)` filters by `scope === identity.zone` **and** `identity.permissions.has(tool.permission)`, so the model is never told about tools the caller cannot use (§16).
- `execute(name, args, ctx)` runs, in order: unknown tool → deny without revealing the catalogue; zone gate; schema validation of the model's arguments (`safeParse(tool.validator)`); `resolveResource()` from the database; `PolicyGateway.authorize()`; only then `handler()` with `allowedClassifications` from the decision. A handler is never called on a denial (`tests/unit/tool-registry.test.ts` "never calls a handler when the gateway denies the request").
- The orchestrator (`packages/ai/src/orchestrator.ts`) caps tool requests at three per turn, truncates messages to 2 000 characters and history to 600 characters per turn, and consumes the AI budget before any provider call.

### Intents

`IntentClassifier` (`packages/ai/src/intent-classifier.ts`) tries deterministic regex rules first and makes at most one short JSON-only LLM call. Whatever comes back is passed through `canonicaliseIntent()`, so only the intent *name* survives; scope, target and risk come from `INTENT_DEFINITIONS`. Out-of-zone or RESTRICTED-risk intents (`EMPLOYEE_SALARY`) are sent to the gateway before the model is shown any tool list, so a salary question that the model might answer without a tool still produces an audited denial (`orchestrator.ts` step 5).

### Model output

Answers are generated from `TOOL RESULTS` and `AUTHORISED CONTEXT` only; retrieved passages are always wrapped with `wrapUntrusted()`; when no tool succeeded the reply is the tools' own refusal messages, never the prompt scaffold; an empty answer to a policy question becomes the fixed `INSUFFICIENT_KNOWLEDGE_REPLY` and an `unanswered_questions` row (§30).

---

## Bearer credentials for application references

A candidate has no account. The application reference (`SPA-` + 20 base64url characters, about 120 bits, generated in `packages/db/src/repositories/recruitment.ts`) is treated as a bearer credential:

- `getApplicationStatusTool` declares `bearerCredential: 'application_reference'` (`packages/ai/src/tools/external.ts`). `ToolRegistry.execute()` binds an `ANONYMOUS` identity that has no stronger linkage (`candidateId` unset) to the candidate the reference resolved to, then authorises `application:read` with the `application.read.self` / `SELF` grant. The binding is recorded as `metadata.credential` in the audit row.
- `GET /public/applications/:reference` does the same explicitly (`apps/api/src/routes/recruitment.ts`): when the reference resolves, a new anonymous identity carrying `candidateId` is built and authorised; when it does not, no binding happens and the `SELF` grant fails, so the response is a uniform 404/403 that never echoes the reference.
- A Telegram id already linked to a candidate (`candidates.findByTelegramUserId`) keeps that linkage and cannot be re-bound by quoting someone else's reference.
- Guessing is bounded by `publicApiPerIp` and the Telegram per-user limit; the reference is never included in responses to an unauthorised caller, and only the coarse `publicStageLabel()` is returned, never the internal stage.

Proof: `tests/security/acceptance.test.ts` Test 8 (foreign-tenant reference not resolvable) and `tests/e2e/flows.test.ts` "searches jobs, applies, and checks status — without ever seeing internal data".

---

## RAG permission filtering

Filtering happens **inside** the retrieval query. `KnowledgeRepository.searchChunks()` (`packages/db/src/repositories/knowledge.ts`):

```sql
SELECT ... , bm25(document_chunks_fts) AS rank
  FROM document_chunks_fts f
  JOIN document_chunks c ON c.id = f.chunk_id
  JOIN documents       d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
 WHERE document_chunks_fts MATCH ?
   AND c.tenant_id = ?
   AND c.classification IN (?, ?, ...)        -- AllowDecision.allowedClassifications
   AND d.status = 'ACTIVE'
   AND c.effective_from <= ?                  -- policy versioning (§23)
   AND (c.effective_to IS NULL OR c.effective_to >= ?)
 ORDER BY rank
 LIMIT ?
```

The `LIKE` fallback (`searchChunksFallback()`) applies the identical tenant, classification, status and effective-date predicates. Additional guarantees in `D1KnowledgeSearchService` (`packages/knowledge/src/search-service.ts`):

- An empty `allowedClassifications` returns nothing (`strategy: 'none'`); it never widens to "all".
- Results are re-checked against the allowed set; a mismatch is logged as `classification_mismatch` at error level (it would indicate a regression, since the SQL already guarantees it).
- User text is tokenised and each term is double-quoted before `MATCH` so FTS5 operators are inert (`toFtsQuery()` in `packages/shared/src/text.ts`); `LIKE` wildcards are escaped.
- Every returned passage is scanned with `scanForInjection()` and carries the scan result, and the orchestrator wraps every passage in `<untrusted>` framing before it reaches the model.

The `search_hr_policy` tool asks the gateway for `knowledge.chunk:search` at `INTERNAL` and then uses `decision.allowedClassifications` for retrieval, so an EMPLOYEE is not denied outright but can only ever retrieve PUBLIC/INTERNAL chunks (`tools/internal-self.ts`).

Ingestion (`packages/knowledge/src/ingestion.ts`) treats extracted text as data: it is scanned, chunked and indexed; an injection-like document is flagged with a `DOCUMENT_INJECTION` event (evidence samples only, never the document) but not rejected, because the protection is the framing at prompt time, not exclusion.

Proof: `tests/integration/rag-permission-filtering.test.ts` (per-role ceilings, empty set, PUBLIC-only, tenant boundary, FTS operators, versioning, malicious document) and `tests/security/prompt-attacks.test.ts` "refuses CONFIDENTIAL HR procedures to an employee, via API and assistant".

---

## Curated bot answers

Curated answers (**Knowledge → Bot training**) are the one knowledge path reachable from the EXTERNAL zone, and the one served **verbatim with no model turn**. There is no summarisation step in between, so retrieval is the whole control.

Three axes, all filtered in SQL (`KnowledgeAnswerRepository.search()`):

| Axis | Source | Never from |
|---|---|---|
| `audience` ∈ {EXTERNAL, INTERNAL, BOTH} | The verified channel | The caller, the model, the request body |
| `classification` | `AllowDecision.allowedClassifications` from `knowledge.answer:search` | Anything the caller supplies |
| `requires_account` | `identity.kind === 'USER'` | Anything the caller supplies |

`AUDIENCES_FOR_COMPARTMENT` makes the first axis a compartment rather than a ladder: EXTERNAL sees `{EXTERNAL, BOTH}`, INTERNAL sees `{INTERNAL, BOTH}`. An EXTERNAL-only answer is invisible internally too. The compartment comes from the **channel**, not the security zone, so an unverified person on the internal bot is correctly placed in the internal compartment with no clearance rather than being conflated with a candidate.

The governing invariant is enforced four times, and deliberately so:

> An answer the external bot can serve must be classified `PUBLIC`.

1. The dashboard disables the classification selector for an external audience (UX only).
2. `validateAnswerDraft` rejects the combination (`packages/domain/src/answer-flow.ts`).
3. The `knowledge.answer:create` / `:update` rules apply the gateway's classification ceiling — and `:update` is checked against the **higher** of the stored and requested classification, so neither widening nor narrowing can be done from below the row's own ceiling.
4. `CHECK (audience = 'INTERNAL' OR classification = 'PUBLIC')` in `migrations/0007_knowledge_answers.sql`.

Only 3 and 4 are load-bearing. `tests/security/bot-training.test.ts` inserts directly through the repository, bypassing 1–3, to prove the schema refuses the row on its own.

### Bot command menus

A command bound to a curated answer is two separable things, and conflating them would be the bug:

- **Running** it takes the answer's *question* and runs the ordinary turn, so every filter applies. An unauthorised command is indistinguishable from an unknown one.
- **Advertising** it in the Telegram menu is world-readable: the menu is shown to anyone who opens the bot, before any verification. Only `ACTIVE`, in-date, **PUBLIC** answers are published (`listMenuCommands`), so a CONFIDENTIAL answer's command keeps working for the authorised without its existence being announced.

The menu description is authored, never derived from the question — the question can say more than a public menu should — and the schema refuses a command without one. `RESERVED_BOT_COMMANDS` stops an author taking `/verify`, `/code` or any other built-in, which would otherwise let curated text intercept the verification flow. Pushing a menu is an audited `knowledge.answer:update`, gated on `faq.manage`.

Two further properties worth stating explicitly:

- **The curated lookup runs before the intent zone gate**, so a candidate asking a policy-shaped question gets the answer HR published for candidates rather than a zone refusal. `RESTRICTED`-risk intents are excluded from that shortcut entirely: a salary question still reaches the gate and still leaves an audited `DENY`, whatever curated text happens to match it. Both halves are pinned by tests.
- **A curated answer never answers a person-specific question.** Intents whose `target` is `SELF` or `OTHER_EMPLOYEE` skip the curated path: their true answer differs per asker, so approved static text can never be right for them. Found in practice — a seeded answer about leave benefits matched "what is my remaining leave balance" at exactly the coverage floor and pre-empted `get_my_leave_balance`.
- **A match must clear a threshold** — ≥ 0.67 stem coverage of the asker's question and ≥ 2 matching stems — before approved text is reused. Below it the turn falls through to normal retrieval. Declining is safe; confidently serving the wrong approved answer is not.

### The verified-account gate

Not every internal question is a personal one, so a blanket "verified account required" rule made the internal bot useless for general staff information. `requires_account` makes that an explicit per-answer decision, bounded so it cannot become a hole:

- An answer may only drop the requirement when it is classified `PUBLIC`. Enforced in `validateAnswerDraft`, and again by two `BEFORE` triggers in `migrations/0009_answer_account_gate.sql` that `RAISE(ABORT)` — SQLite cannot add a `CHECK` via `ALTER TABLE`, so the triggers carry the same database-level guarantee.
- The classification filter runs **independently** of the gate. An unverified reader is anonymous, so `maxReadableClassification` gives them `PUBLIC` regardless of what any `requires_account` flag says.
- An external-audience answer is never account-gated, because a candidate has no account; `resolveRequiresAccount` forces it off rather than allowing an incoherent state.

On the internal bot, an unlinked Telegram id reaches `AIOrchestrator.answerFromCuratedOnly()` and nothing else: no tool, no document, no provider call, no employee record. A personal or credential question therefore finds nothing and falls through to the verification prompt. There is no maintained list of "personal" topics — anything person-specific lives behind a tool, and this path has none. The `UNKNOWN_USER` security event is still recorded either way.

Injection-shaped text inside a curated answer is logged, not stripped: there is no model turn for it to hijack, and a holder of `faq.manage` approved it. Figures inside a served answer are passed to the response filter as `groundedNumbers`, because a human approved them — otherwise the filter would redact the very numbers HR published.

Proof: `tests/security/bot-training.test.ts` (56), `tests/unit/answer-flow.test.ts` (35), `tests/e2e/bot-training-flow.test.ts` (6).

---

## Candidate CVs

A CV is the most personal record the system holds, about someone who does not even work here. It is **CONFIDENTIAL**, so `EMPLOYEE` and `MANAGER` cannot list, read, download or match one — only `candidate.document.read` reaches it, and that is granted to HR, HR_ADMIN and SYSTEM_ADMIN alone.

| Control | Where |
|---|---|
| Format allow-list (**PDF, DOC, DOCX**) and a 5 MB cap | `CvIntakeService` — one path shared by both bots, so they cannot drift. An allow-list is only as good as its shortest entry, so it names the three formats a CV actually arrives in and nothing else |
| CONFIDENTIAL on every read | `candidate.document:*` rules; the route resolves the stored row before the gateway call |
| Never in a chat | `maxRiskInChat: 'LOW'` on `candidate.document:read` |
| Download hardening | `attachment` disposition with a sanitised filename, `no-store`, `nosniff` — the filename came from a candidate |
| Tenant isolation | Every query is tenant-scoped; a cross-tenant id returns 404 |

**A slash command's arguments go straight to its tool.** `/apply` is parsed in the bot and executed through `ToolRegistry.execute` — the PolicyGateway still decides and audits — with no provider call in between. Handing already-known arguments to a model to re-extract is a loss of fidelity, not a convenience: an earlier version did exactly that and created a candidate named "Monika Chan and my email is monika" after a provider regex over-matched the sentence it had been rendered into.

**A half-finished application holds nothing.** `application_drafts` is conversational scratch space keyed by Telegram id: unvalidated, bound to no identity, granting nothing, expiring after an hour and swept by the retention job. A candidate record appears only when `submit_application` runs and the gateway allows it.

**Intake is Telegram-only.** There is no upload route: a CV arrives either from the candidate on the recruitment bot or forwarded by staff on the employee bot, both via `/cv`. One ingestion path means one set of checks, and it makes the `source` column on every row a meaningful record of provenance.

**Each bot identifies the owner differently, and neither guesses.**

- *Recruitment bot*: the CV attaches to the candidate its Telegram id already resolves to — a link that exists only because they applied and gave a real name and e-mail. A file from an id that has never applied is refused outright; inventing an owner from a Telegram profile is exactly the identity guess §12 forbids.
- *Employee bot*: the sender is an employee, not the person the CV describes, so the candidate is named in the caption — `/cv <e-mail-or-reference>`, or a bare reference. An unknown address is refused rather than turned into a new candidate. Forwarding requires `candidate.document.manage` through the PolicyGateway, so EMPLOYEE and MANAGER are refused with an audited DENY however the caption is written, and `uploaded_by_user_id` records who forwarded it. Running `/cv` on its own checks that permission **first**, so someone who may not forward a CV finds out before preparing a file.

**Neither PDF nor legacy `.doc` text is read automatically.** Both are stored, checksummed and downloadable, with `extraction_status = EMPTY` and a warning telling the reader to paste the text in. A crude byte scrape of either produces plausible-looking garbage, which is worse than an honest "not read" for something a hiring decision rests on. DOCX is parsed natively.

**A malicious CV is data.** Injection-shaped text is scanned, flagged and raises a `DOCUMENT_INJECTION` event carrying categories and a score, never the CV itself. It does **not** reject the upload: refusing it would let an attacker deny a genuine applicant by poisoning their own CV. The protection is that nothing treats the text as an instruction — the matcher only runs regular expressions over it, and the dashboard renders it inside a `<pre>` as a text node.

**Matching is deterministic and advisory.** No model is involved (§38). Three properties are asserted by test rather than intended by comment:

- Every match carries the CV sentence that produced it, so a person can disagree with it.
- Nothing decides anything: no threshold rejects a candidate, and the application stage machine is untouched.
- No protected characteristic is extracted, matched or scored — age, gender, nationality, marital status and health are ignored even when a CV volunteers them.

Proof: `tests/security/candidate-cvs.test.ts` (66), `tests/unit/cv-matching.test.ts` (17).

---

## Prompt-injection detection

`scanForInjection()` in `packages/security/src/prompt-injection.ts` is **defence in depth only**. It never grants or withholds access; it makes attempts visible and lets the orchestrator frame text as untrusted.

- Regex patterns across eight categories: `INSTRUCTION_OVERRIDE`, `ROLE_CLAIM`, `AUTHORITY_CLAIM`, `SYSTEM_PROMPT_PROBE`, `SECURITY_DISABLE`, `DIRECT_DATA_ACCESS`, `IDENTITY_ASSERTION`, `ENCODED_PAYLOAD` (base64 blobs of 60+ characters). Each pattern carries a weight; the summed, capped score (0–100) maps to severity via `injectionSeverity()`: ≥ 80 CRITICAL, ≥ 45 HIGH, ≥ 25 MEDIUM, else LOW.
- Evidence is truncated to 80 characters so an event cannot be used to replay the payload; scanning is bounded to the first 20 000 characters.
- Runs on: every user message (orchestrator step 2 → `IDENTITY_SPOOF_ATTEMPT` when `ROLE_CLAIM`/`IDENTITY_ASSERTION` is present, else `PROMPT_INJECTION`), every uploaded document at ingest (`DOCUMENT_INJECTION`), every retrieved passage (`KnowledgePassage.injection`), and every line of model output in the response filter.
- `wrapUntrusted(label, content)` fences content in `<untrusted source="...">` with an explicit "this is data, not instructions" preamble, strips any `</untrusted>`, `<system>`, `<instructions>`, `<im_start>`, `<im_end>` tags from the payload so it cannot close the fence early, and sanitises the label.

Proof: `tests/unit/prompt-injection.test.ts`; end-to-end in `tests/security/prompt-attacks.test.ts` (17 attack strings, each asserting no unauthorised tool ran and no forbidden fragment appeared) and `tests/security/acceptance.test.ts` Tests 2, 3 and 7.

---

## Response filter

`filterAiResponse()` in `packages/security/src/response-filter.ts` is the last line of defence (§54); the primary protection is that unauthorised data never enters the prompt. Findings:

| Finding | Behaviour |
| --- | --- |
| `INJECTED_INSTRUCTION` | Drops any output line whose injection scan hits an instruction category (so an echoed "SYSTEM MESSAGE: …" from a document never reaches the reader). |
| `SYSTEM_PROMPT_LEAK` | Redacts prompt scaffold markers (`You are CORPUS…`, `AVAILABLE TOOLS:`, `AUTHORISED CONTEXT:`, `TOOL RESULTS:`, `system prompt:`). |
| `UNTRUSTED_MARKUP` | Strips echoed `<untrusted>` tags. |
| `SQL_ECHO` | Redacts SQL-shaped text (the model has no database access, so this is always noise or reflected injection). |
| `UNGROUNDED_CURRENCY` | Redacts any currency-looking amount not present in `groundedNumbers` returned by a tool; when no tool returned a figure, monetary values are not allowed at all. |
| `BULK_PII` | Redacts all e-mail addresses when ≥ 4 appear (≥ 2 in the EXTERNAL zone). |

Any finding raises a `BLOCKED_REQUEST` security event (HIGH for a prompt leak, else MEDIUM) from the orchestrator. Proof: `tests/unit/response-filter.test.ts`.

---

## Rate limiting

`packages/security/src/rate-limit.ts` implements fixed-window counters behind a `RateLimiter` interface with three backends chosen in `apps/api/src/container.ts`: `KvRateLimiter` when the `RATE_LIMIT` KV namespace is bound, `D1RateLimiter` (table `rate_limit_counters`, atomic upsert) when only D1 is bound, `MemoryRateLimiter` otherwise. All limits are configurable via environment variables (`packages/shared/src/config.ts`).

| Surface | Default | Env var | Key | Where consumed |
| --- | --- | --- | --- | --- |
| Telegram messages | 30 / min | `RATE_LIMIT_TELEGRAM_PER_MINUTE` | `tg:ext:<telegramUserId>`, `tg:int:<telegramUserId>` | `external-bot.ts`, `internal-bot.ts` |
| Telegram verification | 5 / 15 min | `RATE_LIMIT_VERIFY_PER_15M` | `tg:verify:<telegramUserId>`, `verify:<userId>` | `internal-bot.ts`, `routes/auth.ts` |
| AI requests | 60 / hour | `AI_REQUESTS_PER_HOUR` | `ai:<tenantId>:<subjectKey>` | `orchestrator.ts` (before any provider call) |
| Login | 10 / 15 min | `RATE_LIMIT_LOGIN_PER_15M` | `login:email:<email>` and `login:ip:<ip>` | `routes/auth.ts` |
| Application submission | 5 / hour | `RATE_LIMIT_APPLICATIONS_PER_HOUR` | `apply:<subjectKey>` | `routes/recruitment.ts` |
| Admin API | 600 / min | `RATE_LIMIT_ADMIN_API_PER_MINUTE` | `api:<tenantId>:<userId>` | `middleware/auth.ts` `requireSession` |
| Public API | 120 / min | `RATE_LIMIT_PUBLIC_API_PER_MINUTE` | `pub:<tenantId>:<ip>` | `middleware/auth.ts` `publicIdentity` |

Exceeding a limit returns 429 with `Retry-After` (or a bot message) and records a `RATE_LIMIT` event. Account lockout (8 failures → 15 minutes) is enforced separately in `LoginService`. Other bounds: request bodies ≤ 512 KiB (`MAX_REQUEST_BODY_BYTES`, `apps/api/src/middleware/body.ts`), uploads ≤ 8 MiB (`MAX_UPLOAD_BYTES`), page size ≤ 100 (`MAX_PAGE_SIZE`), ≤ 3 tool calls per turn, ≤ 5 context chunks (`AI_MAX_CONTEXT_CHUNKS`), ≤ 600 output tokens (`AI_MAX_OUTPUT_TOKENS`).

Proof: `tests/integration/rate-limiting.test.ts` (login, lockout, AI, applications, Telegram, admin API, page size, body size, D1-shared counters) and `tests/unit/misc-units.test.ts` "rate limiting".

---

## Audit log and security events

Both tables are defined in `migrations/0005_security_conversations.sql` and written through `packages/db/src/repositories/audit.ts`, which exposes no update or delete method other than the retention pruner and security-event acknowledgement.

### `audit_logs`

Columns: `timestamp, tenant_id, user_id, telegram_id, channel, bot, intent, resource, resource_id, action, decision (ALLOW|DENY|ERROR), reason_code, risk, source, request_id, metadata`. Every `PolicyGateway` decision writes a row (ALLOW rows carry the satisfied permission as `reason_code`); `skipAudit` is only ever honoured for read-only, unclassified UI pre-checks such as `GET /departments`; `maySkipAudit()` overrides it for mutations and for CONFIDENTIAL/RESTRICTED reads. Proof: `tests/security/hardening.test.ts`. `metadata` is passed through `redact()` and truncated to 4 000 characters before storage. Reading the audit trail (`GET /audit`, permission `audit.read`) is itself audited (`apps/api/src/routes/security.ts`).

### `security_events`

Columns: `timestamp, tenant_id, event_type, severity, user_id, telegram_id, subject_key, channel, summary, detail, request_id, acknowledged_at, acknowledged_by`. `SecurityEventService.record()` (`packages/security/src/security-events.ts`) applies the default severity and never lets a telemetry failure change a request's outcome. Events are readable and acknowledgeable by holders of `security.read` (HR_ADMIN, SYSTEM_ADMIN) via `GET /security/events`, `GET /security/events/summary`, `POST /security/events/:id/acknowledge`.

| Event type | Default severity | Emitted by |
| --- | --- | --- |
| `TENANT_ACCESS_VIOLATION` | CRITICAL | gateway (`TENANT_MISMATCH`) |
| `PROMPT_INJECTION` | HIGH | orchestrator (user message scan) |
| `IDENTITY_SPOOF_ATTEMPT` | HIGH | orchestrator (role/identity claims); `routes/auth.ts` Telegram link to another e-mail |
| `CROSS_USER_ACCESS` | HIGH | gateway (`NOT_OWNER`, `NOT_MANAGER_OF_TARGET`) |
| `SCOPE_VIOLATION` | HIGH | gateway (`WRONG_SECURITY_ZONE`, `INTENT_NOT_ALLOWED_IN_ZONE`) |
| `DOCUMENT_INJECTION` | HIGH (scan-derived) | `DocumentIngestionService` |
| `RESTRICTED_DATA_REQUEST` | MEDIUM | gateway (`CLASSIFICATION_TOO_HIGH`, `RISK_TOO_HIGH`) |
| `AUTH_FAILURE` | MEDIUM | `requireSession`, login, Telegram code failures, webhook secret rejections |
| `TOOL_DENIED` | MEDIUM | declared in the taxonomy; **no emitter in the current code** — tool denials appear as the gateway's own event plus the `tool_calls` row |
| `BLOCKED_REQUEST` | LOW | gateway default; response-filter findings (severity raised) |
| `UNKNOWN_USER` | LOW | internal bot, unverified Telegram id |
| `RATE_LIMIT` | LOW | every limiter site |

Conversation records (`conversations`, `messages`, `tool_calls`, `unanswered_questions`, `hr_tickets`) store the exchange for troubleshooting; `subject_key` there is pseudonymous. Retention is declared in `retention_policies` (audit and security events 730 days, messages 90, tool calls 180, verification codes and rate-limit counters 1) and enforced by `scripts/prune.ts`.

---

## Transport and HTTP hardening

| Control | Implementation |
| --- | --- |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`, `Cross-Origin-Opener-Policy: same-origin`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `Permissions-Policy`, `Cache-Control: no-store`, HSTS in production (`apps/api/src/middleware/security-headers.ts`). The dashboard sets its own subset in `apps/web/next.config.mjs`. |
| CORS | Explicit origin allowlist from `CORS_ORIGINS`; credentials allowed only for a listed origin; preflight answered 403 otherwise. `validateConfig()` makes an empty list fatal in production. |
| Request bodies | JSON only, content-length and actual length capped, object-only, arrays rejected (`middleware/body.ts`); query parameters accept a single value each. |
| Input validation | Every route body and query goes through the validators in `packages/shared/src/validate.ts` (`parse`, `object`, `str`, `email`, `dateOnly`, …); tool arguments through `safeParse(tool.validator)`. |
| Error handling | `errorHandler` (`middleware/errors.ts`) converts anything thrown into an `AppError` and returns `{ error: { code, message, details?, requestId } }`; `internal` detail is logged only. Unknown throwables become a generic `INTERNAL`. Unknown paths return a stable 404 (`tests/integration/api-smoke.test.ts` "fails closed on unknown internal paths"). |
| Request ids | Inbound `x-request-id` is echoed only if it matches `^[A-Za-z0-9_-]{6,64}$`; otherwise a fresh id is generated (`middleware/request-context.ts`). |
| Logging | Single-line JSON; `redact()` replaces the value of any key matching `pass|password|secret|token|api[_-]?key|authorization|cookie|code|otp|hash|salt|cv_text|content` at any depth, truncates strings to 512 characters and depth to 4 (`packages/shared/src/logger.ts`). The Telegram client logs the API method only, never Telegram's description text (`packages/telegram/src/client.ts`). |
| Health | `GET /health` reports degradation (ephemeral storage, mock provider, missing secrets) using `describeConfig()`, which exposes booleans and limits, never values (`apps/api/src/routes/health.ts`; `tests/integration/api-smoke.test.ts` "never exposes secrets through /health"). |
| Statelessness | The dependency container is built per request from bindings (`apps/api/src/container.ts`); the only module-scope objects are the in-memory fallbacks used when KV/R2 are not bound, and `/health` reports that degradation. |
| Tenant scoping | Repository methods take a `TenantScope`; `tenantScope()` throws on a blank tenant id, so a missing tenant cannot become an unscoped query (`packages/db/src/tenant.ts`). |

---

## Secrets

- Secrets are read from Worker bindings / `process.env` in `loadConfig()`; `AppConfig` is never serialised to a response (`packages/shared/src/config.ts`). Production values are set with `wrangler secret put`; `apps/api/wrangler.toml` holds only non-secret `[vars]` and `TODO_` placeholders for ids.
- `.env.example` contains placeholders only; `.gitignore` excludes `.env`, `.env.local`, `.dev.vars` and local SQLite files.
- `scripts/check-secrets.ts` scans the tree for credential shapes (Telegram tokens, Anthropic/OpenAI/AWS/Google/GitHub/Slack keys, private-key blocks, assigned `SESSION_SECRET`/`AI_API_KEY`/`TELEGRAM_*` literals) and fails CI; it runs as the first step of `.github/workflows/ci.yml` and in `npm run ci`.
- AI provider keys are used only inside `packages/ai/src/providers/*.ts` on the Worker; the mock provider needs none.
- The dashboard holds no secret: authentication is the HttpOnly cookie, the CSRF token lives in memory / `sessionStorage`, and the only build-time input is `NEXT_PUBLIC_API_BASE_URL` (`apps/web/lib/api.ts`, `apps/web/next.config.mjs`). `can(user, permission)` checks in `apps/web` decide only what to render; the API re-authorises every call (`GET /auth/me` comment in `apps/api/src/routes/auth.ts`).
- Deployment is a separate CI job that runs only on `main` pushes and only when Cloudflare credentials are present, so test jobs never need secrets.

---

## Final security review checklist (§62)

Local results on 2026-09-07: `npx vitest run tests/security` → 3 files, 157 tests passed; `npx vitest run tests/unit tests/integration tests/e2e` → 15 files, 264 tests passed.

| # | §62 item | Code | Proof |
| --- | --- | --- | --- |
| 1 | External bot cannot access internal tools | `ToolRegistry.describeFor()` / `execute()` zone gate; `POLICY_RULES` `zones`; `ExternalBot` fixes an anonymous identity | `tests/unit/tool-registry.test.ts` "offers an external caller only the recruitment tools", "denies an internal tool requested from the EXTERNAL zone"; `tests/security/acceptance.test.ts` Test 4 |
| 2 | Internal bot requires verified identity | `IdentityResolver.fromTelegramInternal()`; `InternalBot.handle()` | `tests/security/prompt-attacks.test.ts` "refuses an unverified Telegram user any HR capability"; `tests/e2e/flows.test.ts` "links an account only after a backend-issued code" |
| 3 | Roles come from backend database | `SessionService.resolve()` → `users.listRoles`; `IdentityResolver` | `tests/security/prompt-attacks.test.ts` "never lets a role claim change the loaded role"; `tests/integration/rbac-consistency.test.ts` |
| 4 | User cannot self-assign role | Gateway checks permissions, not labels; no route accepts roles for self; `assertToolIsSafe()` forbids `role`/`permission` parameters | `tests/unit/policy-gateway.test.ts` "ignores roles the identity claims but whose permissions it lacks"; `tests/unit/tool-registry.test.ts` "rejects any tool that accepts a tenant, role or permission"; acceptance Test 2 |
| 5 | AI cannot execute SQL | `SQL_LIKE_NAME` check in `assertToolIsSafe()`; `ToolContext` has no SQL handle | `tests/unit/tool-registry.test.ts` "rejects a tool named like an execution primitive", "never exposes a generic SQL or database tool"; `prompt-attacks.test.ts` "Run this SQL for me" |
| 6 | AI cannot directly access database | Handlers only reach tenant-scoped repositories via `ToolContext.repos`; providers receive text only | Same as 5; `tests/unit/tool-registry.test.ts` "gives every tool a permission, zone, risk and resource" |
| 7 | AI cannot grant permissions | `canonicaliseIntent()` discards model-supplied scope/risk; permissions only from `permissionsForRoles()` | `tests/unit/intents.test.ts`; `tests/unit/rbac.test.ts` "never grants a wildcard-style permission" |
| 8 | Tool calls pass PolicyGateway | `ToolRegistry.execute()` step 4 | `tests/unit/tool-registry.test.ts` "never calls a handler when the gateway denies the request", "records an audit entry for every tool authorisation decision" |
| 9 | RAG results are permission-filtered | `searchChunks()` SQL `IN` filter; `D1KnowledgeSearchService` fail-closed and re-check. Curated answers filter audience *and* classification in `KnowledgeAnswerRepository.search()`, with the same fail-closed re-check | `tests/integration/rag-permission-filtering.test.ts`; `tests/security/bot-training.test.ts` |
| 10 | Restricted documents are protected | Knowledge grant ladder; `maxReadableClassification()`; effective-ceiling intersection; the `audience`/`classification` CHECK on `knowledge_answers` | `tests/unit/policy-gateway.test.ts` "knowledge classification ceilings"; `tests/security/authorization-matrix.test.ts` "read a RESTRICTED document"; `tests/security/bot-training.test.ts` "the database refuses an unsafe row" |
| 11 | Tenant isolation works | Gateway step 1; `tenantScope()`; tenant column on every query | `tests/unit/policy-gateway.test.ts` "denies a cross-tenant resource even for SYSTEM_ADMIN"; acceptance Test 8; RAG test "never crosses a tenant boundary" |
| 12 | Cross-user access is blocked | `SELF`/`TEAM` ownership; owner ids from database in `resolveResource()` | `tests/unit/policy-gateway.test.ts` "ownership"; `prompt-attacks.test.ts` "data leakage attacks"; acceptance Tests 1, 6 |
| 13 | Prompt injection is tested | `scanForInjection()`, `wrapUntrusted()` | `tests/unit/prompt-injection.test.ts`; `tests/security/prompt-attacks.test.ts`; acceptance Test 3 |
| 14 | Malicious documents are tested | `DocumentIngestionService` scan + framing; `CvIntakeService` scan + flag on CVs | `tests/integration/rag-permission-filtering.test.ts` "malicious document handling"; acceptance Test 7; `tests/security/candidate-cvs.test.ts` "a malicious CV is data, not instruction" |
| 15 | Sensitive actions are audited | Gateway writes ALLOW/DENY rows; `tool_calls` per tool | `tests/security/authorization-matrix.test.ts` "records a DENY audit row for every refusal"; `tests/unit/policy-gateway.test.ts` "auditing" |
| 16 | Secrets are not exposed | `AppError.toPublicJSON()`, `redact()`, `describeConfig()` | `tests/integration/api-smoke.test.ts` "never exposes secrets through /health"; `authorization-matrix.test.ts` "never leaks SQL, stack traces or internal detail"; `tests/unit/misc-units.test.ts` "log redaction" |
| 17 | Frontend does not contain secrets | `apps/web/lib/api.ts`, `next.config.mjs`; cookie is HttpOnly | Structural (no test); `scripts/check-secrets.ts` scans `apps/web` in CI |
| 18 | Rate limiting exists | `packages/security/src/rate-limit.ts` and consumers listed above | `tests/integration/rate-limiting.test.ts` |
| 19 | Input validation exists | `packages/shared/src/validate.ts`; `middleware/body.ts`; tool validators | `tests/unit/misc-units.test.ts` "validation"; `tests/unit/tool-registry.test.ts` "rejects invalid arguments before the handler runs"; `rate-limiting.test.ts` "rejects an oversized request body" |
| 20 | Production state is not stored on local filesystem | D1 + R2 via `StorageService`; per-request container; memory fallbacks reported by `/health` | `tests/integration/repositories.test.ts`; `/health` `documentStorage` field |
| 21 | Database migrations work | `migrations/*.sql`, `packages/db/src/migrations.ts` | `tests/integration/schema.test.ts` "applies all migrations exactly once", "enforces foreign keys" |
| 22 | CI passes | `.github/workflows/ci.yml` (secret scan → lint → typecheck → unit → integration → security → e2e → RBAC drift → build) | Full suite passed locally on 2026-09-12 (706 tests). The GitHub Actions run itself must be confirmed in the repository's Actions tab. |
| 23 | Security tests pass | `tests/security/*.test.ts` | `npm run test:security` → 327 passed (2026-09-12) |

---

## Security test suite

```text
npm run test:security     # tests/security — acceptance (§44), authorisation matrix, prompt attacks
npm run test:unit         # policy gateway, RBAC, tool registry, injection scanner, response filter
npm run test:integration  # RAG filtering, rate limiting, RBAC/migration consistency, API smoke
npm run test:e2e          # candidate, Telegram verification, leave, job, policy, admin flows
```

All suites run against the real Hono app on an in-process SQLite database with the real migrations and seed data (`tests/helpers/harness.ts`); only the LLM (`MockAIProvider`) and outbound Telegram HTTP are stubbed. Seed accounts use the `corpus.test` domain and a development password from `.env.example`.

`tests/security/acceptance.test.ts` maps one-to-one onto §44 Tests 1–8. `tests/security/authorization-matrix.test.ts` walks five roles against 23 sensitive endpoints (115 role/endpoint cases plus two invariant tests) and asserts every refusal leaves a `DENY` audit row with no internal detail. `tests/security/prompt-attacks.test.ts` sends 17 injection strings plus targeted leakage and spoofing attacks through `/assistant/ask` and the Telegram webhooks.

---

## Limitations / Roadmap

Items below are real gaps between `CLAUDE.md` and the current code, stated plainly so they are not mistaken for implemented controls.

| Area | Current state | Roadmap |
| --- | --- | --- |
| Verification-code delivery | There is no e-mail transport. `selectCodeDelivery()` returns `LogOnlyCodeDelivery` in development (prints the code to the console, bypassing redaction on purpose) and `NullCodeDelivery` in production and staging, which discards it. The code is never sent back over Telegram or returned by any API, and `/health` reports `VERIFICATION_CODE_TRANSPORT` as a config error. | Implement a production `VerificationCodeDelivery` (e-mail) and select it in `selectCodeDelivery()`; until then, internal Telegram linking cannot be completed in production. |
| Pruning / retention | Enforced. `apps/api/src/scheduled.ts` applies every `retention_policies` row (plus expired sessions and orphaned conversations) from the Worker's `scheduled()` export, on a daily Cron trigger. `scripts/prune.ts` remains for local use. | — |
| Tenant selection | Isolation is enforced everywhere, but every request resolves the single tenant from `DEFAULT_TENANT_SLUG`; there is no per-request tenant routing. | Resolve tenant from host, path or bot configuration before enabling multiple tenants. |
| `TOOL_DENIED` event | Emitted. `ToolRegistry.execute()` records it for refusals that never reach the gateway — unknown tool, wrong zone, unusable arguments, unresolvable resource — so those are visible on the dashboard alongside gateway denials. | — |
| Prompt-injection heuristics | English-only regex patterns and a simple weight sum; obfuscated or non-English payloads will not be flagged. | Detection is telemetry, not authorisation, so misses do not widen access; improve coverage incrementally with the attack corpus in `tests/unit/prompt-injection.test.ts`. |
| Response filter | Heuristic (currency regex, e-mail count, marker strings); it cannot recognise every form of leakage. | Keep as last line only; the invariant remains authorisation-before-retrieval. |
| Rate-limit consistency | `KvRateLimiter` is eventually consistent (a few extra requests can pass at a cold edge); `MemoryRateLimiter` and `MemoryReplayGuard` are per-isolate when neither KV nor D1 is bound. | Bind the KV namespace in production; `/health` already reports the fallback. |
| Client IP for public limits | Only `CF-Connecting-IP` is trusted (`clientIpKey()` in `apps/api/src/client-ip.ts`); `X-Forwarded-For` is ignored, so rotating it cannot reset a per-IP bucket. Without the edge header every caller shares one `unknown` bucket — strict rather than permissive. Proof: `tests/security/hardening.test.ts`. | — |
| Document formats | Text-family and HTML/JSON are extracted; DOCX and PDF uploads are refused (`UnsupportedDocumentError`) rather than indexed as garbage. | See `docs/rag.md`; add a Worker-compatible extractor or an out-of-band conversion step. |
| Search | D1 FTS5 with a `LIKE` fallback; no vector or hybrid retrieval. | `KnowledgeSearchService` interface is in place for a later vector backend. |
| Password reset | `verification_codes.purpose` allows `PASSWORD_RESET` but no route implements it. | Implement with the same hashed-code, rate-limited pattern. |
| Session binding | `sessions.user_agent` and `ip_hash` are recorded but not compared on later requests. | Optional anomaly detection on the security dashboard. |
| CI status | The workflow exists and the full suite passes locally; a green run on GitHub has not been verified from this repository state. | Confirm in the Actions tab after the next push. |


---

## Secret scanning

`npm run secrets:check` (`scripts/check-secrets.ts`) runs first in CI and fails the
build on anything that looks like a live credential: vendor key formats (Telegram,
Anthropic, OpenAI, AWS, Google, GitHub, Slack, private-key blocks) and quoted
assignments to `SESSION_SECRET`, `AI_API_KEY` or any `TELEGRAM_*_TOKEN`/`_SECRET`.

**Scope: committable files only.** Paths git ignores are skipped, because the point
of the gate is to stop a credential being *committed* and an ignored file cannot be.
Local development legitimately holds real tokens in `apps/api/.dev.vars` and `.env`;
scanning them would fail `npm run ci` for every developer with working credentials,
which teaches people to bypass the gate. Tracked files are scanned in full, and
`--all` scans everything for a local audit.

**Which files count as configuration.** In a config file an unquoted `KEY=value` is a
literal, so the assignment rules apply there and not in source. The set is matched by
*basename*, with backup and variant suffixes stripped first — `.env`, `.dev.vars`,
`*.vars`, `*.toml`, `*.yaml`, `*.sh` and friends, so `.dev.vars.bak.1788876584` is
treated exactly like `.dev.vars`. This mattered: `.dev.vars` — the Worker's own local
secrets file — was previously *not* recognised, so only vendor format rules applied to
it and a plain `SESSION_SECRET=value` there was invisible to the scanner.

Two deliberate distinctions keep the signal high:

- In **source files** only a *quoted* value counts, so `SESSION_SECRET: TEST_SESSION_SECRET`
  (an identifier reference) is not a hit. In **configuration files** — `.env*`, `.toml`,
  `.yaml`, `.sh` and friends — an unquoted `KEY=value` is the literal syntax, so it is.
- `--all` scans ignored files too, for a local audit: `npm run secrets:check -- --all`.

### Keeping credentials out of history

Scanning content is the last of three layers, not the only one:

| Layer | Mechanism | Catches |
|---|---|---|
| 1. Ignore | `.gitignore` patterns cover every *variant* of a secrets file — `.dev.vars`, `.dev.vars.*`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.bak`, `*~` | The file never becomes committable |
| 2. Refuse by name | `.githooks/pre-commit` blocks a staged secrets file outright, whatever it contains | A file force-staged past `.gitignore`, or one whose values match no known credential shape |
| 3. Scan content | `npm run secrets:check`, in the hook and first in CI | A credential pasted into an otherwise ordinary file |

Layer 1 alone is fragile: `.gitignore` matching `.dev.vars` does **not** match
`.dev.vars.bak`, which is how a backup of the Worker's local secrets became
committable during development. The broadened patterns and the name-based hook
exist because of that.

The pre-commit hook is **opt-in** — it runs on every commit, so enabling it is the
developer's choice:

```bash
npm run hooks:install          # git config core.hooksPath .githooks
git config --unset core.hooksPath   # to disable
```

CI runs the scan regardless. Note the difference in cost: the hook prevents the
commit, whereas a CI catch means the secret is already pushed and must be **rotated**,
not merely un-staged.

Proof: `tests/security/hardening.test.ts` asserts the committed tree passes, that a
quoted literal, an unquoted config value and a vendor key format are all still caught,
that an identifier reference is not, and that a real token in `.dev.vars` is invisible
to the default scan but visible under `--all`.

---

## Security review (CLAUDE.md §62)

An adversarial review of the §62 checklist was run against this codebase: six independent
reviewers covering zones/identity, the AI data path, tenancy and routes, auth/session/transport,
business logic and deployment configuration produced 24 candidate findings, each then put to
three independent skeptics instructed to refute it. Sixteen survived and were fixed; the rest
were refuted as unreachable or already covered.

Every fix below is pinned by a regression test in `tests/security/hardening.test.ts` unless
another file is named.

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | HIGH | The public bot returned an existing applicant's reference and status to anyone who supplied their e-mail address, and `createOrGet` bound the caller's Telegram id to that candidate — an identity takeover. | `submit_application` discloses the reference only when the caller is already bound to the candidate; `createOrGet` never attaches a Telegram id to an existing record. Linking now requires `linkTelegramAccount`, reachable only after the reference is presented. |
| 2 | MEDIUM | A verified Telegram employee with no user account was given a synthetic `userId` (`employee:<id>`), violating the `users` foreign key on conversation and audit rows. | `UserIdentity.userId` is `string \| null`; the resolver passes `null`. Dashboard-only routes use `sessionUserIdOf()`, where a user account is guaranteed. |
| 3 | MEDIUM | Third-party strings inside tool `data` (candidate names, application notes) reached the prompt without the untrusted framing applied to retrieved passages. | The whole tool-result payload is wrapped by `wrapUntrusted()`; only the `TOOL RESULTS:` label stays outside the fence. |
| 4 | MEDIUM | A turn where the model requested no tool returned its own prose, so HR policy could be answered with no retrieval, no citation and no unanswered-question record. | Grounding is a backend requirement: for `HR_POLICY_QUESTION` (and `UNKNOWN` internally) a turn with no ALLOW tool call returns `INSUFFICIENT_KNOWLEDGE_REPLY` and records the question. |
| 5 | MEDIUM | `POST /reports/unanswered/:id/resolve` rode the read-only middleware decision and wrote no audit row. | Its own `action: 'update'` decision against `conversation:update`, and `maySkipAudit()` cannot silence a mutation. |
| 6 | MEDIUM | `GET /policies/:id/versions` set `skipAudit`, so reads of RESTRICTED documents left no trail. | Flag removed, and `maySkipAudit()` now refuses it for CONFIDENTIAL/RESTRICTED resources regardless. |
| 7 | LOW | The bulk application listing was unaudited. | Flag removed. |
| 8, 12 | LOW | `?limit=abc` became `NaN`, survived the clamp and reached the SQL bind, returning 500 on every list endpoint. | `pageOf()` validates both parameters (422 on a bad value) and `resolvePage()` treats a non-finite number as absent. |
| 9 | HIGH | The failed-login lockout set `users.status = 'LOCKED'` permanently. The window expired and the correct password was accepted, but every issued session was then rejected — an unauthenticated attacker could brick any account, including SYSTEM_ADMIN, with eight wrong guesses. | `recordLoginSuccess` restores ACTIVE, and `clearExpiredLock` releases the lock and resets the counter when the window has passed. A deliberately DISABLED account is untouched. |
| 10 | HIGH | `LogOnlyCodeDelivery` was wired unconditionally, printing the Telegram one-time code and the target e-mail to the Worker log in production. | `selectCodeDelivery()` returns `NullCodeDelivery` for production and staging; `validateConfig()` raises `VERIFICATION_CODE_TRANSPORT`. |
| 11 | MEDIUM | Forged webhooks were unthrottled and each wrote a D1 row before the secret was checked. | The secret is verified before any database access; rejections are recorded at most five per client per five minutes. |
| 13 | HIGH | Cancelling an APPROVED leave request that had already been taken refunded the days, letting the same entitlement be spent twice. | `canCancelLeave()` in `packages/domain` allows cancelling APPROVED leave only before it starts; both the route and the `cancel_leave_request` tool use it, so the denial is audited. |
| 14 | HIGH | `decide()` and `cancel()` queued the balance movement in the same batch as their status-guarded UPDATE, so a second concurrent approval whose UPDATE matched no row still moved the days. | The status transition runs first and alone; a `changes !== 1` result raises CONFLICT and no balance moves. |
| 15 | MEDIUM | Interviews and offers could be created on a terminal or CLOSED application, and an ARCHIVED job could be republished. | `canAttachToApplication()` / `canExtendOffer()` gate the side paths, and `canTransitionJob()` (`packages/domain/src/job-flow.ts`) makes ARCHIVED terminal. All three are passed as gateway business rules, so refusals are audited. |
| 16 | HIGH | The secret scanner flagged its own test harness, so `npm run secrets:check` exited 1 on the committed tree and every later CI gate was skipped. | The source rule requires a quoted literal; unquoted `KEY=value` is matched only in configuration files. Vendor-format rules are unaffected. |

Two further gaps the review flagged as documented-but-unfixed were closed at the same time:
`TOOL_DENIED` is now emitted by `ToolRegistry.execute()` for refusals that never reach the
gateway, and `X-Forwarded-For` is no longer accepted as a rate-limit key (only Cloudflare's
`CF-Connecting-IP`), so rotating that header cannot reset a per-IP bucket.

A second defect surfaced only under `wrangler dev`, never in the test suite:
`DUMMY_HASH` — the constant the login path verifies against when no account
matches, so an unknown e-mail costs the same work as a wrong password — was
computed by calling `hashPassword()` at **module scope**. Workers forbid
generating random values in global scope, so the promise rejected and every
unknown-account login returned **500** while a wrong password returned **401**.
That is a perfect account-enumeration oracle, produced by the very code meant to
prevent one. `DUMMY_HASH` is now a literal, so no crypto runs at import.

The suite could not have caught it: tests run on Node, where module-scope crypto
is legal. `tests/unit/worker-runtime-constraints.test.ts` now scans every
Worker-reachable file for that whole class of violation, and
`tests/security/hardening.test.ts` asserts the unknown-account and
wrong-password responses are byte-identical.

A separate defect was found while verifying the dashboard against a running Worker: the session
cookie was always `SameSite=Lax`, which a `*.pages.dev` dashboard can never send to a
`*.workers.dev` API, so login silently failed in the documented default deployment. See the
Sessions table above for the cross-site policy that replaced it.
