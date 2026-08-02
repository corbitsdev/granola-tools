/**
 * Durable, mutable Granola bucket-binding store: folder id -> workflow type
 * -> chat channel bindings. Persistence goes through `GranolaBindingsPort`
 * (`./bindings-port.ts`) — the package declares the seam, the host
 * implements it against its own storage (a config artifact, a database row,
 * a file — this module doesn't know or care), which is what keeps this file
 * free of any dependency on a specific host or product.
 *
 * A host's own seed configuration is demoted to a fallback: `list()` returns
 * the persisted bindings when any exist, and only falls back to
 * `seedBindings` when nothing has ever been saved for the tenant. Reading
 * never writes — a host that has never touched bindings stays on the seed
 * fallback indefinitely; the persisted set is created only by an explicit
 * `replaceAll` call. This is the "seed-on-first-write, no silent
 * auto-migration" behavior: a read-triggered persist would make the seed
 * fallback disappear the moment anything called `list()`, with no operator
 * action behind it.
 *
 * An in-memory cache avoids round-tripping to the port on every ingested
 * Granola event; `replaceAll` invalidates it so the next `list()` reflects
 * the write it just made.
 */
import { getLogger } from "@intx/log";
import { type } from "arktype";

import type { GranolaBindingsPort } from "./bindings-port.js";
import { GranolaBucketsArray, type GranolaBucket } from "../tools/types.js";

type Logger = ReturnType<typeof getLogger>;

const log = getLogger(["corbits", "granola", "binding-store"]);

export type GranolaBindingStore = {
  /** Current bindings for the tenant — from the persisted store, or the seed-config fallback. */
  list(): Promise<GranolaBucket[]>;
  /** Persists a whole new binding set as the next version of the tenant's bindings. */
  replaceAll(bindings: GranolaBucket[]): Promise<void>;
};

export type CreateGranolaBindingStoreOptions = {
  port: GranolaBindingsPort<GranolaBucket>;
  tenantId: string;
  principalId: string;
  /** Seed bindings, used only while nothing has been persisted for this tenant. */
  seedBindings: GranolaBucket[];
  log?: Logger;
  /** Invoked with the new binding set after every successful `replaceAll` — e.g. to reconcile a webhook subscription's folder scope. */
  onChange?: (bindings: GranolaBucket[]) => void | Promise<void>;
};

export function createGranolaBindingStore(
  options: CreateGranolaBindingStoreOptions,
): GranolaBindingStore {
  const { port, tenantId, principalId, seedBindings } = options;
  const logger = options.log ?? log;

  let cache: GranolaBucket[] | undefined;

  async function load(): Promise<GranolaBucket[]> {
    const found = await port.load({ tenantId });
    if (found !== undefined) {
      const validated = GranolaBucketsArray(found.bindings);
      if (validated instanceof type.errors) {
        logger.error(
          "Granola bindings for tenant {tenantId} exist but failed validation — falling back to {count} seed binding(s): {summary}",
          { tenantId, count: seedBindings.length, summary: validated.summary },
        );
        return seedBindings;
      }
      logger.info(
        "Granola bindings for tenant {tenantId} resolved from the persisted store — {count} binding(s), version {version}",
        { tenantId, count: validated.length, version: found.version },
      );
      return validated;
    }

    logger.info(
      "No persisted Granola bindings for tenant {tenantId} — falling back to {count} seed binding(s) until replaceAll persists a binding set",
      { tenantId, count: seedBindings.length },
    );
    return seedBindings;
  }

  // Single-process cache: invalidation happens only via replaceAll on THIS
  // store instance. Running more than one host replica means a binding edit
  // on one process is invisible to the others until restart — revisit with
  // a TTL or notification channel before a host scales horizontally.
  return {
    async list() {
      if (cache === undefined) {
        cache = await load();
      }
      // Defensive copy: callers must not be able to mutate the cached set.
      return [...cache];
    },
    async replaceAll(bindings) {
      await port.save({
        tenantId,
        principalId,
        bindings,
      });
      logger.info(
        "Granola bindings for tenant {tenantId} replaced — {count} binding(s) written",
        {
          tenantId,
          count: bindings.length,
        },
      );
      cache = undefined;
      try {
        await options.onChange?.(bindings);
      } catch (cause) {
        // The binding write already succeeded — a convergence hook failure
        // must never make it look failed to the caller.
        logger.error("Granola binding onChange hook failed: {error}", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
  };
}
