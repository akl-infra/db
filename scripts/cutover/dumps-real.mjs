// The real ends of copy-dumps: R2 through its S3-compatible API (read-only token) and the AWS data bucket. aws4fetch signs both; no SDK.
import { AwsClient } from "aws4fetch";

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");
const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
const unescapeXml = (s) => s.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&apos;", "'");

export function r2Source({ endpoint, accountId, accessKeyId, secretAccessKey, bucket = "akl-db-dumps", fetchImpl = fetch }) {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const base = `${(endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, "")}/${bucket}`;
  const send = async (url, init) => fetchImpl(await client.sign(url, init));
  return {
    async list() {
      const out = [];
      let token;
      do {
        const res = await send(`${base}?list-type=2${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`, { method: "GET" });
        const xml = await res.text();
        if (!res.ok) throw new Error(`R2 ListObjectsV2: ${res.status} ${xml.slice(0, 200)}`);
        for (const c of xml.split("<Contents>").slice(1)) out.push({ key: unescapeXml(tag(c, "Key")[0]), size: Number(tag(c, "Size")[0]), etag: unescapeXml(tag(c, "ETag")[0]) });
        token = tag(xml, "IsTruncated")[0] === "true" ? unescapeXml(tag(xml, "NextContinuationToken")[0]) : undefined;
      } while (token);
      return out;
    },
    async get(key, { headOnly = false } = {}) {
      const res = await send(`${base}/${encodeKey(key)}`, { method: headOnly ? "HEAD" : "GET" });
      if (!res.ok) throw new Error(`R2 ${headOnly ? "HeadObject" : "GetObject"} ${key}: ${res.status}`);
      const contentType = res.headers.get("content-type") ?? undefined;
      const etag = res.headers.get("etag") ?? undefined;
      if (headOnly) return { contentType, etag, bytes: new Uint8Array(0), size: Number(res.headers.get("content-length") ?? 0) };
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, contentType, etag, size: bytes.byteLength };
    },
  };
}

export function s3Destination({ bucket, region = "us-east-2", credentials, prefix = "dumps/", fetchImpl = fetch }) {
  const client = new AwsClient({ ...credentials, service: "s3", region });
  const url = (key) => `https://${bucket}.s3.${region}.amazonaws.com/${prefix}${encodeKey(key)}`;
  const send = async (u, init) => fetchImpl(await client.sign(u, init));
  return {
    async head(key) {
      const res = await send(url(key), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 HeadObject ${key}: ${res.status}`);
      return { size: Number(res.headers.get("content-length") ?? 0), etag: res.headers.get("etag") ?? "", contentType: res.headers.get("content-type") ?? undefined };
    },
    async put(key, bytes, contentType) {
      const res = await send(url(key), { method: "PUT", headers: { "content-type": contentType ?? "application/octet-stream" }, body: bytes });
      if (!res.ok) throw new Error(`S3 PutObject ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      await res.body?.cancel();
    },
  };
}
