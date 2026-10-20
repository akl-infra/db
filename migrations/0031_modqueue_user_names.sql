-- Reconcile tracked cards once so missing author profiles display Discord
-- names instead of raw snowflakes. Existing leases/retries bound the refresh.
UPDATE modqueue_notifications SET shown_review_version = -1;
