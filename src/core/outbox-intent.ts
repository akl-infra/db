// The decision DM outbox row a moderation decision queues, as data for the
// storage port (src/store/port.ts `OutboxIntent`). The same key and nonce
// rule as core/rejection-dm.ts's `decisionOutboxStatement`, which it
// replaces during P1 (design/p1-briefs.md): agents C and D both build
// decisions from this one function.
import type { OutboxIntent } from "../store/port";
import { discordNonceFor, type RejectionDelivery } from "./rejection-dm";

export async function outboxIntent(input: RejectionDelivery, decision: "rejection" | "approval"): Promise<OutboxIntent> {
  const deliveryKey = `${decision}:${input.kind}:${input.submissionId}${input.reviewVersion ? `:${input.reviewVersion}` : ""}`;
  return {
    decision,
    deliveryKey,
    nonce: await discordNonceFor(deliveryKey),
    kind: input.kind,
    submissionId: input.submissionId,
    layoutId: input.layoutId,
    recipientId: input.recipientId,
    at: input.at,
    reviewVersion: input.reviewVersion ?? 0,
  };
}
