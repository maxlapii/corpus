# CORPUS

**An HR platform where the AI answers questions but never decides who may ask them.**

CORPUS gives a company two Telegram bots and a web dashboard over one HR system: employee
records, leave, recruitment, and a versioned policy library the assistant can search. What
separates it from an HR chatbot is that the language model has no authority. It can classify a
question, retrieve authorised material and phrase an answer — but every fact it sees has already
passed a server-side authorisation decision it cannot influence, and every decision is recorded.

It runs on Cloudflare's free tier end to end: one Hono Worker over D1, R2 and KV, inference on
Workers AI, and a Next.js dashboard on Pages. No API key, no server, no monthly bill.

## Why "Corpus"

*Corpus* is Latin for **body**, and the name holds the three things this system is at once:

| Sense | In CORPUS |
| --- | --- |
| **A body of people** — the root of *corporate*, *corporation*, *corps* | The workforce: employees, departments, managers, candidates |
| **A body of texts** — a corpus is an indexed document collection | The knowledge base: policies chunked, versioned and retrieved with citations |
| **A body of law** — *corpus juris*; *habeas corpus* | The authorisation model: 45 permissions, 71 policy rules, and an append-only audit trail |

The third sense is the pointed one. *Habeas corpus* is the writ that forbids holding someone
without an authority willing to justify it before a court. CORPUS applies the same rule to data:
nothing is released without a decision that can be justified afterwards, and the justification is
written down.

---

## Core security invariant

> The AI may understand the question, but the backend decides what the user is allowed to know or do.

How it is enforced (details and file-by-file evidence in [docs/security.md](docs/security.md)):

- **Identity comes from the database only.** `Identity` objects are constructed in exactly one
  place, `packages/auth/src/identity-resolver.ts` — never from a request body, a Telegram display
  name, or model output.
- **One authorisation service.** `PolicyGateway.authorize()` / `.require()` in
  `packages/security/src/policy-gateway.ts` decides every protected operation, combining tenant,
  role, permission, resource ownership, classification, business rules and risk.
- **The AI can only call registered tools.** `ToolRegistry.execute()` in
  `packages/ai/src/tool-registry.ts` runs the gateway before any handler. There is no
  `execute_sql()`, no generic query tool, and the model holds no database credentials.
- **The model's own claims about scope and permission are discarded.** `canonicaliseIntent()` in
  `packages/domain/src/intents.ts` re-reads scope, target and risk from the server-side intent
  table; the classifier is only asked for an intent name (`packages/ai/src/prompts.ts`).
- **Unauthorised knowledge never reaches a prompt.** Classification filtering happens inside the
  retrieval SQL (`KnowledgeRepository.searchChunks()` in
  `packages/db/src/repositories/knowledge.ts`), driven by the classification set on the gateway's
  ALLOW decision — not by asking the model to withhold anything.
- **Prompts are defence in depth only.** Security tests assert on which tools ran and what data
  appeared, never on model wording (`tests/security/prompt-attacks.test.ts`).
- **Everything sensitive is audited.** Decisions and denials are written to `audit_logs` and
  `security_events` (`packages/security/src/security-events.ts`).

---

## Architecture

```text
                    ┌─────────────────────┐
                    │ Telegram External   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │                     │
                    │ Cloudflare Worker   │
                    │ Hono API            │
                    │                     │
                    └──────┬───────┬──────┘
                           │       │
             ┌─────────────┘       └──────────────┐
             │                                    │
      ┌──────▼──────┐                      ┌──────▼──────┐
      │ D1 Database │                      │ R2 Storage  │
      │ SQLite      │                      │ Documents   │
      └─────────────┘                      └─────────────┘
             │
      ┌──────▼────────────────────┐
      │ Security / RBAC / AI      │
      │ Orchestrator / RAG        │
      └────────────┬──────────────┘
                   │
            ┌──────▼───────┐
            │ LLM Provider │
            └──────────────┘


      ┌──────────────────────────┐
      │ Next.js Admin Dashboard  │
      │ Cloudflare Pages         │
      └────────────┬─────────────┘
                   │
                   ▼
             Cloudflare Worker
```

| Layer | Technology | Notes |
| --- | --- | --- |
| API | Cloudflare Worker + Hono 4 | `apps/api`, entrypoint `apps/api/src/index.ts`, app assembly in `apps/api/src/app.ts` |
| Structured data | D1 (SQLite) | binding `DB`; better-sqlite3 stands in locally and in tests |
| Documents | R2 | binding `DOCUMENTS`; `MemoryStorageService` locally |
| Rate limits / replay guard | KV | binding `RATE_LIMIT`; falls back to a D1 or in-memory limiter |
| Search | D1/SQLite text search | `packages/knowledge/src/search-service.ts`; no vector database |
| LLM | provider abstraction | `packages/ai/src/providers` — `mock`, `anthropic`, `openai`, `compatible` |
| Dashboard | Next.js 14 App Router | `apps/web`, deployable to Cloudflare Pages |

The Worker is stateless per request: the dependency container in `apps/api/src/container.ts` is
rebuilt from the bindings on every request, and adapter selection (D1 vs. SQLite, R2 vs. memory,
KV vs. D1 rate limiting) happens there and nowhere else. See
[docs/architecture.md](docs/architecture.md) §7 for the full adapter table.

---

## Repository layout

```text
corpus/
├── apps/
│   ├── api/                    Cloudflare Worker (Hono)
│   │   ├── src/
│   │   │   ├── app.ts          route mounting, middleware chain
│   │   │   ├── container.ts    per-request dependency container
│   │   │   ├── env.ts          Worker bindings and environment
│   │   │   ├── middleware/     auth, body limits, errors, request context, security headers
│   │   │   └── routes/         auth, employees, leave, recruitment, knowledge,
│   │   │                       knowledge-answers, candidate-documents, reports,
│   │   │                       security, assistant, telegram, health
│   │   └── wrangler.toml       D1 / R2 / KV bindings, vars, production env
│   │
│   └── web/                    Next.js 14 admin dashboard
│       ├── app/                login, dashboard, people, recruitment, leave,
│       │                       knowledge, knowledge/training, recruitment/cvs,
│       │                       reports, security, settings, assistant
│       ├── components/         shell, session, UI primitives
│       └── lib/                API client (`NEXT_PUBLIC_API_BASE_URL`)
│
├── packages/
│   ├── shared/                 config, logging, errors, ids, dates, validation, pagination
│   ├── domain/                 entities, roles, permissions, classification, intents,
│   │                           leave calculation, application/leave state machines
│   ├── db/                     DatabaseService, D1 + SQLite adapters, migrations runner,
│   │                           tenant scope, storage services, repositories/
│   ├── auth/                   passwords, sessions, login, identity resolver,
│   │                           Telegram identity linking
│   ├── security/               PolicyGateway, policy rules, prompt-injection scanner,
│   │                           response filter, rate limiting, security events
│   ├── knowledge/              extraction, chunking, ingestion, KnowledgeSearchService
│   ├── ai/                     AIProvider abstraction, providers/, orchestrator,
│   │                           intent classifier, ToolRegistry, tools/
│   └── telegram/               webhook verification, client, external and internal bots
│
├── migrations/                 0001_core_identity … 0006_rbac_reference
├── tests/                      unit/, integration/, security/, e2e/, helpers/
├── scripts/                    migrate, seed, reset, telegram-setup, secret scan,
│                               API contract check, RBAC migration generator
├── docs/                       architecture, security, rbac, database, ai, rag,
│                               telegram, deployment, testing, roadmap
├── .github/workflows/          CI: secret scan → contract → lint → typecheck → tests → build
├── .env.example
└── CLAUDE.md                   the governing specification
```

---

## Quick start

**Prerequisites:** Node.js 20 or newer (`engines.node` is `>=20`) and npm. No Cloudflare account,
no LLM API key and no paid service is required to run the project locally.

```bash
npm install
cp .env.example .env            # scripts and tests
npm run db:migrate              # applies all 6 migrations to ./data/corpus.sqlite
npm run db:seed                 # fictional development data
```

Run the API and the dashboard in two terminals:

```bash
npm run dev                     # Worker via wrangler dev  → http://127.0.0.1:8787
npm run dev:web                 # Next.js dashboard        → http://localhost:3000
```

`wrangler dev` reads its secrets from `apps/api/.dev.vars` (gitignored) rather than `.env`, and it
uses **its own** locally simulated D1 database, not `data/corpus.sqlite`. Two extra steps are
therefore needed before the dashboard can log in:

```bash
# 1. Give the Worker a session secret.
cp .env.example apps/api/.dev.vars      # then set SESSION_SECRET to 32+ random characters
                                        #   openssl rand -base64 48

# 2. Migrate, then seed, the simulated D1 database.
npm run db:migrate:local
npm run db:seed:wrangler
```

`GET http://127.0.0.1:8787/health` reports `"status":"ok"` once migrations are applied, and lists
configuration warnings (missing bot tokens, missing session secret) without revealing any values.
Without a session secret the Worker cannot derive its HMAC key and returns HTTP 500 on most routes,
including `/public/jobs`, so do not skip step 1.

`wrangler dev --local` keeps its own D1 store under `apps/api/.wrangler/state`, which is why the
seed has a second entry point: `npm run db:seed:wrangler` loads the same fixtures there.
`npm run db:migrate` / `npm run db:seed` target `data/corpus.sqlite` instead, which is what the
scripts and the integration tests use. `npm run db:reset` deletes that file; both
seed and reset refuse to run with `ENVIRONMENT=production`.

### Seeded accounts

**Fictional development data — not real people.** Every address uses the reserved `corpus.test`
domain, so no seed e-mail can reach a real inbox. The seed script prints the same list and refuses
to run against a production environment (`scripts/seed.ts`, `scripts/seed-data.ts`).

| E-mail | Role | Notes |
| --- | --- | --- |
| `lapii.admin@corpus.test` | `SYSTEM_ADMIN` | Operations / platform administrator |
| `lapii.director@corpus.test` | `HR_ADMIN` | HR Director |
| `lapii.partner@corpus.test` | `HR` | HR Business Partner |
| `lapii.lead@corpus.test` | `MANAGER` | Engineering Manager, manages the two engineers below |
| `lapii.dev@corpus.test` | `EMPLOYEE` | Software Engineer, reports to `lapii.lead` |
| `lapii.coder@corpus.test` | `EMPLOYEE` | Senior Software Engineer, reports to `lapii.lead` |
| `lapii.sales@corpus.test` | `EMPLOYEE` | Account Executive outside the manager's team, used to prove manager scoping |

All seven share one password, read from `SEED_PASSWORD`. Set it in your `.env` before seeding;
`.env.example` carries the development placeholder, and `npm run db:seed` prints the value it
actually used. No password is documented here, so this file stays safe to publish.

The seed also creates five departments, eight positions, four leave types with balances, six
recurring public holidays, three jobs (two published, one draft), three fictional candidates with
applications, and four HR policy documents spanning the `INTERNAL`, `CONFIDENTIAL` and `RESTRICTED`
classifications. Policy documents are indexed through the real ingestion pipeline, so local search
behaves exactly as it does in production.

---

## Configuration

`.env.example` is the complete list. Copy it to `.env` for the Node scripts and tests, and to
`apps/api/.dev.vars` for `wrangler dev`. In production every value marked **secret** is set with
`wrangler secret put NAME` and never appears in `wrangler.toml`. Non-secret values live in
`[vars]` in `apps/api/wrangler.toml`. Defaults are applied in `packages/shared/src/config.ts`.

### Runtime

| Variable | Secret | Default | Purpose |
| --- | --- | --- | --- |
| `ENVIRONMENT` | no | `development` | One of `development`, `staging`, `test`, `production`. Also guards the seed/reset scripts. |
| `LOG_LEVEL` | no | `debug` (dev) / `info` (prod) | Structured log verbosity. |
| `PUBLIC_APP_URL` | no | `http://localhost:3000` | Public dashboard URL. |
| `CORS_ORIGINS` | no | value of `PUBLIC_APP_URL` | Comma-separated allowed origins. `TODO_`-prefixed entries are ignored. |
| `DEFAULT_TENANT_SLUG` | no | `default` | Tenant resolved for single-tenant deployments. |

### Session

| Variable | Secret | Default | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | **yes** | — | HMAC key for dashboard sessions. Must be at least 32 random characters (`openssl rand -base64 48`). Missing in production is a `/health` error; the Worker cannot sign sessions without it. |

### Telegram

| Variable | Secret | Purpose |
| --- | --- | --- |
| `TELEGRAM_EXTERNAL_BOT_TOKEN` | **yes** | Public recruitment bot. Empty disables the bot; the Worker still starts. |
| `TELEGRAM_INTERNAL_BOT_TOKEN` | **yes** | Internal employee bot. |
| `TELEGRAM_EXTERNAL_WEBHOOK_SECRET` | **yes** | Value Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`; verified on every update. Generate with `openssl rand -hex 32`; the setup script requires at least 16 characters. |
| `TELEGRAM_INTERNAL_WEBHOOK_SECRET` | **yes** | As above, for the internal bot. Use a different value. |

### AI provider

| Variable | Secret | Default | Purpose |
| --- | --- | --- | --- |
| `AI_PROVIDER` | no | `mock` (dev), `workers-ai` (prod) | `mock`, `workers-ai`, `google`, `anthropic`, `openai` or `compatible`. An unrecognised value falls back to `mock`. |
| `AI_API_KEY` | **yes** | — | Provider key. Never exposed to the dashboard or to Telegram clients. |
| `AI_MODEL` | no | provider default | Model identifier. |
| `AI_BASE_URL` | no | — | Endpoint for `compatible` (OpenAI-shaped) providers. |
| `AI_MAX_OUTPUT_TOKENS` | no | `600` | Output cap per response. |
| `AI_MAX_CONTEXT_CHUNKS` | no | `5` | Maximum retrieved knowledge passages per request. |
| `AI_REQUESTS_PER_HOUR` | no | `60` | Per-subject AI rate limit. |

### Limits and rate limits

Not in `.env.example`, but read from the environment by `packages/shared/src/config.ts` if you set
them: `MAX_UPLOAD_BYTES` (8 MiB), `MAX_REQUEST_BODY_BYTES` (512 KiB), `MAX_PAGE_SIZE` (100),
`DEFAULT_PAGE_SIZE` (25), `RATE_LIMIT_TELEGRAM_PER_MINUTE` (30), `RATE_LIMIT_LOGIN_PER_15M` (10),
`RATE_LIMIT_VERIFY_PER_15M` (5), `RATE_LIMIT_APPLICATIONS_PER_HOUR` (5),
`RATE_LIMIT_ADMIN_API_PER_MINUTE` (600), `RATE_LIMIT_PUBLIC_API_PER_MINUTE` (120).

### Local development

| Variable | Secret | Default | Purpose |
| --- | --- | --- | --- |
| `LOCAL_DB_PATH` | no | `./data/corpus.sqlite` | SQLite file used by the scripts and integration tests. |
| `SEED_PASSWORD` | no | see `.env.example` | Password assigned to all seeded accounts. Development data only. |
| `SEED_ADMIN_EMAIL` | no | `lapii.admin@corpus.test` | Present in `.env.example` but **not currently read** by `scripts/seed-data.ts`, which derives addresses from the `lapii.<surname>` pattern. |

### Dashboard

`apps/web/lib/api.ts` reads `NEXT_PUBLIC_API_BASE_URL`, defaulting to `http://127.0.0.1:8787`.
This is the only frontend configuration value, and it is deliberately not a secret — the dashboard
holds no credentials and calls the Worker for everything.

---

### Command reference

| Command | What it does |
| --- | --- |
| `npm run dev` | Worker API on :8787 (must be running for the dashboard to work) |
| `npm run dev:web` | Admin dashboard on :3000 |
| `npm run db:migrate` / `npm run db:seed` | Migrate/seed `data/corpus.sqlite` (scripts and tests) |
| `npm run db:migrate:local` / `npm run db:seed:wrangler` | Migrate/seed the separate `wrangler dev` D1 store |
| `npm run telegram:setup` | Register both Telegram webhooks (auto-detects a running cloudflared tunnel) |
| `npm run telegram:status` | Report Telegram's view of both webhooks; changes nothing |
| `npm run test` | Full suite |
| `npm run lint` / `npm run lint:fix` | Lint, and auto-fix what is mechanically fixable |
| `npm run ci` | Everything CI runs: secret scan, lint, both typechecks, tests |
| `npm run secrets:check` | Scan committable files for credentials; add `-- --all` to include gitignored files |
| `npm run hooks:install` | Enable the opt-in pre-commit hook that blocks secrets before they enter history |

Every command runs from the repository root. `wrangler` is a project dependency, not a global
install, so invoke it through an npm script or `npx` — a bare `wrangler` will be "command not found".

## Telegram setup

Two separate bots, with separate tokens and separate permission surfaces. They must never share a
token (`docs/telegram.md`).

| Bot | Webhook path | Zone | Commands |
| --- | --- | --- | --- |
| External (candidates) | `POST /telegram/external` | `EXTERNAL` (anonymous) | `/start`, `/help`, `/jobs`, `/apply`, `/status <reference>` |
| Internal (employees) | `POST /telegram/internal` | `INTERNAL` (verified employee) | `/verify <company e-mail>`, `/code`, `/start`, `/help`, `/balance`, `/leave`, `/request`, `/holidays`, `/policy <question>`, `/approvals` |

1. Create both bots with `@BotFather` and record the two tokens.
2. Generate one webhook secret per bot: `openssl rand -hex 32`.
3. Store all four values as Worker secrets (`wrangler secret put TELEGRAM_EXTERNAL_BOT_TOKEN`, and
   so on).
4. Deploy the Worker, then register the webhooks:

   ```bash
   TELEGRAM_EXTERNAL_BOT_TOKEN=... TELEGRAM_EXTERNAL_WEBHOOK_SECRET=... \
   TELEGRAM_INTERNAL_BOT_TOKEN=... TELEGRAM_INTERNAL_WEBHOOK_SECRET=... \
   API_BASE_URL=https://corpus-api.<account>.workers.dev \
   npx tsx scripts/telegram-setup.ts
   ```

   The script requires an `https` base URL, skips a bot with no token, and never prints a token
   (`scripts/telegram-setup.ts`).

Internal access requires verified identity. A Telegram user sends `/verify <company e-mail>`; the
backend issues a six-digit code, stores only its hash, and replies with the same message whether or
not the address matched an employee, so the bot cannot be used to enumerate staff. The user returns
`/code <digits>` within ten minutes and the Telegram account is linked to the employee record; roles
are then loaded from the database. The code is never sent back over Telegram
(`packages/auth/src/telegram-identity.ts`, `packages/telegram/src/internal-bot.ts`).

---

## AI provider setup

**You do not need to pay for AI, or open an account with an LLM vendor.** The production default is
Cloudflare Workers AI, which runs on the `[ai]` binding already declared in
`apps/api/wrangler.toml` — no API key, no second account, inside the same free tier as the Worker,
D1 and R2.

| `AI_PROVIDER` | Cost | What you need |
| --- | --- | --- |
| `mock` | free | Nothing. Deterministic and offline — the default for local development and the whole test suite. Rejected in production. |
| **`workers-ai`** *(production default)* | **free** | Nothing beyond your Cloudflare account. |
| `google` | free tier | An API key from [Google AI Studio](https://aistudio.google.com) — no billing account required. |
| `anthropic` / `openai` | paid | A vendor account with billing. |
| `compatible` | varies | Any OpenAI-shaped endpoint plus `AI_BASE_URL`. |

```bash
# Workers AI — the zero-cost default. No AI_API_KEY at all.
AI_PROVIDER=workers-ai
AI_MODEL=@cf/meta/llama-3.1-8b-instruct     # any Workers AI text model

# Google Gemini — free tier, key but no billing account
AI_PROVIDER=google
AI_API_KEY=<key>            # wrangler secret put AI_API_KEY
AI_MODEL=gemini-2.0-flash

# Anthropic / OpenAI — paid
AI_PROVIDER=anthropic
AI_API_KEY=<key>
AI_MODEL=claude-haiku-4-5-20251001

# Any OpenAI-compatible endpoint
AI_PROVIDER=compatible
AI_API_KEY=<key>
AI_BASE_URL=https://<host>/v1
AI_MODEL=<model id>
```

Provider selection happens in one factory (`packages/ai/src/providers/index.ts`); nothing else in
the codebase knows which provider is in use, so switching is an environment change.

On the free providers the limit is a **daily allowance**, not a bill. Exhausting it is an expected
operating state: the assistant replies "temporarily unavailable" rather than erroring, and any tool
results already authorised in that turn are still returned. The orchestrator's caps on output
tokens, retrieved chunks, conversation history and requests per hour
(`AI_REQUESTS_PER_HOUR`) exist to keep one user from spending the whole day's quota — see
[docs/ai.md](docs/ai.md).

---

## Cloudflare setup

Summary only — [docs/deployment.md](docs/deployment.md) is the authoritative runbook.

```bash
wrangler d1 create corpus                      # paste database_id into apps/api/wrangler.toml
wrangler r2 bucket create corpus-documents
wrangler kv namespace create CORPUS_RATE_LIMIT # paste id into apps/api/wrangler.toml
npm run db:migrate:remote                       # apply migrations to the real D1
wrangler secret put SESSION_SECRET              # repeat for AI_API_KEY and the four Telegram values
npm run deploy:api
```

`apps/api/wrangler.toml` ships with `TODO_D1_DATABASE_ID`, `TODO_KV_NAMESPACE_ID` and
`TODO_PUBLIC_APP_URL` placeholders — no account IDs, tokens or secrets are committed. The dashboard
builds for Pages with `npm run pages:build --workspace @corpus/web` and deploys with
`npm run pages:deploy --workspace @corpus/web`.

---

## Testing

```bash
npm test                   # all 706 tests (vitest run)
npm run test:unit          # tests/unit        — 282 tests
npm run test:integration   # tests/integration —  76 tests
npm run test:security      # tests/security    — 327 tests
npm run test:e2e           # tests/e2e         —  21 tests
npm run test:watch         # vitest in watch mode

npm run lint               # eslint, zero warnings tolerated
npm run typecheck          # API and packages
npm run typecheck:web      # dashboard
npm run secrets:check      # repository secret scan
npm run check:contract     # every dashboard API call matches a mounted Worker route
npm run ci                 # the full CI sequence, locally
```

The suites run against the real Hono app, the real migrations and the real seed fixtures, with
SQLite in memory standing in for D1 (`tests/helpers/harness.ts`), so authorisation is exercised
end to end rather than mocked.

`tests/security/acceptance.test.ts` contains the eight CLAUDE.md §44 security acceptance tests
(cross-user salary access, role claims, "ignore all security rules", an external candidate asking
for the internal handbook, a legitimate own-balance query, employee-ID manipulation, a malicious CV,
and cross-tenant access). `tests/security/authorization-matrix.test.ts` adds 117 checks (23
sensitive endpoints × 5 roles, plus two invariant tests) and
`tests/security/prompt-attacks.test.ts` 32 cases built around 17 injection payloads.

**Current result on this checkout:** 421 of 421 pass (18 files). `npm run ci` is *not* currently
green end to end: its first step, `npm run secrets:check`, exits 1 with three findings in
`tests/helpers/harness.ts` where test-only constants are assigned to `SESSION_SECRET` and the two
`TELEGRAM_*_WEBHOOK_SECRET` bindings. No secret is exposed; the fix is an `ALLOWLIST` entry in
`scripts/check-secrets.ts` (see [docs/testing.md](docs/testing.md) → Limitations). The leave end-to-end tests are no
longer clock-sensitive: `tests/e2e/flows.test.ts` scans forward from the current date, bounded at
52 weeks, for the first Monday–Friday window that contains no seeded public holiday, so the
working-day assertions hold on every calendar date.

CI (`.github/workflows/`) runs secret scan → contract check → lint → typecheck (API and dashboard)
→ unit → integration → security → e2e → build. Deployment is a separate job gated on that passing
*and* on Cloudflare credentials being present, so a fork or a secret-less run can never deploy.

---

## Security

[docs/security.md](docs/security.md) is the security reference: threat model, security zones
(`EXTERNAL` / `INTERNAL`), the four data classifications (`PUBLIC`, `INTERNAL`, `CONFIDENTIAL`,
`RESTRICTED`), identity handling, the PolicyGateway decision pipeline, the AI tool system, RAG
permission filtering, prompt-injection detection, the response filter, rate limiting, audit logs and
security events, transport hardening and secret handling. The CLAUDE.md §62 final security review
checklist lives there, in the "Final security review checklist" section, with the evidence for each
item.

[docs/rbac.md](docs/rbac.md) holds the five roles (`EMPLOYEE`, `MANAGER`, `HR`, `HR_ADMIN`,
`SYSTEM_ADMIN`), the permission list, the role × permission matrix, classification ceilings,
ownership semantics and the policy rule table. The database reference for RBAC is generated into
`migrations/0006_rbac_reference.sql` by `scripts/generate-rbac-migration.ts`, and CI fails if it
drifts from the code.

Never commit real secrets. `npm run secrets:check` scans the repository and runs first in CI.

---

## Migration strategy

The MVP deliberately stays inside Cloudflare's free tier, but nothing in the business logic depends
on it. Storage sits behind `StorageService` (`packages/db/src/storage.ts`), SQL behind
`DatabaseService` and the repositories (`packages/db/src/repositories/`), search behind
`KnowledgeSearchService`, and the LLM behind `AIProvider`. Swapping an implementation is a change in
`apps/api/src/container.ts`, not a rewrite.

```text
today                          later
─────                          ─────
Cloudflare Worker      →       container / FastAPI-style host
D1 (SQLite)            →       PostgreSQL
R2                     →       S3
D1 text search         →       pgvector, or hybrid text + vector
KV rate limiting       →       Redis, only if actually required
```

The migration path and its sequencing are described in [docs/roadmap.md](docs/roadmap.md).

---

## Documentation

| Document | Contents |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | The governing specification. Every other document cites its sections. |
| [docs/architecture.md](docs/architecture.md) | Hosted topology, monorepo layout, the per-request container, HTTP and AI request lifecycles, stateless-Worker constraints, local vs. production adapters, free-tier budgets. |
| [docs/security.md](docs/security.md) | Threat model, zones, classification, identity, PolicyGateway, tool system, RAG filtering, injection handling, audit, and the §62 review checklist. |
| [docs/rbac.md](docs/rbac.md) | Roles, permissions, the role × permission matrix, classification ceilings, ownership, policy rules, and how to add a permission safely. |
| [docs/database.md](docs/database.md) | Schema by domain, tenancy columns, indexes, foreign keys, and the migration files. |
| [docs/ai.md](docs/ai.md) | Provider abstraction, orchestrator, intent classification, the tool registry and tool catalogue, cost controls. |
| [docs/rag.md](docs/rag.md) | Document ingestion, extraction, chunking, versioning and effective dates, search, and permission filtering before retrieval. |
| [docs/telegram.md](docs/telegram.md) | The two bots, webhook verification, identity linking, command surfaces, rate limiting. |
| [docs/deployment.md](docs/deployment.md) | Cloudflare account setup, D1/R2/KV creation, migrations, secrets, Worker and Pages deployment, webhook registration, smoke tests. |
| [docs/testing.md](docs/testing.md) | Test layout, the harness, what each suite covers, and how to run and extend them. |
| [docs/roadmap.md](docs/roadmap.md) | What is deferred, in what order, and the migration path off the free tier. |

---

## Status

### Implemented

- Cloudflare Worker API on Hono with a per-request dependency container, structured logging,
  request IDs, security headers, body-size limits and structured error responses.
- Six SQL migrations covering identity, HR core, recruitment, knowledge, security/conversations and
  the generated RBAC reference; a migration runner shared by D1 and local SQLite.
- Repository layer over `DatabaseService` with tenant scoping applied at the query level.
- Authentication (password hashing, HTTP-only session cookie plus CSRF token), the five-role RBAC
  model, and the PolicyGateway with ownership, classification and risk rules.
- HR core: employees, departments, positions, manager relationships, leave types, balances,
  requests, approvals and holidays, with backend working-day calculation (weekends and holidays
  excluded, balances and overlaps validated server-side).
- Recruitment: jobs and requirements, candidates, applications, stage transitions and application
  events, interviews and offers (both permission-gated, `interview.manage` and `offer.manage`), and
  a public job surface that can withhold a salary range per posting.
- CVs: intake is Telegram-only via `/cv` — candidates send their own to the recruitment bot after
  applying, staff forward one to the employee bot with the candidate's e-mail as the caption.
  **PDF, DOC and DOCX** are accepted; DOCX text is read automatically, while PDF and legacy `.doc`
  are stored and downloadable with their text pasted in by hand (see docs/rag.md §14a). Everything
  is CONFIDENTIAL; the dashboard previews, filters and matches against a job's structured
  requirements — a deterministic, evidence-carrying, advisory report with no model involved.
- Knowledge base: documents, versions with effective dates, chunks with classifications, ingestion
  through extraction and chunking, and classification-filtered search.
- Bot answers page: curated question/answer pairs authored in the dashboard and served **verbatim** by
  either Telegram bot, with an audience axis (external / internal / both) on top of the usual
  classification filter, training phrasings, draft-and-publish, effective dates, a per-bot preview,
  a backlog of questions the bots could not answer, and Telegram commands: an answer can be bound to
  `/command` and the bot menus pushed from the dashboard. General staff answers can be marked as
  needing no verified account, so the internal bot is useful before a Telegram id is linked while
  anything personal or credential-bearing still requires verification.
- AI layer: provider abstraction with mock, Anthropic, OpenAI and OpenAI-compatible providers;
  intent classification with server-side canonicalisation; a tool registry where every tool is
  authorised before its handler runs; a response filter; and per-subject rate limits.
- Two Telegram bots with webhook secret verification, a replay guard, rate limiting, and
  e-mail-plus-one-time-code identity linking.
- Next.js dashboard: login, a home page with KPIs and the work the bots hand to HR (pending leave,
  unanswered questions, open HR tickets), people, leave, recruitment and CVs, policies, the
  Bot answers page (curated answers, unanswered questions, command menus, a reply preview),
  security and settings. Chat happens on Telegram; the dashboard has no chat page.
- Audit logs and security events, surfaced to authorised administrators.
- CI with secret scanning, an API contract check, lint, typecheck, four test suites and a build.

### Deferred

| Area | Current behaviour | Why |
| --- | --- | --- |
| **E-mail transport for verification codes** | No production mail provider is wired in. `selectCodeDelivery()` (`packages/telegram/src/internal-bot.ts`) prints the code to the console in development and **discards** it in production/staging, so the flow fails closed instead of logging a one-time code; `/health` reports `VERIFICATION_CODE_TRANSPORT`. Internal Telegram verification therefore cannot complete in production yet. | Every free-tier mail path needs an external account. The `VerificationCodeDelivery` interface is the single place to add one. |
| **PDF and DOCX text extraction** | `extractText()` (`packages/knowledge/src/extraction.ts`) handles `text/plain`, `text/markdown`, `text/csv`, `text/html` and `application/json`. PDF and DOCX uploads raise `UnsupportedDocumentError` (HTTP 415) rather than being indexed as binary garbage — the DOCX media type is listed in `SUPPORTED_CONTENT_TYPES`, but the extraction `switch` still refuses it. | A binary PDF parser is too heavy for a Worker bundle, and no DOCX unzip/XML step is implemented. Upload the plain-text or Markdown export instead. |
| **Vector / hybrid search** | D1/SQLite text search behind `KnowledgeSearchService`, with a minimum-term-match relevance floor. | CLAUDE.md §25 defers a vector database. The service interface already anticipates vector and hybrid backends. |
| **Multi-tenancy at runtime** | Every table and query carries `tenant_id` and isolation is tested, but a deployment resolves a single tenant from `DEFAULT_TENANT_SLUG`. | Tenant onboarding and per-tenant routing are future work. |
| **Deployment** | Configuration, scripts and runbook exist. No deployment to Cloudflare has been executed from this repository. | Requires a Cloudflare account, which this project does not assume. |
