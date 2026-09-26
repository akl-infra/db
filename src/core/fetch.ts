// A minimal, injectable fetch shape -- moved out of the (now-deleted)
// cmini importer's `import/upstream.ts` (`design/layout-db/
// 28-remove-cmini-import.md`) so `auth/discord.ts`'s user lane, the one
// other caller that needs an injectable fetch, doesn't depend on
// importer-only code. Deliberately narrower than the DOM `fetch` type
// (`init` never optional, `headers` a plain record) -- both the real
// `fetch` and every test double already satisfy it either way.
export type FetchImpl = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
