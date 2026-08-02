// @corbits/granola/ingress — the Granola webhook extension.
//
// Depends on @corbits/granola (the tools); the tools must never depend on
// this. See ARCHITECTURE.md for the dependency direction and how it is
// structurally enforced.
export {
  verifyGranolaSignature,
  decodeSigningSecret,
  signGranolaPayload,
  parseGranolaPayload,
  MIN_SIGNING_KEY_BYTES,
  KNOWN_GRANOLA_EVENT_TYPES,
} from "./webhook.js";
export type {
  GranolaWebhookPayload,
  GranolaWebhookHeaders,
  VerifyGranolaSignatureArgs,
  SignatureVerificationResult,
  GranolaEventType,
} from "./webhook.js";
export type { GranolaBindingsPort, GranolaBindingsLoadResult } from "./bindings-port.js";

export { createGranolaBindingStore } from "./binding-store.js";
export type {
  GranolaBindingStore,
  CreateGranolaBindingStoreOptions,
} from "./binding-store.js";

export {
  ensureGranolaWebhook,
  reconcileGranolaWebhookFolders,
} from "./webhook-registration.js";
export type { EnsureGranolaWebhookOptions } from "./webhook-registration.js";
