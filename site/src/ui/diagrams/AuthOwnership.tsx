// W1c: "the sequence diagram for how auth and ownership works" (saltorbit,
// 2026-09-13). Every step below is sourced from code, not memory:
//   1-3  Discord's own OAuth2 authorization-code flow (identify scope) --
//        `db/docs/adoption.md` §2.2, `server/discord.ts` (db/site's own
//        Worker holds the exchanged token server-side; the browser never
//        sees it, S3 -- the diagram's "Browser/App" lane is deliberately
//        one lane because from akldb's own point of view there is exactly
//        one caller, whether or not it proxies through a backend of its
//        own).
//   4    `GET /v1/me` with `Authorization: Bearer <token>` -- the "prove
//        your whole auth chain works" call adoption.md §2.2 itself
//        recommends first.
//   5-6  `db/src/auth/discord.ts`'s `resolveBearer`: a cache miss calls
//        Discord's `GET /oauth2/@me`, cached 5 min on success (60 s on a
//        Discord 401) -- `CACHE_OK_SECONDS`/`CACHE_FAIL_SECONDS`.
//   7    `db/src/auth/roles.ts`'s `roleOf` -- admin/banned, proved fresh on
//        every request, never cached (LDB-MD10).
//   8    `db/src/auth/actor.ts`'s `Actor` shape, minus the fields the
//        diagram doesn't need.
//   9-10 A write's own `If-Match` + `db/src/core/write.ts`'s
//        `loadForWrite`: owner-or-admin, thrown as `not_owner` otherwise.
//   11   `db/src/core/events.ts`'s `commitWrite` -- one D1 transaction,
//        the record's own rev bumped, an event appended.
//   12-13 the write's own response, then `GET /v1/changes` (adoption.md
//        §4: "the change feed is ground truth").
//
// Text-fit: `sequence.ts`'s `checkFit`/`checkLaneFit` are asserted over
// this exact model by `tests/ui/diagrams.test.ts` (SITE-33); the real
// rendered page was also measured in Chrome (`getBBox()` per `<text>` vs
// its lane) per the W1c brief -- zero clipped labels, no squeeze beyond
// what `MAX_SQUEEZE` already allows (see that test's own header for the
// numbers).
import type { Component } from "solid-js";
import SequenceDiagram from "./SequenceDiagram.tsx";
import { buildSequenceModel } from "./sequence.ts";
import type { LaneInput, StepInput } from "./sequence.ts";

export const AUTH_OWNERSHIP_LANES: LaneInput[] = [
  { id: "browser", label: "Browser / App" },
  { id: "discord", label: "Discord" },
  { id: "akldb", label: "akldb" },
  { id: "d1", label: "D1" },
];

export const AUTH_OWNERSHIP_STEPS: StepInput[] = [
  { kind: "arrow", from: "browser", to: "discord", label: "OAuth authorize (identify scope)" },
  { kind: "arrow", from: "discord", to: "browser", label: "redirect: code" },
  { kind: "arrow", from: "browser", to: "discord", label: "exchange code for access token" },
  { kind: "arrow", from: "browser", to: "akldb", label: "GET /v1/me  Bearer <token>" },
  { kind: "arrow", from: "akldb", to: "discord", label: "GET /oauth2/@me (skip if cached <=5m)" },
  { kind: "arrow", from: "discord", to: "akldb", label: "user id + application id" },
  { kind: "self", lane: "akldb", label: "roleOf: admin/banned" },
  { kind: "arrow", from: "akldb", to: "browser", label: "{user_id, name, via, admin}" },
  { kind: "arrow", from: "browser", to: "akldb", label: 'write  If-Match: "<scope>:<rev>"' },
  { kind: "self", lane: "akldb", label: "owner match, or admin" },
  { kind: "arrow", from: "akldb", to: "d1", label: "commitWrite: append event, bump rev" },
  { kind: "arrow", from: "akldb", to: "browser", label: "200/201 updated record" },
  { kind: "arrow", from: "browser", to: "akldb", label: "GET /v1/changes?since=<seq>" },
];

export const authOwnershipModel = buildSequenceModel(AUTH_OWNERSHIP_LANES, AUTH_OWNERSHIP_STEPS);

const AuthOwnership: Component<{ ariaLabel: string }> = (props) => {
  return <SequenceDiagram model={authOwnershipModel} ariaLabel={props.ariaLabel} markerId="akl-seq-auth-arrow" />;
};

export default AuthOwnership;
