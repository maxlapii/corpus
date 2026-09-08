-- CORPUS 0007 — curated bot answers ("training") for the internal and external
-- Telegram bots, authored from the admin dashboard.
--
-- A curated answer is authoritative text a human approved, not model prose, so
-- it carries the same two access axes as every other knowledge resource:
--   audience       which bot may serve it (CLAUDE.md §8 zones)
--   classification who may read it once inside the internal zone (§9)
-- Both are filtered inside the retrieval query (§24), never after the fact.

PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_answers (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  answer         TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'GENERAL',
  audience       TEXT NOT NULL DEFAULT 'INTERNAL'
                   CHECK (audience IN ('EXTERNAL','INTERNAL','BOTH')),
  classification TEXT NOT NULL DEFAULT 'INTERNAL'
                   CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  -- Denormalised question + training phrasings, so one FTS row covers every
  -- way a person might ask. Rebuilt by the repository on any phrase change.
  search_text    TEXT NOT NULL,
  -- Set when the answer was authored to close an unanswered question, which is
  -- what turns the bot's own gaps into the training backlog (§29, §30).
  source_unanswered_id TEXT REFERENCES unanswered_questions(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by     TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- The invariant that keeps the public bot safe: anything a candidate can be
  -- served is PUBLIC. Enforced by the database, so no code path can bypass it.
  CHECK (audience = 'INTERNAL' OR classification = 'PUBLIC'),
  CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

CREATE INDEX idx_answers_retrieval
  ON knowledge_answers (tenant_id, status, audience, classification, effective_from, effective_to);
CREATE INDEX idx_answers_category ON knowledge_answers (tenant_id, category, status);
CREATE UNIQUE INDEX idx_answers_tenant_question ON knowledge_answers (tenant_id, question);

-- Alternative phrasings. Kept relational so the dashboard can edit them
-- individually and so a phrase cannot silently shadow another answer.
CREATE TABLE knowledge_answer_phrases (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  answer_id  TEXT NOT NULL REFERENCES knowledge_answers(id) ON DELETE CASCADE,
  phrase     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_answer_phrases_answer ON knowledge_answer_phrases (tenant_id, answer_id);
CREATE UNIQUE INDEX idx_answer_phrases_unique ON knowledge_answer_phrases (answer_id, phrase);

-- Content-less external FTS table keyed by answer id, mirroring the document
-- chunk index so both retrieval paths behave identically.
CREATE VIRTUAL TABLE knowledge_answers_fts USING fts5(
  search_text,
  answer,
  answer_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_answers_fts_insert AFTER INSERT ON knowledge_answers BEGIN
  INSERT INTO knowledge_answers_fts (search_text, answer, answer_id)
  VALUES (new.search_text, new.answer, new.id);
END;

CREATE TRIGGER trg_answers_fts_delete AFTER DELETE ON knowledge_answers BEGIN
  DELETE FROM knowledge_answers_fts WHERE answer_id = old.id;
END;

CREATE TRIGGER trg_answers_fts_update AFTER UPDATE ON knowledge_answers BEGIN
  DELETE FROM knowledge_answers_fts WHERE answer_id = old.id;
  INSERT INTO knowledge_answers_fts (search_text, answer, answer_id)
  VALUES (new.search_text, new.answer, new.id);
END;

-- Closes the loop from an unanswered question to the curated answer that now
-- covers it, so the dashboard can show a resolved backlog rather than losing it.
ALTER TABLE unanswered_questions ADD COLUMN resolved_answer_id TEXT
  REFERENCES knowledge_answers(id) ON DELETE SET NULL;

ALTER TABLE unanswered_questions ADD COLUMN resolved_by_user_id TEXT
  REFERENCES users(id) ON DELETE SET NULL;
