// The likes wire: `GET /v1/layouts/:ref/likes` answers `{ "user_ids": [...] }`
// (db/tests/fixtures/db-responses/likes.json is the recorded truth). The
// first Layout page read `.likes` off it instead -- a TypeError inside the
// `liked` memo, thrown only once a user is signed in, and a throw inside a
// Solid memo disposes the whole root: production 2026-09-13, "none of the
// buttons work at all once I get to that page". SITE-21 pins the shape
// against the fixture; this helper never throws on an unexpected shape.
export interface LikesWire {
  user_ids: string[];
}

export function isLikedBy(res: unknown, userId: string): boolean {
  const ids = (res as { user_ids?: unknown } | null | undefined)?.user_ids;
  return Array.isArray(ids) && ids.includes(userId);
}
