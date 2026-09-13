import type { Component } from "solid-js";
import { authorName } from "../lib/authorNames.ts";
import { onLinkClick } from "../router.ts";

/** W1b deliverable 2: every place an author id is shown (list, layout,
 * author page, changes feed) renders through this -- the resolved display
 * name as the text, the raw Discord id as the `title` tooltip, falling
 * back to the id itself when it isn't in the cached `/v1/authors` map
 * (SITE-17). `linked` renders it as a link to that author's own page --
 * off by default so the author page itself (and a changes-feed actor,
 * which very often has no layouts and no reason to navigate) can use the
 * plain-text form. */
const AuthorRef: Component<{ userId: string; linked?: boolean }> = (props) => {
  const href = () => `/a/${encodeURIComponent(props.userId)}`;
  return (
    <>
      {props.linked ? (
        <a href={href()} title={props.userId} onClick={(e) => onLinkClick(e, href())}>
          {authorName(props.userId)}
        </a>
      ) : (
        <span title={props.userId}>{authorName(props.userId)}</span>
      )}
    </>
  );
};

export default AuthorRef;
