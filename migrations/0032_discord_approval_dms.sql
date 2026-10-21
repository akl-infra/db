-- The private outbox carries both moderation decisions. Existing rows remain rejections.
ALTER TABLE discord_rejection_dm_outbox ADD COLUMN decision TEXT NOT NULL DEFAULT 'rejection'
  CHECK (decision IN ('rejection', 'approval'));
