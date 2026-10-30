// A Store stand-in for tests that drive one outbound-Discord code path: every area method resolves to null, and
// `overrides` (area.method) replaces the ones the path reads. The proxy has `events` as an object and no `prepare`, so
// toStore() takes it as a Store.
type Fn = (...args: unknown[]) => unknown;

export function stubStore(extra: Record<string, Fn> = {}): never {
  const overrides: Record<string, Fn> = { "auth.rolesOf": async () => ({ admin: false, banned: false }), ...extra };
  const area = (name: string) =>
    new Proxy({}, { get: (_t, method) => (typeof method === "string" ? (overrides[`${name}.${method}`] ?? (async () => null)) : undefined) });
  const areas = new Map<string, unknown>();
  return new Proxy({}, { get: (_t, name) => (typeof name === "string" ? (areas.get(name) ?? (areas.set(name, area(name)), areas.get(name))) : undefined) }) as never;
}
