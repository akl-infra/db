// Discord proof authorship validation before submission [LDB-WPM15], and
// optional proof enrichment after the notification claim [LDB-WPM13].
// No persistent image store: bytes are bounded in memory, then uploaded onto
// the moderation message. Never forward the bot token to a media host.
import type { Bindings } from "../env";
import { invalidProof } from "./errors";

export const PROOF_MAX_IMAGES = 3;
export const PROOF_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const PROOF_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MESSAGE_MAX_BYTES = 256 * 1024;
const PROOF_TIMEOUT_MS = 4000;
const AUTHOR_TIMEOUT_MS = 800;
export type DiscordProofAccess = Pick<Bindings, "DISCORD_API_URL" | "MODQUEUE_DISCORD_BOT_TOKEN">;

export interface ProofImage {
  filename: string;
  content: Uint8Array;
  contentType: string;
  description: string;
  spoiler: boolean;
}
export type ProofPreview = { kind: "images"; images: ProofImage[]; incomplete: boolean }
  | { kind: "youtube"; videoUrl: string; thumbnailUrl?: string }
  | { kind: "unavailable" } | { kind: "none" };

function urlOf(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

export function discordProofMessage(value: string): { channelId: string; messageId: string } | null {
  const url = urlOf(value);
  if (!url || !["discord.com", "www.discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"].includes(url.hostname)) return null;
  const parts = /^\/channels\/\d{17,20}\/(\d{17,20})\/(\d{17,20})\/?$/.exec(url.pathname);
  return parts ? { channelId: parts[1]!, messageId: parts[2]! } : null;
}

function discordImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = urlOf(value);
  return url && ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
    && /^\/attachments\/\d{17,20}\/\d{17,20}\/[^/]+$/.test(url.pathname) ? url.href : null;
}

/** Canonical watch link; arbitrary query text never becomes message content. */
export function youtubeProofUrl(value: string): string | null {
  const url = urlOf(value.replace(/^http:/i, "https:"));
  if (!url) return null;
  let id: string | null = null;
  if (url.hostname === "youtu.be") id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname)) {
    id = url.pathname === "/watch" ? url.searchParams.get("v")
      : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const result = new URL(`https://www.youtube.com/watch?v=${id}`);
  const time = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (time && /^(?:\d+|(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/.test(time)) result.searchParams.set("t", time);
  return result.href;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readDiscordMessage(message: NonNullable<ReturnType<typeof discordProofMessage>>, env: DiscordProofAccess, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!env.MODQUEUE_DISCORD_BOT_TOKEN) throw new Error("Discord proof access is not configured");
  const response = await fetchImpl(`${env.DISCORD_API_URL.replace(/\/$/, "")}/v10/channels/${message.channelId}/messages/${message.messageId}`, {
    method: "GET", headers: { Authorization: `Bot ${env.MODQUEUE_DISCORD_BOT_TOKEN}`, "User-Agent": "akl-db/1.0" },
    redirect: "error", signal,
  });
  const body: unknown = JSON.parse(new TextDecoder().decode(await readBounded(response, MESSAGE_MAX_BYTES, signal)));
  if (!record(body) || body.id !== message.messageId || body.channel_id !== message.channelId) throw new Error("Discord proof response does not match its message");
  return body;
}

// [LDB-WPM15] Unlike optional previews, authorship must be established BEFORE
// any submission write. No cache, no trust in a client-supplied author, and no
// best-effort bypass when Discord or the configured bot cannot read the proof.
export async function verifyDiscordProofAuthor(proof: string, userId: string, env: DiscordProofAccess, fetchImpl: typeof fetch = fetch): Promise<void> {
  const host = new URL(proof).hostname.toLowerCase().replace(/\.$/, "");
  if (!["discord.com", "discordapp.com", "discordapp.net", "discord.gg"].some((domain) => host === domain || host.endsWith(`.${domain}`))) return;
  const message = discordProofMessage(proof);
  if (!message) throw invalidProof("Discord proof must be a Copy Message Link to a message written by the typist; direct image, channel and invite links cannot verify authorship.");
  let body: Record<string, unknown>;
  try {
    body = await readDiscordMessage(message, env, fetchImpl, AbortSignal.timeout(AUTHOR_TIMEOUT_MS));
    if (!record(body.author) || typeof body.author.id !== "string" || !/^\d{17,20}$/.test(body.author.id)) throw new Error("Discord proof author missing");
  } catch {
    throw invalidProof("Could not verify the Discord proof message. Try again, or use your own message in a channel the akldb bot can read.");
  }
  if (!record(body.author) || body.author.id !== userId || body.webhook_id != null || body.author.bot === true) {
    throw invalidProof("The Discord proof message must be written by the person whose WPM is being submitted.");
  }
}

/** Content-Length is only an early rejection; chunked or dishonest bodies are bounded too. */
async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get("content-length")) > limit || !response.body) {
    await response.body?.cancel();
    throw new Error("Proof response unavailable or too large");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Proof response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function imageType(bytes: Uint8Array, contentType: string | null): { extension: string; mime: string } | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  if (type === "image/png" && starts(137, 80, 78, 71, 13, 10, 26, 10)) return { extension: "png", mime: type };
  if (type === "image/jpeg" && starts(255, 216, 255)) return { extension: "jpg", mime: type };
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  if (type === "image/gif" && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return { extension: "gif", mime: type };
  if (type === "image/webp" && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { extension: "webp", mime: type };
  return null;
}

export async function resolveProofPreview(proof: string, env: Bindings, fetchImpl: typeof fetch, budgetMs = PROOF_TIMEOUT_MS): Promise<ProofPreview> {
  const videoUrl = youtubeProofUrl(proof);
  if (videoUrl) return { kind: "youtube", videoUrl, thumbnailUrl: `https://i.ytimg.com/vi/${new URL(videoUrl).searchParams.get("v")!}/hqdefault.jpg` };
  const message = discordProofMessage(proof);
  const direct = discordImageUrl(proof);
  if (!message && !direct) return { kind: "none" };
  if (budgetMs <= 0) return { kind: "unavailable" };
  const signal = AbortSignal.timeout(Math.min(PROOF_TIMEOUT_MS, budgetMs));
  const images: ProofImage[] = [];
  let incomplete = false;
  try {
    let attachments: unknown[];
    if (message) {
      const body = await readDiscordMessage(message, env, fetchImpl, signal);
      if (!Array.isArray(body.attachments)) return { kind: "unavailable" };
      attachments = body.attachments.filter((item) => record(item) && (
        (typeof item.content_type === "string" && item.content_type.startsWith("image/"))
        || (item.content_type === undefined && typeof item.filename === "string" && /\.(?:png|jpe?g|gif|webp)$/i.test(item.filename))));
    } else attachments = [{ url: direct }];
    if (attachments.length > 10) incomplete = true;
    let totalBytes = 0;
    for (const attachment of attachments.slice(0, 10)) {
      if (images.length >= PROOF_MAX_IMAGES || signal.aborted) { incomplete = true; break; }
      const url = record(attachment) ? discordImageUrl(attachment.url) : null;
      const remaining = Math.min(PROOF_MAX_IMAGE_BYTES, PROOF_MAX_TOTAL_BYTES - totalBytes);
      if (!url || remaining <= 0 || (record(attachment) && typeof attachment.size === "number" && attachment.size > remaining)) { incomplete = true; continue; }
      try {
        const response = await fetchImpl(url, { method: "GET", redirect: "error", signal });
        const bytes = await readBounded(response, remaining, signal);
        const type = imageType(bytes, response.headers.get("content-type"));
        if (!type) { incomplete = true; continue; }
        const spoiler = record(attachment) && ((typeof attachment.filename === "string" && attachment.filename.startsWith("SPOILER_"))
          || (typeof attachment.flags === "number" && (attachment.flags & 8) !== 0));
        images.push({ filename: `${spoiler ? "SPOILER_" : ""}wpm-proof-${images.length + 1}.${type.extension}`, content: bytes, contentType: type.mime,
          description: "Copy of submitted WPM proof", spoiler });
        totalBytes += bytes.byteLength;
      } catch { incomplete = true; }
    }
  } catch { incomplete = true; }
  return images.length ? { kind: "images", images, incomplete } : { kind: "unavailable" };
}
