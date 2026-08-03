/**
 * The contract a Granola bucket-type handler must satisfy.
 *
 * Declared by the pipeline module, same inversion as the lifecycle
 * contract: the pipeline is the generic caller, so the shape it dispatches
 * through belongs to whoever implements it. Hosts register concrete
 * handlers per bucket type (e.g. Scout's diligence and internal handlers).
 *
 * `TRef` is whatever the host's transcript store returns from `persist` —
 * opaque to the pipeline, handed through to the handler unexamined.
 */
import type { GranolaBucket, GranolaNote } from "../tools/types.js";

/** Where the ack message for a note's processing run lives; every later post about that note threads under it. */
export type GranolaThreadAnchor = { channel: string; ts: string };

/**
 * Context handed to a bucket-type handler once a note's transcript has been
 * persisted and captured. `threadAnchor` is populated for every real
 * ingest-triggered dispatch (the ack posted before this handler runs) — it
 * is optional only so handlers keep working standalone in tests/call sites
 * that construct a context with no ack thread to reply into.
 *
 * `TAnchor` mirrors the pipeline's own anchor type (established by
 * `GranolaIngestLifecycle.onProcessingStarted`) — defaulted to
 * `GranolaThreadAnchor` so existing single-type-argument call sites keep
 * compiling unchanged.
 */
export type GranolaBucketHandlerContext<
  TRef = unknown,
  TAnchor = GranolaThreadAnchor,
> = {
  note: GranolaNote;
  transcriptText: string;
  bucket: GranolaBucket;
  artifactRef: TRef;
  threadAnchor?: TAnchor;
  /**
   * Set by a host's re-entry affordance (e.g. Scout's ambiguous-ask card):
   * the handler pins these companies on the run, skipping extraction.
   */
  pinnedCompanies?: string[];
};

export type GranolaBucketHandler<TRef = unknown, TAnchor = GranolaThreadAnchor> = (
  context: GranolaBucketHandlerContext<TRef, TAnchor>,
) => Promise<void>;
