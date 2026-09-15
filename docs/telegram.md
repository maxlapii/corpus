# CORPUS — Telegram Integration

This document describes the two Telegram bots as they are implemented in the repository today: how updates reach the Worker, what is verified before anything is processed, what each bot can do, and how an employee links a Telegram account to an employee record.

It is written against the source. Where `CLAUDE.md` asks for something the code does not do, that is stated under [Limitations](#19-limitations). Paths are relative to the repository root; section references (`§n`) point at `CLAUDE.md`.

## Contents

1. [Two bots, two zones](#1-two-bots-two-zones)
2. [Request path](#2-request-path)
3. [BotFather setup](#3-botfather-setup)
4. [Configuration](#4-configuration)
5. [Webhook authentication](#5-webhook-authentication)
6. [Replay protection](#6-replay-protection)
7. [Rate limits](#7-rate-limits)
8. [Update normalisation and what is not trusted](#8-update-normalisation-and-what-is-not-trusted)
9. [External bot](#9-external-bot)
9a. [CV uploads on the external bot](#9a-cv-uploads-on-the-external-bot)
9b. [CV forwarding on the internal bot](#9b-cv-forwarding-on-the-internal-bot)
10. [Internal bot](#10-internal-bot)
10a. [Curated answers (bot training)](#10a-curated-answers-bot-training)
11. [Identity verification flow](#11-identity-verification-flow)
12. [Identity resolution on every later message](#12-identity-resolution-on-every-later-message)
13. [Error policy: always 200 after the secret check](#13-error-policy-always-200-after-the-secret-check)
14. [Outbound client](#14-outbound-client)
15. [Registering the webhooks](#15-registering-the-webhooks)
16. [Security events emitted](#16-security-events-emitted)
17. [Tests](#17-tests)
18. [Troubleshooting](#18-troubleshooting)
19. [Limitations](#19-limitations)

---

## 1. Two bots, two zones

CORPUS runs **two separate Telegram bots** (§36). They are not two modes of one bot; nothing in a payload can move a request from one to the other.

| | External bot | Internal bot |
|---|---|---|
| Audience | Public candidates, anonymous users | Verified employees only |
| Route | `POST /telegram/external` | `POST /telegram/internal` |
| Token | `TELEGRAM_EXTERNAL_BOT_TOKEN` | `TELEGRAM_INTERNAL_BOT_TOKEN` |
| Webhook secret | `TELEGRAM_EXTERNAL_WEBHOOK_SECRET` | `TELEGRAM_INTERNAL_WEBHOOK_SECRET` |
| Handler | `ExternalBot` (`packages/telegram/src/external-bot.ts`) | `InternalBot` (`packages/telegram/src/internal-bot.ts`) |
| Outbound client | `container.externalBotClient` | `container.internalBotClient` |
| Identity | `IdentityResolver.anonymous()` → `zone: 'EXTERNAL'` | `IdentityResolver.fromTelegramInternal()` → `zone: 'INTERNAL'`, or refusal |
| Channel recorded | `TELEGRAM_EXTERNAL` | `TELEGRAM_INTERNAL` |
| Replay-guard key prefix | `external` | `internal` |
| Rate-limit key prefix | `tg:ext:` | `tg:int:` |

### Why they are separate

The separation is a containment boundary, and it is enforced at four independent layers:

1. **Separate credentials.** Two BotFather bots, two tokens, two webhook secrets. Compromising the public bot's token yields nothing that reaches the internal endpoint, because the internal endpoint accepts only the internal secret.
2. **Separate handlers.** `apps/api/src/routes/telegram.ts` registers the two paths in a `for (const bot of ['external', 'internal'])` loop and constructs a different class per branch. The external branch never receives `telegramIdentity` or `codeDelivery` in its dependencies, so it has no code path to the linking flow.
3. **The zone is fixed by the route path, in code.** `ExternalBot` always calls `identityResolver.anonymous()`; there is no branch in it that can produce an `INTERNAL` identity. Nothing read from the update — not a command, not a claim in the text, not a username — participates in that decision.
4. **Tool visibility follows the zone.** `ToolRegistry.describeFor()` filters on `tool.scope === identity.zone` (`packages/ai/src/tool-registry.ts:71`) and `ToolRegistry.execute()` re-checks `tool.scope !== ctx.identity.zone` at execution time (line 119). An `EXTERNAL` identity is never even *told* that internal tools exist, and could not run one if it named it.

Both bots feed the same `AIOrchestrator`, and the `PolicyGateway` treats both Telegram channels as chat: `identity.channel === 'TELEGRAM_INTERNAL' || identity.channel === 'TELEGRAM_EXTERNAL'` sets `isChat`, and any resource rule carrying `maxRiskInChat` refuses a higher-risk operation on that channel regardless of role (`packages/security/src/policy-gateway.ts:160`). Compensation, offers, audit and security events are all capped this way, so they are not served over Telegram even to `HR_ADMIN`.

---

## 2. Request path

```text
Telegram ──► POST /telegram/{external|internal}          apps/api/src/routes/telegram.ts
   │
   1. resolve tenant by DEFAULT_TENANT_SLUG          (attribution only — confers nothing)
   2. verifyWebhookSecret(header, configured secret) constant-time; no secret configured = reject
        └─ fail ─► record AUTH_FAILURE security event ─► 401 {"error":{"code":"UNAUTHENTICATED"}}
   3. parse JSON body                                  malformed ─► 200
   4. normaliseUpdate(payload)                          nothing actionable ─► 200
   5. ExternalBot.handle | InternalBot.handle
        a. replayGuard.seen(botKey, update_id)          duplicate ─► drop
        b. private chats only                           group/supergroup/channel ─► polite refusal
        c. per-user rate limit                          exceeded ─► RATE_LIMIT event + notice
        d. identity
             external → anonymous(EXTERNAL) [+ candidateId if the Telegram id is known]
             internal → fromTelegramInternal(); failure ─► UNKNOWN_USER event + verification help
        e. /verify, /code (internal only) handled without the model
        f. everything else → AIOrchestrator.handle → PolicyGateway → authorised tools
   6. always 200 once the secret verified
```

Route mounting places `/telegram/*` outside the session-protected group: `app.route('/telegram', telegramRoutes)` sits in the unauthenticated block of `apps/api/src/app.ts`, before `requireSession` is applied to the internal API. The webhook secret is the authentication for these two paths.

---

## 3. BotFather setup

Both bots are ordinary BotFather bots. Nothing in CORPUS automates this step.

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Create the **public** bot (for example `CORPUS Careers` / `@yourcompany_careers_bot`). Copy the token — it is `TELEGRAM_EXTERNAL_BOT_TOKEN`.
3. Send `/newbot` again and create the **internal** bot (for example `CORPUS HR` / `@yourcompany_hr_bot`). Copy the token — it is `TELEGRAM_INTERNAL_BOT_TOKEN`.
4. For the internal bot, send `/setjoingroups` → **Disable**. The handler already refuses group chats, but preventing the bot from being added at all removes the failure mode entirely.
5. For the internal bot, send `/setprivacy` → **Enable** (the default). CORPUS only reads direct messages.
6. Optionally send `/setcommands` for each bot so the client shows a command menu. CORPUS does not call `setMyCommands`, so this must be pasted manually:

   External bot:

   ```text
   jobs - Browse current openings
   apply - Submit an application
   status - Check an application by reference
   help - What I can do
   ```

   Internal bot:

   ```text
   verify - Link your Telegram account using your company e-mail
   code - Submit the 6-digit code you received
   balance - Your leave balance
   leave - Your leave requests
   request - Submit a leave request
   holidays - Upcoming public holidays
   policy - Search HR policy
   approvals - Leave awaiting your decision
   help - What I can do
   ```

7. Generate one webhook secret **per bot** — they must not be the same value:

   ```bash
   openssl rand -hex 32   # TELEGRAM_EXTERNAL_WEBHOOK_SECRET
   openssl rand -hex 32   # TELEGRAM_INTERNAL_WEBHOOK_SECRET
   ```

8. Store all four values as secrets, then register the webhooks — see [§4](#4-configuration) and [§15](#15-registering-the-webhooks).

---

## 4. Configuration

All four values are secrets. They are read in `packages/shared/src/config.ts` (`loadConfig`) and typed in `apps/api/src/env.ts`.

| Variable | Purpose |
|---|---|
| `TELEGRAM_EXTERNAL_BOT_TOKEN` | Outbound Bot API calls for the public bot |
| `TELEGRAM_INTERNAL_BOT_TOKEN` | Outbound Bot API calls for the HR bot |
| `TELEGRAM_EXTERNAL_WEBHOOK_SECRET` | Expected `X-Telegram-Bot-Api-Secret-Token` on `/telegram/external` |
| `TELEGRAM_INTERNAL_WEBHOOK_SECRET` | Expected `X-Telegram-Bot-Api-Secret-Token` on `/telegram/internal` |
| `RATE_LIMIT_TELEGRAM_PER_MINUTE` | Messages per Telegram user per minute (default 30) |
| `RATE_LIMIT_VERIFY_PER_15M` | `/verify` requests per Telegram user per 15 minutes (default 5) |

Production:

```bash
wrangler secret put TELEGRAM_EXTERNAL_BOT_TOKEN      --config apps/api/wrangler.toml
wrangler secret put TELEGRAM_INTERNAL_BOT_TOKEN      --config apps/api/wrangler.toml
wrangler secret put TELEGRAM_EXTERNAL_WEBHOOK_SECRET --config apps/api/wrangler.toml
wrangler secret put TELEGRAM_INTERNAL_WEBHOOK_SECRET --config apps/api/wrangler.toml
```

Local development: copy `.env.example` to `.dev.vars`. The template ships all four keys blank.

### Configuration validation

`validateConfig()` (`packages/shared/src/config.ts:157–176`) enforces the pairing:

| Condition | Severity | Message |
|---|---|---|
| No external bot token | `warning` | `not set — external bot disabled` |
| No internal bot token | `warning` | `not set — internal bot disabled` |
| External token set, external webhook secret unset | `error` | `required whenever the external bot token is configured` |
| Internal token set, internal webhook secret unset | `error` | `required whenever the internal bot token is configured` |

`GET /health` surfaces these as `configErrors` / `configWarnings` (keys and messages only, never values) and returns 503 while any error remains. `describeConfig()` reports `externalBotConfigured` / `internalBotConfigured` as booleans; tokens are never echoed.

A missing token does not open a hole: an unset token makes `TelegramClient.configured` false, so outbound sends are skipped and logged (`packages/telegram/src/client.ts`), while an unset webhook secret makes the *inbound* route reject everything ([§5](#5-webhook-authentication)).

---

## 5. Webhook authentication

Telegram authenticates itself by echoing the `secret_token` given to `setWebhook` in the `X-Telegram-Bot-Api-Secret-Token` header. `verifyWebhookSecret()` (`packages/telegram/src/webhook.ts`) is the only check that gates processing:

```ts
export function verifyWebhookSecret(presented, expected): WebhookVerification {
  if (!expected)   return { ok: false, reason: 'NO_SECRET_CONFIGURED' }
  if (!presented)  return { ok: false, reason: 'MISSING_HEADER' }
  return timingSafeEqual(presented, expected) ? { ok: true } : { ok: false, reason: 'BAD_SECRET' }
}
```

Three properties matter:

- **Fail closed on an unconfigured secret.** An empty `expected` rejects *everything* rather than accepting everything. A deployment that forgot the secret has a dead bot, not an open one.
- **Constant time.** `timingSafeEqual()` (`packages/shared/src/crypto.ts:29`) compares over `max(a.length, b.length)` bytes and folds the length difference into the accumulator, so neither the contents nor the length of the configured secret leaks through response timing.
- **No diagnostics to the caller.** The reason code is recorded server-side; the HTTP body is a fixed `{"error":{"code":"UNAUTHENTICATED","message":"Rejected."}}`.

### On failure

`apps/api/src/routes/telegram.ts` records a security event and returns **401** without reading the body:

| Field | Value |
|---|---|
| `eventType` | `AUTH_FAILURE` |
| `severity` | `MEDIUM` for `NO_SECRET_CONFIGURED`, `HIGH` for `MISSING_HEADER` / `BAD_SECRET` |
| `channel` | `TELEGRAM_EXTERNAL` or `TELEGRAM_INTERNAL`, by route |
| `summary` | `Telegram webhook rejected (<reason>)` |
| `tenantId` | the tenant resolved from `DEFAULT_TENANT_SLUG`, or `null` |
| `requestId` | the per-request id from `requestContext` |

The tenant lookup happens *before* the secret check purely so a rejected webhook is attributable on the security dashboard. It grants nothing — the route comment states this explicitly, and no payload is parsed on the failure path. The event is visible at `GET /security/events` and in the dashboard's Security section to holders of `security.read`.

401 is the one status the endpoints return other than 200; it is safe because a genuine Telegram delivery always carries the correct header, so a 401 never triggers Telegram's retry loop for legitimate traffic.

---

## 6. Replay protection

Telegram redelivers an update until it receives a 200, so duplicate `update_id`s are normal traffic, not only an attack. Processing a duplicate would submit a leave request twice.

`ReplayGuard.seen(botKey, updateId)` is the first thing both handlers call, before the chat-type check and before the rate limiter:

| Implementation | Used when | Behaviour |
|---|---|---|
| `KvReplayGuard` | The `RATE_LIMIT` KV namespace is bound | Key `tg:update:<botKey>:<updateId>`, TTL 3600 s. Present ⇒ duplicate; otherwise written and processed. |
| `MemoryReplayGuard` | No KV binding (local dev, tests) | Bounded `Map`; above 5 000 entries the oldest 2 500 are dropped. Process-lifetime only. |
| `NoopReplayGuard` | Tests asserting other behaviour | Never de-duplicates. |

Selection happens in `apps/api/src/container.ts:112` — the same `isKv()` check that selects the rate limiter, so KV covers both or neither. The `botKey` is part of the key, so the external and internal bots have independent `update_id` sequences and cannot collide.

A duplicate is dropped silently: the external handler logs at debug level and returns; the internal handler returns with no log line. Telegram still receives 200.

---

## 7. Rate limits

Both limits are fixed-window counters through the shared `RateLimiter` (KV, else the D1 `rate_limit_counters` table, else memory) and are configurable per deployment (§45).

| Limit | Default | Env var | Key | Enforced in |
|---|---|---|---|---|
| Messages per Telegram user | 30 / 60 s | `RATE_LIMIT_TELEGRAM_PER_MINUTE` | `tg:ext:<telegramUserId>` / `tg:int:<telegramUserId>` | `ExternalBot.handle` step 3, `InternalBot.handle` |
| `/verify` requests per Telegram user | 5 / 900 s | `RATE_LIMIT_VERIFY_PER_15M` | `tg:verify:<telegramUserId>` | `InternalBot.handleVerifyRequest` |
| AI requests per subject | 60 / 3600 s | `AI_REQUESTS_PER_HOUR` | pseudonymous `subjectKey` | `AIOrchestrator.handle` step 1 |

Exceeding a Telegram limit records a `RATE_LIMIT` security event (with `telegramId` and `requestId`) and replies with the remaining wait in seconds — `You are sending messages very quickly. Please wait Ns.` externally, `Too many messages. Please wait Ns.` internally. Exceeding the verification limit replies `Too many verification attempts. Please try again later.` and issues no code.

The verification budget is consumed **before** the e-mail is even parsed, so a malformed `/verify` still costs a slot; that is deliberate, since the alternative lets an attacker probe addresses for free. The `/code` path is bounded separately by `max_attempts` on the code row (5, see [§11](#11-identity-verification-flow)) rather than by the rate limiter.

KV is eventually consistent, so a cold edge may admit a small number of extra requests. The rate limiter is a cost and abuse control; authorisation, not the limiter, is what protects data.

---

## 8. Update normalisation and what is not trusted

`normaliseUpdate(raw)` (`packages/telegram/src/webhook.ts`) validates the payload and reduces it to a `NormalisedUpdate`. It returns `null` — meaning "nothing actionable", answered with 200 — when:

- the body is not an object, or `update_id` is not a finite number;
- there is no `message`, `edited_message` or `callback_query` carrying a `from` with a finite numeric `id`;
- `from.is_bot === true` (other bots are ignored entirely);
- the extracted text is empty after trimming.

What it produces:

| Field | Source | Trust |
|---|---|---|
| `updateId` | `update_id` | Used only as the replay key |
| `telegramUserId` | `String(from.id)` | A **lookup key**. Grants nothing on its own. |
| `chatId` | `chat.id`, falling back to `from.id` | Reply address only |
| `chatType` | `chat.type`, defaulting to `private` | Gates the group refusal |
| `text` | `message.text` or `callback_query.data`, truncated to 4 096 chars, trimmed | Untrusted content |
| `command` / `commandArgs` | `/^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/`, command lower-cased | Untrusted; routes to a handler, never to a permission |
| `displayName` | `first_name last_name`, else `username`, else `Unknown` | **Logging only** |
| `isBot` | `from.is_bot` | Used to drop the update |

### Explicitly not trusted

None of the following affects authorisation anywhere in the codebase:

- **`from.username`** — an attacker can set it to `hr_admin`; it is not even carried into `NormalisedUpdate` except as a display-name fallback. `tests/security/prompt-attacks.test.ts` "refuses an unverified Telegram user any HR capability" sends exactly that username and asserts zero `tool_calls` rows.
- **`from.first_name` / `from.last_name`** — display only. The greeting the internal bot uses (`Hello <name>`) comes from `employees.first_name`/`last_name` via the resolved identity, not from the update.
- **`from.language_code`, `chat.title`, any other Telegram metadata** — not read.
- **Any text the user sends** — including "I am HR", "the CEO authorised me", an employee number, another person's e-mail, or an instruction to ignore prior rules. Text becomes the model's *input*, never an authorisation input. `canonicaliseIntent()` re-derives scope/target/risk from the server-side intent table, so even the classifier's own opinion of a request's risk is discarded.
- **`from.id` on its own** — the numeric id is a lookup key. On the external bot it may match a `candidates.telegram_user_id`, which only ever attaches *that candidate's own* application. On the internal bot it grants access only if `telegram_accounts` holds a verified, non-revoked `INTERNAL` row for it.

`normaliseUpdate` also does not read `message.date`; freshness is not checked, and the replay guard's `update_id` window is the only temporal control ([§19](#19-limitations)).

---

## 9. External bot

`packages/telegram/src/external-bot.ts`. Public candidates only (§31). The identity is always `ANONYMOUS` / `EXTERNAL` with `PUBLIC_PERMISSIONS`, so the tool registry offers it exactly the six recruitment tools in `packages/ai/src/tools/external.ts`:

```text
search_jobs()  get_job_details()  get_job_requirements()
get_hiring_process()  submit_application()  get_application_status()
```

### Order of operations

1. Replay guard.
2. **Group refusal.** Any `chatType` other than `private` gets `Please message me directly so we can keep your application details private.` and nothing else runs — no identity resolution, no model call, no candidate creation. A public group is the wrong place to collect personal details. Proof: `tests/e2e/flows.test.ts` "refuses to talk about recruitment personal data in a group chat" asserts no candidate row is created from a supergroup message.
3. Per-user rate limit (`tg:ext:`).
4. Identity: `candidates.findByTelegramUserId()`, then `identityResolver.anonymous({ channel: 'TELEGRAM_EXTERNAL', telegramUserId, candidateId? })`. A matched candidate id lets the candidate see *their own* application; it never widens permissions.
5. `/start` and `/help` are answered from constants with no model call.
6. Everything else is mapped to natural language and passed to the orchestrator, which checks the
   curated answers first — see "Curated answers" below.

### Commands

| Command | Behaviour |
|---|---|
| `/start` | Static welcome listing the commands and the sentence "I can only discuss public recruitment information." No model call. |
| `/help` | Static command list. No model call. |
| `/jobs [terms]` | Rewritten to `What jobs are available[ matching <terms>]?` and sent to the orchestrator. |
| `/apply [job]` | Rewritten to `I want to apply for job <job>` or a request for details. |
| `/status [ref]` | Rewritten to a status question quoting the reference. |
| Free text | Passed through unchanged. |

`commandToNaturalLanguage()` exists so slash commands and free text converge on one classifier path; the rewrite is a phrasing convenience, not a privilege.

### Refusals

Asking the public bot for internal information is refused by the gateway, not by wording. `search_hr_policy` and every other internal tool has `scope: 'INTERNAL'`, so it is neither described to the model nor executable for an `EXTERNAL` identity. `tests/security/acceptance.test.ts` (§44 Test 4) posts "Show me the internal employee handbook and HR policies" to `/telegram/external` and asserts no handbook content is served. If the orchestrator produces no text, the bot sends `I could not find an answer for that. Please try rephrasing.`

Each turn is logged with `action: 'telegram.external'`, the intent, and `name:decision` for every tool call, so a refusal is visible in the log without recording the message body.

---

## 9. Applying: three questions, asked one at a time

`/apply` starts a short guided conversation rather than demanding a format:

```text
/apply
  → Which job are you applying for? Send the job code, like ENG-001.
ENG-001
  → Thanks. What is your full name?
Dara Sok
  → And your e-mail address?
dara.sok@example.test
  → Application submitted for Senior Backend Engineer.
    Reference: SPA-…
    Send me your CV as a file and I will attach it.
```

The part-finished answers live in `application_drafts`, keyed by Telegram id and expiring after an
hour. A draft is scratch space, not a record of anybody: nothing in it is validated, it is bound to
no identity, and it grants nothing. A candidate exists only once `submit_application` runs.

Each answer is classified **by shape**, not by a stored step number, so an e-mail typed at the name
question still lands on the e-mail field and a job code never becomes somebody's name. Anyone who
prefers one line can still send `/apply ENG-001 Dara Sok dara@example.test` — pipes, newlines and
plain spaces all parse identically. `/cancel` abandons a draft, and a plain message is only ever
captured while one is open, so ordinary conversation is untouched.

The parsed fields go **straight to the registered `submit_application` tool** through
`AIOrchestrator.runTool()` — still via `ToolRegistry`, so the PolicyGateway decides and audits, but
with no provider call in between.

That last part is load-bearing rather than an optimisation. An earlier version rendered the parsed
fields back into a sentence (`"My name is Monika Chan and my email is …"`) and let the provider
re-extract them; the provider's name regex ran past the name and created a candidate called
*"Monika Chan and my email is monika"*. Arguments that are already known must not be laundered back
through a model.

A message the bot cannot classify — when no draft is open — gets a recruitment-appropriate reply listing `/jobs`, `/apply`,
`/cv` and `/status` — **not** the internal "contact HR" referral, which names a department an
outside candidate has no relationship with.

---

## 9a. CV uploads on the external bot

A candidate can send their CV as a Telegram document. The bot handles a file before any model call —
a file is not a question.

`/cv` is the discoverable way in — it is in the bot's command menu — but a file dragged in with no
command works identically, because that is what people actually do.

```text
/cv  (or a document message with no command)
      ↓
 no file attached ? ──→ explain how to send one, and say whether a CV is already on file
      ↓
 candidate resolved from telegram_user_id ? ──no──→ "apply first so I know who this belongs to"
      │ yes
      ↓
 format allow-list (PDF / DOCX / TXT / MD) and 5 MB cap  ← checked BEFORE any download
      ↓
 upload rate limit  (tg:cv:<id>, the application budget)
      ↓
 client.downloadFile()  → getFile, then the file endpoint
      ↓
 CvIntakeService: store original → extract text → scan for injection → row
      ↓
 "I have attached <filename> to your application."
```

Points that matter:

- **The candidate must already be identified.** The CV attaches to the candidate the Telegram id
  already resolves to, which exists only because they applied and gave a real name and e-mail.
  A file from an unknown id is refused rather than owned by a guess (§12).
- **The download URL embeds the bot token**, so it is never logged, returned or put in an error
  message — only the byte count is.
- **Format and size are checked before downloading**, so a hostile 20 MB file costs no transfer.
  Accepted formats are **PDF, DOC and DOCX** only.
- **A photo is not a file.** Telegram sends a photographed CV as `photo`, not `document`, and that
  used to normalise to nothing — the bot answered with silence, which is indistinguishable from
  being broken. A photo, video or voice note now gets an explicit "send it as a file" reply.
- **Every refusal is logged with its reason** (`cv_no_candidate`, `cv_bad_format`, `cv_too_large`,
  `cv_rate_limited`, `cv_download_failed`) and answered. A failed upload was previously invisible
  from both ends.
- **A separate, tighter rate limit** than ordinary messages: a download costs far more than a reply.
- **Extraction failure is not the candidate's problem.** Neither PDF nor legacy `.doc` text is read
  automatically; both are stored, the original stays downloadable, and HR pastes the text in the
  dashboard so it can be matched. DOCX is read natively.

Where it goes next: **Recruitment → CVs** in the dashboard, which reads and filters but never
ingests — intake is the bots. See `docs/database.md` §3.9 for the
schema and `docs/security.md`, "Candidate CVs", for the access rules.

---

## 9b. CV forwarding on the internal bot

Staff can forward a CV they received elsewhere. The sender is an employee, not the candidate, so
there is nothing in the Telegram identity to attach the file to — the **caption names the
candidate**: `/cv <e-mail-or-reference>`, or a bare reference.

```text
/cv <reference>  (with or without a file), from a verified employee
      ↓
 gateway.authorize(candidate.document:create)  ← needs `candidate.document.manage`
      │                                          checked FIRST, so someone who may not forward
      │ DENY → the gateway's own message           learns before preparing a file
      ↓ ALLOW
 no file attached ? ──→ explain the format, and confirm the candidate exists
      ↓
 candidate found by e-mail or reference ? ──no──→ refused; no candidate is created
      ↓
 format allow-list (PDF / DOC / DOCX) and 5 MB cap  ← before any download
      ↓
 upload rate limit → downloadFile → CvIntakeService
      ↓
 "Attached <file> to <candidate>." plus whether the text could be read
```

`uploaded_by_user_id` records who forwarded it, and `source` is `TELEGRAM_INTERNAL`, so the
dashboard can tell a candidate's own CV from one staff supplied. A plain EMPLOYEE or MANAGER cannot
forward: writing to a candidate record needs `candidate.document.manage`, an HR permission.

---

## 10. Internal bot

`packages/telegram/src/internal-bot.ts`. Verified employees only (§32). An unlinked Telegram id can do exactly one thing: start the verification flow.

### Order of operations

1. Replay guard.
2. **Group refusal**, stricter in wording than the external bot: `For confidentiality I only respond in a direct message.` HR data must never be rendered into a shared conversation.
3. Per-user rate limit (`tg:int:`).
4. `/verify` and `/code` are handled *before* identity resolution — they are the only capabilities an unverified id has.
5. `identityResolver.fromTelegramInternal()`. On failure: an `UNKNOWN_USER` security event plus a reason-appropriate message, and the turn ends. No tool, no model call, no conversation row.
6. `/start` and `/help` for a verified user return `Hello <employee name>` plus the capability list.
7. Everything else goes to the orchestrator with the resolved `UserIdentity`, which checks the
   curated answers first — see "Curated answers" below.

### Commands for a verified employee

| Command | Rewritten to |
|---|---|
| `/balance` | `What is my remaining leave balance?` |
| `/leave` | `Show my leave requests` |
| `/request [details]` | `I want to request leave: <details>` or a prompt for details |
| `/holidays` | `What are the upcoming public holidays?` |
| `/policy <question>` | the question verbatim |
| `/approvals` | `Show pending leave requests from my team` |
| `/start`, `/help` | Static capability list, no model call |
| Free text | Passed through unchanged |

`/approvals` is listed for everyone but is not a grant: it resolves to `get_team_leave_requests`, which requires `leave.read.team` (`packages/ai/src/tools/internal-management.ts`), and a plain employee's request is denied by the `PolicyGateway` and audited as a `DENY`. The command list is UX; permission is backend.

### Citations

When the orchestrator returns knowledge citations, the internal bot appends them:

```text
Source: Employee Handbook — Annual Leave (v3); Leave Policy (v2)
```

built from `citation.documentName`, optional `section` and `version`. Only chunks the identity was authorised to retrieve ever reach the model, so a citation cannot name a document the reader may not see. When the orchestrator returns nothing usable the bot sends `I could not answer that. Please contact HR.` rather than guessing (§30).

### Refusal messages when identity resolution fails

| `reason` | Message |
|---|---|
| `LINK_REVOKED` | `Your Telegram link has been revoked. Please contact HR.` |
| `EMPLOYEE_INACTIVE`, `USER_DISABLED` | `Your account is not active. Please contact HR.` |
| anything else (`NOT_LINKED`, `EMPLOYEE_MISSING`) | The verification instructions |

---

## 10a. Curated answers (bot training)

Both bots can answer from question/answer pairs an HR author publishes in the dashboard under
**Bot answers**. The orchestrator consults them before planning any tool call, and
serves a match **verbatim** — no provider call, no paraphrase, no cost.

| | External bot | Internal bot (unverified) | Internal bot (verified) |
|---|---|---|---|
| Audiences it may serve | `EXTERNAL`, `BOTH` | `INTERNAL`, `BOTH` | `INTERNAL`, `BOTH` |
| Classification ceiling | `PUBLIC` only | `PUBLIC` only | The caller's own ceiling |
| Account-gated answers | n/a | **No** | Yes |
| Typical use | Hiring process, what to bring to an interview | Who approves leave, how to reach HR, office hours | Payroll portal, leave balances, policy detail |

This is the only knowledge path the external bot has. Policy documents remain INTERNAL and
unreachable from the public zone, which is exactly why a candidate-facing answer has to be written
deliberately rather than retrieved: an author with `faq.manage` decides what candidates may be told.

Behaviour worth knowing when reasoning about a reply:

- Only `ACTIVE`, in-date answers are served. A `DRAFT` is invisible to both bots, which makes the
  draft state a genuine review step — and is the first thing to check when a newly authored answer
  "does not apply": the form saves a draft unless the status is set to ACTIVE, and the dashboard
  now says so on save and offers a **Publish it now** button.
- A match must clear a relevance threshold (≥ 0.67 stem coverage, ≥ 2 matching stems). Below it the
  bot falls through to its normal tools, so an adjacent question is not answered with the wrong
  approved text.
- Adding **training phrasings** to an answer is what widens the ways the bot recognises it. A
  phrasing that is not listed is a phrasing the bot will not match.
- **A command can be bound to an answer.** `/benefits` runs the same turn as asking the question, so
  audience, classification and the account gate all still apply — an unauthorised command behaves
  exactly like an unknown one. **Bot answers → Command menus** shows what each
  bot would publish and pushes it with `setMyCommands`. Only `ACTIVE`, in-date, **PUBLIC** answers
  are listed, because Telegram shows the menu to anyone who opens the bot before they verify; a
  command on a more sensitive answer still works, it is just not advertised. Built-ins are always
  sent alongside curated commands, since `setMyCommands` replaces the whole list.
- **A curated answer never answers a person-specific question.** Intents whose `target` is `SELF` or
  `OTHER_EMPLOYEE` skip the curated path entirely: "my leave balance" comes from the database (§38).
- **A question about doing something is not an instruction to do it.** The classifier separates the
  two before its rules run (see `docs/ai.md` §4.1), so "how do I request sick leave?" reaches the
  approved process rather than trying to book leave with no dates, "who approves my leave request?"
  reaches the approval chain rather than the asker's balances, and "can I apply for two positions?"
  is answered rather than filed as an application. The seed set ships answers for all three, plus the
  working location, the documents a candidate needs, and how to request annual leave — `tests/e2e/bot-faq.test.ts`
  drives them through the real webhooks.
- Salary-shaped questions are never answered this way. `RESTRICTED`-risk intents skip the curated
  path and go to the PolicyGateway, which refuses and writes an audited `DENY`.
- **An unlinked Telegram id can get general answers without verifying.** Not every internal question
  is a personal one, so an author can mark an answer "answer this without a verified account". Only
  `PUBLIC` answers may be marked that way, and the unverified path reaches curated answers and
  nothing else — no tool, no document, no employee record — so a personal or credential question
  still ends at the verification prompt. Replies on that path carry a footer explaining how to link
  an account for the rest.
- When neither a curated answer nor an authorised tool can answer, the internal bot records the
  question in the training backlog, which is what HR works through in the dashboard.

Authors can dry-run either bot from **Test a bot** on the training page without publishing anything;
the external preview is capped at `PUBLIC` so it shows what a candidate would see, not what the
author can see.

Full mechanics: `docs/rag.md` §14. Security properties: `docs/security.md`, "Curated bot answers".

---

## 11. Identity verification flow

§12 forbids trusting a username, a display name, or a user-supplied employee id. CORPUS therefore never accepts an identifier from the user: the user supplies a **company e-mail**, and the backend resolves the employee itself.

```text
 Telegram user                InternalBot                  TelegramIdentityService / D1
 ─────────────                ───────────                  ────────────────────────────
 /verify jane@company.com ──► rate limit tg:verify:<id>
                              validate e-mail syntax
                                   │
                                   └──► requestLink() ──►  employees.findByEmail(tenant, email)
                                                           consume any outstanding code for this
                                                             Telegram id (whether or not matched)
                                                           if no ACTIVE / ON_LEAVE employee:
                                                             return { accepted: true, deliverTo: null }
                                                           else:
                                                             code = randomNumericCode(6)   CSPRNG
                                                             store sha256(<telegramId>:<code>)
                                                             expires_at = now + 10 min
                                                             max_attempts = 5
                                   ┌───────────────────────  { deliverTo: { email, code } }
                                   │
                              codeDelivery.deliver(...)  ── e-mail, OUT OF BAND (never Telegram)
                                   │
 ◄── "If that address belongs to an active employee, a 6-digit code has been sent to it."
                              (identical text either way)

 /code 123456 ──────────────► strip non-digits, require exactly 6
                                   └──► verifyLink() ───►  findActive(TELEGRAM_LINK, telegramId, now)
                                                           no row              ─► NO_ACTIVE_CODE
                                                           attempts >= max     ─► TOO_MANY_ATTEMPTS (consume)
                                                           recordAttempt()
                                                           timingSafeEqual(sha256(<telegramId>:<code>),
                                                                           stored hash)
                                                           mismatch            ─► INVALID_CODE
                                                           no employee on row  ─► INVALID_CODE (consume)
                                                           markConsumed()
                                                           telegram_accounts.link(scope INTERNAL,
                                                             employeeId, userId)
 ◄── "Your account is verified." + capability list
```

Implementation: `packages/auth/src/telegram-identity.ts`, storage in `migrations/0001_core_identity.sql` (`verification_codes`, `telegram_accounts`).

### Properties

| Property | How |
|---|---|
| The user never names an employee | `requestLink` takes `claimedEmail` and uses it only as a lookup key; the resulting `employee_id` is written on the code row by the backend. `verifyLink` links the employee **from the code row**, never from anything the user re-sends. |
| The code is never stored | Only `sha256(<telegramUserId>:<code>)` is persisted (`code_hash`). |
| A code is bound to one Telegram id | The id is part of the hashed pre-image, so a code observed for one account cannot be redeemed by another. |
| Single use | `markConsumed()` runs on success and on the terminal failures; `findActive` ignores consumed rows. |
| Bounded guessing | `max_attempts` 5 (`MAX_CODE_ATTEMPTS`), incremented before comparison, plus 5 `/verify` requests per 15 minutes. |
| Bounded lifetime | `CODE_TTL_SECONDS = 600`. Retention policy deletes `verification_codes` after 1 day (`migrations/0005_security_conversations.sql`, applied by `scripts/prune.ts`). |
| Constant-time comparison | `timingSafeEqual` on the two hex digests. |
| Never logged | The logger's `redact()` strips any key matching `code`; `requestLink` logs `result: 'issued'` and the employee id only. |
| Inactive staff cannot link | Only `ACTIVE` and `ON_LEAVE` employees produce a code. |
| Failures are recorded | Each failed `/code` writes an `AUTH_FAILURE` security event with the reason. |

### Enumeration resistance

The reply to `/verify` is byte-identical whether or not the address matched an employee:

> If that address belongs to an active employee, a 6-digit code has been sent to it. Reply with `/code` followed by the digits. The code expires in 10 minutes.

`requestLink` also calls `consumeOutstanding()` **before** branching on whether the employee was found, so the matched and unmatched paths do the same database work and timing does not separate them either. Proof: `tests/e2e/flows.test.ts` "does not reveal whether an e-mail belongs to an employee" posts a real seed address and a non-existent one, asserts both return 200, and asserts exactly one `verification_codes` row exists across the two.

### The delivery requirement — a production blocker

`VerificationCodeDelivery.deliver()` must put the code in the employee's **company mailbox**. That is the entire security value of the step: possession of the mailbox is what proves the Telegram user is the employee. Sending the code back over Telegram would let anyone who knows an address link their own account, which is exactly the attack the flow exists to stop. The interface doc-comment states this, and no code path returns the code to the chat or to any API response body (`/auth/telegram/link` returns `{ accepted: true }` only).

**There is no mail transport in this repository, and the code is never logged in production.**
`selectCodeDelivery(config.environment, logger)` (`packages/telegram/src/internal-bot.ts`) chooses
the sink: `production` and `staging` get `NullCodeDelivery`, which discards the code and logs only
that no transport is configured, so verification simply cannot complete — the safe outcome.
`validateConfig()` raises `VERIFICATION_CODE_TRANSPORT` as an **error**, so `/health` reports the
gap alongside the other degradations. In `development` and `test` the sink is
`LogOnlyCodeDelivery`, which prints:

```text
[CORPUS dev] verification code for jane@corpus.test: 123456 (valid 10 minutes).
Configure a mail transport for production.
```

using `console.warn` deliberately, because the structured logger would redact the code. This is a **development-only sink and a production blocker**: deployed as-is, the only way to complete a link is to read the Worker's log, which means anyone with log access can link any account. Before production, implement a real `VerificationCodeDelivery` (e-mail) and select it by environment in `apps/api/src/routes/telegram.ts`.

### Dashboard equivalent

`apps/api/src/routes/auth.ts` exposes the same flow to a signed-in dashboard user:

- `POST /auth/telegram/link` — body `{ email }` **must equal the session's own e-mail**; a mismatch records an `IDENTITY_SPOOF_ATTEMPT` and returns 403. Without a `?telegramUserId=<digits>` query parameter it returns 202 with instructions to use the bot. The code is never in the response.
- `POST /auth/telegram/verify` — body `{ code, telegramUserId }`, rate limited by `verify:<userId>`; failures record `AUTH_FAILURE` and return 401. The link is made against the employee resolved from the *code row*.

Proof: `tests/security/prompt-attacks.test.ts` "cannot link a Telegram account to another employee".

---

## 12. Identity resolution on every later message

Verification is not a session. Every subsequent internal-bot message re-resolves the identity from the database through `IdentityResolver.fromTelegramInternal()` (`packages/auth/src/identity-resolver.ts:104`):

1. `telegramAccounts.findVerified(scope, telegramUserId, 'INTERNAL')` — a verified, non-revoked, `INTERNAL`-scope row is required. A missing row falls back to `findAny()` purely to distinguish `LINK_REVOKED` from `NOT_LINKED` for the user-facing message.
2. The row must carry an `employee_id`, and that employee must exist. `TERMINATED` or `SUSPENDED` ⇒ `EMPLOYEE_INACTIVE`.
3. The user account is loaded via `link.user_id`, else by `users.findByEmployeeId`. A non-`ACTIVE` user ⇒ `USER_DISABLED`.
4. Roles come from `user_roles` via `users.listRoles()`. An employee with no user account gets the baseline `EMPLOYEE` role so self-service works; nothing else.
5. Permissions come from `permissionsForRoles()`; `managedEmployeeIds` from `employees.manager_id` / `employee_managers`.

So a revocation, a termination or a role change takes effect on the *next message* with no session to expire. The resulting `UserIdentity` carries `zone: 'INTERNAL'`, `channel: 'TELEGRAM_INTERNAL'` and a pseudonymous `subjectKey` (HMAC of `channel:telegramUserId` under the session secret, truncated to 22 chars) used for rate limiting and conversation threading rather than the raw id.

`telegram_accounts` has a unique index on `(tenant_id, telegram_user_id, scope)`, so a Telegram id can hold at most one internal link per tenant and the resolution is unambiguous.

---

## 13. Error policy: always 200 after the secret check

Once the secret verifies, both endpoints answer `200 {"ok": true}` on every path, including failures. The route comment gives the reason:

> Telegram retries any non-200, and a retry storm on a handler error would amplify the problem.

Concretely, 200 is returned when the tenant is missing (logged `result: 'no_tenant'`), the body is not valid JSON, `normaliseUpdate` returns `null`, the update is a duplicate, the chat is a group, the rate limit is exceeded, identity resolution fails, the AI provider errors, or the handler throws — the `try/catch` around `handle()` logs `result: 'handler_error'` with the error message and falls through to 200.

The consequences are deliberate:

- A bug cannot turn into an infinite Telegram retry loop that burns the free-tier request budget.
- A caller cannot use the status code as an oracle. The e-mail-enumeration test relies on this: both `/verify` calls return 200 and the only difference is a database row the caller cannot observe.
- Diagnostics live in the log and in `security_events`, not in the response — so operators must look there, not at Telegram's delivery status, when a bot misbehaves.

The single exception is the 401 for a failed secret check, which is safe because genuine Telegram traffic always carries the header.

---

## 14. Outbound client

`TelegramClient` (`packages/telegram/src/client.ts`) wraps the Bot API.

| Aspect | Behaviour |
|---|---|
| Methods used | `sendMessage`, `sendChatAction` (typing indicator), `setWebhook`, plus unused `deleteWebhook` / `getWebhookInfo` helpers |
| Token handling | Appears only in the request URL to `api.telegram.org`; never logged, never returned |
| Not configured | `configured === false` skips the send and logs `result: 'not_configured'` |
| Message length | Truncated to 4 096 characters (Telegram's own limit) |
| Link previews | `disable_web_page_preview: true` on every send |
| Timeout | 10 s via `AbortController` |
| Error logging | Method name and HTTP status only — Telegram's `description` can echo request content, so it is never logged |
| Failure mode | Returns `false`; there is no retry and no outbound queue |

`setWebhook` registers `allowed_updates: ['message', 'edited_message', 'callback_query']` with `drop_pending_updates: true`, so a re-registration discards whatever queued while the endpoint was down.

---

## 15. Registering the webhooks

`scripts/telegram-setup.ts` (§61 step 7), exposed as two npm scripts:

```bash
npm run telegram:setup     # register both webhooks, then report the result
npm run telegram:status    # report only — changes nothing
```

**Configuration is read for you.** Values already in the environment win; anything
still unset is loaded from `apps/api/.dev.vars`, then `.env`. That matters because
retyping a secret onto a command line is the most common way to register one value
with Telegram while the Worker checks another — which manifests as every delivery
silently 401ing. Nothing secret is ever printed.

So in normal use there is nothing to pass:

```bash
npm run telegram:setup
```

Environment variables still override the files, which is what CI and one-off
production runs use:

```bash
API_BASE_URL=https://corpus-api.example.workers.dev npm run telegram:setup
```

### Local development: the tunnel

Telegram will not call `http://` or `localhost`, so a local Worker needs a public
HTTPS front. With `cloudflared`:

```bash
brew install cloudflared                              # once
cloudflared tunnel --url http://127.0.0.1:8787        # leave running
```

**You do not need to copy the URL it prints.** A quick tunnel is issued a *new*
hostname every time it restarts, so any value written into `.env` goes stale — and
a stale webhook looks exactly like the bot ignoring everybody. The script therefore
queries the running tunnel's local metrics listener
(`127.0.0.1:20241/quicktunnel`, then 20242/20243) and **prefers the live tunnel over
the configured `API_BASE_URL`**, reporting both when they differ. After restarting a
tunnel, just run `npm run telegram:setup` again.

### Behaviour

| Condition | Result |
|---|---|
| A `cloudflared` quick tunnel is running | Its URL is detected and used in preference to `API_BASE_URL` |
| `API_BASE_URL` unset, not `https://`, and no tunnel found | Prints the tunnel instructions and exits 1 without contacting Telegram |
| `<base>/health` is unreachable or non-2xx | Exits 1 before registering, rather than pointing Telegram at a dead URL |
| Both bots share a webhook secret | Exits 1 — that separation is what stops a request meant for the public bot being replayed against the internal one |
| A bot's token is empty | `• <bot>: no bot token configured, skipped` — not a failure, so one bot can be registered alone |
| A bot's secret is missing or under 16 characters | Counted as a failure |
| `setWebhook` succeeds | `• <bot>: webhook set to https://…/telegram/<bot>`, followed by the state read back from Telegram |
| Telegram reports a `last_error_message` | Printed, with a hint distinguishing a 401 (secret mismatch) from a connection error (URL unreachable) |
| Telegram reports a different URL than the one just set | Counted as a failure |

Exit code is 1 if any bot failed, 0 otherwise, so it is usable as a deployment gate.
Paths are hard-coded to `/telegram/external` and `/telegram/internal`.

After every run — and for `--status`, instead of registering — the script reads
`getWebhookInfo` back from Telegram and prints the registered URL, `pending_update_count`
and any `last_error_message`. Telegram's own view is the ground truth, so this is the
first thing to check when updates are not arriving.

Run it **after** the Worker is up and the secrets are set. Re-run after any change of
Worker URL (including a tunnel restart) or webhook secret.



---

## 16. Security events emitted

All are written through `SecurityEventService` and readable at `GET /security/events` with `security.read`.

| Event | Severity | Raised when | Where |
|---|---|---|---|
| `AUTH_FAILURE` | HIGH (`MISSING_HEADER`, `BAD_SECRET`) / MEDIUM (`NO_SECRET_CONFIGURED`) | Webhook secret check fails | `apps/api/src/routes/telegram.ts` |
| `AUTH_FAILURE` | default | `/code` submission fails (`NO_ACTIVE_CODE`, `INVALID_CODE`, `TOO_MANY_ATTEMPTS`) | `InternalBot.handleCodeSubmission` |
| `UNKNOWN_USER` | default | An unverified Telegram id messages the internal bot; the resolution reason is in the summary | `InternalBot.handle` |
| `RATE_LIMIT` | default | Message or verification budget exhausted, either bot | `ExternalBot.handle`, `InternalBot.handle*` |
| `IDENTITY_SPOOF_ATTEMPT` | HIGH | Dashboard attempt to link Telegram to another employee's e-mail | `apps/api/src/routes/auth.ts` |
| `PROMPT_INJECTION` / `IDENTITY_SPOOF_ATTEMPT` | HIGH | Injection or role-claim patterns in the message text | `AIOrchestrator` via `scanForInjection()` |

Denied tool calls additionally leave `DENY` rows in `audit_logs` with a reason code and no internal detail.

---

## 17. Tests

| Test | File |
|---|---|
| Rejects a webhook with a wrong or missing secret (401 both ways) | `tests/security/prompt-attacks.test.ts` |
| Refuses an unverified Telegram user any HR capability — asserts an `UNKNOWN_USER` event and zero `tool_calls` rows | `tests/security/prompt-attacks.test.ts` |
| Cannot link a Telegram account to another employee | `tests/security/prompt-attacks.test.ts` |
| External bot cannot reach the employee handbook (§44 Test 4) | `tests/security/acceptance.test.ts` |
| Links an account only after a backend-issued code, then serves own data — and still refuses another employee's salary | `tests/e2e/flows.test.ts` |
| Does not reveal whether an e-mail belongs to an employee | `tests/e2e/flows.test.ts` |
| Ignores a duplicate Telegram update (replay protection) | `tests/e2e/flows.test.ts` |
| Refuses to talk about recruitment personal data in a group chat | `tests/e2e/flows.test.ts` |
| Caps Telegram messages per user (throttle appears as a security event, response stays 200) | `tests/integration/rate-limiting.test.ts` |

The tests drive the real Hono app over the real migrations and seed data; only the LLM (`MockAIProvider`) and outbound Telegram HTTP are stubbed. Seed accounts use the reserved `corpus.test` domain. Run them with `npm run test:security`, `npm run test:e2e`, `npm run test:integration`.

---

## 18. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Bot never replies; `getWebhookInfo` shows `last_error_message` with 401 | The Worker's secret differs from the one given to `setWebhook` | Re-run `scripts/telegram-setup.ts` with the same `TELEGRAM_*_WEBHOOK_SECRET` the Worker holds. Look for `AUTH_FAILURE` / `Telegram webhook rejected (BAD_SECRET)` in `GET /security/events`. |
| Every request 401s and events say `NO_SECRET_CONFIGURED` | The webhook secret is unset for that bot; the route fails closed | `wrangler secret put TELEGRAM_<BOT>_WEBHOOK_SECRET`. `GET /health` lists it under `configErrors`. |
| `getWebhookInfo` shows no URL, or the wrong one | `setWebhook` was never run, or ran against an old Worker URL | Re-run the setup script with the correct `API_BASE_URL`. |
| Script prints `webhook secret missing or too short` | Secret under 16 characters | Generate with `openssl rand -hex 32`. |
| Script prints `failed to set webhook (check the token)` | Wrong or revoked bot token | Re-copy from BotFather; confirm the external token is not being used for the internal bot. |
| Webhook returns 200 but nothing is sent back | Bot token unset ⇒ sends are skipped | Look for `telegram send skipped: bot token not configured`; `GET /health` shows `externalBotConfigured` / `internalBotConfigured`. |
| Internal bot always answers with the verification instructions | No verified `INTERNAL` link for that Telegram id | Complete `/verify` + `/code`. Confirm a `telegram_accounts` row with `scope='INTERNAL'`, `verified_at` set and `revoked_at` null. |
| `/verify` accepted but no code arrives | No mail transport is implemented. In development `LogOnlyCodeDelivery` prints the code to the console; in production `NullCodeDelivery` discards it | See [§11](#11-identity-verification-flow). In development read the `[CORPUS dev]` line from `wrangler tail`; in production a `VerificationCodeDelivery` implementation must be added — `/health` reports `VERIFICATION_CODE_TRANSPORT` until then. |
| `/code` says "I do not have a pending code" | Code consumed, expired (10 min), or a newer `/verify` invalidated it | Send `/verify` again. |
| `/code` says "Too many incorrect attempts" | 5 attempts used on that code row | Send `/verify` for a fresh code. |
| "Too many verification attempts" | 5 `/verify` calls in 15 minutes | Wait out the window, or raise `RATE_LIMIT_VERIFY_PER_15M`. |
| Bot replies "Your account is not active" | Employee `TERMINATED`/`SUSPENDED`, or the user account is not `ACTIVE` | Intentional; fix the employee/user record. |
| Bot replies "Your Telegram link has been revoked" | A `telegram_accounts` row exists with `revoked_at` set | Intentional; the employee must re-verify after HR clears it. |
| Nothing happens in a group | Both bots refuse non-private chats | Message the bot directly. Disable group joins in BotFather for the internal bot. |
| A message is silently ignored | `normaliseUpdate` returned null — no text, a bot sender, a photo/sticker/document with no caption text, or a malformed payload | Send text. Non-text attachments are not handled ([§19](#19-limitations)). |
| The same action happened twice | Replay guard degraded: no KV binding, so `MemoryReplayGuard` is per-isolate | Bind the `RATE_LIMIT` KV namespace in `wrangler.toml`. |
| Rate limits look loose under load | KV counters are eventually consistent across edges | Expected; tighten `RATE_LIMIT_TELEGRAM_PER_MINUTE` if needed. |
| A permitted-looking request is refused for HR staff | `maxRiskInChat` caps RESTRICTED resources on chat channels | Intentional — use the dashboard for compensation, offers, audit and security data. |
| Log shows `telegram webhook received before tenant initialisation` | Migrations/seed not applied, or `DEFAULT_TENANT_SLUG` does not match a `tenants` row | Run `npm run db:migrate` and `npm run db:seed`; check the var. |

---

## 19. Limitations

Known gaps between `CLAUDE.md` and the code as it stands.

| Gap | Detail | What closing it requires |
|---|---|---|
| **No e-mail transport (production blocker)** | `selectCodeDelivery()` returns `NullCodeDelivery` for production and staging, so the code is discarded rather than logged and internal Telegram linking cannot be completed in production. The failure is loud: `validateConfig()` raises `VERIFICATION_CODE_TRANSPORT` and `/health` lists it under `configErrors`. | A real `VerificationCodeDelivery` implementation, selected in `selectCodeDelivery()`. |
| **No attachment handling** | `normaliseUpdate` discards any update without text, so a CV sent as a Telegram document is dropped silently. `TelegramMessage.document` is modelled in `packages/telegram/src/types.ts` but nothing consumes it, and `submit_application` has no CV parameter. | Document intake: file download via the Bot API, R2 storage, a `cv_file_id` on the candidate, and size/type validation. |
| **No interactive UI** | `callback_query.data` is read as plain text; no bot sends inline keyboards or buttons, so multi-step flows (applying, requesting leave) are conducted entirely in prose. | Keyboard markup in `TelegramClient` and per-step state, which needs durable conversation state rather than the current stateless turn. |
| **No `setMyCommands`** | The BotFather command menu must be pasted manually ([§3](#3-botfather-setup)); `TelegramClient` has no method for it. | Add `setMyCommands` and call it from `scripts/telegram-setup.ts`. |
| **Setup script is register-only** | `deleteWebhook` and `getWebhookInfo` exist on the client but no script calls them; there is no unregister or status mode. | Flags on `scripts/telegram-setup.ts`. |
| **Secret only, no IP allowlist** | Telegram's published IP ranges are not checked; the shared secret is the sole webhook authentication. Cloudflare-level IP rules can add this outside the application. | Optional `cf-connecting-ip` check or a Cloudflare WAF rule. |
| **No freshness check** | `message.date` is not read. Replay protection is by `update_id` within a 1-hour KV TTL, so a captured update older than that window would not be recognised as a duplicate — though it would still need a valid secret to be accepted at all. | A staleness bound on `message.date`. |
| **Replay guard degrades without KV** | `MemoryReplayGuard` is per-isolate; with no `RATE_LIMIT` binding, duplicate updates can be processed on different isolates. | Bind KV in production (already the documented deployment step). |
| **Single tenant per deployment** | Both routes resolve the tenant from `DEFAULT_TENANT_SLUG`. The schema is multi-tenant (`tenant_id` on `telegram_accounts`, `verification_codes`), but there is no per-bot or per-tenant webhook routing. | A bot-to-tenant mapping keyed by path or bot id. |
| **No external-scope account links** | `telegram_accounts.scope` allows `'EXTERNAL'`, but no code writes such a row; the external bot recognises returning candidates through `candidates.telegram_user_id` instead. | Only needed if verified candidate accounts are introduced. |
| **`revokeLink` has no caller** | `TelegramIdentityService.revokeLink()` is implemented and the resolver honours `revoked_at`, but no route or dashboard action invokes it — revocation is currently a manual database operation. | An HR-facing endpoint plus a dashboard control, gated on an appropriate permission and audited. |
| **No outbound retry** | A failed `sendMessage` is logged and dropped; the user sees nothing. | A retry or queue, which the free-tier constraints in §52 deliberately avoid. |
