// Lane R: re-signing with the lab client key (design/aws-port.md §5.1). The lab copy's `clients` row holds the
// lab public key under this client id, so the real Ed25519 path, nonce and skew checks run. Same key and message
// as scripts/lab/p1-crawl-diff.mjs (`akl-v1\nMETHOD\npathWithQuery\ntimestamp\nnonce\nactor\nbodyHash`).
import crypto from "node:crypto";

export const LAB_CLIENT = "01JAB0000000000000000P1C01";
export const LAB_USER = "100000000000000009";
export const LAB_ADMIN = "100000000000000001";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function labKey(seedText = "akldb-lab-client-key") {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, crypto.createHash("sha256").update(seedText).digest()]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv);
  return { priv, pub, pubRaw: pub.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url") };
}

/** The `clients` row to import into the lab copy so the replay's signatures verify. */
export function labClientRow(opts = {}) {
  const key = opts.key ?? labKey();
  return {
    id: opts.clientId ?? LAB_CLIENT,
    name: "lab-replay",
    pubkey: key.pubRaw,
    owner_user_id: opts.owner ?? LAB_ADMIN,
    caps: "act-as-user,feed:wait",
    discord_app_id: null,
    status: "active",
    created_at: "2026-10-25T00:00:00.000Z",
    revoked_at: null,
  };
}

export function createSigner(opts = {}) {
  const key = opts.key ?? labKey();
  const clientId = opts.clientId ?? LAB_CLIENT;
  return {
    clientId,
    pubRaw: key.pubRaw,
    /** `nonceSeed` must be unique per request (the lab seed is) and identical for both sides. */
    sign({ method, pathWithQuery, body, actor, nowMs, nonceSeed }) {
      const timestamp = String(Math.floor(nowMs / 1000));
      const nonce = crypto.createHash("sha256").update(`nonce:${nonceSeed}`).digest().subarray(0, 16).toString("base64url");
      const bodyHash = crypto.createHash("sha256").update(body ?? Buffer.alloc(0)).digest("base64url");
      const message = `akl-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${actor}\n${bodyHash}`;
      const signature = crypto.sign(null, Buffer.from(message, "utf8"), key.priv).toString("base64url");
      return { "X-Akl-Client": clientId, "X-Akl-Timestamp": timestamp, "X-Akl-Nonce": nonce, "X-Akl-Actor": actor, "X-Akl-Signature": signature };
    },
  };
}
