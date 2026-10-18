import type { Component } from "solid-js";
import { Show } from "solid-js";
import { safeProofLink } from "../lib/safelink.ts";

/** A WPM submission's proof, shown IN FULL for a moderator to judge: the
 * visible text is the whole URL, the href is used only if it re-parses as
 * http(s) here (`safeProofLink`), and it opens in a new tab with `noopener`
 * -- the proof is a stranger's page. Wraps anywhere (long URLs). */
const ProofLink: Component<{ proof: string }> = (props) => (
  <Show when={safeProofLink(props.proof)} fallback={<span class="akl-muted akl-url">{props.proof}</span>} keyed>
    {(l) => (
      <a class="akl-url" href={l.href} target="_blank" rel="noopener">
        {props.proof}
      </a>
    )}
  </Show>
);

export default ProofLink;
