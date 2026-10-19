import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { discordProofMessage, youtubeProofUrl, resolveProofPreview, verifyDiscordProofAuthor, PROOF_MAX_IMAGE_BYTES, PROOF_MAX_TOTAL_BYTES } from "../../src/core/modqueue-proof";

const env = { DISCORD_API_URL: "https://discord.test/api", MODQUEUE_DISCORD_BOT_TOKEN: "private-token" } as Bindings;
const channel = "900000000000000001";
const message = "900000000000000002";
const proof = `https://discord.com/channels/900000000000000000/${channel}/${message}`;
const cdn = `https://cdn.discordapp.com/attachments/${channel}/900000000000000003/proof.png?ex=123&is=456&hm=789`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const image = (url = cdn, size = png.length) => ({ url, filename: "proof.png", content_type: "image/png", size });
const response = (attachments: unknown[]) => Response.json({ id: message, channel_id: channel, attachments });
const imageResponse = (bytes: Uint8Array = png, contentType = "image/png") => new Response(bytes, { headers: { "content-type": contentType } });

describe("Discord WPM proof authorship", () => {
  const user = "900000000000000010";
  const owned = { id: message, channel_id: channel, author: { id: user }, attachments: [] };

  it("[LDB-WPM15] accepts only the verified human author, without needing message content or making image downloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(owned));
    await expect(verifyDiscordProofAuthor(proof, user, env, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bot private-token");
    for (const body of [{ ...owned, author: { id: "900000000000000011" } },
      { ...owned, webhook_id: "900000000000000012" }, { ...owned, author: { id: user, bot: true } }]) {
      await expect(verifyDiscordProofAuthor(proof, user, env, vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(body))))
        .rejects.toMatchObject({ status: 400, body: { error: "invalid_proof", message: expect.stringContaining("must be written by") } });
    }
  });

  it("[LDB-WPM15] direct CDN links and non-message Discord URLs cannot bypass verification; other providers make no lookup", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const value of [cdn, "https://media.discordapp.net/attachments/1/2/proof.png", "https://discord.gg/test",
      `https://discord.com/channels/900000000000000000/${channel}`, proof.replace("https:", "http:"),
      proof.replace("discord.com", "discord.com."), proof.replace("discord.com", "discord.com:444"),
      proof.replace("discord.com", "user@discord.com"), proof.replace("discord.com", "sub.discord.com")]) {
      await expect(verifyDiscordProofAuthor(value, user, env, fetchImpl), value).rejects.toMatchObject({ status: 400, body: { error: "invalid_proof" } });
    }
    for (const value of ["https://youtu.be/aBcD_123-45", "https://monkeytype.com/profile/test", "https://example.com/proof",
      "https://discord.com.evil.test/proof", "https://discord.com@evil.test/proof"]) {
      await expect(verifyDiscordProofAuthor(value, user, env, fetchImpl)).resolves.toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[LDB-WPM15] missing config, inaccessible, malformed or oversized messages fail closed with a retryable explanation", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(verifyDiscordProofAuthor(proof, user, { ...env, MODQUEUE_DISCORD_BOT_TOKEN: undefined }, fetchImpl))
      .rejects.toMatchObject({ body: { error: "invalid_proof", message: expect.stringContaining("Try again") } });
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const make of [() => new Response(null, { status: 403 }), () => new Response(null, { status: 404 }),
      () => new Response(null, { status: 429 }), () => new Response(null, { status: 500 }),
      () => new Response("not-json"), () => new Response(" ".repeat(256 * 1024 + 1)),
      () => Response.json({ ...owned, id: "wrong" }), () => Response.json({ ...owned, author: null }),
      () => Response.json({ ...owned, author: { id: 900000000000000010 } })]) {
      await expect(verifyDiscordProofAuthor(proof, user, env, vi.fn<typeof fetch>().mockResolvedValueOnce(make())))
        .rejects.toMatchObject({ status: 400, body: { error: "invalid_proof", message: expect.stringContaining("Could not verify") } });
    }
  });

  it("[LDB-WPM15] a stalled Discord lookup is aborted within its request budget and cannot accept the proof", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    await expect(verifyDiscordProofAuthor(proof, user, env, fetchImpl)).rejects.toMatchObject({ status: 400, body: { error: "invalid_proof" } });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe("WPM proof resolution", () => {
  it("[LDB-WPM13] only fetches exact Discord message/CDN URLs, with credentials confined to the API", async () => {
    expect(discordProofMessage(proof)).toEqual({ channelId: channel, messageId: message });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([image()])).mockResolvedValueOnce(imageResponse());
    const result = await resolveProofPreview(proof, env, fetchImpl);
    expect(result.kind).toBe("images");
    if (result.kind !== "images") throw new Error("expected snapshot");
    expect(result.images[0]?.content).toEqual(png);
    expect(result.images[0]?.filename).toBe("wpm-proof-1.png");
    expect(result.incomplete).toBe(false);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://discord.test/api/v10/channels/${channel}/messages/${message}`);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bot private-token");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(cdn);
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    for (const bad of [proof.replace("discord.com", "discord.com.evil.test"), proof.replace("discord.com", "discord.com@evil.test"),
      proof.replace("https:", "http:"), proof.replace("discord.com", "discord.com:444"), "https://127.0.0.1/proof.png",
      cdn.replace("cdn.discordapp.com", "cdn.discordapp.com.evil.test"), cdn.replace("/attachments/", "/external/"), "not a URL"]) {
      const never = vi.fn<typeof fetch>();
      expect(await resolveProofPreview(bad, env, never), bad).toEqual({ kind: "none" });
      expect(never).not.toHaveBeenCalled();
    }
  });

  it("[LDB-WPM13] inaccessible, expired, empty, wrong-message, oversized-metadata and malformed responses fall back without throwing", async () => {
    const missing = vi.fn<typeof fetch>();
    expect(await resolveProofPreview(proof, { ...env, MODQUEUE_DISCORD_BOT_TOKEN: undefined }, missing)).toEqual({ kind: "unavailable" });
    expect(await resolveProofPreview(proof, env, missing, 0)).toEqual({ kind: "unavailable" });
    expect(missing).not.toHaveBeenCalled();
    for (const make of [() => new Response(null, { status: 403 }), () => new Response(null, { status: 404 }),
      () => new Response(null, { status: 429 }), () => response([]), () => new Response("not-json"),
      () => new Response(" ".repeat(256 * 1024 + 1)), () => Response.json({ id: "wrong", channel_id: channel, attachments: [image()] })]) {
      expect(await resolveProofPreview(proof, env, vi.fn<typeof fetch>().mockResolvedValueOnce(make()))).toEqual({ kind: "unavailable" });
    }
    expect(await resolveProofPreview(proof, env, vi.fn<typeof fetch>().mockRejectedValue(new Error("network failure")))).toEqual({ kind: "unavailable" });
  });

  it("[LDB-WPM13] untrusted attachment URLs, redirects, non-images and oversized streams cannot become uploads", async () => {
    for (const attachment of [image("https://localhost/private"), image(cdn.replace("https:", "http:")), image(cdn, PROOF_MAX_IMAGE_BYTES + 1)]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([attachment]));
      expect(await resolveProofPreview(proof, env, fetchImpl)).toEqual({ kind: "unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    for (const make of [() => new Response(null, { status: 302, headers: { location: "https://localhost/private" } }),
      () => imageResponse(png, "text/html"), () => imageResponse(new TextEncoder().encode("<html>not an image</html>")),
      () => imageResponse(new Uint8Array(PROOF_MAX_IMAGE_BYTES + 1)),
      () => new Response(png, { headers: { "content-length": String(PROOF_MAX_IMAGE_BYTES + 1), "content-type": "image/png" } })]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([image()])).mockResolvedValueOnce(make());
      expect(await resolveProofPreview(proof, env, fetchImpl)).toEqual({ kind: "unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("[LDB-WPM13] bounds aggregate bytes and image count, keeps spoilers, and marks partial copies", async () => {
    for (const size of [png.length, PROOF_MAX_IMAGE_BYTES]) {
      const bytes = new Uint8Array(size); bytes.set(png);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(Array.from({ length: 12 }, () => ({ ...image(cdn, size), filename: "SPOILER_proof.png" }))))
        .mockImplementation(async () => imageResponse(bytes));
      const result = await resolveProofPreview(proof, env, fetchImpl);
      if (result.kind !== "images") throw new Error("expected snapshots");
      expect(result.images.length).toBe(size === png.length ? 3 : 2);
      expect(result.images.reduce((n, i) => n + i.content.length, 0)).toBeLessThanOrEqual(PROOF_MAX_TOTAL_BYTES);
      expect(result.images.every((i) => i.spoiler && i.filename.startsWith("SPOILER_"))).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4);
    }
  });

  it("[LDB-WPM13] supports each allowed image signature, including optional message MIME metadata and Discord spoiler flags", async () => {
    for (const [mime, bytes, extension] of [
      ["image/png", png, "png"], ["image/jpeg", new Uint8Array([255, 216, 255, 224]), "jpg"],
      ["image/gif", new TextEncoder().encode("GIF89a"), "gif"],
      ["image/webp", new TextEncoder().encode("RIFF1234WEBP"), "webp"],
    ] as const) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response([{ url: cdn, filename: `test.${extension}`, flags: 8 }]))
        .mockResolvedValueOnce(imageResponse(bytes, mime));
      const result = await resolveProofPreview(proof, env, fetchImpl);
      if (result.kind !== "images") throw new Error(`missing ${mime} preview`);
      expect(result.images[0]).toMatchObject({ contentType: mime, filename: `SPOILER_wpm-proof-1.${extension}`, spoiler: true });
      expect(result.images[0]?.content).toEqual(bytes);
    }
  });

  it("[LDB-WPM13] an expired download budget cancels a stalled body and direct CDN proofs require no bot token", async () => {
    const cancel = vi.fn();
    const stalled = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "image/png" } });
    const result = await resolveProofPreview(cdn, env, vi.fn<typeof fetch>().mockResolvedValue(stalled), 5);
    expect(result).toEqual({ kind: "unavailable" });
    expect(cancel).toHaveBeenCalled();
    const direct = vi.fn<typeof fetch>().mockResolvedValueOnce(imageResponse());
    expect((await resolveProofPreview(cdn, { ...env, MODQUEUE_DISCORD_BOT_TOKEN: undefined }, direct)).kind).toBe("images");
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("[LDB-WPM14] accepts video, short, live and share URLs but never turns arbitrary query text into an embed", () => {
    const id = "aBcD_123-45";
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    for (const url of [canonical, canonical.replace("https:", "http:"), `https://youtu.be/${id}?si=tracking`, `https://m.youtube.com/watch?v=${id}`,
      `https://youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`, `https://youtube.com/embed/${id}`]) {
      expect(youtubeProofUrl(url)).toBe(canonical);
    }
    expect(youtubeProofUrl(`https://youtu.be/${id}?t=1m20s&extra=@everyone`)).toBe(`${canonical}&t=1m20s`);
    for (const url of ["https://youtube.com/@someone", "https://youtube.com/playlist?list=123", `https://youtube.com.evil.test/watch?v=${id}`,
      `https://youtube.com@evil.test/watch?v=${id}`, `https://youtu.be/${id}/extra`, "https://youtube.com/watch?v=bad%0A@everyone"]) {
      expect(youtubeProofUrl(url)).toBeNull();
    }
  });

  it("[LDB-WPM14] YouTube thumbnails use the validated video id with no download, token or time budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await resolveProofPreview("https://youtu.be/aBcD_123-45?t=80&si=tracking", env, fetchImpl, 0)).toEqual({
      kind: "youtube", videoUrl: "https://www.youtube.com/watch?v=aBcD_123-45&t=80",
      thumbnailUrl: "https://i.ytimg.com/vi/aBcD_123-45/hqdefault.jpg",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
