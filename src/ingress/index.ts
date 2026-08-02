// @corbits/granola/ingress — the Granola webhook extension.
//
// Depends on @corbits/granola (the tools); the tools must never depend on
// this. See ARCHITECTURE.md for the dependency direction and how it is
// structurally enforced.
export { verifyGranolaSignature } from "./webhook.js";
export type { GranolaIngressOptions, GranolaWebhookHandler } from "./webhook.js";
export type { GranolaBindingsPort, GranolaBindingsLoadResult } from "./bindings-port.js";
