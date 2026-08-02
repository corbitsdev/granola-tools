// The persistence seam for durable Granola bucket bindings (folder id ->
// workflow type -> chat channel). This package never persists anything
// itself — a host composing @corbits/granola/ingress supplies a concrete
// GranolaBindingsPort backed by whatever storage it already has (a
// database row, a config artifact, a file — this package doesn't care).
// Generic over the binding shape so this file has zero dependency on any
// host-specific or product-specific type.

export interface GranolaBindingsLoadResult<Binding> {
  bindings: Binding[];
  version: number;
}

export interface GranolaBindingsPort<Binding> {
  /** Current persisted bindings for a tenant, or `undefined` if none have ever been saved. */
  load(args: { tenantId: string }): Promise<GranolaBindingsLoadResult<Binding> | undefined>;
  /** Persists a whole new binding set as the tenant's current bindings. */
  save(args: { tenantId: string; principalId: string; bindings: Binding[] }): Promise<void>;
}
