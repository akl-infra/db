# 21 — several formats per layout, repeated letters, webhook lease

Status: decisions recorded; the plan body is still being written. It will be reviewed by an Opus agent before any code is written; Fable is out of credits until 2026-09-12.

Source: xsznix's review in saltorbit's test server, #general, 2026-09-11 11:28–16:14Z, and saltorbit's decisions the same day.

## Decisions (saltorbit, 2026-09-11)

| # | decision |
|---|---|
| D1 | **Webhook delivery takes a lease.** A drain claims a hook before it POSTs and commits on the lease, never on the cursor. This fixes the race xsznix reported ("your webhook seq CAS is racy"): overlapping drains interleaved POSTs and lost failure counts. Built on branch `ldb-webhook-lease`. |
| D2 | **spark/1 keys are a list of positions, not a map from character.** A layout can contain the same letter more than once, exactly as mana2 allows (neon's two `y` keys). |
| D3 | **A layout name holds several formats.** Each format under a name has its own payload, rev, created/modified timestamps and history. Name, owner, likes and deletion stay per layout. The formats are independent: no format has to be convertible to any other. |
| D4 | **No default format.** Every read and every write names its format. A request without one is `400 format_required`. The feed, webhooks and the SSE stream carry no payloads and take no format parameter, but every event names the format it concerns. |
| D5 | **The cmini export is deleted entirely.** `?as=cmini/1`, the `adapter:cmini` alias and `toCmini` go. The cmini *import* (`fromCmini`, the upstream sync) stays. |
| D6 | **akl.gg's editor stays as is.** The site reads the new keys shape; supporting repeated letters on akl.gg is #322. |
| D7 | **Out of scope:** Fossil-style content-addressed revisions and WASM format modules ("overkill"; "idc about wasm"). |
| D8 | **No data migration.** layoutdb is wiped and rebuilt from cmini and akl.gg after the schema change (standing rule: layoutdb is disposable). |
| D9 | **Docs move with the code.** Each slice updates `architecture.md` (the `/layoutdb/` page), `20-spark.md`, `db/README.md`, `bot/README.md` and the invariant IDs it touches. A spark/1 spec page is part of this work. |
| D10 | **spark/1 drops its free-form `x` field.** It existed so the cmini import could round-trip exactly (`x.cmini` held `tag`, `blame`, `combos` and `link`, which spark has nowhere to put) and as a place for other clients' extras. D5 removes the round trip and D3 gives other clients their own formats. Cost: the combos on crescent and finch are not carried (spark has no combos idiom); `link` is already never rendered (18 C3), and nothing reads `tag` or `blame`. |
