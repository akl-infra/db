#!/usr/bin/env node
// db/scripts/validate-akl1-payload.mjs -- runs the REAL akl/1 format's
// validate() (../formats/akl/1/index.ts) against one candidate payload, so
// ../../scripts/migrate_magic_rules_to_db.py (the site's magic migration,
// design/layout-db/11-implementation-phase3.md §1 W5) can know -- with
// zero network traffic -- whether a write would be refused with `400
// magic_collision` and what the fix hint is (01-format.md §2 "Collision
// rule (D4)").
//
// Lives under db/scripts/, not scripts/tools/ (LDB-G5, db/tests/tools/
// boundary.test.ts): the site tree (web/src, scripts, functions, workers,
// tools) must never import a db/ path, and this shim's whole job is
// importing db/formats/akl/1 -- db/'s OWN tooling is where an import like
// that belongs. The Python caller shells out to it the same way it would
// any other cross-language boundary; that's not an import.
//
// This is the same posture as scripts/tools/compile_rules.mjs (which
// stays where it is -- it only imports web/src/core, not db/): call the
// real production code rather than re-deriving its logic in Python
// ("Integrate via real tool" -- parity with the server is the bar, and
// the server runs this exact function server-side too, db/src/core/
// write.ts's validatePayload). ../formats/akl/1/index.ts only imports
// `ajv`/`ajv-formats` plus its own sibling formats via relative,
// extension-explicit `.ts` paths -- no `db/node_modules` install needed,
// Node's resolver walks up to the repo root's node_modules (which
// already has both packages) the same way it would for any nested
// import.
//
// Usage: node db/scripts/validate-akl1-payload.mjs < payload.json
//   input:  a full spark/1 payload object ({ keys, magic? } -- no board since 26-no-board.md)
//   output: the ValidationResult JSON validate() returns --
//           { ok: true } or { ok: false, error: { error, message, ... } }
import { validate } from '../formats/spark/1/index.ts';

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  console.error(`validate-akl1-payload.mjs: invalid JSON on stdin: ${e.message}`);
  process.exit(1);
}

const result = validate(payload);
process.stdout.write(JSON.stringify(result));
