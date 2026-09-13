// Backwards paging over /v1/changes for the Event log (newest first).
//
// /v1/changes pages OLDEST-to-newest from an exclusive `since` cursor
// (`since=0` returns seq 1). The Event log wants the newest events at the
// top, so it walks the sequence from the head DOWN: page 1 is the window
// (head-PAGE, head], page 2 is (head-2*PAGE, head-PAGE], ... until the
// window's low edge reaches 0. Pure, so SITE-19 can prove the windows
// partition (0, head] exactly, in descending order, with no gaps or
// overlaps, whatever `head` and `page` are.
export interface Window {
  since: number; // exclusive lower bound to send as `since=`
  limit: number; // events in this window (hi - since); 0 when nothing is left
  nextHi: number; // the `hi` for the following (older) window
}

export function windowBelow(hi: number, page: number): Window {
  const safeHi = Math.max(0, Math.floor(hi));
  const safePage = Math.max(1, Math.floor(page));
  const since = Math.max(0, safeHi - safePage);
  return { since, limit: safeHi - since, nextHi: since };
}
