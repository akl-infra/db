import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminSubmitWpm } from "../../api.ts";
import type { WpmSubmission } from "../../lib/types.ts";
import { SPEED_FIELDS, speedFormBody, speedFormErrors, visibleSpeedErrors, type SpeedFormField } from "../../lib/speedForm.ts";
import ProofLink from "../../ui/ProofLink.tsx";
import AuthorRef from "../../ui/AuthorRef.tsx";
import { onLinkClick } from "../../router.ts";

/** Admin console, Users tab: "Submit a speed for a user" (`POST
 * /v1/admin/wpm`, db decision 28). Enters a typing speed on someone else's
 * behalf; the DB approves it at once. A field's validation error shows only
 * after that field is left (blur) or after a submit attempt -- unfinished
 * input is never an error. A refusal the DB still makes (`invalid_wpm`, an
 * unknown layout, ...) is shown verbatim. */
const SpeedForm: Component = () => {
  const [userId, setUserId] = createSignal("");
  const [layout, setLayout] = createSignal("");
  const [wpm, setWpm] = createSignal("");
  const [proof, setProof] = createSignal("");
  const [touched, setTouched] = createSignal<Partial<Record<SpeedFormField, true>>>({});
  const [attempted, setAttempted] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [serverError, setServerError] = createSignal<string | null>(null);
  const [recorded, setRecorded] = createSignal<{ submission: WpmSubmission; layoutRef: string } | null>(null);

  const values = () => ({ userId: userId(), layout: layout(), wpm: wpm(), proof: proof() });
  const errors = () => speedFormErrors(values());
  const touch = (field: SpeedFormField) => setTouched((t) => ({ ...t, [field]: true }));
  const shown = (field: SpeedFormField): boolean => visibleSpeedErrors(errors(), touched(), attempted())[field] === true;

  async function submit(): Promise<void> {
    setAttempted(true);
    setServerError(null);
    setRecorded(null);
    if (SPEED_FIELDS.some((f) => errors()[f] === true)) return;
    setPending(true);
    const layoutRef = layout().trim();
    const result = await adminSubmitWpm(speedFormBody(values()));
    setPending(false);
    if (!result.ok) {
      setServerError(result.message ?? result.error);
      return;
    }
    setRecorded({ submission: result.data.submission, layoutRef });
    setUserId("");
    setLayout("");
    setWpm("");
    setProof("");
    setTouched({});
    setAttempted(false);
  }

  return (
    <div>
      <form
        class="akl-speed-form"
        novalidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>{copy.admin.speed.userLabel}</span>
          <input
            type="text"
            value={userId()}
            aria-invalid={shown("userId") ? "true" : undefined}
            onInput={(e) => setUserId(e.currentTarget.value)}
            onBlur={() => touch("userId")}
          />
          <Show when={shown("userId")}>
            <span class="akl-inline-error">{copy.admin.speed.errorUser}</span>
          </Show>
        </label>
        <label>
          <span>{copy.admin.speed.layoutLabel}</span>
          <input
            type="text"
            value={layout()}
            aria-invalid={shown("layout") ? "true" : undefined}
            onInput={(e) => setLayout(e.currentTarget.value)}
            onBlur={() => touch("layout")}
          />
          <Show when={shown("layout")}>
            <span class="akl-inline-error">{copy.admin.speed.errorLayout}</span>
          </Show>
        </label>
        <label>
          <span>{copy.admin.speed.wpmLabel}</span>
          <input
            type="text"
            inputmode="numeric"
            value={wpm()}
            aria-invalid={shown("wpm") ? "true" : undefined}
            onInput={(e) => setWpm(e.currentTarget.value)}
            onBlur={() => touch("wpm")}
          />
          <Show when={shown("wpm")}>
            <span class="akl-inline-error">{copy.admin.speed.errorWpm}</span>
          </Show>
        </label>
        <label>
          <span>{copy.admin.speed.proofLabel}</span>
          <input
            type="text"
            value={proof()}
            aria-invalid={shown("proof") ? "true" : undefined}
            onInput={(e) => setProof(e.currentTarget.value)}
            onBlur={() => touch("proof")}
          />
          <Show when={shown("proof")}>
            <span class="akl-inline-error">{copy.admin.speed.errorProof}</span>
          </Show>
        </label>
        <div class="akl-action-row">
          <button class="akl-btn" type="submit" disabled={pending()}>
            {copy.admin.speed.submitButton}
          </button>
        </div>
      </form>

      <Show when={serverError()}>{(msg) => <div class="akl-error">{msg()}</div>}</Show>
      <Show when={recorded()} keyed>
        {(r) => {
          const layoutHref = `/l/${encodeURIComponent(r.submission.layout_id)}`;
          return (
            <dl class="akl-speed-result">
              <dt>{copy.admin.speed.recorded}</dt>
              <dd>
                {copy.admin.speed.recordLayout}:{" "}
                <a href={layoutHref} onClick={(e) => onLinkClick(e, layoutHref)}>
                  {r.layoutRef}
                </a>
              </dd>
              <dd>
                {copy.admin.speed.recordUser}: <AuthorRef userId={r.submission.user_id} linked /> <span class="akl-muted">{r.submission.user_id}</span>
              </dd>
              <dd>
                {copy.admin.speed.recordSpeed}: {copy.admin.inbox.wpmValue(r.submission.wpm)}
              </dd>
              <dd>
                {copy.admin.speed.recordProof}:{" "}
                <ProofLink proof={r.submission.proof} />
              </dd>
            </dl>
          );
        }}
      </Show>
    </div>
  );
};

export default SpeedForm;
