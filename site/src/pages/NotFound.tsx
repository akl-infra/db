import type { Component } from "solid-js";
import { copy } from "../copy.ts";
import { onLinkClick } from "../router.ts";

const NotFound: Component = () => {
  return (
    <div>
      <h1>{copy.notFound.title}</h1>
      <p class="akl-muted">{copy.notFound.body}</p>
      <a href="/" onClick={(e) => onLinkClick(e, "/")}>
        {copy.notFound.backHome}
      </a>
    </div>
  );
};

export default NotFound;
