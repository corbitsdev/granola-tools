/**
 * Granola API data shapes — the note payload and the folder-binding record
 * — with zero behavior of their own. Zero dependency on anything hub-,
 * mounting-, or product-specific: any host wiring this package in supplies
 * its own tenant/channel-binding plumbing around these shapes.
 */
import { type } from "arktype";

export const GranolaNote = type({
  id: "string",
  title: "string",
  "owner?": "unknown",
  "created_at?": "string",
  "updated_at?": "string",
  "web_url?": "string",
  "calendar_event?": "unknown",
  "attendees?": "unknown",
  "folder_membership?": "unknown",
  "summary_text?": "string",
  "summary_markdown?": "string",
  "transcript?": type({
    // Live API shape (verified 2026-08-01): `speaker` is an object like
    // `{source: "microphone", attribution: "me"}`, not a string. The
    // string form stays accepted defensively.
    speaker: type({
      "source?": "string",
      "attribution?": "string",
    }).or("string"),
    text: "string",
    "start_time?": "string",
    "end_time?": "string",
  }).array(),
});

export type GranolaNote = typeof GranolaNote.infer;

/** One transcript segment of a `GranolaNote` — derived, not redeclared. */
export type GranolaTranscriptSegment = NonNullable<GranolaNote["transcript"]>[number];

/** A segment's speaker — derived, not redeclared. */
export type GranolaTranscriptSpeaker = GranolaTranscriptSegment["speaker"];

/** Workflow type a Granola folder is bound to. */
export const GranolaBucketType = type("'diligence' | 'internal'");
export type GranolaBucketType = typeof GranolaBucketType.infer;

const GranolaBucketEntry = type({
  folderId: "string",
  type: GranolaBucketType,
  channel: "string",
});

/**
 * Exported so `src/ingress/binding-store.ts` can validate a persisted
 * bindings record (read back as an opaque JSON value via the host's
 * `GranolaBindingsPort`) against the same shape this module validates a
 * host's own seed configuration against.
 */
export const GranolaBucketsArray = GranolaBucketEntry.array();

/** One folder -> workflow-type -> chat-channel binding. */
export type GranolaBucket = typeof GranolaBucketEntry.infer;
