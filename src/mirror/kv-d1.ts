// The mirror queue on D1 (design/aws-port.md §5.2 "reverse mirror"; lane Z): the D1-side receiver has no queue service, so its
// queue is one table, `mirror_queue(sk, body)` (migrations/0037_mirror_queue.sql). It stays empty until the route is on
// (MIRROR_SECRET set, after the cutover); it is not one of the dumped tables, and the proofs ignore it.
import { QueueConflict, type Kv } from "./queue";

export function d1Kv(db: D1Database, nowMs: () => number = () => Date.now()): Kv {
  const exists = async (sk: string): Promise<boolean> => (await db.prepare("SELECT 1 AS x FROM mirror_queue WHERE sk = ?").bind(sk).first()) !== null;
  const kv: Kv = {
    async putBatch(items, markerSk, markerTtlSec) {
      await db.prepare("DELETE FROM mirror_queue WHERE sk LIKE 'B#%' AND CAST(body AS INTEGER) < ?").bind(nowMs()).run();
      const stmts = [
        db.prepare("INSERT INTO mirror_queue (sk, body) VALUES (?, ?)").bind(markerSk, String(nowMs() + markerTtlSec * 1000)),
        ...items.map((i) => db.prepare("INSERT INTO mirror_queue (sk, body) VALUES (?, ?)").bind(i.sk, i.body)),
      ];
      try {
        await db.batch(stmts); // one transaction: the marker and the calls land together or not at all
        return "ok";
      } catch (e) {
        if (await exists(markerSk)) return "duplicate";
        for (const i of items) if (i.sk.startsWith("E#") && (await exists(i.sk))) throw new QueueConflict(i.sk);
        throw e;
      }
    },
    async list(prefix, limit) {
      const { results } = await db.prepare("SELECT sk, body FROM mirror_queue WHERE sk >= ? AND sk < ? ORDER BY sk LIMIT ?").bind(prefix, prefix + "\uffff", limit).all<{ sk: string; body: string }>();
      return results;
    },
    async first(prefix) {
      return (await kv.list(prefix, 1))[0] ?? null;
    },
    async get(sk) {
      const r = await db.prepare("SELECT body FROM mirror_queue WHERE sk = ?").bind(sk).first<{ body: string }>();
      return r === null ? null : r.body;
    },
    async put(sk, body) {
      await db.prepare("INSERT INTO mirror_queue (sk, body) VALUES (?, ?) ON CONFLICT(sk) DO UPDATE SET body = excluded.body").bind(sk, body).run();
    },
    async delete(sk) {
      await db.prepare("DELETE FROM mirror_queue WHERE sk = ?").bind(sk).run();
    },
    async cas(sk, expected, next) {
      const r =
        expected === null
          ? await db.prepare("INSERT OR IGNORE INTO mirror_queue (sk, body) VALUES (?, ?)").bind(sk, next).run()
          : await db.prepare("UPDATE mirror_queue SET body = ? WHERE sk = ? AND body = ?").bind(next, sk, expected).run();
      return (r.meta.changes ?? 0) === 1;
    },
  };
  return kv;
}
