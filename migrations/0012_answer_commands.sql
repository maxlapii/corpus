-- CORPUS 0012 — bot commands on curated answers.
--
-- An author can bind a curated answer to a Telegram command, so /benefits
-- answers from approved text and appears in the bot's command menu.
--
-- Two things are separate on purpose:
--
--   Running  /command  goes through the ordinary retrieval path, so audience,
--            classification and the account gate all still apply.
--   Advertising it in the menu is a *world-readable* act — Telegram shows the
--            menu to anyone who opens the bot, before any verification — so
--            only PUBLIC answers are ever published to it. See `command_description`.

PRAGMA foreign_keys = ON;

ALTER TABLE knowledge_answers ADD COLUMN command TEXT;

-- Shown in the Telegram menu next to the command, so it is as public as the
-- command name. Authored deliberately rather than derived from the question,
-- which may say more than the menu should.
ALTER TABLE knowledge_answers ADD COLUMN command_description TEXT;

-- One command cannot mean two things. Partial, so the many rows without a
-- command do not collide with each other.
CREATE UNIQUE INDEX idx_answers_command
  ON knowledge_answers (tenant_id, command) WHERE command IS NOT NULL;

CREATE INDEX idx_answers_command_menu
  ON knowledge_answers (tenant_id, status, audience, classification) WHERE command IS NOT NULL;

-- A command with no description would be published to the menu as a bare slash
-- word, so the pair is required together.
CREATE TRIGGER trg_answers_command_pair_insert
BEFORE INSERT ON knowledge_answers
WHEN (new.command IS NOT NULL AND (new.command_description IS NULL OR TRIM(new.command_description) = ''))
BEGIN
  SELECT RAISE(ABORT, 'knowledge_answers: a command needs a menu description');
END;

CREATE TRIGGER trg_answers_command_pair_update
BEFORE UPDATE ON knowledge_answers
WHEN (new.command IS NOT NULL AND (new.command_description IS NULL OR TRIM(new.command_description) = ''))
BEGIN
  SELECT RAISE(ABORT, 'knowledge_answers: a command needs a menu description');
END;
