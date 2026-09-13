// Whole-row click for the Home list (saltorbit, 2026-09-13), without any
// absolutely-positioned overlay: a stretched `::after` on the row's link
// needs `position: relative` on the <tr> to be its containing block, and
// Safari does not honour that on table rows -- the overlay then anchors to
// the document, so every row's overlay covered the whole table (and the
// header) and the LAST row won every click (production, 2026-09-13:
// "clicking graphite takes me to /l/zxcvb", nav dead). Delegation instead:
// the <tr> handles a plain left click anywhere in the row that did not
// land on a link (the Owner column's own link, the name link itself) by
// running the same `onLinkClick` the name link uses -- modified clicks and
// non-left buttons are left alone exactly as there (SITE-20).
import { onLinkClick } from "../router.ts";

export interface RowClickEvent extends MouseEvent {
  target: EventTarget | null;
}

/** True iff the click landed on (or inside) an anchor, which handles itself. */
export function landedOnLink(target: EventTarget | null): boolean {
  // Duck-typed (`closest`), not `instanceof Element`, so the unit test can
  // run in vitest's node environment with a stub and no DOM.
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && el.closest("a") !== null && el.closest("a") !== undefined;
}

export function rowClick(e: MouseEvent, href: string): void {
  if (landedOnLink(e.target)) return;
  onLinkClick(e, href);
}
