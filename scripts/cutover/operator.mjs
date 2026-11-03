// The operator's view of the prod log: a local Replica over the DynamoDB log with the operator's credentials, never the public API.
// `kit` is the replica layer ({ Replica, bootReplica, appendImage, writeSnapshot }): the esbuild bundle of src/replica in production
// (kit.mjs), the TypeScript sources themselves in tests. `log`/`objects`/`state` are the DynamoDB/S3 backends or their memory twins.
export function createOperator({ kit, log, objects, state, logLine = () => {} }) {
  const boot = () => kit.bootReplica(log, { snapshots: { state, objects }, logLine });
  return {
    log,
    head: () => log.head(),
    async firstEntry() {
      const e = await log.get(1);
      return e === null ? null : { kind: e.kind, hash: e.hash, unitId: e.unitId, image: e.image ?? null };
    },
    /** The entries after the image, as {seq, kind, sqls}; null when there are too many to be an operator's flag units. */
    async tail() {
      const head = await log.head();
      if (head <= 1) return [];
      if (head > 100) return null;
      return (await log.read(1, head)).map((e) => ({ seq: e.seq, kind: e.kind, sqls: e.stmts.map((s) => s.sql) }));
    },
    async appendImage({ raw, tables, source }) {
      return kit.appendImage({ log, raw, tables, source });
    },
    /** A rolling snapshot at the head (the POINTER item): the first cold boot after the cutover starts from it, not from a replay of the image. */
    async snapshot() {
      const r = await boot();
      try {
        const out = await kit.writeSnapshot(r, { objects, state, logLine });
        const ref = out.status === "written" ? out.ref : out.pointer;
        return { seq: ref.seq, key: ref.key, sha256: ref.sha256 };
      } finally {
        r.close();
      }
    },
    /** One commit unit, appended through the log like any write. Resolves to the seq reached. */
    async runUnit(sql, params = []) {
      const r = await boot();
      try {
        await r.runUnit([{ sql, params }]);
        return { seq: r.seq };
      } finally {
        r.close();
      }
    },
    async readFlag() {
      const r = await boot();
      try {
        await r.catchUp();
        const [out] = await r.runUnit([{ sql: "SELECT value FROM import_state WHERE key = 'cutover.mode'", params: [] }], { fresh: true });
        return out.rows.length === 0 ? null : String(out.rows[0].value);
      } finally {
        r.close();
      }
    },
    /** The database image at the log head (a consistent seq). */
    async capture() {
      const r = await boot();
      try {
        const cap = await r.capture();
        return { seq: cap.seq, bytes: cap.bytes };
      } finally {
        r.close();
      }
    },
  };
}
