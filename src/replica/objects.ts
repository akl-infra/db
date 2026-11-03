// The object store phase B needs: two calls, because the lean signer covers exactly five (RP6): S3 GetObject and
// PutObject here, DynamoDB GetItem/Query/TransactWriteItems in log-ddb.ts. Implementations: s3.ts (aws4fetch) and
// MemoryObjects below (tests, local runs, the boot benchmark).

export interface StoredObject {
  bytes: Uint8Array;
  /** User metadata (S3 `x-amz-meta-*`), lower-case names. */
  meta: Record<string, string>;
}

export interface ObjectStore {
  /** null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;
  /** Overwrite. Resolves once the object is durable (S3 is strongly consistent for a read after this). */
  put(key: string, bytes: Uint8Array, meta?: Record<string, string>): Promise<void>;
}

/** An in-memory ObjectStore. `corrupt`/`failGet` let tests damage or withhold an object the way S3 never should. */
export class MemoryObjects implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly calls = { gets: 0, puts: 0 };
  /** Keys whose next get throws (a GET failure). */
  readonly failGet = new Set<string>();
  /** Fail every put whose key starts with one of these (a failed upload). */
  readonly failPut = new Set<string>();

  async get(key: string): Promise<StoredObject | null> {
    this.calls.gets++;
    if (this.failGet.has(key)) throw new Error(`MemoryObjects: injected GET failure for ${key}`);
    const o = this.objects.get(key);
    return o === undefined ? null : { bytes: Uint8Array.from(o.bytes), meta: { ...o.meta } };
  }

  async put(key: string, bytes: Uint8Array, meta: Record<string, string> = {}): Promise<void> {
    this.calls.puts++;
    for (const p of this.failPut) if (key.startsWith(p)) throw new Error(`MemoryObjects: injected PUT failure for ${key}`);
    this.objects.set(key, { bytes: Uint8Array.from(bytes), meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k.toLowerCase(), v])) });
  }

  /** Synchronous read for assertions and MemoryLog.entries(). */
  peek(key: string): StoredObject | undefined {
    return this.objects.get(key);
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** A copy sharing no state (a fresh container looking at the same bucket contents). */
  clone(): MemoryObjects {
    const c = new MemoryObjects();
    for (const [k, v] of this.objects) c.objects.set(k, { bytes: Uint8Array.from(v.bytes), meta: { ...v.meta } });
    return c;
  }
}
