/**
 * The lifecycle-hooks CONTRACT the Granola ingest pipeline reports through.
 *
 * Declared by the pipeline module because the pipeline is the generic
 * caller: the shape it reports through belongs to whoever implements it.
 * A host provides a concrete implementation (e.g. Scout's Slack-rendering
 * lifecycle) and hands it to `createGranolaIngest`.
 */
import type { GranolaBucketType } from "../tools/types.js";
import type { GranolaThreadAnchor } from "./bucket-handler.js";

/**
 * Every human-visible event the pipeline reports, in the order a single
 * note's run can produce them. `TAnchor` is whatever the host's
 * `onProcessingStarted` returns — opaque to the pipeline, threaded back
 * unexamined through every later hook for that note's run.
 *
 * One hook per event, not one generic "post text" hook: each carries
 * exactly the structured data a host needs to render its own copy (or
 * choose not to post at all), rather than the pipeline deciding wording.
 */
export type GranolaIngestLifecycle<TAnchor = GranolaThreadAnchor> = {
  /**
   * A second event for a note already being processed arrived — usually
   * two webhook deliveries racing (e.g. `note.generated` and `note.edited`
   * close together). `anchor` is set once processing reached
   * `onProcessingStarted`; `bucketChannel` is set once a bucket resolved
   * even if processing hasn't reached that point yet. Both undefined means
   * there is nowhere known to notify — the host may no-op.
   */
  onDuplicateEvent(args: {
    noteId: string;
    anchor: TAnchor | undefined;
    bucketChannel: string | undefined;
  }): Promise<void>;

  /**
   * The note couldn't be fetched from the Granola API at all — no bucket is
   * known yet (folder membership only comes back from the fetch that just
   * failed), so `candidateChannels` is every channel any current binding
   * points at, deduped. The host decides how to broadcast (or not) across
   * them.
   */
  onFetchFailed(args: {
    noteId: string;
    error: string;
    candidateChannels: string[];
  }): Promise<void>;

  /**
   * A `note.access_granted` event arrived for a note whose AI summary hasn't
   * been generated yet — Granola's API 404s on ungenerated notes and offers
   * no way to trigger generation. Recovery is automatic: a human clicking
   * "Generate Notes" in Granola fires `note.generated`, which re-enters the
   * pipeline. Like `onFetchFailed`, no bucket is known yet, so
   * `candidateChannels` is every bound channel.
   */
  onNoteNotGenerated(args: {
    noteId: string;
    candidateChannels: string[];
  }): Promise<void>;

  /**
   * A re-added note already has a persisted transcript — the durable
   * human-in-the-loop gate: a human decides whether to reprocess rather
   * than the pipeline silently skipping or blindly rerunning.
   */
  onAlreadyProcessed(args: {
    noteId: string;
    noteTitle: string;
    bucketChannel: string;
  }): Promise<void>;

  /**
   * Fresh processing is starting for a note whose bucket just resolved.
   * Returns the anchor this note's run threads every later hook through —
   * e.g. a Slack host posts an initial message here and returns its
   * channel+ts.
   */
  onProcessingStarted(args: {
    noteId: string;
    noteTitle: string;
    bucketChannel: string;
  }): Promise<TAnchor>;

  /**
   * The note has no transcript/summary yet. `isFinalAttempt: false` means a
   * retry was just scheduled `retryDelayMs` out; `true` means the retry
   * already ran and the pipeline is giving up on the note until another
   * webhook event arrives for it.
   */
  onNoteNotReady(args: {
    anchor: TAnchor;
    isFinalAttempt: boolean;
    retryDelayMs: number;
  }): Promise<void>;

  /** Transcript/summary text is in hand and about to be persisted. */
  onTranscriptReady(args: {
    anchor: TAnchor;
    segmentCount: number | undefined;
  }): Promise<void>;

  /** Persisting the transcript artifact failed; processing stops here. */
  onPersistFailed(args: { anchor: TAnchor; error: string }): Promise<void>;

  /** About to dispatch to the bucket-type handler — the last stage before handler-specific behavior takes over. */
  onHandlerDispatching(args: {
    anchor: TAnchor;
    bucketType: GranolaBucketType;
  }): Promise<void>;

  /** The bucket-type handler threw. */
  onHandlerFailed(args: { anchor: TAnchor; error: string }): Promise<void>;
};
