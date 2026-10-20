-- Private Discord receipt binding; never part of public submission/dump shapes.
ALTER TABLE wpm_submissions ADD COLUMN source_message_url TEXT;
-- Exact URL rendered by the last successful POST/PATCH, for late binding races.
ALTER TABLE modqueue_notifications ADD COLUMN shown_source_message_url TEXT;
