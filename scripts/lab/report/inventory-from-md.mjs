// Lane S: one-off converter. Reads handoff/aws-coverage-inventory.md's tables and writes the akldb + akldb-site
// entries as JSON (the fixture tests/lab/fixtures/coverage/akldb-inventory.json). Run by hand when the handoff changes:
//   node scripts/lab/report/inventory-from-md.mjs <inventory.md> > tests/lab/fixtures/coverage/akldb-inventory.json
import fs from "node:fs";
import process from "node:process";
import url from "node:url";

// Short stable keys for jobs and background steps (the observed side may use these or the full id).
const KEYS = [
  [/^scheduled\(\) \*\/5 dispatch/, "dispatch-5min"],
  [/^modqueue-notify/, "modqueue-notify"],
  [/^discord-interaction-actions/, "discord-interaction-actions"],
  [/^discord-moderation-dms/, "discord-moderation-dms"],
  [/prune-auth-cache/, "nightly-prune-auth-cache"],
  [/prune-rate-limits/, "nightly-prune-rate-limits"],
  [/prune-nonces/, "nightly-prune-nonces"],
  [/prune-idempotency/, "nightly-prune-idempotency"],
  [/write-dump/, "nightly-write-dump"],
  [/^dump-catchup/, "dump-catchup"],
  [/replica snapshot rebuild/, "replica-snapshot"],
  [/AWS-only: migrations/, "migrations"],
  [/index checker/, "index-checker"],
  [/drainDiscordActions \+ dispatchRejectionDms after a type 5\/6/, "step-interaction-drain"],
  [/notifyPending after link submit/, "step-link-notify"],
  [/announceComment/, "step-comment-announce"],
  [/updateQueueNotification/, "step-comment-decision"],
];

export function parseInventory(md) {
  const items = [];
  for (const line of md.split("\n")) {
    if (!/^\| akldb(-site)? \|/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length < 7) continue;
    const [component, kind, id, writes, source, coverage, gap] = c;
    const cleanId = id.replace(/^`|`$/g, "");
    const item = { component, kind: kind.replace(/ /g, "_"), id: cleanId, writes, source, coverage, gap };
    if (kind === "scheduled job" || kind === "background step") item.key = KEYS.find(([re]) => re.test(cleanId))?.[1] ?? null;
    items.push(item);
  }
  // The handoff inventory (2026-10-25) predates one route the app has (found by the route-table drift test, LDB-PG52).
  const extra = [{ component: "akldb", kind: "http_route", id: "POST /v1/admin/discord-users/refresh", writes: "store: author names; Discord user lookups", source: "db-aws:src/routes/wpm.ts:126", coverage: "NONE (missing from the 2026-10-25 handoff inventory; added by lane S)", gap: "G7" }];
  for (const e of extra) if (!items.some((i) => i.id === e.id)) items.push(e);
  return { source: "handoff/aws-coverage-inventory.md (2026-10-25) + extras", items };
}

if (process.argv[1] && url.fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(parseInventory(fs.readFileSync(process.argv[2], "utf8")), null, 1)}\n`);
}
