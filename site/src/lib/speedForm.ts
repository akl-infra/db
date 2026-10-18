// "Submit a speed for a user" (`pages/admin/SpeedForm.tsx`): the client-side
// half of `POST /v1/admin/wpm`'s validation (db/src/core/wpm.ts), so an
// obviously malformed entry is caught before a round trip. The server stays
// the authority: its own `invalid_wpm`/`invalid_proof`/`bad_request` message
// is shown verbatim when it still refuses.
export interface SpeedFormValues {
  userId: string;
  layout: string;
  wpm: string;
  proof: string;
}

export type SpeedFormField = keyof SpeedFormValues;

export const SPEED_FIELDS: readonly SpeedFormField[] = ["userId", "layout", "wpm", "proof"];

const MIN_WPM = 1;
const MAX_WPM = 1000;
const MAX_PROOF_LENGTH = 512;

/** The fields whose current value is not acceptable (absent key = fine).
 * Pure: showing these is the form's job, and only after blur or submit --
 * never while the person is still typing. */
export function speedFormErrors(v: SpeedFormValues): Partial<Record<SpeedFormField, true>> {
  const errors: Partial<Record<SpeedFormField, true>> = {};
  if (!/^\d{17,20}$/.test(v.userId.trim())) errors.userId = true;
  if (v.layout.trim() === "") errors.layout = true;
  const wpm = v.wpm.trim();
  if (!/^\d+$/.test(wpm) || Number(wpm) < MIN_WPM || Number(wpm) > MAX_WPM) errors.wpm = true;
  if (!validProof(v.proof.trim())) errors.proof = true;
  return errors;
}

function validProof(proof: string): boolean {
  if (proof === "" || proof.length > MAX_PROOF_LENGTH) return false;
  if (!/^https?:\/\//i.test(proof)) return false;
  try {
    return new URL(proof).hostname !== "";
  } catch {
    return false;
  }
}

/** The request body for values `speedFormErrors` accepted. */
export function speedFormBody(v: SpeedFormValues): { user_id: string; layout: string; wpm: number; proof: string } {
  return { user_id: v.userId.trim(), layout: v.layout.trim(), wpm: Number(v.wpm.trim()), proof: v.proof.trim() };
}

/** The errors to SHOW: a field's error appears only once that field has been
 * left (`touched`) or a submit has been attempted -- never while the person
 * is still typing in it, and never on a form nobody has touched yet. */
export function visibleSpeedErrors(
  errors: Partial<Record<SpeedFormField, true>>,
  touched: Partial<Record<SpeedFormField, true>>,
  attempted: boolean,
): Partial<Record<SpeedFormField, true>> {
  const out: Partial<Record<SpeedFormField, true>> = {};
  for (const field of SPEED_FIELDS) {
    if (errors[field] === true && (attempted || touched[field] === true)) out[field] = true;
  }
  return out;
}
