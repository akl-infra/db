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

## Other flagged spots

- web/src/ui/card/PublishSheet.tsx:8:// is `copy/db.ts`'s own stand-in (COPY: sign-off pending -- CLAUDE.md's
- functions/_lib/dbproxy.mjs:47:  return json({ error: 'reauth', reason: 'reauth', message: 'Sign in again to publish' }, 401); // COPY: sign-off pending
