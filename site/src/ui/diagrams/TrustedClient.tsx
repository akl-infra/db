// W1c: "how trusted discord clients work" (saltorbit, 2026-09-13). Every step
// below is sourced from code, not memory:
//   pre   `db/docs/adoption.md` §2.1 / `db/src/routes/admin.ts`'s
//        `POST /v1/admin/clients` -- one-time, admin-run, out of band from
//        the request flow below (drawn as a note, not a lane, since it
//        happens once per client, not once per request).
//   1    the bot's own trigger -- it already trusts `message.author.id`
//        (adoption.md §1.1: "your program already trusts
//        `message.author.id`").
//   2    `db/src/auth/client.ts`'s `signingString` -- the five-field
//        string signed with the client's Ed25519 key.
//   3    the five request headers `verifyClientRequest` reads
//        (`X-Akl-Client`/`-Timestamp`/`-Nonce`/`-Actor`/`-Signature`).
//   4-6  `verifyClientRequest`'s own step order: signature verified under
//        the stored pubkey, the nonce INSERTed (its own PK is the replay
//        check), then `scopeCapOf(caps) === "act-as-owner-only"` checked
//        against `X-Akl-Actor`.
//   7-8  the same write pipeline the user lane uses (`core/write.ts`'s
//        `commitWrite`) -- `Actor.via` is `` `client:<id>` `` on this lane,
//        recorded on the event same as any other.
//   9-11 `db/docs/adoption.md` §4's long-poll: `wait=` honoured for any
//        request signed on the client lane, no extra cap needed, the
//        Worker checking the event head "about once a second" until
//        `since` is exceeded or `wait` elapses (clamped to 25 s).
//
// Text-fit: see AuthOwnership.tsx's own header for the shared method
// (`sequence.ts`'s `checkFit`/`checkLaneFit`, `tests/ui/diagrams.test.ts`,
// SITE-33) and the real-Chrome measurement this diagram was also checked
// against.
import type { Component } from "solid-js";
import SequenceDiagram from "./SequenceDiagram.tsx";
import { buildSequenceModel } from "./sequence.ts";
import type { LaneInput, StepInput } from "./sequence.ts";

export const TRUSTED_CLIENT_LANES: LaneInput[] = [
  { id: "discord", label: "Discord" },
  { id: "client", label: "Client (bot)" },
  { id: "akldb", label: "akldb" },
  { id: "d1", label: "D1" },
];

export const TRUSTED_CLIENT_STEPS: StepInput[] = [
  { kind: "arrow", from: "discord", to: "client", label: "message.author.id" },
  { kind: "self", lane: "client", label: "sign: Ed25519(method,path,ts,nonce,actor,hash)" },
  { kind: "arrow", from: "client", to: "akldb", label: "signed request (5 X-Akl-* headers)" },
  { kind: "self", lane: "akldb", label: "verify sig, stored pubkey" },
  { kind: "arrow", from: "akldb", to: "d1", label: "INSERT nonce (PK = replay check)" },
  { kind: "self", lane: "akldb", label: "caps: act-as-user or owner" },
  { kind: "arrow", from: "akldb", to: "d1", label: "commitWrite: append event, bump rev" },
  { kind: "arrow", from: "akldb", to: "client", label: "200/201 (same write pipeline)" },
  { kind: "arrow", from: "client", to: "akldb", label: "GET /v1/changes?wait=25 (client lane)" },
  { kind: "arrow", from: "akldb", to: "d1", label: "poll the event head, ~1/s" },
  { kind: "arrow", from: "akldb", to: "client", label: "answers when since or wait is due" },
];

export const trustedClientModel = buildSequenceModel(TRUSTED_CLIENT_LANES, TRUSTED_CLIENT_STEPS);

const TrustedClient: Component<{ ariaLabel: string }> = (props) => {
  return <SequenceDiagram model={trustedClientModel} ariaLabel={props.ariaLabel} markerId="akl-seq-trusted-arrow" />;
};

export default TrustedClient;
