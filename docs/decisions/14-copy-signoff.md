# 14 — Copy awaiting sign-off

Every user-facing string the layout-DB work introduced, flagged `// COPY: sign-off pending` in its source. saltorbit signs off by editing the string in place (or replying "fine") and removing the flag; the invariant tests do not depend on the wording. Generated 2026-09-09T15:51Z from the branch; regenerate with `sh scratchpad/copy-signoff.sh`.

## `web/src/copy/db.ts`

```ts
8-// invent user-facing copy without it). Every entry below is flagged
9:// `// COPY: sign-off pending`. No UI consumes this module yet -- it lands
10-// ahead of the DraftCard/publish-sheet/bench-footer/own-card-verb
11-// components this slice's own handoff describes as not yet built, so the
12-// component work that follows has real copy to read from day one instead
22-  // "from <b>sturdy</b> by oxey · <span class="dest">not published</span>"
23:  fromByNotPublished: (base: string, author: string): string => // COPY: sign-off pending
24-    `from ${base} by ${author} · not published`,
25-  // "changes to <b>whirl</b> (yours) · <span class="dest">not published</span>"
26:  changesToYoursNotPublished: (base: string): string => // COPY: sign-off pending
27-    `changes to ${base} (yours) · not published`,
28:  publishToCminiVerb: 'Publish to cmini…', // COPY: sign-off pending
29:  updateVerb: (name: string): string => `Update ${name}…`, // COPY: sign-off pending
30-
31-  // ── 2.2 the publish sheet ──────────────────────────────────────────────
32:  publishSheetTitle: 'Publish to cmini', // COPY: sign-off pending
33:  publishSheetSubtitle: 'as a new layout', // COPY: sign-off pending
34:  updateSheetTitle: (name: string): string => `Update ${name}`, // COPY: sign-off pending
35:  updateSheetSubtitle: 'replaces the record in the cmini DB', // COPY: sign-off pending
36:  fieldName: 'name', // COPY: sign-off pending
37:  fieldBoard: 'board', // COPY: sign-off pending
38:  fieldFingermap: 'fingermap', // COPY: sign-off pending
39:  fieldLink: 'link', // COPY: sign-off pending
40:  fieldTravels: 'travels', // COPY: sign-off pending
41:  linkPlaceholder: 'https:// (optional)', // COPY: sign-off pending
42-  // "✓ available · `!cmini view sturdy-vy` will work"
43:  nameAvailableHint: (name: string): string => `✓ available · !cmini view ${name} will work`, // COPY: sign-off pending
44-  // "taken — <b>whirl</b> is yours. <a>Update whirl instead</a>, or pick another name."
45:  nameTakenIsYoursHint: (name: string): string => // COPY: sign-off pending
46-    `taken — ${name} is yours. Update ${name} instead, or pick another name.`,
47-  // A generic "taken, not yours" hint -- the mockups only draw the
48-  // is-yours case explicitly; this is the natural sibling for a name
49-  // someone else already holds.
50:  nameTakenHint: 'taken — pick another name.', // COPY: sign-off pending
51-  // "keys · standard fingermap · 2 magic rules"
52:  travelsLine: (fingermap: string, ruleCount: number): string => // COPY: sign-off pending
53-    ruleCount > 0 ? `keys · ${fingermap} fingermap · ${ruleCount} magic rule${ruleCount === 1 ? '' : 's'}` : `keys · ${fingermap} fingermap`,
54-  // "Signed in as <b>deeroh</b> · this becomes yours in the cmini DB; the
55-  // bot's <code>!cmini remove</code> and this card's Delete both work on it."
56:  publishFooterNote: (user: string): string => // COPY: sign-off pending
57-    `Signed in as ${user} · this becomes yours in the cmini DB; the bot's !cmini remove and this card's Delete both work on it.`,
58-  // "Signed in as <b>deeroh</b> · whirl keeps its 61 likes and its id.
59-  // <a>Publish as a new layout instead</a>"
60:  updateFooterNote: (user: string, name: string, likes: number): string => // COPY: sign-off pending
61-    `Signed in as ${user} · ${name} keeps its ${likes} likes and its id.`,
62:  publishAsNewInstead: 'Publish as a new layout instead', // COPY: sign-off pending
63-  // "<b>Sign in with Discord</b> to publish. It is the same account the
64-  // cmini bot uses; the layout is added under it, exactly as if you had
65-  // typed <code>!cmini add</code>."
66:  signInToPublishNote: 'Sign in with Discord to publish. It is the same account the cmini bot uses; the layout is added under it, exactly as if you had typed !cmini add.', // COPY: sign-off pending
67:  signInVerb: 'Sign in', // COPY: sign-off pending
68:  namesUniqueNote: 'Names are unique across the whole cmini DB, same as the bot.', // COPY: sign-off pending
69-  // "cmini rejected it: <b>missing gap before column `k c`</b>. Nothing was
70-  // published — your draft is untouched."
71:  apiErrorNote: (message: string): string => `cmini rejected it: ${message}. Nothing was published — your draft is untouched.`, // COPY: sign-off pending
72:  tryAgainVerb: 'Try again', // COPY: sign-off pending
73:  publishVerb: 'Publish', // COPY: sign-off pending
74:  cancelVerb: 'Cancel', // COPY: sign-off pending
75-
76-  // ── 2.3 bench footer (own layout) ──────────────────────────────────────
77-  // the bind line: "changes to <b>whirl</b> · yours"
78:  benchBindNote: (name: string): string => `changes to ${name} · yours`, // COPY: sign-off pending
79-
80-  // ── 2.4 own card verbs ──────────────────────────────────────────────────
81:  editKeysVerb: 'Edit keys', // COPY: sign-off pending
82:  renameVerb: 'Rename', // COPY: sign-off pending
83:  linkVerb: 'Link', // COPY: sign-off pending
84:  moreVerb: 'More', // COPY: sign-off pending
85:  fingermapVerb: 'Fingermap', // COPY: sign-off pending
86:  deleteFromCminiVerb: 'Delete from cmini', // COPY: sign-off pending
87:  giveToVerb: 'Give to…', // COPY: sign-off pending
88-  // rename sheet: "Same as `!cmini rename whirl whirl-v2`."
89:  renameSameAsNote: (oldName: string, newName: string): string => `Same as !cmini rename ${oldName} ${newName}.`, // COPY: sign-off pending
90-  // "✓ available · keeps the id, the likes and the rules · the bot sees the
91-  // new name at once"
92:  renameAvailableHint: '✓ available · keeps the id, the likes and the rules · the bot sees the new name at once', // COPY: sign-off pending
93-
94-  // ── 2.5 after publish ────────────────────────────────────────────────────
95:  verifyingBadge: 'verifying · draft numbers', // COPY: sign-off pending
96:  liveBadge: 'live', // COPY: sign-off pending
97-  // "Published just now. Sorting and filters already use these numbers;
98-  // the site build re-confirms them in about two minutes."
99:  publishedJustNowNote: 'Published just now. Sorting and filters already use these numbers; the site build re-confirms them in about two minutes.', // COPY: sign-off pending
100-  // "SFB 0.71 in the draft, 0.73 from the site build — the build's number
101-  // is shown. This should not happen; it has been reported."
102:  tripwireNote: (stat: string, draftValue: string, patchValue: string): string => // COPY: sign-off pending
103-    `${stat} ${draftValue} in the draft, ${patchValue} from the site build — the build's number is shown. This should not happen; it has been reported.`,
104-
105-  // ── 2.6 conflict + delete ───────────────────────────────────────────────
107-  // (2 keys). Your changes are kept here either way."
108:  conflictNote: (name: string, when: string, via: string, keyCount: number): string => // COPY: sign-off pending
109-    `${name} changed in cmini since you started — ${when} ago, ${via} (${keyCount} key${keyCount === 1 ? '' : 's'}). Your changes are kept here either way.`,
110-  // The 409 `last_write.via` -> words (design/layout-db/
111-  // 11-implementation-phase3.md §0's last row): 'discord' -> "on akl.gg",
112-  // 'client:<id>' -> "via the bot", 'import:cmini' -> "from cmini".
113:  viaWord: (via: string): string => { // COPY: sign-off pending
114-    if (via === 'discord') return 'on akl.gg';
115-    if (via && via.startsWith('client:')) return 'via the bot';
116-    if (via === 'import:cmini') return 'from cmini';
118-  },
119:  reapplyVerb: (name: string): string => `Re-apply onto the live ${name}`, // COPY: sign-off pending
120:  overwriteVerb: 'Overwrite', // COPY: sign-off pending
121-  // "Delete <b>whirl</b> from the cmini DB? Its 61 likes and 2 magic rules
122-  // go with it. <b>It stays here as a draft.</b> Same as
123-  // <code>!cmini remove whirl</code>."
124:  deleteConfirmNote: (name: string, likes: number, ruleCount: number): string => { // COPY: sign-off pending
125-    const rules = ruleCount > 0 ? ` and ${ruleCount} magic rule${ruleCount === 1 ? '' : 's'}` : '';
126-    return `Delete ${name} from the cmini DB? Its ${likes} likes${rules} go with it. It stays here as a draft. Same as !cmini remove ${name}.`;
127-  },
128:  deleteVerb: 'Delete', // COPY: sign-off pending
129:  keepVerb: 'Keep', // COPY: sign-off pending
130-  // "was <b>whirl</b> in cmini until just now · <span class="dest">not published</span>"
131:  wasInCminiUntilJustNow: (name: string): string => `was ${name} in cmini until just now · not published`, // COPY: sign-off pending
132-  // undo pill: "whirl removed from cmini" / "Undo"
133:  removedFromCminiMsg: (name: string): string => `${name} removed from cmini`, // COPY: sign-off pending
134:  undoVerb: 'Undo', // COPY: sign-off pending
135-
136-  // ── 2.7 identity (Settings row) ──────────────────────────────────────────
137:  connectedToCmini: 'connected to cmini', // COPY: sign-off pending
138:  signInAgainToPublish: 'Sign in again to publish', // COPY: sign-off pending -- same stand-in functions/_lib/dbproxy.mjs's reauthRequired() already carries server-side (W3); kept identical here s
139:  authDbSubLabel: 'Used to publish layouts and magic rules to the cmini DB under your Discord account.', // COPY: sign-off pending
140-
141-  // ── magic collision (01-format.md §3) ────────────────────────────────────
142:  applyFixAndPublishVerb: 'Apply fix and publish', // COPY: sign-off pending
143-} as const;
```

## `bot/src/copy.ts`

```ts
1:// bot/src/copy.ts -- COPY: sign-off pending. User-facing bot strings that
2-// are new (not a direct port of cmini's own wording -- those live inline
3-// next to the parity table row they come from) -- saltorbit's copy surface
4-// (CLAUDE.md: "never touch user-facing copy... as a side effect"),
```

LDB-B26 (branch `ldb-b26`, 2026-09-10) adds FIVE new strings -- `quoteUserText`'s own neutral fallback per kind, printed instead of a user's raw text once it fails that kind's allow-list:

```ts
155:// COPY: sign-off pending -- the five neutral fallbacks `quoteUserText`
156-// prints instead of a user's raw text once it fails that kind's allow-
157-// list. Chosen to keep the surrounding cmini-parity sentence grammatical
158-// ("Error: couldn't find any layout named that layout") without ever
159-// repeating anything that wasn't typed as an actual name/corpus/ngram/
160-// command.
161:function thatLayout(): string { return 'that layout'; }
162:function thatUser(): string { return 'that user'; }
163:function thatCorpus(): string { return 'that corpus'; }
164:function thatNgram(): string { return 'that n-gram'; }
165:function thatVerb(): string { return 'that command'; }
```

## `bot/src/main.ts`

LDB-B27 (branch `ldb-b26`, 2026-09-10) adds ONE new string -- the marker line `capReplyContent` appends when it has to cut an over-2 000-char reply short:

```ts
122:// COPY: sign-off pending -- the marker line `capReplyContent` appends when
123-// it has to cut a reply short (F2, `16-command-audit.md` §3).
124:const TRUNCATED_MARKER = '… (truncated)';
```

## `bot/src/copy.ts` (round 2, worktree `worktree-ldb-v3`, 2026-09-10)

`18-command-decisions.md` §2's C1-C8/C12 items add THREE new strings:

```ts
// C2 (18-command-decisions.md, LDB-B31, 2026-09-10): `search`/`filter`/
// `homerow`'s DSL is gone -- "the complex things should direct people to
// the site" (saltorbit). Registered honest redirect stubs rather than
// unregistered/"unknown command" -- one line, a masked link to akl.gg's
// own filters, matching the LDB-B25 masked-link template (`[akl.gg](<url>)`).
// COPY: sign-off pending
export function siteFiltersRedirect(siteBaseUrl: string): string {
  return `Search and filter live on akl.gg: [akl.gg](<${siteBaseUrl}>)`;
}

// C6 (18-command-decisions.md, LDB-B34, 2026-09-10): `authors [page]`
// pages like `rank` (same 15-per-page size). ...
// COPY: sign-off pending
export function invalidPageNumber(): string {
  return 'Error: invalid page number';
}

export function pageOutOfRange(page: number, totalPages: number): string {
  const plural = totalPages === 1 ? 'is' : 'are';
  const noun = totalPages === 1 ? 'page' : 'pages';
  return `Error: page ${page} is out of range -- there ${plural} only ${totalPages} ${noun}`;
}
```

Plus one changed `desc()` string (not flagged inline -- `use()`/`desc()`
text follows the existing lighter convention, "the description text is a
bot string, ledgered", `authors.ts`'s own header comment) — listed here
for the same sign-off:

- `commands/assign.ts`: `'assign your layout to a new author'` →
  `'assign your layout to a new author (alias: transfer)'` (C4, LDB-B32 --
  `transfer` is registered as a second key for the same Command).
- `commands/search.ts`/`filter.ts`/`homerow.ts`: `desc()` reworded to
  `'... -- now on akl.gg'` (C2, LDB-B31), and `use()` shortened to just the
  bare verb name (no more flag/arg usage line, since none of the three
  parses args any more).
- `commands/authors.ts`: `desc()` → `'see a list of layout creators, 15
  per page'` (C6, LDB-B34); `use()` → `'authors [page]'`.
- `commands/history.ts`: `desc()` → `"see a layout's changelog on akl.gg"`
  (C7, LDB-B35; was `'see the last 5 events for a layout'`).
- `commands/image.ts`: `desc()` → `"get a picture of a layout's detail
  card, or a compare card for two"` (C12, LDB-B36); `use()` →
  `'image [name] [old_name]'`.

Two masked links reuse the EXISTING `appendSiteLink`/`[akl.gg](<url>)`
template (`siteLink.ts`'s new `appendMaskedLink`, C7/C8/C12's `history`/
`compare`/`image <a> <b>`) -- no new wording there, just the same visible
text (`akl.gg`) pointed at a different url. `image <a> <b>`'s header line
reuses `compare.ts`'s own EXISTING parity text (`${new}(new) -
${old}(old)`) verbatim rather than inventing new "a vs b" wording.

## `bot/src/copy.ts` + `bot/src/commands/spacegrams.ts` (round 3, worktree `ldb-c13-bot`, 2026-09-10)

`18-command-decisions.md` §2's C13/C10 items add FOUR new strings:

```ts
// bot/src/copy.ts -- LDB-B37 (C13): `!image`'s footer suffix, now a
// function of the caller's own spacegrams setting rather than a static
// string (`off` keeps the exact wording the round-2 section above already
// shipped as `noSpacegramsSuffix`, now removed).
// COPY: sign-off pending
export function spacegramsFooterSuffix(pref: SpacegramsPref): string {
  if (pref === 'left') return ' · spacegrams (left thumb)';
  if (pref === 'right') return ' · spacegrams (right thumb)';
  return ' · no spacegrams';
}
```

```ts
// bot/src/commands/spacegrams.ts -- LDB-B37 (C13): the new `!spacegrams`
// verb's own three replies (no cmini parity-table row to match -- a new
// preference, same posture as `setcorpus.ts`'s own un-prefixed replies).
// COPY: sign-off pending
`Your spacegrams preference is \`${current}\`.`               // no arg
`${quoteUserText(arg, 'corpus')} isn't \`off\`, \`left\`, or \`right\`.`  // invalid arg
`Your spacegrams preference has been changed to \`${parsed}\`.`          // set
```

Plus FIVE changed `desc()` strings (not flagged inline -- same lighter
convention as C4's `assign.ts` change above), one per C10 alias:

- `commands/alternates.ts`: `'see the best hand alternations for a
  particular layout'` → `'... (alias: alternates)'` (`alt` is now the
  primary registered name, `commands/index.ts`).
- `commands/rolls.ts`: `'see the best rolls for a particular layout'` →
  `'... (alias: rolls)'` (`rol2` primary).
- `commands/onehands.ts`: `'see the best onehands for a particular
  layout'` → `'... (alias: onehands)'` (`rol3` primary).
- `commands/redirects.ts`: `'see the worst redirects for a particular
  layout'` → `'... (alias: redirects)'` (`red` primary).
- `commands/sfbs.ts`: `'see the worst same-finger bigrams for a particular
  layout'` → `'... (alias: sfbs)'` (`sfb` primary).

`commands/spacegrams.ts` also gets its own `desc()`/`use()` pair (new
verb, no prior string to diff against):

- `use()`: `'spacegrams [off|left|right]'`
- `desc()`: `'set whether stats treat space as a thumb key (off/left/right)'`

## Round 4 — directed by saltorbit 2026-09-10 (3-rolls not onehands; akl.gg names everywhere) — SIGNED

Two verbatim asks (2026-09-10): *"Spacegrams should also support auto"*
and *"this should say 3-rolls, not onehands ```Top 10 graphite Onehands:
...``` (If there's anywhere else similar, let's fix)"*. The STAT NAMES
below are user-facing copy saltorbit directed in that message, so they are
**signed off, not pending** (LDB-B40, `bot/src/copy.ts`'s `NGRAM_LABELS`
+ `STAT_LABELS`; sources: `web/src/copy/explainer.ts`'s names,
`web/src/copy/card.ts`'s card labels, both read only):

| surface | old (cmini) | new (akl.gg) |
|---|---|---|
| `Top 10 <layout> …:` header, `onehands`/`rol3` | `Onehands` | `3-Rolls` |
| `Top 10 <layout> …:` header, `rolls`/`rol2` | `Rolls` | `2-Rolls` |
| `Top 10 <layout> …:` header, `inrolls` | `Inrolls` | `2-Rolls In` |
| `Top 10 <layout> …:` header, `outrolls` | `Outrolls` | `2-Rolls Out` |
| `Top 10 <layout> …:` header, `alternates`/`alt` | `Alternates` | `Alternations` |
| `Top 10 <layout> …:` header, `redirects`/`red`, `sfbs`/`sfb`, `sfs` | `Redirects`/`SFBs`/`SFS` | unchanged |
| `view`/`compare`/write-success stats block (`render/grid.ts`'s `statsStr`) | rows `Alt`, `Rol`, `One`, `Rtl`, `Red (Bad)`, `SFB`, `SFS (Red/Alt)`, `LH/RH` | rows `Alt`, `Roll` (In/Out), `Rol2` (In/Out), `Rol3` (In/Out), `Red` (Bad), `SFB`, `SFS` (Alt/Red), `LH/RH` — the card's order (`ui/card/StatsCmini.tsx`), cmini's column shape |

Stretch/Scissor and the NoTh/Thumb sub-rows are NOT added: the composed
cmini row the bot prints from carries none of those numbers.

Still **pending** from this round (sentences, not stat names — same
lighter convention as C4's `desc()` changes):

- `commands/onehands.ts` `desc()`: `'see the best onehands for a
  particular layout (alias: onehands)'` → `'see the best 3-rolls for a
  particular layout (alias: onehands)'`
- `commands/rolls.ts` `desc()`: `'see the best rolls …'` → `'see the best
  2-rolls for a particular layout (alias: rolls)'`
- `commands/inrolls.ts` `desc()`: `'see the best inward rolls …'` → `'see
  the best inward 2-rolls for a particular layout'`
- `commands/outrolls.ts` `desc()`: `'see the best outward rolls …'` →
  `'see the best outward 2-rolls for a particular layout'`
- `commands/spacegrams.ts` (LDB-B39, `auto`): `use()` `'spacegrams
  [off|left|right|auto]'`; `desc()` `'set whether stats treat space as a
  thumb key (off/left/right/auto)'`; the invalid-arg reply now ends
  ``isn't `off`, `left`, `right`, or `auto`.``; the no-arg/set replies
  are unchanged and simply print `auto` as the value.
- ~~`bot/src/copy.ts` `spacegramsFooterSuffix` (LDB-B39): `' · spacegrams
  (auto: left thumb)'` / `' · spacegrams (auto: right thumb)'`, and on a
  compare card whose two layouts resolved differently `' · spacegrams
  (auto: new left thumb, old right thumb)'` (new first, matching the
  `a(new) - b(old)` header order).~~ — SUPERSEDED by round 5 (the long
  forms are gone).

## Round 5 — directed by saltorbit 2026-09-10 (mockup round, T2 + I1 picks) — SIGNED

Two strings, dictated verbatim by saltorbit ("SG On or SG Off") for `!image`'s
footer (LDB-B42, `bot/src/copy.ts`'s `spacegramsFooterSuffix`), replacing
round 3/4's long forms, which overflowed the card's footer into the LH/RH
block:

| surface | old | new (signed) |
|---|---|---|
| `!image` footer, spacegrams preference `off` | `corpus: reddit · no spacegrams  ·  akl.gg` | `corpus: reddit · SG Off  ·  akl.gg` |
| `!image` footer, any resolved side (`left`/`right`/`auto`, a compare card whose sides differ included) | `corpus: reddit · spacegrams (left thumb)  ·  akl.gg`, `… (auto: new left thumb, old right thumb) …` | `corpus: reddit · SG On  ·  akl.gg` |

Also in this round, not copy strings and needing no sign-off: the `␣`
glyph the `view`/`compare` text grid shows under the space thumb
(LDB-B41), and the `NoTh:`/`Thumb:` stats-block labels (LDB-B44) — the
latter are `web/src/copy/card.ts`'s own `noTh`/`thumb` (akl.gg's names,
round 4's rule: signed).

## Other flagged spots

- web/src/ui/card/PublishSheet.tsx:8:// is `copy/db.ts`'s own stand-in (COPY: sign-off pending -- CLAUDE.md's
- functions/_lib/dbproxy.mjs:47:  return json({ error: 'reauth', reason: 'reauth', message: 'Sign in again to publish' }, 401); // COPY: sign-off pending
