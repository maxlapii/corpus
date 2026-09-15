# CORPUS — Deployment Runbook

This document is a runbook: follow the numbered steps in order and you will
have a working production deployment. It describes what the code in this
repository actually does. Every non-obvious statement cites the file that
implements it; paths are relative to the repository root.

Companion documents: [`docs/architecture.md`](architecture.md) (topology and
request lifecycle), [`docs/security.md`](security.md) (threat model, secrets),
[`docs/rbac.md`](rbac.md) (roles and permissions).

Two rules govern everything below:

- **No secret is ever committed.** `apps/api/wrangler.toml` holds non-secret
  `[vars]` and `TODO_` placeholders only; secrets go in with
  `wrangler secret put`. `scripts/check-secrets.ts` fails CI if a credential
  shape reaches the tree.
- **Production is never seeded.** `scripts/seed.ts` is development-only and
  cannot reach D1 at all (step 6).

---

## Contents

1. [What gets deployed](#1-what-gets-deployed)
2. [Prerequisites](#2-prerequisites)
3. [Cloudflare account setup](#3-cloudflare-account-setup)
4. [Provision D1, R2 and KV, and fill the placeholders](#4-provision-d1-r2-and-kv-and-fill-the-placeholders)
5. [Apply migrations to the remote database](#5-apply-migrations-to-the-remote-database)
6. [Do not seed production — bootstrap instead](#6-do-not-seed-production--bootstrap-instead)
7. [Worker secrets](#7-worker-secrets)
8. [Non-secret variables and tunable limits](#8-non-secret-variables-and-tunable-limits)
9. [Deploy the Worker](#9-deploy-the-worker)
10. [Deploy the dashboard to Cloudflare Pages](#10-deploy-the-dashboard-to-cloudflare-pages)
11. [Wire the dashboard origin into the API (`CORS_ORIGINS`, `PUBLIC_APP_URL`)](#11-wire-the-dashboard-origin-into-the-api)
12. [Register the Telegram webhooks](#12-register-the-telegram-webhooks)
13. [Custom domains](#13-custom-domains)
14. [Production smoke tests](#14-production-smoke-tests)
15. [CI pipeline and deploy gating](#15-ci-pipeline-and-deploy-gating)
16. [Retention pruning (suggested Cron trigger)](#16-retention-pruning-suggested-cron-trigger)
17. [Rollback](#17-rollback)
18. [What costs money](#18-what-costs-money)
19. [Limitations](#19-limitations)
20. [Deployment checklist](#20-deployment-checklist)

---

## 1. What gets deployed

```text
                    Telegram (external service)
                               │  webhook POST + X-Telegram-Bot-Api-Secret-Token
                               ▼
  Browser ──► Cloudflare Pages ──fetch──► Cloudflare Worker  "corpus-api"
              (apps/web,                  (apps/api, Hono)
               Next.js 14)                     │      │      │
                                               │      │      └── KV  RATE_LIMIT
                                               │      └───────── R2  DOCUMENTS
                                               └──────────────── D1  DB  "corpus"
                                               │
                                               └──► LLM provider API (paid)
```

| Artefact | Cloudflare product | Binding | Declared in |
|---|---|---|---|
| API | Workers | — | `apps/api/wrangler.toml` |
| Structured data | D1 (`corpus`) | `DB` | `[[d1_databases]]` |
| Uploaded documents | R2 (`corpus-documents`) | `DOCUMENTS` | `[[r2_buckets]]` |
| Rate-limit counters, webhook replay guard | Workers KV | `RATE_LIMIT` | `[[kv_namespaces]]` |
| Admin dashboard | Pages | — | `apps/web/package.json` (`pages:build`, `pages:deploy`) |

Missing bindings do not crash the Worker except for `DB`: without R2 the
storage falls back to per-isolate memory and without KV the limiter falls back
to the D1 `rate_limit_counters` table (`apps/api/src/container.ts`). `/health`
reports the degradation honestly rather than hiding it
(`apps/api/src/routes/health.ts`).

> **Name collision, by design.** Both the default configuration and
> `[env.production]` set `name = "corpus-api"` in `apps/api/wrangler.toml`.
> They therefore deploy to the *same* Worker script, share one URL and one
> secret store, and differ only in `[vars]`. Always pass `--env production` for
> production work; a plain `npm run deploy:api` would overwrite the live
> Worker with the development vars (`ENVIRONMENT=development`,
> `AI_PROVIDER=mock`, `CORS_ORIGINS=http://localhost:3000`).

---

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | `engines` in `package.json`. Wrangler and the scripts assume it. |
| npm workspaces | `npm ci` at the repository root installs `apps/*` and `packages/*`. |
| Wrangler | Pinned as a devDependency (`wrangler ^3.78.0`); always invoke as `npx wrangler` so the pinned version is used. |
| A Cloudflare account | Free plan is sufficient for the Worker, D1, R2, KV and Pages (see [§18](#18-what-costs-money)). |
| Two Telegram bots | Created with `@BotFather`: one external (candidates), one internal (staff). Optional — the Worker starts without them and `/health` lists them as warnings. |
| An LLM API key | Optional for a first deploy, but `AI_PROVIDER=mock` is a **configuration error in production** (`validateConfig` in `packages/shared/src/config.ts`), so `/health` will report `degraded` until a real provider is configured. |
| `openssl`, `curl` | Used by the commands below. |

Before deploying anything, prove the tree is green locally:

```bash
npm ci
npm run ci      # secret scan → contract check → lint → typecheck ×2 → all tests
```

`npm run ci` is defined in `package.json` and mirrors the CI job in
`.github/workflows/ci.yml`.

> **Known failing step on this checkout.** All 421 tests pass, but the first
> step, `npm run secrets:check`, currently exits 1 with three findings in
> `tests/helpers/harness.ts` (lines 71, 85 and 86) where test-only constants are
> assigned to `SESSION_SECRET` and the two `TELEGRAM_*_WEBHOOK_SECRET` bindings.
> No secret is exposed; the fix is an `ALLOWLIST` entry in
> `scripts/check-secrets.ts`. See `docs/testing.md` → Limitations.

---

## 3. Cloudflare account setup

1. Create (or sign in to) a Cloudflare account and note the **Account ID** from
   the dashboard sidebar. Do **not** put it in `wrangler.toml` — the file header
   forbids committing account IDs.
2. Authenticate Wrangler interactively:

   ```bash
   npx wrangler login
   ```

   For CI or a headless machine, create a scoped API token instead
   (My Profile → API Tokens → Create Token) with permissions:
   *Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Workers R2 Storage:
   Edit*, *D1: Edit*, *Cloudflare Pages: Edit*, *Account Settings: Read*.
   Export it as `CLOUDFLARE_API_TOKEN` together with `CLOUDFLARE_ACCOUNT_ID`;
   those are exactly the two names the CI deploy job expects
   (`.github/workflows/ci.yml`).
3. Pick a `workers.dev` subdomain if you have not already. With
   `workers_dev = true` the API will be reachable at
   `https://corpus-api.<subdomain>.workers.dev` until you attach a custom
   domain ([§13](#13-custom-domains)).

---

## 4. Provision D1, R2 and KV, and fill the placeholders

Run each command from the repository root.

1. **D1**

   ```bash
   npx wrangler d1 create corpus
   ```

   Copy the `database_id` from the output.

2. **R2**

   ```bash
   npx wrangler r2 bucket create corpus-documents
   ```

   R2 is referenced by bucket name, so there is no id to paste.

3. **KV**

   ```bash
   npx wrangler kv namespace create CORPUS_RATE_LIMIT
   ```

   Copy the namespace `id` from the output. (Wrangler 3 also accepts the older
   `kv:namespace create` spelling.)

4. **Fill every `TODO_` placeholder** in `apps/api/wrangler.toml`. There are
   six, in two blocks:

   | Placeholder | Occurs in | Replace with |
   |---|---|---|
   | `TODO_D1_DATABASE_ID` | `[[d1_databases]]` and `[[env.production.d1_databases]]` | the D1 `database_id` from step 1 (the same value in both) |
   | `TODO_KV_NAMESPACE_ID` | `[[kv_namespaces]]` and `[[env.production.kv_namespaces]]` | the KV `id` from step 3 (the same value in both) |
   | `TODO_PUBLIC_APP_URL` | `[env.production.vars] PUBLIC_APP_URL` and `CORS_ORIGINS` | the dashboard origin, e.g. `https://corpus-dashboard.pages.dev` — you will know it after [§10](#10-deploy-the-dashboard-to-cloudflare-pages), so it is normal to fill this in a second pass |

   None of these are secrets, so the edited file may be committed. Account IDs
   and tokens must never be added to it.

   Until `CORS_ORIGINS` is replaced, the value is dropped rather than trusted:
   `loadConfig` filters out any origin starting with `TODO_`
   (`packages/shared/src/config.ts`), and `validateConfig` then raises
   `CORS_ORIGINS: must list the dashboard origin(s)` as a production **error**.

---

## 5. Apply migrations to the remote database

The six SQL files in `migrations/` are the whole schema;
`migrations_dir = "../../migrations"` in `apps/api/wrangler.toml` points
Wrangler at them.

```bash
npx wrangler d1 migrations list  corpus --remote --env production --config apps/api/wrangler.toml
npx wrangler d1 migrations apply corpus --remote --env production --config apps/api/wrangler.toml
```

Expected: `0001_core_identity`, `0002_hr_core`, `0003_recruitment`,
`0004_knowledge`, `0005_security_conversations`, `0006_rbac_reference` applied.

Notes:

- `migrations/0006_rbac_reference.sql` is generated from
  `packages/domain/src/roles.ts` by `scripts/generate-rbac-migration.ts`; CI
  regenerates it and fails on a diff. Never edit it by hand — change the roles
  file and regenerate.
- The repository also ships `npm run db:migrate:remote`, which omits
  `--env production`. Because both configurations point at the same
  `database_id`, it reaches the same database — but prefer the explicit command
  above so the environment is never ambiguous.
- `/health` counts rows in `d1_migrations` and reports them as
  `migrationsApplied` (`apps/api/src/routes/health.ts`), which is how you
  verify this step later.

---

## 6. Do not seed production — bootstrap instead

`npm run db:seed` is **development-only**:

- `scripts/seed.ts` exits immediately when `ENVIRONMENT=production`.
- More fundamentally it cannot reach D1: `scripts/local-db.ts` opens a
  file-backed SQLite database through `better-sqlite3`, so the seed only ever
  writes to `data/corpus.sqlite`.
- The content is fictional staff on the reserved `corpus.test` domain with one
  shared password (`scripts/seed-data.ts`). Loading that into a real tenant
  would create real, loggable accounts with a known password.

Migrations create the roles and permissions but **no tenant and no user**. A
freshly migrated deployment therefore answers `401 This deployment is not
initialised.` on public routes and login (`apps/api/src/middleware/auth.ts`,
`apps/api/src/routes/auth.ts`), because both resolve the tenant named by
`DEFAULT_TENANT_SLUG` (default `default`).

Bootstrap the tenant and the first administrator by hand. There is no bootstrap
script — see [§19](#19-limitations).

1. Generate a PBKDF2 hash of the chosen password, in the exact
   `algorithm$iterations$salt$hash` format the API verifies
   (`packages/auth/src/passwords.ts`). The password must satisfy the policy in
   the same file (≥ 12 characters, three character classes):

   ```bash
   read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
   npx tsx -e "import('@corpus/auth').then(m => m.hashPassword(process.env.ADMIN_PASSWORD)).then(console.log)"
   ```

   Output looks like `pbkdf2-sha256$210000$<salt>$<hash>`. The plaintext never
   leaves your shell.

2. Insert the tenant, the user and the role grant. Substitute the hash, your
   administrator e-mail, and fresh UUIDs (`uuidgen`):

   ```bash
   npx wrangler d1 execute corpus --remote --env production \
     --config apps/api/wrangler.toml --command "
   INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
   VALUES ('<tenant-uuid>', 'default', '<Company Name>', 'ACTIVE', datetime('now'), datetime('now'));

   INSERT INTO users (id, tenant_id, email, display_name, password_hash, status,
                      failed_login_count, created_at, updated_at)
   VALUES ('<user-uuid>', '<tenant-uuid>', '<admin@your-company.example>', 'Platform Administrator',
           '<paste-the-hash>', 'ACTIVE', 0, datetime('now'), datetime('now'));

   INSERT INTO user_roles (user_id, role_code, tenant_id, granted_at)
   VALUES ('<user-uuid>', 'SYSTEM_ADMIN', '<tenant-uuid>', datetime('now'));
   "
   ```

   `users.employee_id` is nullable (`migrations/0001_core_identity.sql`), so an
   administrator without an employee record can sign in; self-service leave
   routes will simply not apply to them. Create real employees afterwards
   through the dashboard, not through SQL.

3. `slug` must match `DEFAULT_TENANT_SLUG` in `[env.production.vars]`. Role
   codes are `EMPLOYEE`, `MANAGER`, `HR`, `HR_ADMIN`, `SYSTEM_ADMIN`
   (`migrations/0006_rbac_reference.sql`); grant the narrowest one that works.

---

## 7. Worker secrets

These six names are read by `loadConfig()` in `packages/shared/src/config.ts`
and are the complete secret set. Set each one with `wrangler secret put`, which
prompts for the value on stdin — never pass a secret as a shell argument or put
it in `wrangler.toml`.

| Secret | Required when | Effect if missing |
|---|---|---|
| `SESSION_SECRET` | always | Production **error**: `must be set to at least 32 random characters`. Also keys the IP hashing used in session records (`hashIp`, `apps/api/src/routes/auth.ts`). |
| `TELEGRAM_EXTERNAL_BOT_TOKEN` | to run the candidate bot | Warning; external bot disabled. |
| `TELEGRAM_INTERNAL_BOT_TOKEN` | to run the staff bot | Warning; internal bot disabled. |
| `TELEGRAM_EXTERNAL_WEBHOOK_SECRET` | whenever the external token is set | **Error**: `required whenever the external bot token is configured`. |
| `TELEGRAM_INTERNAL_WEBHOOK_SECRET` | whenever the internal token is set | **Error** (same rule, internal bot). |
| `AI_API_KEY` | whenever `AI_PROVIDER` is not `mock` | **Error**: `required for AI_PROVIDER=<name>`. |

Generate and set them:

```bash
# Session signing key — at least 32 characters (validateConfig enforces it).
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --env production --config apps/api/wrangler.toml

# One webhook secret per bot; scripts/telegram-setup.ts requires >= 16 chars.
openssl rand -hex 32 | npx wrangler secret put TELEGRAM_EXTERNAL_WEBHOOK_SECRET --env production --config apps/api/wrangler.toml
openssl rand -hex 32 | npx wrangler secret put TELEGRAM_INTERNAL_WEBHOOK_SECRET --env production --config apps/api/wrangler.toml

# Bot tokens from @BotFather, and the LLM provider key — paste when prompted.
npx wrangler secret put TELEGRAM_EXTERNAL_BOT_TOKEN --env production --config apps/api/wrangler.toml
npx wrangler secret put TELEGRAM_INTERNAL_BOT_TOKEN --env production --config apps/api/wrangler.toml
npx wrangler secret put AI_API_KEY                  --env production --config apps/api/wrangler.toml
```

Keep the two webhook secrets you generated: [§12](#12-register-the-telegram-webhooks)
needs the same values to register the webhooks with Telegram.

Verify (names only are ever returned):

```bash
npx wrangler secret list --env production --config apps/api/wrangler.toml
```

Rotation: `wrangler secret put` with a new value takes effect on the next
request. Rotating `SESSION_SECRET` invalidates the IP-hash correlation of
existing session rows but not the sessions themselves; rotating a webhook secret
requires re-running [§12](#12-register-the-telegram-webhooks) immediately, or
Telegram's calls start failing the secret check and are recorded as
`AUTH_FAILURE` security events (`apps/api/src/routes/telegram.ts`).

---

## 8. Non-secret variables and tunable limits

### 8.1 Declared in `[env.production.vars]`

| Var | Shipped value | Meaning |
|---|---|---|
| `ENVIRONMENT` | `production` | Switches `validateConfig` warnings into errors, forces `Secure` session cookies and adds HSTS (`apps/api/src/middleware/security-headers.ts`). |
| `LOG_LEVEL` | `info` | `packages/shared/src/logger.ts`. |
| `AI_PROVIDER` | `anthropic` | One of `mock`, `anthropic`, `openai`, `compatible` (`packages/ai/src/providers/index.ts`). `mock` is rejected in production. |
| `AI_MODEL` | `claude-haiku-4-5-20251001` | Passed to the provider; change it to whatever model your key can call. Empty means the provider default. |
| `AI_MAX_OUTPUT_TOKENS` | `600` | Ceiling on generated tokens. |
| `AI_MAX_CONTEXT_CHUNKS` | `5` | Maximum authorised knowledge chunks sent to the model. |
| `AI_REQUESTS_PER_HOUR` | `60` | Doubles as the per-subject AI rate limit. |
| `DEFAULT_TENANT_SLUG` | `default` | Must match the tenant row created in [§6](#6-do-not-seed-production--bootstrap-instead). |
| `PUBLIC_APP_URL` | `TODO_PUBLIC_APP_URL` | Dashboard base URL used in outbound links. |
| `CORS_ORIGINS` | `TODO_PUBLIC_APP_URL` | Comma-separated allowlist; `*` is never used with credentials (`apps/api/src/middleware/security-headers.ts`). |

`AI_BASE_URL` is read by `loadConfig` and typed in `apps/api/src/env.ts` but is
not present in `wrangler.toml`. Add it to `[env.production.vars]` if you set
`AI_PROVIDER=compatible`, which routes to the OpenAI-compatible client against
that base URL.

### 8.2 Configurable rate limits (CLAUDE.md §45)

All are plain `[vars]` — add any you want to change; the default applies when
the var is absent or unparseable (`packages/shared/src/config.ts`).

| Env var | Default | Window | Applies to |
|---|---|---|---|
| `RATE_LIMIT_TELEGRAM_PER_MINUTE` | 30 | 60 s | Telegram messages per user |
| `AI_REQUESTS_PER_HOUR` | 60 | 3600 s | AI requests per subject |
| `RATE_LIMIT_LOGIN_PER_15M` | 10 | 900 s | Login attempts, per e-mail **and** per IP |
| `RATE_LIMIT_VERIFY_PER_15M` | 5 | 900 s | Telegram verification requests |
| `RATE_LIMIT_APPLICATIONS_PER_HOUR` | 5 | 3600 s | Public application submissions |
| `RATE_LIMIT_ADMIN_API_PER_MINUTE` | 600 | 60 s | Authenticated API calls per user |
| `RATE_LIMIT_PUBLIC_API_PER_MINUTE` | 120 | 60 s | Public API calls per IP |

Size bounds are configurable the same way: `MAX_UPLOAD_BYTES` (8 MiB),
`MAX_REQUEST_BODY_BYTES` (512 KiB), `MAX_PAGE_SIZE` (100), `DEFAULT_PAGE_SIZE`
(25).

Every effective value is visible, secret-free, at `GET /health` under
`config.rateLimits` and `config.limits` (`describeConfig`).

---

## 9. Deploy the Worker

```bash
# Dry run first — this is exactly what CI does before it is allowed to deploy.
npx wrangler deploy --dry-run --outdir dist --env production --config apps/api/wrangler.toml

# Real deployment.
npx wrangler deploy --env production --config apps/api/wrangler.toml
```

Note the `https://corpus-api.<subdomain>.workers.dev` URL in the output; call
it `$BASE` from here on.

```bash
export BASE="https://corpus-api.<subdomain>.workers.dev"
curl -fsS "$BASE/health"
```

A healthy response has `"status":"ok"`, `"database":"ok"`,
`"migrationsApplied":6`, `"documentStorage":"r2"` and an empty `configErrors`.
Anything in `configErrors` returns HTTP 503 and names the key (never the value)
— fix it before continuing.

---

## 10. Deploy the dashboard to Cloudflare Pages

The dashboard (`apps/web`) is a Next.js 14 app that holds no secrets: its only
build-time input is `NEXT_PUBLIC_API_BASE_URL`, consumed in
`apps/web/lib/api.ts`. Authentication is the HttpOnly session cookie issued by
the API plus a CSRF token held in memory/`sessionStorage`.

1. Create the Pages project once:

   ```bash
   npx wrangler pages project create corpus-dashboard --production-branch main
   ```

2. Build and deploy. `apps/web/package.json` provides both steps:

   ```bash
   cd apps/web
   NEXT_PUBLIC_API_BASE_URL="$BASE" npx next build
   npx @cloudflare/next-on-pages@1          # same as: npm run pages:build
   npx wrangler pages deploy .vercel/output/static --project-name corpus-dashboard
   ```

   `NEXT_PUBLIC_API_BASE_URL` is inlined at build time, so a change to the API
   URL requires a rebuild, not just a redeploy.

3. In the Pages project settings (Functions → Compatibility flags), add
   `nodejs_compat` for the production and preview environments and set a
   compatibility date; `@cloudflare/next-on-pages` output requires it.

4. Note the resulting origin, e.g. `https://corpus-dashboard.pages.dev`.

The dashboard ships the home page (`/`), the sections `/people`,
`/recruitment` (with `/recruitment/cvs`), `/leave`, `/knowledge` (Policies, with
`/knowledge/training`, the Bot answers page), `/security` and `/settings`, and
`/login`, all under `apps/web/app/`. There is no chat page and no separate
reports page: the bots are the conversational surface, and the home page shows
the few aggregates HR acts on (`/reports/summary`, `/reports/bot`,
`/reports/tickets`). Every page is a client
component; there are no server secrets and no server-side data fetching.
Security headers for the static app are set in
`apps/web/next.config.mjs`; the API sets its own, stricter set.

`scripts/check-api-contract.ts` (run by `npm run ci`) asserts that every API
path the dashboard calls is a route the Worker actually mounts — a mistyped
endpoint fails CI instead of 404-ing in production.

---

## 11. Wire the dashboard origin into the API

The API allowlists origins explicitly; a browser request from an unlisted origin
gets no `Access-Control-Allow-Origin`, and its preflight is answered `403`
(`apps/api/src/middleware/security-headers.ts`).

1. Edit `apps/api/wrangler.toml` and replace both `TODO_PUBLIC_APP_URL`
   occurrences in `[env.production.vars]`:

   ```toml
   PUBLIC_APP_URL = "https://corpus-dashboard.pages.dev"
   CORS_ORIGINS   = "https://corpus-dashboard.pages.dev"
   ```

   `CORS_ORIGINS` accepts a comma-separated list — add a custom domain or a
   preview origin only if you genuinely need it. Origins are compared exactly:
   scheme, host and port, no trailing slash.

2. Redeploy the Worker ([§9](#9-deploy-the-worker)) and confirm
   `GET /health` shows the origin under `config.corsOrigins` and no
   `CORS_ORIGINS` entry in `configErrors`.

---

## 12. Register the Telegram webhooks

Two bots, two paths, two secrets. The zone is decided by which path Telegram
hits, in code — never by anything in the payload
(`apps/api/src/routes/telegram.ts`).

| Bot | Path | Secret |
|---|---|---|
| External (candidates) | `POST /telegram/external` | `TELEGRAM_EXTERNAL_WEBHOOK_SECRET` |
| Internal (staff) | `POST /telegram/internal` | `TELEGRAM_INTERNAL_WEBHOOK_SECRET` |

`scripts/telegram-setup.ts` (`npm run telegram:setup`) registers both in one go. It reads the tokens and
secrets from the environment and never prints them:

```bash
API_BASE_URL="$BASE" \
TELEGRAM_EXTERNAL_BOT_TOKEN=... TELEGRAM_EXTERNAL_WEBHOOK_SECRET=... \
TELEGRAM_INTERNAL_BOT_TOKEN=... TELEGRAM_INTERNAL_WEBHOOK_SECRET=... \
npm run telegram:setup
```

The script requires `API_BASE_URL` to be `https://`, skips a bot with no token,
and refuses a webhook secret shorter than 16 characters. It exits non-zero if
any registration fails.

The values passed here **must equal** the Worker secrets set in
[§7](#7-worker-secrets): Telegram echoes the secret back in the
`X-Telegram-Bot-Api-Secret-Token` header and the Worker compares it in constant
time. A mismatch yields `401` and a `HIGH`-severity `AUTH_FAILURE` security
event; a match but a handler failure still answers `200`, deliberately, so
Telegram does not retry-storm.

Prefer supplying these on one shell invocation (as above) rather than exporting
them into your shell profile, and clear your shell history afterwards if your
shell records commands with inline values.

---

## 13. Custom domains

Optional; `workers.dev` and `pages.dev` are fully functional.

1. **API.** Cloudflare dashboard → Workers & Pages → `corpus-api` → Settings →
   Domains & Routes → Add custom domain (e.g. `api.your-company.example`). The
   zone must be on the same Cloudflare account. Cloudflare provisions the
   certificate.
2. **Dashboard.** Pages project → Custom domains → add
   `hr.your-company.example`.
3. After either change, update the corresponding configuration and redeploy:
   - new API domain → rebuild the dashboard with the new
     `NEXT_PUBLIC_API_BASE_URL` ([§10](#10-deploy-the-dashboard-to-cloudflare-pages))
     **and** re-run the Telegram webhook registration with the new
     `API_BASE_URL` ([§12](#12-register-the-telegram-webhooks));
   - new dashboard domain → update `PUBLIC_APP_URL` and `CORS_ORIGINS`
     ([§11](#11-wire-the-dashboard-origin-into-the-api)).
4. Session cookies are issued `Secure` outside development
   (`apps/api/src/routes/auth.ts`), so both ends must be HTTPS. The dashboard
   and the API may live on different hosts — the client sends credentials
   cross-origin and the CORS allowlist permits it.

---

## 14. Production smoke tests

Copy-pasteable. Set `BASE` first; the login checks also need an account from
[§6](#6-do-not-seed-production--bootstrap-instead).

```bash
export BASE="https://corpus-api.<subdomain>.workers.dev"
```

**1. Liveness** — cheap, no database access:

```bash
curl -fsS "$BASE/health/live"
# {"status":"ok"}
```

**2. Health and configuration** — expect `status: ok`, `database: ok`,
`migrationsApplied: 6`, `documentStorage: "r2"`, empty `configErrors`:

```bash
curl -fsS "$BASE/health"
```

**3. Public jobs (EXTERNAL zone, no credentials)** — must return JSON, and must
contain no employee or salary-band data for unauthenticated callers:

```bash
curl -fsS "$BASE/public/jobs?limit=1"
```

**4. Telegram webhook with a wrong secret must be 401** — the single most
important negative check; a `200` here means the webhook is unauthenticated:

```bash
curl -s -o /dev/null -w 'internal=%{http_code}\n' -X POST "$BASE/telegram/internal" \
  -H 'content-type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: definitely-not-the-secret' \
  -d '{"update_id":1}'
# expect: internal=401

curl -s -o /dev/null -w 'external=%{http_code}\n' -X POST "$BASE/telegram/external" \
  -H 'content-type: application/json' \
  -d '{"update_id":1}'
# expect: external=401  (no header at all is also a rejection)
```

**5. Login** — cookie jar in, CSRF token out:

```bash
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
export ADMIN_EMAIL='admin@your-company.example'

curl -fsS -c /tmp/corpus.jar -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' \
  --data-binary "$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
# {"user":{...,"roles":["SYSTEM_ADMIN"]},"csrfToken":"...","expiresAt":"..."}

curl -fsS -b /tmp/corpus.jar "$BASE/auth/me"
# roles + permissions (UX hints only — the backend re-checks every call)

rm -f /tmp/corpus.jar; unset ADMIN_PASSWORD
```

**6. Bad credentials are refused uniformly** — one message for every failure
mode, so the response cannot be used to enumerate accounts:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"nobody@your-company.example","password":"not-the-password"}'
# expect: 401
```

**7. Protected route without a session:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/employees"
# expect: 401
```

**8. CORS allowlist** — a foreign origin must not get a preflight:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$BASE/auth/login" \
  -H 'Origin: https://attacker.example' -H 'Access-Control-Request-Method: POST'
# expect: 403
```

**9. Security headers:**

```bash
curl -sI "$BASE/health" | grep -iE 'strict-transport|content-security|x-frame|x-content-type|cache-control'
```

Repeated failed logins are rate limited (10 per 15 minutes per e-mail and per
IP) and lock the account after 8 attempts for 15 minutes
(`packages/auth/src/login.ts`) — do not loop test 6.

---

## 15. CI pipeline and deploy gating

`.github/workflows/ci.yml` runs on pushes to `main` and `staging` and on every
pull request. It has two jobs.

```text
verify (no secrets needed)
  checkout → setup-node 20 (npm cache) → npm ci
    → npm run secrets:check          scripts/check-secrets.ts
    → npm run check:contract         dashboard calls vs mounted routes
    → npm run lint                   eslint --max-warnings 0
    → npm run typecheck              API + packages
    → typecheck --workspace @corpus/web
    → test:unit → test:integration → test:security → test:e2e
    → regenerate 0006_rbac_reference.sql and `git diff --exit-code`
    → wrangler deploy --dry-run      (Worker builds)
    → next build                     (dashboard builds, dummy API URL)
        │
        ▼  needs: verify
deploy (production environment)
  if: ref == refs/heads/main AND event == push
    → check CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are present
       ├─ absent → log and skip every deploy step (a fork can never deploy)
       └─ present → d1 migrations apply --remote --env production
                  → wrangler deploy --env production
                  → next build + @cloudflare/next-on-pages + pages deploy
                  → smoke test: /health, /public/jobs, webhook-without-secret == 401
```

Gating, precisely:

- The deploy job `needs: verify`, so a single failing test blocks it.
- It only runs on a **push to `main`** — pull requests and the `staging` branch
  build and test but never deploy.
- Every deploy step is additionally conditioned on credentials being present,
  so a fork or a secret-less repository degrades to "verified, not deployed".
- It uses the `production` GitHub environment, where you can require a manual
  approval.

Repository configuration required for automated deploys:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | scoped token from [§3](#3-cloudflare-account-setup) |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | your account id |
| Variable | `PUBLIC_API_BASE_URL` | the deployed Worker URL; also the smoke-test target |
| Variable | `CLOUDFLARE_PAGES_PROJECT` | Pages project name; if empty, the Pages steps are skipped |

CI never sets Worker secrets. `wrangler secret put` ([§7](#7-worker-secrets)) is
a one-off manual operation.

---

## 16. Retention pruning (suggested Cron trigger)

`migrations/0005_security_conversations.sql` seeds a `retention_policies` table:

| Table | Retained |
|---|---|
| `audit_logs` | 730 days |
| `security_events` | 730 days |
| `messages` | 90 days |
| `tool_calls` | 180 days |
| `verification_codes` | 1 day |
| `rate_limit_counters` | 1 day (rows also carry `expires_at`) |

`scripts/prune.ts` enforces those policies, and additionally deletes expired
sessions. **It runs on Node against the local SQLite database** (via
`scripts/local-db.ts`) — it is not wired into the Worker.

`apps/api/src/index.ts` exports `fetch` only, and `apps/api/wrangler.toml`
declares no `[triggers]`, so nothing prunes production today. To close that gap
you need both halves:

```toml
# apps/api/wrangler.toml, under [env.production]
[triggers]
crons = ["17 3 * * *"]   # 03:17 UTC daily
```

```ts
// apps/api/src/index.ts — add alongside fetch
export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) { … },
  async scheduled(_event: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext) {
    // build the container, read retention_policies, call the same
    // repository pruners scripts/prune.ts uses
  },
}
```

Until that exists, run the equivalent deletions manually against D1, e.g.:

```bash
npx wrangler d1 execute corpus --remote --env production --config apps/api/wrangler.toml \
  --command "DELETE FROM verification_codes WHERE expires_at < datetime('now');
             DELETE FROM sessions WHERE expires_at < datetime('now');
             DELETE FROM rate_limit_counters WHERE expires_at < strftime('%s','now');"
```

KV-backed rate-limit keys expire on their own TTL and need no pruning
(`packages/security/src/rate-limit.ts`).

---

## 17. Rollback

Worker deployments are versioned by Cloudflare.

```bash
npx wrangler deployments list   --env production --config apps/api/wrangler.toml
npx wrangler deployments status --env production --config apps/api/wrangler.toml

# Interactive rollback to the previous version…
npx wrangler rollback --env production --config apps/api/wrangler.toml -m "reason"

# …or to a specific version id from the list.
npx wrangler rollback <version-id> --env production --config apps/api/wrangler.toml
```

Alternatively redeploy a known-good commit or tag:

```bash
git checkout <tag-or-commit>
npm ci
npx wrangler deploy --env production --config apps/api/wrangler.toml
```

Constraints to respect:

- **`wrangler rollback` restores code and bindings, not data.** D1 migrations
  are forward-only in this repository — there are no `down` scripts. If a
  release added a migration, rolling the code back leaves the newer schema in
  place. Only roll back to a version whose code still runs against the current
  schema, or write a corrective migration.
- Secrets are not versioned; a rollback keeps whatever secret values are
  currently set.
- The dashboard is rolled back independently: Pages → Deployments → *Rollback to
  this deployment*, or redeploy an earlier build. Because
  `NEXT_PUBLIC_API_BASE_URL` is baked in at build time, an old dashboard build
  keeps pointing at whatever API URL it was built with.
- After any rollback, re-run the smoke tests in
  [§14](#14-production-smoke-tests).

---

## 18. What costs money

### Cloudflare — $0 on the free plan for this workload

Figures are the free-plan allowances published at the time of writing; verify
against Cloudflare's current pricing before relying on them.

| Product | Free allowance | How CORPUS stays inside it |
|---|---|---|
| Workers | ~100 000 requests/day, 10 ms CPU per invocation | Per-request work is bounded: page size ≤ 100, ≤ 3 tool calls per AI turn, ≤ 5 retrieved chunks (`packages/shared/src/config.ts`, `apps/api/src/container.ts`). |
| D1 | ~5 GB storage; ~5 M rows read and ~100 k rows written per day | All queries are indexed and tenant-scoped; retention policies bound growth ([§16](#16-retention-pruning-suggested-cron-trigger)). |
| R2 | ~10 GB-month storage, 1 M class-A and 10 M class-B operations/month, no egress fees | Uploads capped at 8 MiB (`MAX_UPLOAD_BYTES`); documents are written once and read during ingestion. |
| Workers KV | ~100 000 reads/day but only **~1 000 writes/day** | See the warning below. |
| Pages | Unlimited requests/bandwidth, ~500 builds/month | One build per deploy. |
| Workers AI | A daily Neuron allowance on the free plan | The default `AI_PROVIDER`. No account or key beyond the Cloudflare one; see the LLM section below. |

> **KV write budget is the real constraint.** `KvRateLimiter.consume` performs
> one `put` per *allowed* request (`packages/security/src/rate-limit.ts`), and
> the limiter runs on every authenticated and every public request. A few
> thousand requests a day will exhaust the free KV write allowance. Two honest
> options: (a) accept it and monitor, or (b) **omit the `RATE_LIMIT` binding**,
> which makes `createContainer` fall back to `D1RateLimiter` against the
> `rate_limit_counters` table, whose write budget is far larger. The cost of
> (b) is that the Telegram replay guard falls back to per-isolate memory, so a
> retried Telegram update landing on a different isolate may be processed twice
> (`apps/api/src/container.ts`).

Also outside the free plan: Workers Logs/Analytics Engine retention beyond the
default (`[observability] enabled = true` is on), and any Cloudflare Access or
WAF rules you choose to add in front of the dashboard.

### LLM — free by default, metered if you opt in

CLAUDE.md §52 warns that `$0 hosting does not mean $0 AI API cost`. That is true
of the paid providers, so the **default is a free one**: `AI_PROVIDER=workers-ai`
runs inference on Cloudflare's own network through the `[ai]` binding, with no
API key and no second account. The constraint becomes a **daily Neuron
allowance** rather than a bill — when it is spent the binding throws, and the
assistant answers "temporarily unavailable" instead of erroring
(`PROVIDER_UNAVAILABLE_REPLY` in `packages/ai/src/orchestrator.ts`).

Choosing a provider:

| `AI_PROVIDER` | Account needed | Cost model |
|---|---|---|
| `workers-ai` *(default)* | none beyond Cloudflare | Free daily allowance |
| `google` | Google AI Studio API key | Free tier, no billing account |
| `anthropic` / `openai` | Vendor account with billing | Metered per token |
| `compatible` | Depends on the endpoint | Depends |

The levers are configuration rather than code, and apply to every provider:

| Lever | Var / location | Default |
|---|---|---|
| Provider | `AI_PROVIDER` — `mock` costs nothing but is rejected in production | `workers-ai` in prod |
| Model | `AI_MODEL` | `@cf/meta/llama-3.1-8b-instruct` |
| Output ceiling | `AI_MAX_OUTPUT_TOKENS` | 600 |
| Context sent | `AI_MAX_CONTEXT_CHUNKS` | 5 |
| Requests per subject | `AI_REQUESTS_PER_HOUR` | 60/hour |

Because a free allowance is shared across the whole deployment rather than
billed per caller, `AI_REQUESTS_PER_HOUR` is doing real work on the default
configuration: it stops one user from spending the day's quota.

Structural savings already in the code: intent classification is rules-first and
only falls back to the model (for ≤ 60 tokens); intents the `PolicyGateway`
refuses never reach a planning call; only the tools the identity may use are
described to the model; and the second generation call is skipped when no tool
was requested (`packages/ai/src/`, see `docs/architecture.md` §8.3).

Cap your spend at the provider (usage limits / budget alerts) as well as here —
`AI_REQUESTS_PER_HOUR` is per subject, not global.

---

## 19. Limitations

Deferred or partially implemented, stated plainly so the runbook is not read as
a promise:

   There is no mail transport in this repository. `selectCodeDelivery()`
   (`packages/telegram/src/internal-bot.ts`) returns `NullCodeDelivery` for
   `ENVIRONMENT=production` and `staging`: the one-time code is discarded rather than
   written to the Worker log, so internal Telegram verification cannot complete until a
   `VerificationCodeDelivery` implementation is added. `/health` lists
   `VERIFICATION_CODE_TRANSPORT` under `configErrors` whenever the internal bot token is
   configured, so the gap is visible rather than silent.


---

## 20. Deployment checklist

```text
[ ] npm ci && npm run ci is green locally
[ ] Cloudflare account + wrangler login (or scoped API token)
[ ] D1 `corpus` created, database_id pasted in both places
[ ] R2 `corpus-documents` created
[ ] KV `CORPUS_RATE_LIMIT` created, id pasted in both places (or binding
    deliberately omitted in favour of the D1 limiter — see §18)
[ ] No TODO_ placeholder remains in apps/api/wrangler.toml
[ ] Migrations applied --remote --env production (6 applied)
[ ] Production NOT seeded; tenant + first SYSTEM_ADMIN inserted manually
[ ] SESSION_SECRET set (>= 32 chars)
[ ] TELEGRAM_EXTERNAL_BOT_TOKEN / TELEGRAM_INTERNAL_BOT_TOKEN set (if used)
[ ] TELEGRAM_EXTERNAL_WEBHOOK_SECRET / TELEGRAM_INTERNAL_WEBHOOK_SECRET set
[ ] AI_API_KEY set and AI_PROVIDER is not `mock`
[ ] Worker deployed with --env production
[ ] Dashboard built with NEXT_PUBLIC_API_BASE_URL and deployed to Pages
[ ] Pages compatibility flag nodejs_compat enabled
[ ] PUBLIC_APP_URL and CORS_ORIGINS point at the dashboard origin; redeployed
[ ] Telegram webhooks registered with the same secrets as the Worker holds
[ ] /health returns status ok, database ok, documentStorage r2, no configErrors
[ ] Webhook without the correct secret returns 401
[ ] Login works; unauthenticated /employees returns 401; foreign CORS preflight 403
[ ] GitHub secrets/variables set if CI should deploy
[ ] Rollback procedure understood (forward-only migrations)
```
