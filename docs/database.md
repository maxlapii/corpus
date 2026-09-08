# CORPUS Database

This document describes the schema that is actually committed in `migrations/`, the
repository layer that reads and writes it (`packages/db/`), and the tooling that applies,
seeds and prunes it. It is written against the source: where `CLAUDE.md` asks for something
the schema or tooling does not do, it is listed under
[Limitations / Roadmap](#limitations--roadmap).

Paths are relative to the repository root. Section references (`§n`) point at
[`CLAUDE.md`](../CLAUDE.md).

## Contents

1. [Engine and conventions](#1-engine-and-conventions)
2. [Migrations at a glance](#2-migrations-at-a-glance)
3. [Entity overview per migration](#3-entity-overview-per-migration)
4. [Tenancy and the TenantScope discipline](#4-tenancy-and-the-tenantscope-discipline)
5. [Constraints, CHECKs and indexes](#5-constraints-checks-and-indexes)
6. [Compensation isolation](#6-compensation-isolation)
7. [The leave balance transactional model](#7-the-leave-balance-transactional-model)
8. [Application events](#8-application-events)
9. [Knowledge versioning and supersession](#9-knowledge-versioning-and-supersession)
10. [The FTS5 virtual table and its triggers](#10-the-fts5-virtual-table-and-its-triggers)
11. [Audit logs and security events](#11-audit-logs-and-security-events)
12. [Rate-limit counters](#12-rate-limit-counters)
13. [Retention policies and pruning](#13-retention-policies-and-pruning)
14. [Migration tooling](#14-migration-tooling)
15. [The D1 → PostgreSQL path](#15-the-d1--postgresql-path)
16. [Limitations / Roadmap](#limitations--roadmap)

---

## 1. Engine and conventions

Production runs on **Cloudflare D1** (SQLite). Local development, scripts and the whole
integration/security/e2e test suite run the *same* SQL files against **better-sqlite3**
(`packages/db/src/sqlite-adapter.ts`), opened with `foreign_keys = ON`, `busy_timeout = 5000`
and — for file-backed databases — WAL journalling, so the local engine behaves like D1.

Business logic never touches a driver. It depends on `DatabaseService`
(`packages/db/src/database-service.ts`), which is constructed over the `SqlDatabase`
interface in `packages/db/src/sql.ts`. That interface is deliberately the shape D1 already
exposes (`prepare/bind/first/all/run/batch/exec`), so `fromD1()`
(`packages/db/src/d1-adapter.ts`) is a guard plus a cast rather than a translation layer.

| Convention | Detail |
| --- | --- |
| Primary keys | Opaque prefixed random strings — `prefixedId('emp')` → `emp_<18 chars>` from a 32-symbol alphabet (`packages/shared/src/ids.ts`). Never sequential, so an id leaks no cardinality and cannot be enumerated. |
| Timestamps | `TEXT` holding ISO-8601 UTC (`nowIso()`); dates are `TEXT` `YYYY-MM-DD`. String ordering equals chronological ordering, which is what every `ORDER BY timestamp DESC` relies on. |
| Booleans | `INTEGER` 0/1 with a `CHECK (col IN (0,1))`. Converted at the boundary by `asBool`/`boolToInt` (`packages/db/src/repositories/mappers.ts`). |
| Money and day counts | `REAL` (`base_salary`, `salary_min`/`salary_max`, `entitled_days`, `working_days`, …). See [§15](#15-the-d1--postgresql-path) for the `NUMERIC` migration note. |
| Parameterisation | Every value is bound. No user value is ever interpolated into SQL; dynamic arity (`IN (?, ?, …)`) is built from `placeholders(n)` or `map(() => '?')`, and dynamic column names come only from whitelists inside repositories. |
| Error surface | Driver errors are wrapped by `wrap()` in `database-service.ts`, so SQL text never reaches a client (§46); `isUniqueViolation` / `isForeignKeyViolation` let callers map them to `CONFLICT` without parsing text at the edge. |

Transactions go through `DatabaseService.transaction(build)`, which collects statements into
a `UnitOfWork` and commits them with `batch()`. On D1 `batch()` is an implicit transaction;
the SQLite adapter wraps the same statements in a real one. Either way there is no partial
application — which is what leave approval, application transitions and document versioning
depend on.

---

## 2. Migrations at a glance

Nine forward-only SQL files, applied in filename order. There are no down-migrations.

| File | Purpose | Tables created |
| --- | --- | --- |
| `migrations/0001_core_identity.sql` | Tenancy, users, RBAC tables, sessions, Telegram linkage, one-time codes | 9 |
| `migrations/0002_hr_core.sql` | Org structure, employees, compensation, leave, holidays | 10 |
| `migrations/0003_recruitment.sql` | Jobs, requirements, candidates, applications, interviews, offers | 7 |
| `migrations/0004_knowledge.sql` | Documents, versions, chunks, FTS5 index + 3 triggers | 4 (one virtual) |
| `migrations/0005_security_conversations.sql` | Audit, security events, conversations, tickets, rate limiting, retention | 9 |
| `migrations/0006_rbac_reference.sql` | **Generated** reference data: roles, permissions, grants (superseded by 0008) | 0 (data only) |
| `migrations/0007_knowledge_answers.sql` | Curated bot answers, training phrasings, FTS5 index + 3 triggers | 3 (one virtual) |
| `migrations/0008_rbac_reference.sql` | **Generated** reference data, reissued for the `faq.*` permissions | 0 (data only) |
| `migrations/0009_answer_account_gate.sql` | `requires_account` on curated answers, plus two guard triggers | 0 (column + triggers) |

`tests/integration/schema.test.ts` asserts that all six apply cleanly to a real SQLite
engine, that re-running is a no-op, and that every one of the 39 tables exists.

---

## 3. Entity overview per migration

### 3.1 `0001_core_identity.sql` — tenancy and identity

| Table | Purpose | Notable columns |
| --- | --- | --- |
| `tenants` | Root of every scope | `slug` UNIQUE, `status` ∈ {ACTIVE, SUSPENDED} |
| `roles` | Role catalogue (global, not per tenant) | `code` PK |
| `permissions` | Permission catalogue | `code` PK |
| `role_permissions` | Grants | PK (`role_code`, `permission_code`) |
| `users` | Dashboard/API accounts | `password_hash` (`algo$iterations$salt$hash`, PBKDF2-SHA256, nullable), `status` ∈ {ACTIVE, DISABLED, LOCKED}, `failed_login_count`, `locked_until`, `employee_id` |
| `user_roles` | Role assignment per user | Carries `tenant_id`, `granted_at`, `granted_by`; PK (`user_id`, `role_code`) |
| `sessions` | Server-side sessions | `token_hash` UNIQUE (SHA-256 of the bearer token — the token itself is never stored), `csrf_token`, `ip_hash`, `expires_at`, `revoked_at` |
| `telegram_accounts` | Telegram ↔ employee/user links | `scope` ∈ {EXTERNAL, INTERNAL}, `verified_at`, `revoked_at` |
| `verification_codes` | One-time codes for linking (§12) | `code_hash` only, `attempts`/`max_attempts` (default 5), `consumed_at`, `expires_at` |

Two identity rules are visible in the schema itself. `verification_codes.employee_id` is
described in the file as "backend-resolved subject — the requester supplies an e-mail,
never an id", and `telegram_accounts` stores the *link*, not a claim: the internal-zone
link is created only after a code is verified (`TelegramAccountRepository.link()`,
`packages/db/src/repositories/users.ts`, whose doc comment states the repository "does not
decide").

### 3.2 `0002_hr_core.sql` — HR core

| Table | Purpose | Notable columns |
| --- | --- | --- |
| `departments` | Org units, self-referencing | `parent_id` → `departments(id)` ON DELETE SET NULL |
| `positions` | Job titles/levels | `code` unique per tenant |
| `employees` | Employee master record | `employee_no`, `email`, `manager_id` (self-FK), `employment_type`, `status` |
| `employee_managers` | Explicit manager relation | `relation` ∈ {PRIMARY, SECONDARY} — allows matrix reporting without changing the employee row |
| `employee_compensation` | **RESTRICTED** salary history | Separate table; see [§6](#6-compensation-isolation) |
| `leave_types` | Leave catalogue | `paid`, `requires_approval`, `max_consecutive_days`, `counts_working_days_only`, `active` |
| `leave_balances` | Per employee/type/year | `entitled_days`, `used_days`, `pending_days`, `carried_over_days` |
| `leave_requests` | Requests | `working_days` (always server-computed), `status`, `submitted_at`, `decided_at` |
| `leave_approvals` | Decision trail | One row per decision, `approver_user_id` ON DELETE RESTRICT |
| `holidays` | Non-working days | `date`, `recurring`, `region` |

`listDirectReportIds()` unions `employees.manager_id` with `employee_managers`, so team
scoping sees both the column and the relation table
(`packages/db/src/repositories/employees.ts`).

### 3.3 `0003_recruitment.sql` — recruitment

| Table | Purpose | Notable columns |
| --- | --- | --- |
| `jobs` | Postings | `status` ∈ {DRAFT, PUBLISHED, CLOSED, ARCHIVED}, `salary_min`/`salary_max`, `salary_public` (0/1 — whether the range may be shown externally) |
| `job_requirements` | Structured requirements | `requirement_type`, `mandatory`, `priority` |
| `candidates` | Applicants | `email` unique per tenant, `telegram_user_id`, `cv_file_id` (storage key, not bytes) |
| `applications` | Candidate × job | `stage` (10 values), `status` ∈ {OPEN, CLOSED}, `reference` (opaque, globally unique) |
| `application_events` | Immutable stage history | `from_stage`, `to_stage`, `note`, `actor_user_id` |
| `interviews` | Scheduling and evaluation | `evaluation` and `score` are CONFIDENTIAL — never surfaced to the EXTERNAL zone |
| `offers` | Offers | `base_salary`, `status` ∈ {DRAFT, SENT, ACCEPTED, DECLINED, WITHDRAWN, EXPIRED} |

`applications.reference` (`SPA-…`, 20 uppercase base64url characters ≈ 120 bits, generated
in `ApplicationRepository.create()`) is a bearer credential: it is the only thing an
anonymous candidate can present to see their own status. Because it is globally unique
rather than tenant-prefixed, `findByReference()` re-checks `tenant_id` in the same query.

### 3.4 `0004_knowledge.sql` — knowledge base

| Table | Purpose | Notable columns |
| --- | --- | --- |
| `documents` | Logical document | `classification` ∈ {PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED}, `status` ∈ {DRAFT, ACTIVE, SUPERSEDED, ARCHIVED}, `category`, `owner` |
| `document_versions` | Effective-dated versions | `version`, `effective_from`, `effective_to`, `file_path` (R2 key or local storage key), `checksum`, `byte_size` |
| `document_chunks` | Retrieval units | `classification` and `effective_from`/`effective_to` **denormalised** from the document/version, plus `section`, `page`, `ordinal`, `content`, `token_estimate` |
| `document_chunks_fts` | FTS5 virtual table | See [§10](#10-the-fts5-virtual-table-and-its-triggers) |

The denormalisation is deliberate and is the mechanism behind §24: because a chunk row
carries its own classification and effective window, the permission filter is part of the
retrieval `WHERE` clause and unauthorised content is never loaded into memory, let alone
into a prompt (`KnowledgeRepository.searchChunks()`,
`packages/db/src/repositories/knowledge.ts`). `updateDocument()` keeps the denormalised
copy in step: changing a document's classification issues a matching
`UPDATE document_chunks SET classification = ?`.

### 3.5 `0005_security_conversations.sql` — audit, conversations, operations

| Table | Purpose | Notable columns |
| --- | --- | --- |
| `audit_logs` | Every authorisation decision | `decision` ∈ {ALLOW, DENY, ERROR}, `reason_code`, `risk`, `channel`, `bot`, `intent`, `resource`, `request_id`, redacted JSON `metadata` |
| `security_events` | Security taxonomy (§28) | `event_type`, `severity` ∈ {INFO…CRITICAL}, `subject_key`, `summary`, truncated `detail`, `acknowledged_at`/`acknowledged_by` |
| `conversations` | Chat threads | `subject_key` — a pseudonymous stable key, explicitly "not an identity claim" |
| `messages` | Turns | `role` ∈ {user, assistant, system, tool}; content truncated on write |
| `tool_calls` | AI tool invocations | `tool_name`, `decision` ∈ {ALLOW, DENY}, `reason_code`, `latency_ms` |
| `unanswered_questions` | "I don't know" outcomes (§30) | `question`, `resolved_at` |
| `hr_tickets` | Escalations | `status` ∈ {OPEN, IN_PROGRESS, RESOLVED, CLOSED} |
| `rate_limit_counters` | Durable limiter fallback | See [§12](#12-rate-limit-counters) |
| `retention_policies` | Retention bookkeeping | Seeded with six rows; see [§13](#13-retention-policies-and-pruning) |

### 3.6 `0006_rbac_reference.sql` / `0008_rbac_reference.sql` — generated reference data

Data only: 5 roles, 43 permissions and the full role→permission grant matrix, written by
`scripts/generate-rbac-migration.ts` from `packages/domain/src/roles.ts`. `SYSTEM_ADMIN` is
fully enumerated rather than wildcarded, "so every grant stays visible in the audit trail".
Drift between code and migration is a test failure — see
[§14](#14-migration-tooling).

The generator writes a **new numbered file** each time the permission set changes, rather than
rewriting the previous one. A migration runner records what it has applied by filename, so editing
an applied file would silently leave every existing database on the old grants. Each generated file
replaces the reference tables wholesale (`INSERT OR REPLACE` for roles and permissions, `DELETE`
then `INSERT` for grants), so a fresh database and an upgraded one converge on identical rows.
`0008` is the current one; bump `TARGET` in the generator for the next change.

### 3.7 `0007_knowledge_answers.sql` — curated bot answers

| Table | Purpose | Notes |
|---|---|---|
| `knowledge_answers` | One approved question/answer pair | `audience` ∈ {EXTERNAL, INTERNAL, BOTH}, `classification`, `status` ∈ {DRAFT, ACTIVE, ARCHIVED}, `requires_account` (0009), effective dates, `search_text` |
| `knowledge_answer_phrases` | Alternative phrasings the bot should recognise | Unique per `(answer_id, phrase)` |
| `knowledge_answers_fts` | FTS5 external-content index over `search_text` + `answer` | Kept in step by three triggers, mirroring `document_chunks_fts` |

Two CHECK constraints carry security weight:

```sql
CHECK (audience = 'INTERNAL' OR classification = 'PUBLIC')
CHECK (effective_to IS NULL OR effective_from <= effective_to)
```

The first is the last line of defence for the public bot: anything a candidate can be served is
`PUBLIC` at rest, whatever the application layer believes.
`tests/security/bot-training.test.ts` inserts straight through the repository to prove the
constraint holds on its own.

`search_text` is the question plus every training phrasing, denormalised so one FTS row covers every
way a person might ask. The repository rebuilds it on any phrase change.

The migration also adds `resolved_answer_id` and `resolved_by_user_id` to `unanswered_questions`,
linking a gap the bot had to the curated answer that now covers it.

### 3.8 `0009_answer_account_gate.sql` — the verified-account gate

Adds `requires_account INTEGER NOT NULL DEFAULT 1`, so an author can publish general staff
information ("who approves leave") that the internal bot answers before a Telegram id has been
linked, while anything personal or credential-bearing stays behind verification. Existing
external-audience rows are backfilled to `0`, since a candidate has no account to verify.

SQLite cannot attach a `CHECK` through `ALTER TABLE`, so the invariant is two `BEFORE` triggers
that `RAISE(ABORT)`:

```sql
WHEN (new.requires_account = 0 AND new.classification <> 'PUBLIC')
  OR (new.audience <> 'INTERNAL' AND new.requires_account <> 0)
```

Same guarantee as a constraint — the database refuses the row whatever the caller believes — and
the classification filter still runs independently, so the gate can never widen access to
classified text.

---

## 4. Tenancy and the TenantScope discipline

Every tenant-owned table carries `tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE
CASCADE`, and every composite index leads with it, so the isolation predicate is always the
cheapest one available and a query that omits it is a visible anomaly rather than a subtle
one.

The discipline that keeps it honest is `TenantScope` (`packages/db/src/tenant.ts`):

```text
                     tenantScope(id)
                           │  throws forbidden() on null/blank/whitespace
                           ▼
   repository.method(scope: TenantScope, …)      ← never a bare string
                           │
                           ▼
        "… WHERE tenant_id = ?"  with scope.tenantId bound
                           │
                           ▼   (rows reached by a global key only)
              assertSameTenant(scope, row)  → forbidden() on mismatch
```

Two properties follow:

- A missing tenant is a **runtime error**, not an unfiltered query. `tenantScope()` throws
  `forbidden('The requested resource is not available.')` for `null`, `undefined` or a blank
  string — proven by *"refuses to build a scope from a blank tenant id"* in
  `tests/integration/repositories.test.ts`.
- Rows fetched by a globally unique key are re-checked. `assertSameTenant()` is applied in
  `EmployeeRepository.findById`, `LeaveRequestRepository.findById` and
  `KnowledgeRepository.findDocumentById`, and is what makes the application-reference lookup
  safe (*"rejects a tenant-mismatched row fetched by a global reference"*).

The same "empty means nothing, never everything" rule appears wherever a caller passes a
computed set: `EmployeeRepository.search()` returns `{ items: [], total: 0 }` for an empty
`restrictToIds`, `LeaveRequestRepository.listForEmployees()` short-circuits on an empty id
list, and `KnowledgeRepository.searchChunks()` returns `[]` for an empty
`allowedClassifications` rather than degrading to "no filter".

---

## 5. Constraints, CHECKs and indexes

### 5.1 Foreign keys

`PRAGMA foreign_keys = ON` heads every migration file and is set on every SQLite handle;
`tests/integration/schema.test.ts` proves enforcement by inserting an employee with a
non-existent tenant and expecting a rejection. Delete behaviour is chosen per relationship:

| Behaviour | Where | Why |
| --- | --- | --- |
| `ON DELETE CASCADE` | everything hanging off `tenants`, plus child rows (`document_chunks`, `application_events`, `leave_approvals`, `messages`, …) | Deleting a tenant must not leave orphan HR data behind. |
| `ON DELETE SET NULL` | `employees.manager_id`, `departments.parent_id`, `applications`→`actor_user_id`, `conversations.user_id` | Losing a manager or an actor must not delete the record that references them. |
| `ON DELETE RESTRICT` | `leave_requests.leave_type_id`, `leave_approvals.approver_user_id` | A leave type or approver that has been used in a decision cannot be erased out from under the audit trail. |
| *(none)* | `users.employee_id`, `audit_logs.*`, `security_events.*` | `users.employee_id` predates the `employees` table (0002 adds `idx_users_employee_link` and the application enforces the link); audit and security rows are intentionally unconstrained so an event can still be written when the tenant or user cannot be resolved — e.g. an `UNKNOWN_USER` or `TENANT_ACCESS_VIOLATION` event. |

### 5.2 CHECK constraints

Every enum in the schema is a `CHECK (col IN (…))` rather than a convention, so an invalid
state cannot be written even by a script or a manual `wrangler d1 execute`. The non-obvious
ones:

| CHECK | Table | Why |
| --- | --- | --- |
| `classification = 'RESTRICTED'` | `employee_compensation` | A single-value check: a compensation row cannot be re-labelled as anything less sensitive. |
| `used_days >= 0 AND pending_days >= 0` | `leave_balances` | The floor under the balance arithmetic — see [§7](#7-the-leave-balance-transactional-model). |
| `start_date <= end_date`, `working_days > 0` | `leave_requests` | Rejects a reversed or empty range at the storage layer, independently of the domain validator (`tests/integration/schema.test.ts` asserts the reversed range is rejected). |
| `salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max` | `jobs` | An inverted advertised range is not representable. |
| `effective_to IS NULL OR effective_from <= effective_to` | `document_versions` | Keeps effective windows well-formed, which the "policy in force on date" query depends on. |
| `score IS NULL OR (score BETWEEN 1 AND 5)` | `interviews` | Bounded evaluation scale. |
| `decision IN ('ALLOW','DENY','ERROR')` / `severity IN (…)` | `audit_logs`, `security_events` | The audit taxonomy in `packages/domain/src/security-events.ts` is mirrored in storage. |

### 5.3 Indexes

| Index | Table | Why it exists |
| --- | --- | --- |
| `idx_users_tenant_email` (UNIQUE) | `users` | E-mail is unique *per tenant*, not globally, so SaaS tenants stay independent. |
| `idx_sessions_expiry` | `sessions` | Supports `deleteExpired()` in the pruner without a scan. |
| `idx_telegram_accounts_unique` (UNIQUE `tenant_id, telegram_user_id, scope`) | `telegram_accounts` | At most one link per scope: the internal link is what grants internal-zone access, so it must be unambiguous. |
| `idx_verification_codes_lookup` / `_expiry` | `verification_codes` | The `findActive()` lookup path, and expiry-based deletion. |
| `idx_employees_tenant_no`, `idx_employees_tenant_email` (UNIQUE) | `employees` | Per-tenant identity keys used by verification (e-mail → employee). |
| `idx_employees_manager`, `idx_employee_managers_manager` | `employees`, `employee_managers` | The two halves of the direct-reports union that drives `*.read.team` scoping. |
| `idx_compensation_employee` (`tenant_id, employee_id, effective_from`) | `employee_compensation` | Exactly the effective-dated lookup in `currentForEmployee()`. |
| `idx_leave_balances_unique` (UNIQUE `tenant_id, employee_id, leave_type_id, year`) | `leave_balances` | One row per employee/type/year — this is both the `ON CONFLICT` target of `upsert()` and the guarantee that `adjustSql()` touches exactly one row. |
| `idx_leave_requests_employee` / `_status` / `_range` | `leave_requests` | Self-service history, the approver queue (`status, start_date`) and overlap detection over a date range. |
| `idx_jobs_status` (`tenant_id, status, published_at`) | `jobs` | The public listing path, which passes an explicit `['PUBLISHED']` status set. |
| `idx_applications_unique` (UNIQUE `tenant_id, candidate_id, job_id`) | `applications` | One application per candidate per job. |
| `idx_applications_reference` (UNIQUE, global) | `applications` | The reference is a bearer credential and must be unique across the deployment; the tenant is re-checked in the query rather than in the key. |
| `idx_chunks_filter` (`tenant_id, classification, effective_from, effective_to`) | `document_chunks` | Precisely the permission-and-effective-date predicate of the RAG query, so filtering stays cheap enough to always be applied. |
| `idx_documents_tenant_name` (UNIQUE) | `documents` | Document names are the human key; duplicates would make supersession ambiguous. |
| `idx_holidays_unique` (`tenant_id, date, COALESCE(region, '')`) | `holidays` | An expression index so two national holidays on the same date collide even though `region` is NULL. |
| `idx_audit_*`, `idx_security_events_*` (all `… timestamp DESC`) | `audit_logs`, `security_events` | The dashboard reads newest-first, filtered by decision, resource, user, type or severity. |
| `idx_rate_limit_expiry` | `rate_limit_counters` | Cheap deletion of expired windows. |

---

## 6. Compensation isolation

Salary is the canonical RESTRICTED resource (§9), and the schema isolates it structurally
rather than by convention:

```text
employees                          employee_compensation
──────────                         ─────────────────────
id, employee_no, names,            id, tenant_id, employee_id,
email, department_id,      ✗       base_salary, currency,
position_id, manager_id,   no      effective_from, effective_to,
hire_date, employment_type join    classification CHECK (= 'RESTRICTED')
status                             created_at, created_by
```

- **No salary column exists on `employees`.** No employee query, search, export or
  `SELECT *` can pick one up by accident — the migration comment states the intent: "no
  employee query can join it in by accident".
- **The classification is not a label, it is a constraint.** `CHECK (classification =
  'RESTRICTED')` admits exactly one value, and `CompensationRepository.upsert()` hard-codes
  `'RESTRICTED'` in the `INSERT` (`packages/db/src/repositories/employees.ts`).
- **Access needs a dedicated permission.** Only `HR_ADMIN` and `SYSTEM_ADMIN` hold
  `employee.read.compensation` (`migrations/0006_rbac_reference.sql`), and the
  `employee.compensation:read`/`:update` rules in `packages/security/src/policy-rules.ts`
  require it with `maxClassification: 'RESTRICTED'`.
- **It is unreachable from chat.** `employee.compensation` and `offer` are classified
  RESTRICTED by `packages/security/src/policy-gateway.ts`, and no AI tool exposes salary —
  `packages/ai/src/tools/internal-self.ts` notes the deliberate absence of a salary field
  in the self-profile tool. The only paths are `GET`/`PUT /employees/:id/compensation`
  (`apps/api/src/routes/employees.ts`).
- **Rows are effective-dated and append-only in practice.** `upsert()` inserts a new row;
  `currentForEmployee(scope, employeeId, onDate)` selects the row whose window covers
  `onDate`, newest `effective_from` first, so salary history is preserved.

---

## 7. The leave balance transactional model

A balance row holds four numbers; availability is derived, never stored:

```text
available = entitled_days + carried_over_days − used_days − pending_days
```

(`availableDays()` in `packages/domain/src/leave-calculation.ts`.)

All movement goes through one statement, exposed as a static so it can only ever be used
inside a transaction (`LeaveBalanceRepository.adjustSql()`,
`packages/db/src/repositories/leave.ts`):

```sql
UPDATE leave_balances
   SET pending_days = pending_days + ?, used_days = used_days + ?, updated_at = ?
 WHERE tenant_id = ? AND employee_id = ? AND leave_type_id = ? AND year = ?
```

The lifecycle, with the `(Δpending, Δused)` pair each operation applies:

```text
  submit (requires approval)        submit (auto-approve)
        (+d, 0)                            (0, +d)
           │                                  │
           ▼                                  ▼
      ┌─────────┐   approve (−d, +d)     ┌──────────┐
      │ PENDING │ ─────────────────────► │ APPROVED │
      └─────────┘                        └──────────┘
           │  reject (−d, 0)                  │
           │                                  │ cancel (0, −d)
           │  cancel (−d, 0)                  ▼
           └───────────────────────────► ┌───────────┐
                                         │ CANCELLED │
                                         └───────────┘
```

What makes each movement safe:

1. **`workingDays` is computed server-side.** The route calls `validateLeaveRequest()`
   (weekends, holidays, hire date, employment status, consecutive-day cap, overlap and
   available balance) and passes `validation.chargeableDays` into the repository
   (`apps/api/src/routes/leave.ts`). The client's number is never used; the
   `CHECK (working_days > 0)` on `leave_requests` is the backstop.
2. **The state change and the balance movement are one transaction.**
   `createWithReservation()` inserts the request, applies `adjustSql()` and — for an
   auto-approved type — writes the `leave_approvals` row in a single
   `DatabaseService.transaction()`. `decide()` and `cancel()` do the same. A request can
   never exist without its days being reserved, or be approved without them being consumed.
3. **The state transitions are guarded in SQL.** `decide()` updates
   `… WHERE tenant_id = ? AND id = ? AND status = 'PENDING'`; `cancel()` updates
   `… AND status = ?` with the previously observed status. A second, concurrent decision
   matches zero rows instead of overwriting the first.
4. **The CHECK is the last line.** Because `CHECK (used_days >= 0 AND pending_days >= 0)`
   is evaluated on UPDATE, a double release drives `pending_days` negative, the statement
   fails, and the whole batch — status change, approval row and balance movement — rolls
   back rather than silently corrupting the balance. (See the caveat in
   [Limitations](#limitations--roadmap).)
5. **A missing balance row cannot be silently skipped.** `validateLeaveRequest()` fails with
   `INSUFFICIENT_BALANCE` when no balance row exists for the year, so `adjustSql()` always
   has exactly one row to hit (guaranteed unique by `idx_leave_balances_unique`).

Five tests in `tests/integration/repositories.test.ts` cover the arithmetic directly:
reservation on submission, pending → used on approval, release on rejection, return on
cancellation of an approved request, and direct consumption for an auto-approved type.

---

## 8. Application events

`applications` holds the current `stage`; `application_events` holds how it got there. The
table is written in exactly two places, both inside a transaction with the row they describe
(`ApplicationRepository`, `packages/db/src/repositories/recruitment.ts`):

| Moment | Rows written in one transaction |
| --- | --- |
| `create()` | `applications` (`stage='APPLIED'`, `status='OPEN'`, fresh `reference`) + an event `NULL → APPLIED`, note "Application received" |
| `transition()` | guarded `UPDATE applications SET stage = ?, status = ? … WHERE stage = ?` + an event `from_stage → to_stage` with `note` and `actor_user_id` |

Two guarantees follow. The `WHERE … AND stage = ?` predicate means a transition computed
against a stale read applies to nothing rather than to the wrong stage — *"will not apply a
transition whose from-stage no longer matches"*. And because both statements share the
transaction, there is no stage change without a corresponding event, so
`listEvents()` (ordered by `created_at`, capped at 100 rows) is a complete history.

Transition *legality* is not a database concern: the caller checks it against the state
machine in `packages/domain/src/application-flow.ts`, and terminal stages set
`status='CLOSED'` via the repository's `closeApplication` flag.

---

## 9. Knowledge versioning and supersession

A policy is a `documents` row; what an answer may cite is a `document_versions` row and its
`document_chunks`. Both the version and the chunk carry `effective_from` / `effective_to`
(inclusive; `NULL` means "still in force").

`addVersionWithChunks()` (`packages/db/src/repositories/knowledge.ts`) performs the whole
publication in one transaction:

```text
BEGIN
  ── if supersedePrevious ────────────────────────────────────────────────
  UPDATE document_versions SET effective_to = date(:from, '-1 day')
    WHERE document_id = :doc AND effective_to IS NULL AND version < :new
  UPDATE document_chunks   SET effective_to = date(:from, '-1 day')
    WHERE document_id = :doc AND effective_to IS NULL AND version < :new
  ────────────────────────────────────────────────────────────────────────
  INSERT INTO document_versions (…, version = MAX(version)+1, effective_from, …)
  INSERT INTO document_chunks   (… one row per chunk, ordinal 0..n …)
  UPDATE documents SET status = 'ACTIVE'
COMMIT
```

Timeline for a handbook superseded on 2025-07-01:

```text
        2025-01-01                     2025-06-30 │ 2025-07-01              ∞
v1  ────●══════════════════════════════════════●──┤
v2                                                ├──●══════════════════════►
                                                  │
   query onDate = 2025-05-04  → v1 (effective_from ≤ d ≤ effective_to)
   query onDate = 2025-08-19  → v2 (effective_to IS NULL)
```

- **The previous version is closed the day *before* the new one starts**, because
  `effective_to` is inclusive — hence `date(:from, '-1 day')`. There is no gap and no
  overlap, so exactly one version is in force on any date.
- **Retrieval filters by date, not by "latest".** Both `findEffectiveVersion()` and the two
  search methods apply `effective_from <= :onDate AND (effective_to IS NULL OR effective_to
  >= :onDate)`, so a superseded policy is never returned as current (§23). Search also
  requires `documents.status = 'ACTIVE'`, keeping DRAFT and ARCHIVED documents out of
  answers entirely.
- **Search never sees a half-indexed document**, because the supersession, the version row
  and every chunk commit together.
- **Version numbers are per document** (`nextVersionNumber()` = `MAX(version) + 1`, unique
  index `idx_document_versions_unique`), and the *file bytes* live in R2 or local storage;
  the row stores only `file_path`, `content_type`, `byte_size` and `checksum`.

`tests/integration/rag-permission-filtering.test.ts` covers the visible behaviour — *"serves
the new version and stops serving the superseded one"* — alongside the classification cases.

---

## 10. The FTS5 virtual table and its triggers

MVP retrieval is SQLite full-text search (§25); there is no vector database.

```sql
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  content,
  section,
  chunk_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

`chunk_id` is stored but not indexed — it is the join key back to `document_chunks`, so the
chunk row stays the single source of truth for classification, dates and ordering. Three
triggers keep the index in step with the base table:

```text
document_chunks                         document_chunks_fts
───────────────                         ───────────────────
INSERT ──trg_chunks_fts_insert──►  INSERT (content, COALESCE(section,''), id)
DELETE ──trg_chunks_fts_delete──►  DELETE WHERE chunk_id = old.id
UPDATE ──trg_chunks_fts_update──►  DELETE old, then INSERT new
```

Because the maintenance is in the database rather than in application code, a chunk written
by a migration, a seed script or a future importer is indexed identically.
`tests/integration/schema.test.ts` asserts the round trip: an inserted chunk is matchable,
and after `DELETE FROM document_chunks` the FTS match count drops to zero.

The search query itself (`searchChunks()`) joins FTS → chunk → document and applies, in one
`WHERE`: the FTS `MATCH`, `tenant_id`, the authorised `classification IN (…)` set,
`documents.status = 'ACTIVE'`, the effective-date window and an optional category, ordered by
`bm25(document_chunks_fts)` and hard-limited. User input reaches `MATCH` only through
`toFtsQuery()` (`packages/shared/src/text.ts`), which tokenises, caps at 12 terms and quotes
each one so FTS operators typed by a user are inert — covered by *"treats FTS operators
inside the question as literal terms"*.

`searchChunksFallback()` is a `LIKE … ESCAPE '\'` variant with the identical tenant,
classification, status and date predicates, for engines without FTS5 and for queries where
bm25 ranking is unhelpful.

---

## 11. Audit logs and security events

Both tables are append-only by construction: `AuditRepository`
(`packages/db/src/repositories/audit.ts`) exposes `record`, `list`, `countByDecision` and
`pruneOlderThan` — there is no update or delete path. `SecurityEventRepository` adds exactly
one narrow mutation, `acknowledge()`, which sets `acknowledged_at`/`acknowledged_by` and is
itself guarded by `AND acknowledged_at IS NULL` so an acknowledgement cannot be overwritten.

| Property | Detail |
| --- | --- |
| Redaction before storage | `metadata` and `detail` pass through `redact()` and are truncated to 4000 characters; summaries to 500. Secrets, tokens and verification codes never reach a row (§29, §47) — proven by *"redacts sensitive metadata before storing it"* in `tests/integration/repositories.test.ts`. |
| No foreign keys | `tenant_id`, `user_id` and `telegram_id` are plain nullable columns, so an event is still recorded when identity resolution fails (`UNKNOWN_USER`) or when a tenant boundary is violated (`TENANT_ACCESS_VIOLATION`). |
| Reads are tenant-scoped | `list()` takes a `TenantScope` and always filters `tenant_id = ?`; *"scopes audit listing to the tenant"* covers it. Access needs `audit.read` / `security.read`. |
| Timestamps drive everything | All four audit indexes and all three security-event indexes are `(tenant_id, …, timestamp DESC)`. |

`tool_calls` plays the same role for the AI layer: one row per invocation with
`ALLOW`/`DENY`, `reason_code` and `latency_ms`.

---

## 12. Rate-limit counters

`rate_limit_counters` is the durable fallback used when no KV namespace is bound (§45):

| Column | Meaning |
| --- | --- |
| `bucket_key` (PK) | `"<key>:<window start epoch seconds>"` — the window is part of the key, so a new window is a new row |
| `window_start` | Epoch seconds of the window start |
| `count` | Requests observed in that window |
| `expires_at` | Epoch seconds after which the row is garbage |

`D1RateLimiter.consume()` (`packages/security/src/rate-limit.ts`) increments with an upsert
and then reads the value back:

```sql
INSERT INTO rate_limit_counters (bucket_key, window_start, count, expires_at)
VALUES (?, ?, 1, ?)
ON CONFLICT (bucket_key) DO UPDATE SET count = count + 1;
```

The primary key makes the increment atomic, so concurrent Workers cannot lose a count. The
three implementations — `KvRateLimiter`, `D1RateLimiter` and `MemoryRateLimiter` — sit behind
one `RateLimiter` interface, so losing the KV binding degrades durability, not enforcement
(`tests/integration/rate-limiting.test.ts`).

---

## 13. Retention policies and pruning

`retention_policies` is seeded by `migrations/0005_security_conversations.sql`:

| `table_name` | `retain_days` | Rationale as stored |
| --- | --- | --- |
| `audit_logs` | 730 | Authorisation decisions retained two years for compliance |
| `security_events` | 730 | Security events retained two years |
| `messages` | 90 | Conversation transcripts pruned after 90 days |
| `tool_calls` | 180 | Tool invocation records pruned after 180 days |
| `verification_codes` | 1 | One-time codes deleted the day after issue |
| `rate_limit_counters` | 1 | Counters expire within a day |

`scripts/prune.ts` reads the table and dispatches per row — `audit.pruneOlderThan`,
`securityEvents.pruneOlderThan`, `conversations.pruneMessagesOlderThan`, a direct delete for
`tool_calls`, `verificationCodes.deleteExpired`, and an `expires_at`-based delete for
`rate_limit_counters` — then unconditionally deletes expired sessions. A policy row naming a
table with no pruner logs `no pruner implemented for <table>` rather than failing, so adding
a policy is safe.

`tests/integration/rbac-consistency.test.ts` asserts a policy exists for `audit_logs`,
`security_events`, `messages` and `verification_codes`, so the table cannot quietly lose a
retention rule.

The script runs on Node against the local SQLite database (`openLocalDb({ migrate: false })`).
In the hosted deployment the same policies are applied by the Worker's `scheduled()` handler
(`apps/api/src/scheduled.ts`), wired to a daily Cron trigger in `apps/api/wrangler.toml`:

```toml
[triggers]
crons = ["15 3 * * *"]
```

The handler additionally deletes expired sessions and conversations whose messages have all
aged out. It is idempotent, so a repeated or missed run changes nothing.

---

## 14. Migration tooling

Two runners, one set of SQL files.

```text
migrations/*.sql
   │
   ├── production ── wrangler d1 migrations apply corpus --remote
   │                 (migrations_dir = "../../migrations" in apps/api/wrangler.toml;
   │                  npm run db:migrate:remote / :local)
   │
   └── local / tests ── loadMigrationsFromDir() → runMigrations(db, migrations)
                        (packages/db/src/migration-files.ts, migrations.ts)
```

`runMigrations()` (`packages/db/src/migrations.ts`) creates a `d1_migrations` bookkeeping
table (`id`, `name` UNIQUE, `applied_at`), applies each not-yet-applied file in name order,
and records it. Two details matter:

- **Statement splitting is trigger-aware.** `splitStatements()` strips comment lines and
  tracks `BEGIN…END` depth and string literals, because the three FTS triggers contain
  internal semicolons that naive splitting on `;` would corrupt.
- **`PRAGMA` goes through `exec()`**, not `prepare()`, since a prepared `PRAGMA` is a no-op
  on D1.

| Command | What it does |
| --- | --- |
| `npm run db:migrate` | `scripts/migrate.ts` → `openLocalDb()` applies pending files to `./data/corpus.sqlite` (or `LOCAL_DB_PATH`) and prints the applied list |
| `npm run db:seed` | `scripts/seed.ts` / `seed-data.ts` — development data only, all addresses on the reserved `corpus.test` domain |
| `npm run db:reset` | Deletes the local database file (plus `-wal`/`-shm`); refuses to run with `ENVIRONMENT=production` |
| `npm run db:migrate:local` / `:remote` | `wrangler d1 migrations apply corpus` against the local or remote D1 database |

Tests get the same schema through `createTestDatabase()`
(`packages/db/src/test-support.ts`): an in-memory SQLite database with every migration
applied and a full `Repositories` container. The Node-only pieces (SQLite adapter, migration
file loading, test support) are deliberately **not** re-exported from
`packages/db/src/index.ts`, so a native dependency can never be pulled into the Worker
bundle.

### The generated RBAC migration

`migrations/0006_rbac_reference.sql` is marked `GENERATED FILE. Do not edit by hand.` It is
produced by `scripts/generate-rbac-migration.ts` from `ROLES`, `PERMISSIONS` and
`ROLE_PERMISSIONS` in `packages/domain/src/roles.ts`, using `INSERT OR REPLACE` for the
catalogues and a `DELETE FROM role_permissions` + bulk insert for the grants, so re-applying
it converges rather than duplicating.

```text
packages/domain/src/roles.ts        ← single source of truth
        │  npx tsx scripts/generate-rbac-migration.ts
        ▼
migrations/0006_rbac_reference.sql  ← committed, applied like any migration
        │
        ▼
tests/integration/rbac-consistency.test.ts
        • roles table  == ROLES
        • permissions  == PERMISSIONS
        • grants       == ROLE_PERMISSIONS[role]  (for every role)
        • no grant references an unknown role or permission
```

Editing roles in code without regenerating the migration — or editing the migration by hand
— fails that test, so the database's idea of RBAC and the code's idea cannot drift.

---

## 15. The D1 → PostgreSQL path

Nothing here is built; this section records exactly what a move would touch (§51). The
abstractions that keep it small are `SqlDatabase`/`DatabaseService`, the repository layer and
`KnowledgeSearchService` — business logic, `PolicyGateway` and the tool registry would not
change.

| Area | Today (D1 / SQLite) | On PostgreSQL | Where |
| --- | --- | --- | --- |
| Driver adapter | `fromD1()` cast; `openSqlite()` for Node | A third `SqlDatabase` implementation over a `pg` client; `batch()` becomes an explicit `BEGIN … COMMIT` | `packages/db/src/d1-adapter.ts`, `sqlite-adapter.ts`, `sql.ts` |
| Placeholders | `?` positional | `$1…$n` — rewrite inside the new adapter, or bind through a driver that accepts `?` | `packages/db/src/database-service.ts` |
| Full-text search | `document_chunks_fts` FTS5 virtual table + 3 triggers, ranked by `bm25()` | A `tsvector` column (generated, GIN-indexed) ranked by `ts_rank`, or `pgvector` embeddings for semantic/hybrid search. The triggers disappear; the virtual table disappears; `searchChunks()` changes shape but its filter predicates do not | `migrations/0004_knowledge.sql`, `packages/db/src/repositories/knowledge.ts` |
| Upserts | `ON CONFLICT (cols) DO UPDATE SET … excluded.…` (leave balances) and `ON CONFLICT (bucket_key) DO UPDATE SET count = count + 1` (rate limits) carry over almost verbatim; `INSERT OR REPLACE` in the generated RBAC migration does not | Regenerate 0006 as `INSERT … ON CONFLICT (code) DO UPDATE` | `packages/db/src/repositories/leave.ts`, `packages/security/src/rate-limit.ts`, `scripts/generate-rbac-migration.ts` |
| Money and day counts | `REAL` | `NUMERIC(12,2)` for `base_salary`, `salary_min`, `salary_max`, `offers.base_salary`; `NUMERIC(5,2)` for `entitled_days`, `used_days`, `pending_days`, `carried_over_days`, `working_days` — floating point should not accumulate leave days or salary | `migrations/0002_hr_core.sql`, `0003_recruitment.sql` |
| Booleans | `INTEGER` 0/1 + `CHECK (col IN (0,1))` | `BOOLEAN`; the `CHECK`s and the `asBool`/`boolToInt` mappers become unnecessary | `packages/db/src/repositories/mappers.ts` |
| Dates and timestamps | ISO-8601 `TEXT` | `TIMESTAMPTZ` and `DATE`; string comparisons in `WHERE`/`ORDER BY` become native comparisons | schema-wide |
| SQLite date arithmetic | `date(?, '-1 day')` in the supersession update | `(?::date - INTERVAL '1 day')` | `packages/db/src/repositories/knowledge.ts` |
| Enum CHECKs | `CHECK (col IN (…))` | Same, or native `ENUM` types — the `CHECK` form ports unchanged and is the lower-friction option | schema-wide |
| Expression index | `UNIQUE (tenant_id, date, COALESCE(region, ''))` | Supported unchanged | `migrations/0002_hr_core.sql` |
| Migration bookkeeping | `d1_migrations` written by `runMigrations()`; `wrangler d1 migrations apply` in production | Same table, applied by the same runner or a standard Postgres tool | `packages/db/src/migrations.ts` |
| Foreign keys | `PRAGMA foreign_keys = ON` per connection | Always on; the pragma lines drop out | every migration file |
| Tenant isolation | Application-level `WHERE tenant_id = ?` + `TenantScope` | Unchanged — optionally hardened further with row-level security | `packages/db/src/tenant.ts` |

---

## Limitations / Roadmap

1. **No down-migrations.** `migrations/` is forward-only and `runMigrations()` has no
   rollback path. Recovering from a bad migration means a new forward migration (or, locally,
   `npm run db:reset`).
2. **Retention runs on a Cron trigger.** `apps/api/src/scheduled.ts` applies every
   `retention_policies` row (plus expired sessions and orphaned conversations) from the
   Worker's `scheduled()` handler, wired to `crons = ["15 3 * * *"]` in
   `apps/api/wrangler.toml`. The handler is idempotent, so a missed or repeated run is
   harmless. `scripts/prune.ts` does the same thing against the local SQLite file for
   development. Proof: `tests/integration/retention.test.ts`.

3. **The balance guard is a floor, not a lock.** In `LeaveRequestRepository.decide()` and
   `cancel()`, the status `UPDATE` is guarded by the expected status but the `adjustSql()`
   movement in the same batch is unconditional. Two concurrent decisions on the same request
   are normally caught by `CHECK (pending_days >= 0)`, which aborts the whole batch — but if
   the employee has other pending days in the same bucket the check may not trip. A
   `changes`-aware transaction (or a conditional update sourced from `leave_requests`) would
   close this properly. The API layer already rejects a non-`PENDING` decision with 409
   before reaching the repository (`apps/api/src/routes/leave.ts`).
4. **`users.employee_id` has no foreign key.** It is declared in `0001` before `employees`
   exists; `0002` adds `idx_users_employee_link` and the link is enforced in application
   code only. A later migration could rebuild the table with the constraint.
5. **Text search only.** `document_chunks_fts` is FTS5 with bm25 plus a `LIKE` fallback.
   There is no vector index and no `pgvector`; embeddings would be a schema change plus a new
   `KnowledgeSearchService` implementation.
6. **Chunks are only produced from text formats.** `packages/knowledge/src/extraction.ts`
   handles `text/plain`, `text/markdown`, `text/csv`, `text/html` and `application/json`;
   PDF and DOCX raise `UnsupportedDocumentError`, so no chunk rows are created for them and
   the operator must upload a text or Markdown export instead.
7. **No e-mail transport for verification codes.** `verification_codes` stores only the hash
   and the delivery interface exists, but the only implementation writes the code to the
   server log, and only in development (`selectCodeDelivery()` returns `NullCodeDelivery` for
   production and staging, which discards the code). The table
   is ready; the transport is not.
8. **Single-tenant routing in practice.** Every table, index and repository is tenant-scoped
   and tenant isolation is tested (`tests/integration/repositories.test.ts`,
   `tests/security/*`), but the API and both bots resolve one tenant from
   `DEFAULT_TENANT_SLUG`. Nothing in the schema needs to change to lift this.
9. **Seed data is development-only.** `scripts/seed-data.ts` uses the reserved
   `corpus.test` domain so no address can reach a real inbox; it must never be applied to a
   production database.
