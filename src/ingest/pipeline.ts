/**
 * Granola ingestion pipeline: webhook event -> fetch note -> resolve bucket
 * -> persist transcript -> knowledge capture -> bucket-type handler.
 *
 * `createGranolaIngest` returns the `onEvent` function `mountGranolaWebhook`
 * calls after it has already verified the signature, deduped by `event_id`,
 * and acked the webhook — this module owns everything downstream of that.
 *
 * CHAT-AGNOSTIC AND HOST-AGNOSTIC BY DESIGN: this module never imports a
 * chat client, never builds UI, and never touches a host's storage schema.
 * Every human-visible event goes through the injected
 * `lifecycle: GranolaIngestLifecycle<TAnchor>`; transcript persistence goes
 * through the injected `transcripts: GranolaTranscriptStore<TRef>`; and
 * knowledge capture goes through the injected `captureKnowledge` port.
 * `TAnchor` (established by `onProcessingStarted`) and `TRef` (returned by
 * `transcripts.persist`) are opaque here — threaded through unexamined.
 */
import { getLogger } from "@intx/log";

import {
  GranolaApiError,
  transcriptText,
  type GranolaClient,
  type GranolaNote,
} from "../tools/client.js";
import type { GranolaBucket, GranolaBucketType } from "../tools/types.js";
import type { GranolaBindingStore } from "../ingress/binding-store.js";
import type { GranolaWebhookPayload } from "../ingress/webhook.js";
import type { GranolaIngestLifecycle } from "./lifecycle.js";
import type {
  GranolaBucketHandler,
  GranolaThreadAnchor,
} from "./bucket-handler.js";

type Logger = ReturnType<typeof getLogger>;

const log = getLogger(["granola", "ingest"]);

/** How long to wait before the one retry for a note whose transcript isn't ready yet. */
const DEFAULT_RETRY_DELAY_MS = 60_000;

export type GranolaIngestHandlers<TRef = unknown> = Partial<
  Record<GranolaBucketType, GranolaBucketHandler<TRef>>
>;

/**
 * The host's durable transcript storage. `hasTranscript` backs the
 * already-processed human-in-the-loop gate; `persist` stores the note's
 * text and returns whatever ref the host's handlers and knowledge capture
 * need back (`TRef` is opaque to the pipeline). The host closes over its
 * own tenancy/attribution — the pipeline never sees a principal.
 */
export type GranolaTranscriptStore<TRef = unknown> = {
  hasTranscript(granolaNoteId: string): Promise<boolean>;
  persist(args: {
    granolaNoteId: string;
    noteTitle: string;
    bucketType: string;
    bucketChannel: string;
    text: string;
  }): Promise<TRef>;
};

/**
 * Knowledge capture port — enrichment, not a gate: the pipeline calls it
 * after the transcript artifact is persisted and swallows (logs) failures,
 * so a capture error never costs the host its downstream processing.
 */
export type GranolaKnowledgeCapture<TRef = unknown> = (args: {
  artifactRef: TRef;
  noteTitle: string;
  text: string;
}) => Promise<void>;

export type CreateGranolaIngestOptions<
  TAnchor = GranolaThreadAnchor,
  TRef = unknown,
> = {
  client: GranolaClient;
  /** Resolves a note's folder ids to a bucket per event — see `GranolaBindingStore`. */
  bindingStore: GranolaBindingStore;
  transcripts: GranolaTranscriptStore<TRef>;
  captureKnowledge: GranolaKnowledgeCapture<TRef>;
  /** Reports every human-visible event — see `GranolaIngestLifecycle`'s own doc comment. */
  lifecycle: GranolaIngestLifecycle<TAnchor>;
  /**
   * Per-bucket-type handlers, injected by the caller. A bucket type with no
   * handler here falls back to a no-op that only logs.
   */
  handlers?: GranolaIngestHandlers<TRef>;
  log?: Logger;
  /** Delay before the one retry for a not-yet-ready note. Defaults to 60s; overridable for tests. */
  retryDelayMs?: number;
};

function defaultHandler<TRef>(
  bucketType: GranolaBucketType,
  logger: Logger,
): GranolaBucketHandler<TRef> {
  return async (context) => {
    logger.info(
      "No handler registered for bucket type {bucketType} — note {noteId} persisted but not otherwise processed",
      { bucketType, noteId: context.note.id },
    );
  };
}

/**
 * Extracts folder ids from a note's `folder_membership` field, whose shape
 * the client deliberately leaves as `unknown` (the Granola API docs don't
 * pin it down precisely). Tolerates the shapes a folder membership
 * plausibly takes — a single id, a list of ids, or a list of
 * `{folderId}`/`{id}` objects — rather than throwing on an unexpected
 * shape, since an ingestion pipeline should degrade to "no bucket matched"
 * instead of crashing on a note whose membership just looks different than
 * expected.
 */
function extractFolderIds(membership: unknown): string[] {
  if (typeof membership === "string") return [membership];

  if (Array.isArray(membership)) {
    return membership.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        const id = record["folderId"] ?? record["id"];
        return typeof id === "string" ? [id] : [];
      }
      return [];
    });
  }

  if (typeof membership === "object" && membership !== null) {
    const record = membership as Record<string, unknown>;
    if (typeof record["folderId"] === "string") return [record["folderId"]];
    if (Array.isArray(record["folderIds"])) {
      return (record["folderIds"] as unknown[]).filter(
        (id): id is string => typeof id === "string",
      );
    }
  }

  return [];
}

async function resolveBucket(
  bindingStore: GranolaBindingStore,
  note: GranolaNote,
  logger: Logger,
): Promise<GranolaBucket | undefined> {
  const folderIds = extractFolderIds(note.folder_membership);
  if (folderIds.length === 0) return undefined;

  const buckets = await bindingStore.list();
  const matches = buckets.filter((bucket) =>
    folderIds.includes(bucket.folderId),
  );
  if (matches.length > 1) {
    logger.info(
      "Granola note {noteId} folders match {count} configured buckets — using the first match ({folderId})",
      {
        noteId: note.id,
        count: matches.length,
        folderId: matches[0]?.folderId,
      },
    );
  }
  return matches[0];
}

/**
 * A note is "not ready" when Granola delivered the webhook before it
 * finished generating a summary/transcript — the note exists but has
 * nothing worth persisting yet.
 */
function isNoteReady(note: GranolaNote): boolean {
  return noteText(note).length > 0;
}

/**
 * The text worth persisting: the transcript when Granola delivered one,
 * otherwise the summary. Never returns whitespace-only text, so a ready
 * note can never persist an empty artifact.
 */
function noteText(note: GranolaNote): string {
  const transcript = transcriptText(note).trim();
  if (transcript.length > 0) return transcript;
  return (note.summary_text ?? "").trim();
}

/**
 * Per-note state threaded through one processing run (including its
 * not-ready retry): the lifecycle anchor once established, the resolved
 * bucket channel once known, and the re-entry flags a host's Reprocess
 * affordances set.
 */
type InFlightNote<TAnchor> = {
  anchor?: TAnchor;
  bucketChannel?: string;
  forceReprocess?: boolean;
  pinnedCompanies?: string[];
};

/** The webhook entry plus the host's forced re-entry affordances. */
export type GranolaIngest = ((
  payload: GranolaWebhookPayload,
) => Promise<void>) & {
  /** Re-enters the pipeline bypassing the already-processed gate — the human just answered it. */
  reprocess(noteId: string): Promise<void>;
  /**
   * Forced reprocess with `pinnedCompanies` pinned through to the bucket
   * handler's context, so the handler skips extraction and fans out exactly
   * these companies.
   */
  reprocessPinned(noteId: string, companies: string[]): Promise<void>;
};

export function createGranolaIngest<
  TAnchor = GranolaThreadAnchor,
  TRef = unknown,
>(options: CreateGranolaIngestOptions<TAnchor, TRef>): GranolaIngest {
  const { client, bindingStore, transcripts, captureKnowledge, lifecycle } =
    options;
  const logger = options.log ?? log;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const handlers = options.handlers ?? {};

  // Bounded by nature: at most one pending retry per in-flight not-ready
  // note. Non-persistent — a host restart within the retry window loses the
  // scheduled retry and the note simply waits for its next webhook event
  // (regenerated/edited) to be reprocessed from scratch.
  const pendingRetries = new Set<string>();

  // Guards against two concurrent events for the same note_id (e.g.
  // note.generated and note.edited delivered close together) both running
  // the pipeline for the same note at once. Held only for the duration of
  // one processing run (including its retry) — a fresh event for a note
  // that is NOT currently in flight always reprocesses from scratch, whether
  // the note was never processed or was already completed. A concurrent
  // duplicate is dropped with a notice rather than queued (see `processNote`).
  const inFlight = new Map<string, InFlightNote<TAnchor>>();

  function handlerFor(bucketType: GranolaBucketType): GranolaBucketHandler<TRef> {
    return handlers[bucketType] ?? defaultHandler(bucketType, logger);
  }

  async function notifyDuplicate(
    noteId: string,
    state: InFlightNote<TAnchor>,
  ): Promise<void> {
    await lifecycle
      .onDuplicateEvent({
        noteId,
        anchor: state.anchor,
        bucketChannel: state.bucketChannel,
      })
      .catch((cause: unknown) => {
        logger.error("Granola duplicate-notice hook failed: {error}", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
  }

  async function processNote(
    noteId: string,
    eventType: string,
    isRetry: boolean,
    carriedState?: InFlightNote<TAnchor>,
  ): Promise<void> {
    const existing = inFlight.get(noteId);
    if (existing !== undefined) {
      logger.info(
        "Granola note {noteId} is already being processed — ignoring concurrent {eventType}",
        { noteId, eventType },
      );
      await notifyDuplicate(noteId, existing);
      return;
    }
    const state = carriedState ?? {};
    inFlight.set(noteId, state);
    try {
      await processNoteBody(noteId, eventType, isRetry, state);
    } finally {
      inFlight.delete(noteId);
    }
  }

  async function processNoteBody(
    noteId: string,
    eventType: string,
    isRetry: boolean,
    state: InFlightNote<TAnchor>,
  ): Promise<void> {
    // Bucket resolution needs the note's folder membership, which only
    // comes back from the note fetch itself — so this one fetch happens
    // before processing is reported as started. `onProcessingStarted` still
    // fires before anything else in the pipeline (the not-ready retry wait,
    // persistence, capture, handler dispatch).
    //
    // A fetch failure can't know WHICH bound channel owns the note (the
    // folder membership is inside the fetch that just failed), so
    // `onFetchFailed`/`onNoteNotGenerated` carry every bound channel — the
    // no-silent-exits rule prefers a couple of channels seeing "couldn't
    // fetch call X" over an operator re-dropping a call into total silence.
    let note: GranolaNote;
    try {
      note = await client.getNote(noteId, { includeTranscript: true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A 404 on note.access_granted is documented Granola behavior, not a
      // failure: an ungenerated call was added to a folder, and the note only
      // becomes fetchable once a human clicks "Generate Notes" (which fires
      // note.generated). Any other 404 — e.g. on note.generated itself — is
      // genuinely anomalous and stays on the failure path.
      const notGeneratedYet =
        cause instanceof GranolaApiError &&
        cause.status === 404 &&
        eventType === "note.access_granted";
      if (notGeneratedYet) {
        logger.info(
          "Granola note {noteId} isn't generated yet — waiting for note.generated",
          { noteId },
        );
      } else {
        logger.error("Granola note fetch failed for {noteId}: {error}", {
          noteId,
          error: message,
        });
      }
      let candidateChannels: string[] = [];
      try {
        const bindings = await bindingStore.list();
        candidateChannels = [...new Set(bindings.map((bucket) => bucket.channel))];
      } catch {
        // No bindings readable — logging above is all that's possible.
      }
      await (notGeneratedYet
        ? lifecycle.onNoteNotGenerated({ noteId, candidateChannels })
        : lifecycle.onFetchFailed({ noteId, error: message, candidateChannels })
      ).catch((hookCause: unknown) => {
        logger.error("Granola fetch-failure hook failed: {error}", {
          error:
            hookCause instanceof Error
              ? hookCause.message
              : String(hookCause),
        });
      });
      return;
    }

    const bucket = await resolveBucket(bindingStore, note, logger);
    if (bucket === undefined) {
      // No bound channel exists to notify — nothing to over-communicate to.
      logger.info(
        "Granola note {noteId} has no folder bound to a bucket — ignoring",
        { noteId },
      );
      return;
    }
    state.bucketChannel = bucket.channel;

    // Human-in-the-loop gate (operator design rule): the durable record — a
    // persisted transcript — is the source of truth for "already
    // processed". A re-added note doesn't silently skip (invisible) or
    // blindly rerun (wasteful); the human decides via whatever affordance
    // the host's `onAlreadyProcessed` renders. `ingest.reprocess`/
    // `ingest.reprocessPinned` (below) are that affordance's re-entry.
    if (state.forceReprocess !== true && !isRetry) {
      let alreadyProcessed = false;
      try {
        alreadyProcessed = await transcripts.hasTranscript(noteId);
      } catch (cause) {
        // The check is an optimization for the human, never a gate on the
        // pipeline: if it fails, process as if new.
        logger.warn(
          "Already-processed lookup failed for note {noteId} — treating as new: {error}",
          {
            noteId,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        );
      }
      if (alreadyProcessed) {
        await lifecycle.onAlreadyProcessed({
          noteId,
          noteTitle: note.title,
          bucketChannel: bucket.channel,
        });
        return;
      }
    }

    if (state.anchor === undefined) {
      try {
        state.anchor = await lifecycle.onProcessingStarted({
          noteId,
          noteTitle: note.title,
          bucketChannel: bucket.channel,
        });
      } catch (cause) {
        logger.error(
          "Granola processing-started hook failed for note {noteId}: {error}",
          {
            noteId,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        );
        return;
      }
    }
    const anchor = state.anchor;

    if (!isNoteReady(note)) {
      if (isRetry) {
        logger.info(
          "Granola note {noteId} still has no transcript/summary after retry — giving up",
          { noteId },
        );
        await lifecycle
          .onNoteNotReady({ anchor, isFinalAttempt: true, retryDelayMs })
          .catch((cause: unknown) => {
            logger.error(
              "Granola note-not-ready (final) hook failed for note {noteId}: {error}",
              {
                noteId,
                error: cause instanceof Error ? cause.message : String(cause),
              },
            );
          });
        return;
      }
      if (pendingRetries.has(noteId)) {
        logger.info(
          "Granola note {noteId} already has a pending retry — not scheduling another",
          {
            noteId,
          },
        );
        return;
      }
      pendingRetries.add(noteId);
      logger.info(
        "Granola note {noteId} has no transcript/summary yet — retrying once in {retryDelayMs}ms",
        { noteId, retryDelayMs },
      );
      await lifecycle
        .onNoteNotReady({ anchor, isFinalAttempt: false, retryDelayMs })
        .catch((cause: unknown) => {
          logger.error(
            "Granola note-not-ready hook failed for note {noteId}: {error}",
            {
              noteId,
              error: cause instanceof Error ? cause.message : String(cause),
            },
          );
        });
      setTimeout(() => {
        pendingRetries.delete(noteId);
        processNote(noteId, eventType, true, state).catch(
          (cause: unknown) => {
            logger.error("Granola retry for note {noteId} failed: {error}", {
              noteId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          },
        );
      }, retryDelayMs);
      return;
    }

    const segmentCount = note.transcript?.length;
    await lifecycle
      .onTranscriptReady({ anchor, segmentCount })
      .catch((cause: unknown) => {
        logger.error(
          "Granola transcript-ready hook failed for note {noteId}: {error}",
          {
            noteId,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        );
      });

    // Re-drops are the documented retry path: a note that was already
    // processed reprocesses from scratch on any fresh webhook event, rather
    // than being permanently gated by a prior `hasTranscript` hit. Guarding
    // against overwriting a newer artifact with a stale re-fetch is the
    // host store's job, not this module's.
    const text = noteText(note);
    let artifactRef: TRef;
    try {
      artifactRef = await transcripts.persist({
        granolaNoteId: noteId,
        noteTitle: note.title,
        bucketType: bucket.type,
        bucketChannel: bucket.channel,
        text,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error(
        "Persisting the call transcript failed for note {noteId}: {error}",
        { noteId, error: message },
      );
      await lifecycle
        .onPersistFailed({ anchor, error: message })
        .catch((hookCause: unknown) => {
          logger.error(
            "Granola persist-failed hook failed for note {noteId}: {error}",
            {
              noteId,
              error:
                hookCause instanceof Error
                  ? hookCause.message
                  : String(hookCause),
            },
          );
        });
      return;
    }

    // Knowledge capture is enrichment, not a gate: the artifact is already
    // persisted, and the mount has already acked (so nothing external
    // retries). Failing here must not cost the host its downstream work.
    try {
      await captureKnowledge({ artifactRef, noteTitle: note.title, text });
    } catch (cause) {
      logger.error(
        "Knowledge capture failed for Granola note {noteId} — continuing to handler dispatch: {error}",
        {
          noteId,
          error: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }

    await lifecycle
      .onHandlerDispatching({ anchor, bucketType: bucket.type })
      .catch((cause: unknown) => {
        logger.error(
          "Granola handler-dispatching hook failed for note {noteId}: {error}",
          {
            noteId,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        );
      });

    try {
      await handlerFor(bucket.type)({
        note,
        transcriptText: text,
        bucket,
        artifactRef,
        threadAnchor: anchor as unknown as GranolaThreadAnchor,
        ...(state.pinnedCompanies !== undefined && {
          pinnedCompanies: state.pinnedCompanies,
        }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error("Granola handler failed for note {noteId}: {error}", {
        noteId,
        error: message,
      });
      await lifecycle
        .onHandlerFailed({ anchor, error: message })
        .catch((hookCause: unknown) => {
          logger.error(
            "Granola handler-failed hook failed for note {noteId}: {error}",
            {
              noteId,
              error:
                hookCause instanceof Error
                  ? hookCause.message
                  : String(hookCause),
            },
          );
        });
    }
  }

  const ingest = async (payload: GranolaWebhookPayload): Promise<void> => {
    await processNote(payload.note_id, payload.event_type, false);
  };
  // Companion entry for a host's Reprocess affordance: re-enters the
  // pipeline bypassing the already-processed gate — the human just
  // answered it.
  ingest.reprocess = async (noteId: string): Promise<void> => {
    await processNote(noteId, "operator.reprocess", false, {
      forceReprocess: true,
    });
  };
  // A host's ambiguity-resolution re-entry: same forced reprocess, with the
  // chosen companies pinned through to the bucket handler's context.
  ingest.reprocessPinned = async (
    noteId: string,
    companies: string[],
  ): Promise<void> => {
    await processNote(noteId, "operator.pinned-diligence", false, {
      forceReprocess: true,
      pinnedCompanies: companies,
    });
  };
  return ingest;
}
