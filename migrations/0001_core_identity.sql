-- CORPUS 0001 — tenancy, users, roles, permissions, Telegram linkage.
-- Every tenant-scoped table carries tenant_id and indexes it first so no query
-- can accidentally omit the isolation predicate cheaply (CLAUDE.md §7).

PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE roles (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  description TEXT
);

CREATE TABLE role_permissions (
  role_code       TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  -- PBKDF2-SHA256 derived key, stored as algo$iterations$salt$hash.
  password_hash      TEXT,
  status             TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE', 'DISABLED', 'LOCKED')),
  employee_id        TEXT,
  last_login_at      TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- E-mail is unique per tenant, not globally, so SaaS tenants stay independent.
CREATE UNIQUE INDEX idx_users_tenant_email ON users (tenant_id, email);
CREATE INDEX idx_users_employee ON users (tenant_id, employee_id);

CREATE TABLE user_roles (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code   TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_at  TEXT NOT NULL,
  granted_by  TEXT,
  PRIMARY KEY (user_id, role_code)
);

CREATE INDEX idx_user_roles_tenant ON user_roles (tenant_id, user_id);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the bearer token. The token itself is never stored.
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_token    TEXT NOT NULL,
  user_agent    TEXT,
  ip_hash       TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE INDEX idx_sessions_user ON sessions (tenant_id, user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE telegram_accounts (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('EXTERNAL', 'INTERNAL')),
  employee_id      TEXT,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_at      TEXT,
  revoked_at       TEXT,
  created_at       TEXT NOT NULL
);

-- A Telegram user can hold at most one link per scope per tenant. The internal
-- link is what grants internal-zone access, so it must be unambiguous.
CREATE UNIQUE INDEX idx_telegram_accounts_unique
  ON telegram_accounts (tenant_id, telegram_user_id, scope);
CREATE INDEX idx_telegram_accounts_employee ON telegram_accounts (tenant_id, employee_id);

-- One-time codes for linking a Telegram account to an employee (CLAUDE.md §12).
-- Only the hash of the code is stored, and codes are single-use.
CREATE TABLE verification_codes (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose          TEXT NOT NULL CHECK (purpose IN ('TELEGRAM_LINK', 'PASSWORD_RESET')),
  -- Backend-resolved subject. The requester supplies an e-mail, never an id.
  employee_id      TEXT,
  user_id          TEXT,
  telegram_user_id TEXT,
  code_hash        TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  consumed_at      TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_verification_codes_lookup
  ON verification_codes (tenant_id, purpose, telegram_user_id, expires_at);
CREATE INDEX idx_verification_codes_expiry ON verification_codes (expires_at);
