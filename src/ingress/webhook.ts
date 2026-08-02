// Webhook extension: receives Granola webhooks, verifies signatures, and
// dispatches notes to handlers. Depends on the tools (src/tools) for the
// client; the tools must never depend on this. Skeleton only — no dispatch
// logic implemented yet.
import { GranolaClient } from "../tools/index.js";

export interface GranolaWebhookHandler {
  (event: unknown): Promise<void>;
}

export interface GranolaIngressOptions {
  client: GranolaClient;
  webhookSecret: string;
  onNote: GranolaWebhookHandler;
}

/** Verify a Granola webhook signature. Placeholder — implementation lands separately. */
export function verifyGranolaSignature(_payload: string, _signature: string, _secret: string): boolean {
  throw new Error("not implemented");
}
