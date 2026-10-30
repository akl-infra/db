// The recording Store (design/aws-port.md §5.2 item 1): wraps every WRITE method of the storage port, records
// method, arguments, outcome, the event seqs it committed and the values each Clock argument returned, and hands
// the record to a sink. It never changes what the call returns, throws or does; a failure to record is one log
// line (TEE_FAILED) and nothing else. Reads pass through unchanged.
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "../core/errors";
import { RevConflictError } from "../core/events";
import { DuplicateInteractionError, type Store } from "../store/port";
import { encodeTee, type TeeCall } from "./record";

/**
 * Every method of every area, by whether the mirror replays it. The test (tests/mirror/recorder.test.ts) walks a
 * real store and fails on a method in neither list, so a port change must classify its new methods.
 */
export const MIRROR_WRITES: Readonly<Record<string, readonly string[]>> = {
  state: ["put", "delete"],
  events: ["commitWrite", "appendInfo", "appendAdmin", "appendModeration", "appendLinkChange", "appendLike", "appendInheritedLikes"],
  // authors (touch, cache success's author upsert) and idempotency are main-table writes. pruneRateLimits is recorded
  // although ratelimit is ephemeral: it deletes the destructive-budget windows commitWrite's budget probe counts.
  // The rest of auth is ephemeral.
  auth: ["touchClientAuthor", "cacheAuthSuccess", "reserveIdempotency", "takeOverIdempotency", "completeIdempotency", "deleteIdempotency", "pruneIdempotency", "pruneRateLimits"],
  // discord_users (migrations/0036) is a main-table write, like authors.
  discordUsers: ["upsert"],
  admin: ["insertAdmin", "removeAdmin", "upsertBan", "deleteBan", "setAuthorNameByAdmin", "insertClient", "revokeClient", "suspendClient", "reactivateClient"],
  links: ["submit", "reject"],
  wpm: ["bindSourceMessage", "insertApproved", "submit", "approve", "reject"],
  comments: ["submit", "deleteOwn", "approve", "reject", "remove", "like", "unlike"],
  review: ["reopen"],
  modqueue: [
    "bumpFailedAttempts", "leaseNotification", "deleteNotification", "markShown", "releaseNotificationLease", "insertNotification",
    "claimAnnounce", "releaseAnnounce", "claimDeliveryGate", "deferDeliveryGate", "releaseDeliveryGate",
  ],
  discord: [
    "claimAction", "expireActions", "disableActions", "expireLeasedAction", "releaseAction", "completeAction", "clearCallbackToken",
    "bumpCallbackAttempts", "deleteExpiredConfirmations", "consumeConfirmation", "consumeConfirmationAndQueueReopen", "insertDenyModal",
    "consumeModalAndQueueDeny", "insertAction",
  ],
  outbox: ["lease", "beginMessage", "markSent", "clearAmbiguous", "retry", "deferAllPending", "terminal"],
};

/**
 * Methods that are not recorded: reads, the ephemeral tables (nonces, auth_cache, ratelimit; the cutover copies
 * them), the hold lease (no storage on D1), and `dump.restore` (never called in production).
 */
export const MIRROR_NOT_RECORDED: Readonly<Record<string, readonly string[]>> = {
  head: ["readHead", "headSeq", "authorsHead", "metaCounts"],
  state: ["get", "getMany"],
  layouts: [
    "byId", "byName", "byRef", "byIdWithFormats", "byNameWithFormats", "byRefWithFormats", "formatsForLayout", "formatsForLayouts", "readFormat",
    "list", "likers", "history", "revision", "revisionPayload", "latestRevBumpingEvent", "tombstoneLikers", "authorExists", "layoutPresence",
    "approvedLink", "liveCountByOwner", "likeCountByUser",
  ],
  events: ["feed", "revertCandidates", "latestLinkEvent"],
  holds: ["takeHold", "releaseHold"],
  cutover: ["mode"],
  auth: [
    "client", "insertNonce", "pruneNonces", "authCache", "cacheAuthFailure", "pruneAuthCache", "rolesOf", "authorName", "authors", "author",
    "hitWindow", "getIdempotency",
  ],
  discordUsers: ["get", "version", "missingWpmUsers"],
  admin: ["isAdmin", "listAdmins", "getAdmin", "listBans", "banExists", "clientStatus", "listClients", "suspendedClients"],
  links: ["pending", "get", "queue"],
  wpm: ["get", "sourceMessage", "queue", "records"],
  comments: ["get", "hasBody", "queue", "counts", "list", "approvedSlotExists", "pairRows", "mine"],
  review: ["decisionState", "history", "submissionLayout", "reopenRecorded", "submissionDecision"],
  modqueue: ["sourceStatus", "notification", "staleNotifications", "linkCandidates", "wpmCandidates", "commentCandidate"],
  discord: ["trackedTarget", "hasReceipt", "pendingCallbacks", "reopenConfirmation", "denyModal"],
  outbox: ["due", "content"],
  dump: ["tables", "restore"],
};

interface SeqContext {
  seqs: number[];
}
const seqContext = new AsyncLocalStorage<SeqContext>();

/** Called by the observed databases when a statement committed event `seq`. A no-op outside a recorded call. */
export function noteSeq(seq: number): void {
  seqContext.getStore()?.seqs.push(seq);
}

type Outcome = TeeCall["outcome"];

function errorOutcome(e: unknown): Outcome {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ApiError) return { error: { name: "ApiError", status: e.status, body: encodeTee(e.body), message } };
  if (e instanceof RevConflictError) return { error: { name: "RevConflictError", body: encodeTee({ layoutId: e.layoutId }), message } };
  if (e instanceof DuplicateInteractionError) return { error: { name: "DuplicateInteractionError", message } };
  const name = e instanceof Error ? e.name : typeof e;
  return { error: { name, message } };
}

function logFailed(what: string, e: unknown): void {
  console.error(`TEE_FAILED ${what}: ${e instanceof Error ? e.message : String(e)}`);
}

type AsyncFn = (...args: unknown[]) => Promise<unknown>;

function recordWrite(method: string, fn: AsyncFn, sink: (c: TeeCall) => void): AsyncFn {
  return async (...args: unknown[]) => {
    // Snapshot the arguments before the call: the caller may mutate them afterwards. A Clock becomes a logging wrapper.
    const clockLogs = new Map<number, string[]>();
    let encodedArgs: unknown[] | null = null;
    const callArgs = args.map((a, i) => {
      if (typeof a !== "function") return a;
      const log: string[] = [];
      clockLogs.set(i, log);
      return () => {
        const v = (a as () => string)();
        log.push(v);
        return v;
      };
    });
    try {
      encodedArgs = args.map((a, i) => (clockLogs.has(i) ? null : encodeTee(a)));
    } catch (e) {
      logFailed(`${method} args`, e);
    }
    const ctx: SeqContext = { seqs: [] };
    let result: unknown;
    let thrown: unknown;
    let failed = false;
    try {
      result = await seqContext.run(ctx, () => fn(...callArgs));
    } catch (e) {
      failed = true;
      thrown = e;
    }
    const atMs = Date.now();
    try {
      if (encodedArgs !== null) {
        for (const [i, log] of clockLogs) encodedArgs[i] = { $clock: log };
        let outcome: Outcome;
        if (failed) outcome = errorOutcome(thrown);
        else {
          try {
            outcome = { ok: encodeTee(result) };
          } catch (e) {
            logFailed(`${method} result`, e);
            outcome = { ok: { $unencodable: 1 } };
          }
        }
        const seqs = [...new Set(ctx.seqs)].sort((a, b) => a - b);
        sink({ v: 1, method, args: encodedArgs, outcome, seqs, atMs });
      }
    } catch (e) {
      logFailed(method, e);
    }
    if (failed) throw thrown;
    return result;
  };
}

/** `inner` with every write method recorded into `sink`. Reads are the inner methods, called on their own area object. */
export function recordingStore(inner: Store, sink: (c: TeeCall) => void): Store {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [area, methods] of Object.entries(inner as unknown as Record<string, Record<string, unknown>>)) {
    const writes = new Set(MIRROR_WRITES[area] ?? []);
    const wrapped: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(methods)) {
      if (typeof fn !== "function") {
        wrapped[name] = fn;
      } else if (writes.has(name)) {
        wrapped[name] = recordWrite(`${area}.${name}`, (...a) => (fn as AsyncFn).apply(methods, a), sink);
      } else {
        wrapped[name] = (fn as (...x: unknown[]) => unknown).bind(methods);
      }
    }
    out[area] = wrapped;
  }
  return out as unknown as Store;
}
