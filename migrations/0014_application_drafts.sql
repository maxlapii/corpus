-- CORPUS 0014 — half-finished applications from the recruitment bot.
--
-- Applying needs three fields, and asking for all three in one line proved to
-- be more than a chat window should demand. This holds the answers between
-- turns so the bot can ask one question at a time.
--
-- Deliberately NOT a candidate record: nothing here has been validated, nobody
-- owns it, and it grants nothing. It becomes a candidate only when
-- `submit_application` runs and the PolicyGateway allows it.

PRAGMA foreign_keys = ON;

CREATE TABLE application_drafts (
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  job_code         TEXT,
  full_name        TEXT,
  email            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, telegram_user_id)
);

-- Drafts are abandoned far more often than finished, so the retention sweep
-- needs to find stale ones cheaply.
CREATE INDEX idx_application_drafts_stale ON application_drafts (updated_at);

INSERT INTO retention_policies (table_name, retain_days, description) VALUES
  ('application_drafts', 1, 'Half-finished bot applications. Unvalidated personal data, kept only long enough to finish the conversation.');
