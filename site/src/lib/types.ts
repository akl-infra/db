// Minimal hand-written wire types for akldb's public API (db/docs/
// adoption.md, db/formats/spark/1/schema.json). Deliberately NOT imported
// from db/src/** or db/formats/** (SITE-9, design/akldb-site/01-plan.md S9)
// -- the site is a client, it reads the schema/docs to learn the shape and
// writes its own types, same as any outside adopter would.

export type Finger = "LP" | "LR" | "LM" | "LI" | "RI" | "RM" | "RR" | "RP" | "LT" | "RT" | "TB";

export interface SparkPosition {
  row: number;
  col: number;
  finger: Finger;
}

export interface SparkBoard {
  kind: "rowstag" | "colstag" | "ortho";
  stagger?: number[];
  cmini?: "stagger" | "angle" | "ortho" | "mini";
}

export interface SparkMagicKeyRule {
  after: string;
  output: string;
}

export interface SparkMagicKey {
  key: string;
  default?: string;
  rules?: SparkMagicKeyRule[];
  except?: string[];
}

export interface SparkPayload {
  keys: Record<string, SparkPosition>;
  free?: SparkPosition[];
  board?: SparkBoard;
  magic?: {
    notes?: string;
    updated?: string;
    magic_keys?: SparkMagicKey[];
    chiral_keys?: unknown[];
    adaptive_swaps?: unknown[];
    rules?: unknown[];
  };
}

export interface FormatSource {
  client: string;
  version: string | null;
}

export interface LayoutFormatMeta {
  rev: number;
  created_at: string;
  modified_at: string;
  has_magic: boolean;
  source: FormatSource;
}

export interface LayoutRecord {
  id: string;
  name: string;
  owner: string;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  like_count: number;
  link?: string | null;
  upstream: { source: string; id: string; state: "following" | "forked" } | null;
  formats: Record<string, LayoutFormatMeta>;
  format?: string;
  derived_from?: string;
  payload?: SparkPayload;
  likes?: string[];
}

export interface LayoutListResponse {
  // The live endpoint answers a bare array for `?full=1` and a
  // `{items,next}`-shaped page otherwise -- both are read defensively in
  // api.ts (readLayoutList) rather than assumed here.
  items?: LayoutRecord[];
  next?: string | null;
}

export interface HistoryEvent {
  seq: number;
  format: string | null;
  rev: number | null;
  at: string;
  actor: string;
  via: string;
  kind: string;
  admin: boolean;
  detail?: unknown;
  source: FormatSource;
}

export interface ChangeEvent extends HistoryEvent {
  layout_id: string;
  name?: string;
  owner?: string;
  before?: unknown;
  after?: unknown;
}

export interface ChangesPage {
  next: number;
  items: ChangeEvent[];
}

export interface Author {
  user_id: string;
  name: string;
  name_source?: string;
}

export interface MeUser {
  user_id: string;
  name: string;
  via: string;
  admin: boolean;
  banned?: boolean;
}

export interface MeResponse {
  user: MeUser | null;
  signin: boolean;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
  [k: string]: unknown;
}

// ── Moderation (L5, db/docs/adoption.md §10) ─────────────────────────────

export interface BanRow {
  user_id: string;
  name: string | null; // joined from authors, not stored
  by: string;
  at: string;
  reason: string | null;
}

export type LinkSubmissionStatus = "pending" | "approved" | "rejected" | "superseded";

export interface LinkSubmission {
  id: string;
  layout_id: string;
  url: string;
  submitted_by: string;
  submitted_at: string;
  status: LinkSubmissionStatus;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

export interface AdminRow {
  user_id: string;
  added_by: string | null;
  added_at: string;
  note: string | null;
}

/** Any of these responses MAY carry a `seq` for the event they just
 * appended -- none observed in the live routes do today (every admin/owner
 * route's response is a row/record shape, not the raw event), but the
 * plan asks the UI to show one when present, so every action result is
 * read through this rather than assumed absent. */
export interface MaybeSeq {
  seq?: number;
}
