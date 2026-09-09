-- CORPUS 0010 — candidate documents (CVs).
--
-- A CV is the most personal thing a candidate hands over, so it is CONFIDENTIAL
-- by construction: the row records where the file lives and what text came out
-- of it, and every read goes through `candidate.document:read` (CLAUDE.md §9).
--
-- The extracted text is UNTRUSTED DATA (§26). It is stored so HR can read and
-- match against it without downloading the original, never so that it can be
-- treated as instructions — the dashboard renders it as plain text and the
-- matcher only ever runs regular expressions over it.

PRAGMA foreign_keys = ON;

CREATE TABLE candidate_documents (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  candidate_id   TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  -- Room for covering letters and portfolios later without another migration.
  kind           TEXT NOT NULL DEFAULT 'CV'
                   CHECK (kind IN ('CV','COVER_LETTER','OTHER')),
  filename       TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  checksum       TEXT,
  -- R2 in production, the in-memory service locally. Never a local path (§4).
  storage_key    TEXT NOT NULL,

  extracted_text TEXT,
  -- OK: usable text. EMPTY: parsed, but no text layer (a scanned PDF).
  -- UNSUPPORTED: the format has no extractor. FAILED: the parser gave up.
  extraction_status TEXT NOT NULL DEFAULT 'OK'
                   CHECK (extraction_status IN ('OK','EMPTY','UNSUPPORTED','FAILED')),
  extractor      TEXT,
  extraction_warnings TEXT,
  -- Recorded, never acted on: a CV carrying prompt-injection text is still a
  -- CV, and refusing it would let an attacker deny a real applicant.
  injection_flagged INTEGER NOT NULL DEFAULT 0 CHECK (injection_flagged IN (0,1)),

  source         TEXT NOT NULL DEFAULT 'DASHBOARD'
                   CHECK (source IN ('TELEGRAM_EXTERNAL','DASHBOARD')),
  uploaded_at    TEXT NOT NULL,
  -- Null when the candidate uploaded it themselves over Telegram.
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_candidate_documents_candidate
  ON candidate_documents (tenant_id, candidate_id, uploaded_at DESC);
CREATE INDEX idx_candidate_documents_recent
  ON candidate_documents (tenant_id, uploaded_at DESC);
