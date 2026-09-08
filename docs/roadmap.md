# CORPUS — Roadmap and Migration Strategy

This document records three things: the stack CORPUS runs on today, what the
code deliberately does **not** do yet, and how each deferred item would be built
without redesigning the system. It is written against the code in this
repository — every limitation names the file that causes it, and nothing is
listed as "done" that is not implemented.

Companion documents: [`docs/architecture.md`](architecture.md) (topology and
request lifecycles), [`docs/security.md`](security.md) (threat model),
[`docs/rbac.md`](rbac.md) (roles and permissions). The governing specification
is [`CLAUDE.md`](../CLAUDE.md); this file discharges §51 (migration strategy)
and §52 (free-tier awareness).

The invariant below constrains every future item on this page. No roadmap entry
may weaken it:

> The AI may understand the question, but the backend decides what the user is
> allowed to know or do.

---

## 1. Current stack

```text
   Telegram (2 bots)                     Browser (HR / admin)
          │                                        │
          │ webhook POST                           │ HTTPS
          ▼                                        ▼
  ┌───────────────────────────┐          ┌──────────────────────┐
  │ Cloudflare Worker         │◄─────────┤ Next.js 14 dashboard │
  │ Hono router (apps/api)    │   REST   │ Cloudflare Pages     │
  └───┬───────────────┬───────┘          └──────────────────────┘
      │               │
      │        ┌──────┴────────┬───────────────┐
      ▼        ▼               ▼               ▼
  ┌───────┐ ┌──────┐   ┌──────────────┐ ┌──────────────┐
  │ D1    │ │ R2   │   │ KV           │ │ LLM provider │
  │ SQLite│ │ docs │   │ rate limit / │ │ (HTTP API)   │
  │ + FTS5│ │      │   │ replay guard │ │              │
  └───────┘ └──────┘   └──────────────┘ └──────────────┘
```

| Layer | Technology | Where it lives |
| --- | --- | --- |
| API runtime | Cloudflare Workers + Hono | `apps/api/src/index.ts` |
| Composition | Per-request container, no module-scope state | `apps/api/src/container.ts` |
| Database | Cloudflare D1 (SQLite) behind `SqlDatabase` | `packages/db/src/sql.ts`, `packages/db/src/database-service.ts` |
| Migrations | 6 numbered SQL files | `migrations/0001_*.sql` … `0006_*.sql` |
| Documents | R2 behind `StorageService` | `packages/db/src/storage.ts` |
| Retrieval | D1 FTS5 (bm25) with LIKE fallback | `packages/knowledge/src/search-service.ts` |
| Authorization | `PolicyGateway`, single decision point | `packages/security/src/policy-gateway.ts` |
| AI | `AIProvider` — Workers AI (free, binding), Google Gemini (free tier), Anthropic, OpenAI/compatible, mock | `packages/ai/src/providers/*.ts` |
| Bots | External (public) and internal (verified) | `packages/telegram/src/external-bot.ts`, `internal-bot.ts` |
| Dashboard | Next.js 14 App Router, 8 sections + login | `apps/web/app/` |
| Tests | 421 tests: unit, integration, security, e2e | `tests/` |
| CI | install → secret scan → contract check → lint → typecheck → unit/integration/security/e2e → build; a separate gated deploy job | `.github/workflows/ci.yml` |

Local development uses the same code paths with different adapters: a
`better-sqlite3` adapter for `SqlDatabase` (`packages/db/src/sqlite-adapter.ts`)
and the mock AI provider, so the whole suite runs offline with no API key.

---

## 2. Known limitations

Each row states what the code actually does today, not what is missing in the
abstract. "Blocker" means the feature cannot be used in production as shipped.

| # | Limitation | File | Impact |
| --- | --- | --- | --- |
| 1 | PDF and DOCX uploads are rejected, not parsed | `packages/knowledge/src/extraction.ts` | Operators must upload a text/Markdown export. Blocker for PDF-only policy libraries. |
| 2 | Verification codes are written to the server log, not e-mailed | `packages/telegram/src/internal-bot.ts` | **Production blocker for the internal bot.** No employee can self-link. |
| 3 | KV rate-limit counters are eventually consistent | `packages/security/src/rate-limit.ts` | A distributed caller can exceed a window at a cold edge. Abuse control only; not an authorization control. |
| 4 | In-memory fallbacks when R2 / KV are unbound | `apps/api/src/container.ts` | Uploads and replay state are per-isolate and lost on eviction. Reported by `/health`. |
| 5 | Mock provider is keyword-matched, not a language model | `packages/ai/src/providers/mock.ts` | Fine for deterministic tests; unusable for real conversation. |
| 6 | One tenant resolved from `DEFAULT_TENANT_SLUG` | `apps/api/src/middleware/auth.ts`, `routes/auth.ts`, `routes/telegram.ts` | The schema is multi-tenant and isolation is tested, but only one tenant is reachable at runtime. |
| 7 | No browser tests for the dashboard | `apps/web/tests/` (empty) | ~9,300 lines of React are covered by typecheck and build only. |
| 8 | No filesystem `LocalStorageService` | `packages/db/src/storage.ts` | Only `R2StorageService` and `MemoryStorageService` exist; CLAUDE.md §4 names a local-filesystem variant that was not built. |
| 9 | ~~Retention pruning is a Node script, not a Cron trigger~~ **Resolved** | `apps/api/src/scheduled.ts`, `apps/api/wrangler.toml` | A `scheduled()` handler applies every `retention_policies` row and runs on a daily Cron trigger (`15 3 * * *`). `scripts/prune.ts` remains for local use. Proof: `tests/integration/retention.test.ts`. |
| 10 | No vector or hybrid retrieval | `packages/knowledge/src/search-service.ts` | Lexical matching only; paraphrased policy questions may miss. |
| 11 | `wrangler.toml` ships `TODO_*` placeholders | `apps/api/wrangler.toml` | `database_id`, KV `id`, `PUBLIC_APP_URL`, `CORS_ORIGINS` must be filled before deploy. |
| 12 | Password login only; no SSO | `packages/auth/src/login.ts` | No SAML/OIDC, no MFA on the dashboard. |

### 2.1 Document extraction (rows 1, 8)

`extractText()` accepts `text/plain`, `text/markdown`, `text/csv`, `text/html`
and `application/json`, falling back to the filename extension when the client
sends a generic content type. Anything else — including
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`, which
is listed in `SUPPORTED_CONTENT_TYPES` but explicitly rejected in the switch —
throws `UnsupportedDocumentError`. The upload route converts that into an HTTP
`UNSUPPORTED_MEDIA_TYPE` response (`apps/api/src/routes/knowledge.ts:307`), so
the failure is explicit rather than a silently mis-indexed document.

The reason is stated in the file header: binary PDF parsing needs a parser too
heavy for a Worker, and half-parsed text would produce plausible-looking but
wrong policy citations. HTML extraction already drops `<script>` and `<style>`
bodies, which is where injected instructions are usually hidden — any future
extractor must keep that property, and must keep returning plain text that the
RAG pipeline wraps in untrusted-data framing (CLAUDE.md §26).

### 2.2 Verification code delivery (row 2) — production blocker

The internal bot's `/verify` flow is complete except for the last step. The
`VerificationCodeDelivery` interface is defined in
`packages/telegram/src/internal-bot.ts`, and the only implementation is
`LogOnlyCodeDelivery` in development only, which prints the code with `console.warn` and records a
`dev_sink` result on the structured logger. It is wired unconditionally in
`apps/api/src/routes/telegram.ts:94`.

Two design decisions must survive any replacement:

- The code is never sent back over Telegram. Doing so would let anyone who
  knows an employee's address link their own Telegram account.
- `/verify` returns the same reply whether or not the address matched an active
  employee, so the bot cannot be used to enumerate staff e-mail addresses.

Until a real transport exists, the internal bot is usable only where an
operator can read Worker logs. Do not deploy it to staff in that state.

### 2.3 Rate limiting and replay under KV (rows 3, 4)

`KvRateLimiter.consume()` reads a fixed-window counter, increments it and writes
it back with a TTL. The read is eventually consistent, and the comment in
`packages/security/src/rate-limit.ts` says so plainly: a determined attacker can
squeeze a few extra requests through a cold edge. This is accepted because the
limiter protects against abuse and cost, not against unauthorized access —
`PolicyGateway` does that, and it reads from D1.

When no KV namespace is bound, `container.ts` selects `D1RateLimiter`, which
increments through an `INSERT … ON CONFLICT DO UPDATE` on
`rate_limit_counters` and is therefore strictly counted, at the cost of a write
per request. `MemoryRateLimiter` is used only when there is no D1 either (unit
tests). The replay guard has no D1 variant: without KV it falls back to
`MemoryReplayGuard`, so a Telegram retry landing on a different isolate may be
processed twice.

### 2.4 What `/health` reports (row 4)

`createContainer()` probes each binding by shape — `isR2()` looks for `put` and
`head`, `isKv()` for `get` and `put` without `head` — and substitutes a
process-lifetime fallback when the binding is absent. The degradation is
surfaced, not hidden. `GET /health` (`apps/api/src/routes/health.ts`) returns:

| Field | Meaning |
| --- | --- |
| `status` | `ok`, or `degraded` with HTTP 503 when the database is unreachable or a config problem is `error`-severity |
| `database` | `ok` / `error` from a count against `d1_migrations` |
| `migrationsApplied` | number of applied migration files |
| `documentStorage` | `r2` when the bucket is bound, `ephemeral` when the in-memory fallback is active |
| `config` | `describeConfig()` — booleans and names only, never a secret value |
| `configErrors` / `configWarnings` | configuration keys with a message; keys only |

`validateConfig()` (`packages/shared/src/config.ts`) is what raises those: a
short `SESSION_SECRET`, a webhook secret missing while a bot token is set, a
missing `AI_API_KEY` for a provider that needs one (`workers-ai` does not), empty `CORS_ORIGINS` in
production, and `AI_PROVIDER=mock` in production are all reported. Note that
the KV fallback is **not** currently reflected in a dedicated `/health` field —
only storage durability is. Adding a `rateLimiter` backend field is a small,
worthwhile change.

### 2.5 Mock provider quality (row 5)

`MockAIProvider` is a table of ~18 regular expressions mapping phrasings to an
intent and, usually, one tool name. It is deliberately deterministic and
offline so the security suite runs with no API key, and it only ever requests a
tool the orchestrator actually offered for that identity — which is the
property the `PolicyGateway` tests depend on. Its summarisation step copies
authorised tool output verbatim, so "the model did not fabricate a number"
remains a meaningful assertion.

It is not a language model. It does not paraphrase, handle multi-turn
disambiguation, or cope with wording outside its rules. `AI_PROVIDER=mock` is
flagged as a configuration problem in production by `validateConfig()`.

### 2.6 Tenant resolution (row 6)

Tenant isolation is real at the data layer: repositories take a `TenantScope`
rather than a bare string, a blank tenant throws rather than producing an
unscoped query, and `assertSameTenant()` re-checks rows fetched by primary key
(`packages/db/src/tenant.ts`). What is single-tenant is *resolution*: three call
sites — dashboard auth middleware, `POST /auth/login`, and both Telegram webhook
handlers — all call `repos.tenants.findBySlug(config.defaultTenantSlug)`.
Nothing derives a tenant from the request host, the bot token, or the session.

---

## 3. Free-tier budget (CLAUDE.md §52)

The limits below are enforced in code and configurable per deployment, so the
system degrades by refusing work rather than by running up a bill.

All values are read in `packages/shared/src/config.ts` and assembled into rules
by `createRateLimits()` in `apps/api/src/container.ts`.

| Control | Default | Environment variable |
| --- | --- | --- |
| Telegram messages per user | 30 / minute | `RATE_LIMIT_TELEGRAM_PER_MINUTE` |
| AI requests per user | 60 / hour | `AI_REQUESTS_PER_HOUR` |
| Login attempts per identifier | 10 / 15 min | `RATE_LIMIT_LOGIN_PER_15M` |
| Account lockout | 8 failures → 15 min | constants in `packages/auth/src/login.ts` |
| Verification requests | 5 / 15 min | `RATE_LIMIT_VERIFY_PER_15M` |
| Applications per subject | 5 / hour | `RATE_LIMIT_APPLICATIONS_PER_HOUR` |
| Admin API per user | 600 / minute | `RATE_LIMIT_ADMIN_API_PER_MINUTE` |
| Public API per IP | 120 / minute | `RATE_LIMIT_PUBLIC_API_PER_MINUTE` |
| Max upload | 8 MiB | `MAX_UPLOAD_BYTES` |
| Max request body | 512 KiB | `MAX_REQUEST_BODY_BYTES` |
| Max page size | 100 (default 25) | `MAX_PAGE_SIZE` / `DEFAULT_PAGE_SIZE` |
| Max AI output | 600 tokens | `AI_MAX_OUTPUT_TOKENS` |
| Max retrieved chunks | 5 | `AI_MAX_CONTEXT_CHUNKS` |
| Conversation history | 4 turns | hard-coded `maxHistoryTurns` in `container.ts` |

$0 hosting does not mean $0 AI cost. The provider is configurable, and every
AI turn is bounded by the per-user hourly limit, the output-token cap, the
retrieved-chunk cap and the history-truncation limit above.

---

## 4. Interface seams

Nothing on the roadmap requires a rewrite, because each future capability
attaches at an interface that already exists and already has more than one
implementation.

| Seam | Defined in | Implementations today | What it unlocks |
| --- | --- | --- | --- |
| `SqlDatabase` / `DatabaseService` | `packages/db/src/sql.ts`, `database-service.ts` | D1, better-sqlite3 | PostgreSQL |
| `StorageService` | `packages/db/src/storage.ts` | `R2StorageService`, `MemoryStorageService` | S3, local filesystem |
| `KnowledgeSearchService` | `packages/knowledge/src/search-service.ts` | `D1KnowledgeSearchService` (FTS5 + LIKE) | vector, hybrid, pgvector |
| `AIProvider` | `packages/ai/src/provider.ts`, `providers/index.ts` | Anthropic, OpenAI/compatible, mock | any provider, self-hosted gateway |
| `RateLimiter` | `packages/security/src/rate-limit.ts` | KV, D1, memory | Durable Objects, Redis |
| `ReplayGuard` | `packages/telegram/src/webhook.ts` | KV, memory | Durable Objects |
| `VerificationCodeDelivery` | `packages/telegram/src/internal-bot.ts` | `LogOnlyCodeDelivery` (development) / `NullCodeDelivery` (production, fail-closed) | transactional e-mail |

The security layer sits *above* all of these. `PolicyGateway`, `ToolRegistry`,
the repositories and the audit trail are unaffected by swapping any row, which
is the point: a backend change must never become an authorization change.

---

## 5. Phased future work

Phases are ordered by what unblocks production use, not by size. Each carries
its acceptance criteria in the CLAUDE.md §57 sense: code, migration, API,
authorization, validation, tests, security tests, audit, documentation.

### Phase A — Production blockers

| Item | Seam | Work |
| --- | --- | --- |
| Transactional e-mail for verification codes | `VerificationCodeDelivery` | Add e.g. `ResendCodeDelivery` / `SmtpCodeDelivery` and select it in `selectCodeDelivery()` (`packages/telegram/src/internal-bot.ts`). The fail-closed half is already done: production and staging get `NullCodeDelivery`, which discards the code rather than logging it, and `validateConfig()` raises `VERIFICATION_CODE_TRANSPORT` as an error so `/health` reports the gap. Until a transport exists, internal Telegram verification cannot complete in production. Never route the code through Telegram; keep the enumeration-safe reply. |
| Fill `wrangler.toml` placeholders | — | Provision D1 and KV, replace the four `TODO_*` values, verify `/health` returns `documentStorage: "r2"` and no `configErrors`. |
| Report the rate-limit backend in `/health` | `RateLimiter` | Add `rateLimiter: "kv" \| "d1" \| "memory"` alongside `documentStorage`, so a missing KV binding is visible in production. |
| ~~Retention as a Cron trigger~~ **Done** | — | `apps/api/src/scheduled.ts` applies every `retention_policies` row from the Worker's `scheduled()` export; `[triggers] crons = ["15 3 * * *"]` is declared for both the default and `production` environments. |

### Phase B — Content coverage

| Item | Seam | Work |
| --- | --- | --- |
| DOCX extraction | `extractText()` | DOCX is a ZIP of XML; unzip `word/document.xml` and take the `<w:t>` runs. Feasible in a Worker with a small inflate implementation. Add cases to the extraction tests, including a DOCX carrying injected instructions. |
| PDF extraction | `extractText()` | Too heavy for the Worker. Either extract client-side in the dashboard and upload the text alongside the original, or run extraction as a separate job outside the request path. Keep `UnsupportedDocumentError` as the rejection for anything not extractable. |
| Local filesystem storage | `StorageService` | Add `LocalStorageService` for `wrangler dev`, so uploads survive a restart without an R2 binding. Production code must remain unaware of it (CLAUDE.md §4). |

### Phase C — Retrieval quality

| Item | Seam | Work |
| --- | --- | --- |
| Embeddings + vector search | `KnowledgeSearchService` | Add a second implementation behind the same interface. The security contract is fixed by the interface and must not move: the caller supplies an ALLOW decision, `allowedClassifications` come from that decision, and filtering happens *inside* the retrieval query — never as a post-filter and never by asking the model to withhold anything (CLAUDE.md §24). |
| Hybrid ranking | same | Combine bm25 and vector scores. Keep the `minTermMatches` floor, which currently prevents a single common word from looking like an answer. |
| Reindex tooling | — | A vector backend needs an offline embedding pass over `document_chunks` and a reindex command in `scripts/`. |

### Phase D — Platform migration (CLAUDE.md §51)

Only if the free tier or D1 stops fitting. The target and the adapter that
carries it:

```text
today                                    later
─────────────────────────────────────    ────────────────────────────────────────
SqlDatabase   ← D1 / better-sqlite3      SqlDatabase   ← PostgreSQL driver
StorageService ← R2 / Memory             StorageService ← S3-compatible
KnowledgeSearch ← FTS5 + LIKE            KnowledgeSearch ← pgvector
RateLimiter   ← KV / D1 / Memory         RateLimiter   ← Redis (only if measured need)
AIProvider    ← Anthropic / OpenAI       unchanged
PolicyGateway, ToolRegistry, repos       unchanged
```

Practical notes for the PostgreSQL step:

- `SqlDatabase` is deliberately shaped like D1's own API
  (`prepare().bind().first()/all()/run()`), so a driver adapter is the whole
  job at the interface. The migration cost is in SQL dialect, not architecture.
- Migrations under `migrations/` are SQLite dialect. Expect to translate
  `INTEGER` timestamps, `AUTOINCREMENT`, FTS5 virtual tables and the
  `ON CONFLICT DO UPDATE` in `D1RateLimiter`.
- `UnitOfWork` currently batches writes (`database-service.ts`); PostgreSQL
  gives real transactions, so the batch semantics can be strengthened, not
  replaced.
- Do not migrate the security layer. If a PostgreSQL migration changes any
  `PolicyGateway` behaviour, something has been done wrong.

### Phase E — Multi-tenant SaaS

| Item | Work |
| --- | --- |
| Tenant resolution by hostname | Replace the three `findBySlug(defaultTenantSlug)` call sites with a resolver: request `Host` → `tenants` row, with `DEFAULT_TENANT_SLUG` as the single-tenant fallback. Cache per request only — the container is per-request by design. |
| Per-bot tenant mapping | Store the Telegram bot token identifier against a tenant, so one Worker can serve several companies' bots. Today the zone is chosen by the webhook path and the tenant by config. |
| Tenant onboarding | An admin flow that creates the tenant, seeds `leave_types`, holidays and RBAC reference rows (see `scripts/generate-rbac-migration.ts`), and issues the first `HR_ADMIN`. |
| Cross-tenant guardrails | Extend `tests/security/` with the new resolver in the loop; the existing tenant-isolation tests assert repository behaviour, not host routing. |

### Phase F — Access, notifications, reach

| Item | Seam | Work |
| --- | --- | --- |
| SSO / SAML / OIDC | `LoginService`, `SessionService` | Add an identity-provider adapter that ends in the same `SessionService.issue()` path. Roles must still be loaded from the database — an IdP assertion may identify a user but must not grant a CORPUS role. |
| MFA for dashboard admins | `LoginService` | TOTP as a second factor before session issue. |
| Notifications | new service | Leave-approval and application-stage events currently produce audit rows and nothing else. A `NotificationService` fed by the same events could push to the internal bot (a channel that already exists) before any e-mail work. |
| Dashboard browser tests | `apps/web/tests/` | Playwright against a seeded local API: login, a permission-denied view, and one write flow per section. The directory exists and is empty. |
| Mobile | — | The dashboard is responsive; a native app is not planned. The internal Telegram bot is the mobile surface. |

---

## 6. Non-goals

These are excluded by design, not deferred:

- **Any `execute_sql` / `query_database` tool.** CLAUDE.md §53. The AI reaches
  data only through narrowly scoped registered tools.
- **AI-side authorization.** No future provider, prompt or tool may decide
  access. Adding a model with better instruction-following does not change this.
- **Prompt-based confidentiality.** Classification filtering happens before
  retrieval, not in the system prompt (CLAUDE.md §55).
- **Kubernetes, Docker-only production, dedicated queues.** CLAUDE.md §3.
- **Redis, unless a measured need appears.** The `RateLimiter` seam exists so
  that decision can be made later on evidence.

---

## 7. Verification

`npm run ci` runs the gate CI runs: secret scan, API-contract check, lint,
typecheck (API and web), and the full Vitest suite. The suite is 421 tests
across `tests/unit`, `tests/integration`, `tests/security` and `tests/e2e`;
`npm run test:security` runs the security subset alone, which is the one that
must stay green before any item on this page ships.

All development data uses the reserved `corpus.test` domain
(`scripts/seed-data.ts`), and no roadmap item may introduce real personal data
into the repository.
