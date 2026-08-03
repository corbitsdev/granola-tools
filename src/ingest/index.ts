/**
 * Public surface of the Granola ingest pipeline: the chat- and
 * host-agnostic machinery downstream of an acked webhook event. Hosts
 * provide the lifecycle (rendering), transcript store (persistence),
 * knowledge capture (enrichment), and bucket handlers (behavior).
 */
export { createGranolaIngest } from "./pipeline.js";
export type {
  CreateGranolaIngestOptions,
  GranolaIngest,
  GranolaIngestHandlers,
  GranolaKnowledgeCapture,
  GranolaTranscriptStore,
} from "./pipeline.js";
export type { GranolaIngestLifecycle } from "./lifecycle.js";
export type {
  GranolaBucketHandler,
  GranolaBucketHandlerContext,
  GranolaThreadAnchor,
} from "./bucket-handler.js";
