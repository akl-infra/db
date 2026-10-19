-- Keep in-flight private replies distinguishable from silent component updates.
-- Their @original endpoints address different messages: a private reply vs the
-- shared queue card. Defaults preserve safe completion of pre-deploy actions.
ALTER TABLE discord_pending_actions ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'reply' CHECK (response_mode IN ('reply', 'update'));
ALTER TABLE discord_reopen_actions ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'reply' CHECK (response_mode IN ('reply', 'update'));
