-- CORPUS 0005 — audit trail, security events, conversations, rate limiting.

PRAGMA foreign_keys = ON;

-- Append-only. No UPDATE/DELETE path exists in the repositories.
CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  tenant_id   TEXT,
  user_id     TEXT,
  telegram_id TEXT,
  channel     TEXT NOT NULL,
  bot         TEXT,
  intent      TEXT,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  action      TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY','ERROR')),
  reason_code TEXT,
  risk        TEXT,
  source      TEXT,
  request_id  TEXT,
  -- JSON. Redacted before it is written; never contains secrets or codes.
  metadata    TEXT
);

CREATE INDEX idx_audit_tenant_time ON audit_logs (tenant_id, timestamp DESC);
CREATE INDEX idx_audit_user ON audit_logs (tenant_id, user_id, timestamp DESC);
CREATE INDEX idx_audit_decision ON audit_logs (tenant_id, decision, timestamp DESC);
CREATE INDEX idx_audit_resource ON audit_logs (tenant_id, resource, timestamp DESC);

CREATE TABLE security_events (
  id           TEXT PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  tenant_id    TEXT,
  event_type   TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  user_id      TEXT,
  telegram_id  TEXT,
  subject_key  TEXT,
  channel      TEXT NOT NULL,
  summary      TEXT NOT NULL,
  -- Truncated, redacted detail for the security dashboard.
  detail       TEXT,
  request_id   TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);

CREATE INDEX idx_security_events_time ON security_events (tenant_id, timestamp DESC);
CREATE INDEX idx_security_events_type ON security_events (tenant_id, event_type, timestamp DESC);
CREATE INDEX idx_security_events_severity ON security_events (tenant_id, severity, timestamp DESC);

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  -- Pseudonymous stable key (e.g. hash of the Telegram id). Not an identity claim.
  subject_key     TEXT NOT NULL,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  candidate_id    TEXT REFERENCES candidates(id) ON DELETE SET NULL,
  started_at      TEXT NOT NULL,
  last_message_at TEXT NOT NULL
);

CREATE INDEX idx_conversations_subject ON conversations (tenant_id, channel, subject_key, last_message_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content         TEXT NOT NULL,
  intent          TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_messages_conversation ON messages (tenant_id, conversation_id, created_at);

CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  tool_name       TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY')),
  reason_code     TEXT,
  latency_ms      INTEGER,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_tool_calls_tenant ON tool_calls (tenant_id, created_at DESC);
CREATE INDEX idx_tool_calls_decision ON tool_calls (tenant_id, decision, created_at DESC);

CREATE TABLE unanswered_questions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  question        TEXT NOT NULL,
  channel         TEXT NOT NULL,
  asked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_unanswered_tenant ON unanswered_questions (tenant_id, resolved_at, created_at DESC);

CREATE TABLE hr_tickets (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  raised_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_hr_tickets_tenant ON hr_tickets (tenant_id, status, created_at DESC);

-- Durable rate-limit counters. KV is used when available; this table is the
-- fallback so the limiter still works with only D1 configured (CLAUDE.md §45).
CREATE TABLE rate_limit_counters (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX idx_rate_limit_expiry ON rate_limit_counters (expires_at);

-- Retention bookkeeping (CLAUDE.md §29).
CREATE TABLE retention_policies (
  table_name    TEXT PRIMARY KEY,
  retain_days   INTEGER NOT NULL,
  description   TEXT
);

INSERT INTO retention_policies (table_name, retain_days, description) VALUES
  ('audit_logs', 730, 'Authorisation decisions retained two years for compliance'),
  ('security_events', 730, 'Security events retained two years'),
  ('messages', 90, 'Conversation transcripts pruned after 90 days'),
  ('tool_calls', 180, 'Tool invocation records pruned after 180 days'),
  ('verification_codes', 1, 'One-time codes deleted the day after issue'),
  ('rate_limit_counters', 1, 'Counters expire within a day');
