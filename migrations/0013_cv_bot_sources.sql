-- CORPUS 0013 — CVs arrive from either bot, not from the dashboard.
--
-- Intake moved to Telegram: a candidate sends their own CV to the recruitment
-- bot, and staff forward one to the employee bot. The dashboard is now a
-- reading surface, so `DASHBOARD` stays only to describe rows created before
-- this change.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt. Nothing
-- references `candidate_documents`, which is what makes that safe here.

PRAGMA foreign_keys = ON;

CREATE TABLE candidate_documents_new (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  candidate_id   TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'CV'
                   CHECK (kind IN ('CV','COVER_LETTER','OTHER')),
  filename       TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  checksum       TEXT,
  storage_key    TEXT NOT NULL,

  extracted_text TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'OK'
                   CHECK (extraction_status IN ('OK','EMPTY','UNSUPPORTED','FAILED')),
  extractor      TEXT,
  extraction_warnings TEXT,
  injection_flagged INTEGER NOT NULL DEFAULT 0 CHECK (injection_flagged IN (0,1)),

  -- DASHBOARD is retained for rows created before intake moved to the bots.
  source         TEXT NOT NULL DEFAULT 'TELEGRAM_EXTERNAL'
                   CHECK (source IN ('TELEGRAM_EXTERNAL','TELEGRAM_INTERNAL','DASHBOARD')),
  uploaded_at    TEXT NOT NULL,
  -- Null when the candidate sent it themselves; set when a member of staff
  -- forwarded it, so provenance survives.
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO candidate_documents_new
  (id, tenant_id, candidate_id, kind, filename, content_type, byte_size, checksum,
   storage_key, extracted_text, extraction_status, extractor, extraction_warnings,
   injection_flagged, source, uploaded_at, uploaded_by_user_id)
SELECT
   id, tenant_id, candidate_id, kind, filename, content_type, byte_size, checksum,
   storage_key, extracted_text, extraction_status, extractor, extraction_warnings,
   injection_flagged, source, uploaded_at, uploaded_by_user_id
  FROM candidate_documents;

DROP TABLE candidate_documents;

ALTER TABLE candidate_documents_new RENAME TO candidate_documents;

CREATE INDEX idx_candidate_documents_candidate
  ON candidate_documents (tenant_id, candidate_id, uploaded_at DESC);
CREATE INDEX idx_candidate_documents_recent
  ON candidate_documents (tenant_id, uploaded_at DESC);

-- Backs the dashboard's filters, which are now the point of that page.
CREATE INDEX idx_candidate_documents_filters
  ON candidate_documents (tenant_id, source, extraction_status, injection_flagged);
