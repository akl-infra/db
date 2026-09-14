-- design/layout-db/27-magic-emit.md: a magic key's rule is `{after, emit}`
-- ("after this n-gram the key emits this"), no longer `{after, output}`
-- with `output` repeating the context. Every stored rule already satisfied
-- `output = after + <emitted>` (the old validator refused anything else), so
-- the rewrite is mechanical: `emit = substr(output, length(after) + 1)`,
-- `output` dropped. Applied in place to the current row AND every historical
-- rev (a `revert` re-validates the payload it restores). `payload_json` is
-- `canonical()` output (sorted keys, no whitespace); json_object() writes
-- `after` before `emit` and json_set()/json_group_array() keep the surviving
-- keys' order and minification, so the result is byte-identical to
-- `canonical()` of the same payload (asserted by
-- tests/api/migration-0017.test.ts). Revs are not bumped: the rows the
-- payload lowers to are unchanged (WIRE_VERSION 13 invalidates every cached
-- body anyway). json_group_array follows json_each's array order.
UPDATE layout_formats
   SET payload_json = json_set(payload_json, '$.magic.magic_keys', (
     SELECT json_group_array(json(
       CASE WHEN json_type(mk.value, '$.rules') = 'array' AND json_array_length(mk.value, '$.rules') > 0 THEN
         json_set(mk.value, '$.rules', (
           SELECT json_group_array(json_object(
             'after', json_extract(r.value, '$.after'),
             'emit', substr(json_extract(r.value, '$.output'), length(json_extract(r.value, '$.after')) + 1)))
           FROM json_each(mk.value, '$.rules') AS r))
       ELSE mk.value END))
     FROM json_each(payload_json, '$.magic.magic_keys') AS mk))
 WHERE lineage = 'spark'
   AND json_type(payload_json, '$.magic.magic_keys') = 'array'
   AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.magic.magic_keys') AS mk, json_each(mk.value, '$.rules') AS r WHERE json_type(r.value, '$.output') IS NOT NULL);

UPDATE layout_revs
   SET payload_json = json_set(payload_json, '$.magic.magic_keys', (
     SELECT json_group_array(json(
       CASE WHEN json_type(mk.value, '$.rules') = 'array' AND json_array_length(mk.value, '$.rules') > 0 THEN
         json_set(mk.value, '$.rules', (
           SELECT json_group_array(json_object(
             'after', json_extract(r.value, '$.after'),
             'emit', substr(json_extract(r.value, '$.output'), length(json_extract(r.value, '$.after')) + 1)))
           FROM json_each(mk.value, '$.rules') AS r))
       ELSE mk.value END))
     FROM json_each(payload_json, '$.magic.magic_keys') AS mk))
 WHERE lineage = 'spark' AND payload_json IS NOT NULL
   AND json_type(payload_json, '$.magic.magic_keys') = 'array'
   AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.magic.magic_keys') AS mk, json_each(mk.value, '$.rules') AS r WHERE json_type(r.value, '$.output') IS NOT NULL);
