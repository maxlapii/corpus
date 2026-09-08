-- CORPUS 0009 — separate "which compartment" from "needs an account".
--
-- Not every internal question is a personal one. "Who approves leave?" or
-- "how do I reach IT?" are general staff information; only credential- and
-- person-specific answers actually need a verified account behind them.
-- `requires_account` makes that an explicit, per-answer authoring decision
-- instead of a blanket rule (CLAUDE.md §8, §12).
--
-- The gate is narrow by construction: an answer can only drop the account
-- requirement when it is classified PUBLIC, so this never widens access to
-- classified text — the classification filter still runs independently.

PRAGMA foreign_keys = ON;

ALTER TABLE knowledge_answers
  ADD COLUMN requires_account INTEGER NOT NULL DEFAULT 1;

-- An external-audience answer is for candidates, who have no account at all.
UPDATE knowledge_answers SET requires_account = 0 WHERE audience IN ('EXTERNAL', 'BOTH');

CREATE INDEX idx_answers_account_gate
  ON knowledge_answers (tenant_id, status, audience, requires_account);

-- SQLite cannot add a CHECK with ALTER TABLE, so the same guarantee is a
-- BEFORE trigger: the database still refuses the row, whatever the caller is.
CREATE TRIGGER trg_answers_account_gate_insert
BEFORE INSERT ON knowledge_answers
WHEN (new.requires_account = 0 AND new.classification <> 'PUBLIC')
  OR (new.audience <> 'INTERNAL' AND new.requires_account <> 0)
BEGIN
  SELECT RAISE(
    ABORT,
    'knowledge_answers: an answer served without an account must be PUBLIC, and an external-audience answer is never account-gated'
  );
END;

CREATE TRIGGER trg_answers_account_gate_update
BEFORE UPDATE ON knowledge_answers
WHEN (new.requires_account = 0 AND new.classification <> 'PUBLIC')
  OR (new.audience <> 'INTERNAL' AND new.requires_account <> 0)
BEGIN
  SELECT RAISE(
    ABORT,
    'knowledge_answers: an answer served without an account must be PUBLIC, and an external-audience answer is never account-gated'
  );
END;
