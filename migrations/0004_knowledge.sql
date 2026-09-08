-- CORPUS 0004 — knowledge base: documents, versions, chunks, FTS index.

PRAGMA foreign_keys = ON;

CREATE TABLE documents (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'GENERAL',
  -- Enforced by the backend on every retrieval (CLAUDE.md §9, §24).
  classification TEXT NOT NULL DEFAULT 'INTERNAL'
                   CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  owner          TEXT,
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','ARCHIVED')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_documents_tenant_status ON documents (tenant_id, status, classification);
CREATE UNIQUE INDEX idx_documents_tenant_name ON documents (tenant_id, name);

CREATE TABLE document_versions (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  -- Storage key in R2 (production) or the local storage root (development).
  file_path      TEXT,
  content_type   TEXT,
  byte_size      INTEGER,
  checksum       TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

CREATE UNIQUE INDEX idx_document_versions_unique ON document_versions (document_id, version);
CREATE INDEX idx_document_versions_effective
  ON document_versions (tenant_id, document_id, effective_from, effective_to);

CREATE TABLE document_chunks (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  -- Denormalised from the document so the permission filter can run entirely
  -- inside the retrieval query, before any content is materialised.
  classification      TEXT NOT NULL
                        CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  effective_from      TEXT NOT NULL,
  effective_to        TEXT,
  section             TEXT,
  page                INTEGER,
  ordinal             INTEGER NOT NULL DEFAULT 0,
  content             TEXT NOT NULL,
  token_estimate      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_chunks_filter
  ON document_chunks (tenant_id, classification, effective_from, effective_to);
CREATE INDEX idx_chunks_document ON document_chunks (tenant_id, document_id, version, ordinal);

-- Full-text index for MVP retrieval (CLAUDE.md §25). Content-less external
-- table keyed by rowid so the chunk row remains the single source of truth.
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  content,
  section,
  chunk_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts (content, section, chunk_id)
  VALUES (new.content, COALESCE(new.section, ''), new.id);
END;

CREATE TRIGGER trg_chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER trg_chunks_fts_update AFTER UPDATE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
  INSERT INTO document_chunks_fts (content, section, chunk_id)
  VALUES (new.content, COALESCE(new.section, ''), new.id);
END;
