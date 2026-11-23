-- [LDB-MD26] Cards parked by LDB-MD25 because their status edit echoed a File /
-- Media component's resolved CDN url (Discord: UNFURLED_MEDIA_ITEM_MUST_USE_
-- ATTACHMENT_PROTOCOL) can now be edited: core/modqueue-message.ts re-sends
-- those as attachment://<filename>. Un-park exactly those rows, once, with a
-- fresh attempt budget; a row parked for any other reason stays parked.
UPDATE modqueue_notifications
   SET failed_attempts = 0, next_attempt_at = NULL, parked_at = NULL, parked_key = NULL, parked_error = NULL
 WHERE parked_at IS NOT NULL AND parked_error LIKE '%UNFURLED_MEDIA_ITEM_MUST_USE_ATTACHMENT_PROTOCOL%';
