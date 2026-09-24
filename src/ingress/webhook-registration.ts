/**
 * Reconciles a host's Granola webhook subscription against the Granola API
 * at boot, so a fresh deploy needs no manual "go create a webhook in the
 * Granola dashboard" step.
 *
 * Docs: https://docs.granola.ai/api-reference — create/list/update
 * webhook-endpoint. Bearer API-key auth, same as `../tools/client.ts`.
 * `signing_secret` is returned only from the create call and cannot be
 * retrieved later, which drives the cases below:
 *
 * - A matching endpoint exists and `GRANOLA_WEBHOOK_SECRET` is set: the
 *   secret is already known, so just keep `folder_ids`/`events` in sync and
 *   reuse it.
 * - A matching endpoint exists but no env secret is set: the secret behind
 *   that endpoint is unrecoverable. Rather than delete-and-recreate (which
 *   would loop on every restart until an operator persists the secret), this
 *   logs a prominent error naming the fix — set GRANOLA_WEBHOOK_SECRET to the
 *   original value, or delete the endpoint manually — and returns
 *   `undefined`, leaving the webhook unmounted.
 * - No matching endpoint: create one. This is the only path that calls
 *   create-webhook-endpoint, so the one-time signing_secret log line only
 *   ever fires here.
 * - The list response can report `url_redacted: true` instead of the real
 *   URL for an endpoint whose owner differs, which defeats exact-URL
 *   matching. When no exact match exists but some listed endpoint is
 *   redacted, reconciliation cannot tell whether that redacted endpoint is
 *   actually ours, so it does not create (which could produce a duplicate)
 *   and falls back to the env secret instead.
 *
 * Never sets a User-Agent header. Every Granola API call carries a 10s
 * timeout so a hung public-api.granola.ai cannot wedge hub boot (`ensureGranolaWebhook`
 * is awaited there). No Granola API call is allowed to crash hub boot — any
 * failure is logged and this falls back to the env secret (or `undefined`,
 * leaving the webhook unmounted) exactly as if reconciliation had never run.
 */
import { type } from "arktype";
import { getLogger } from "@intx/log";

import type { GranolaBindingStore } from "./binding-store.js";

const log = getLogger(["corbits", "granola", "webhook-registration"]);

const WEBHOOK_PATH = "/api/granola/webhook";
const ALL_NOTE_EVENTS = [
  "note.generated",
  "note.regenerated",
  "note.edited",
  "note.access_granted",
] as const;
const GRANOLA_REQUEST_TIMEOUT_MS = 10_000;

const WebhookEndpoint = type({
  id: "string",
  url: "string",
  folder_ids: "string[]",
  "events?": "string[]",
  "url_redacted?": "boolean",
});
type WebhookEndpoint = typeof WebhookEndpoint.infer;

const ListWebhookEndpointsResponse = type({
  webhook_endpoints: WebhookEndpoint.array(),
});

const CreateWebhookEndpointResponse = type({
  id: "string",
  url: "string",
  folder_ids: "string[]",
  signing_secret: "string",
});

export type EnsureGranolaWebhookOptions = {
  apiKey: string;
  /** Granola REST API base URL, e.g. `https://public-api.granola.ai/v1`. */
  baseUrl: string;
  /** Public HTTPS origin the hub is reachable at; `undefined` disables reconciliation. */
  publicUrl: string | undefined;
  /**
   * Source of the folder ids the webhook should be restricted to. Read from
   * the binding store rather than a static list so a binding change made
   * after boot (via `replaceAll`) is reflected the next time this runs.
   */
  bindingStore: GranolaBindingStore;
  /** Pre-provisioned secret from `GRANOLA_WEBHOOK_SECRET`, if set. */
  envSecret: string | undefined;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, index) => id === sortedB[index]);
}

/**
 * Sends a Granola API request with a 10s timeout (so a hung public-api.granola.ai
 * cannot wedge hub boot) and tolerates an empty/204 response body —
 * `Response.json()` throws on empty input, which would otherwise be silently
 * swallowed by the outer catch and leave a caller mid-reconciliation with no
 * indication anything went wrong.
 */
async function granolaRequest(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(GRANOLA_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Granola webhook-endpoint request failed: ${String(response.status)} ${response.statusText} ${body}`,
    );
  }
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text);
}

async function listWebhookEndpoints(
  fetchImpl: typeof fetch,
  apiKey: string,
  baseUrl: string,
): Promise<WebhookEndpoint[]> {
  const raw = await granolaRequest(
    fetchImpl,
    apiKey,
    `${baseUrl}/webhook-endpoints`,
    {
      method: "GET",
    },
  );
  const validated = ListWebhookEndpointsResponse(raw);
  if (validated instanceof type.errors) {
    throw new Error(
      `Granola list-webhook-endpoints response is malformed: ${validated.summary}`,
    );
  }
  return validated.webhook_endpoints;
}

async function createWebhookEndpoint(
  fetchImpl: typeof fetch,
  apiKey: string,
  baseUrl: string,
  args: { url: string; folderIds: string[] },
): Promise<{ id: string; secret: string }> {
  const raw = await granolaRequest(
    fetchImpl,
    apiKey,
    `${baseUrl}/webhook-endpoints`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: args.url,
        scopes: ["public"],
        events: ALL_NOTE_EVENTS,
        folder_ids: args.folderIds,
      }),
    },
  );
  const validated = CreateWebhookEndpointResponse(raw);
  if (validated instanceof type.errors) {
    throw new Error(
      `Granola create-webhook-endpoint response is malformed: ${validated.summary}`,
    );
  }
  return { id: validated.id, secret: validated.signing_secret };
}

async function updateWebhookEndpoint(
  fetchImpl: typeof fetch,
  apiKey: string,
  baseUrl: string,
  endpointId: string,
  body: { folder_ids?: string[]; events?: readonly string[] },
): Promise<void> {
  await granolaRequest(
    fetchImpl,
    apiKey,
    `${baseUrl}/webhook-endpoints/${encodeURIComponent(endpointId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function logFreshSecretWarning(targetUrl: string): void {
  log.warn(
    "Granola webhook endpoint at {url} was created and its signing_secret is unrecoverable after this boot — persist GRANOLA_WEBHOOK_SECRET now with the value logged below",
    { url: targetUrl },
  );
}

function logUnrecoverableSecretError(
  targetUrl: string,
  endpointId: string,
): void {
  log.error(
    "Granola webhook endpoint {endpointId} at {url} already exists but GRANOLA_WEBHOOK_SECRET is unset — its signing_secret cannot be retrieved from the Granola API. Set GRANOLA_WEBHOOK_SECRET to the original value, or delete this endpoint manually via the Granola API/dashboard so a fresh one can be created. The webhook will stay unmounted until then.",
    { endpointId, url: targetUrl },
  );
}

function logRedactedStateUnknown(targetUrl: string): void {
  log.error(
    "Granola webhook-endpoint list contains at least one url_redacted entry and none exactly matches {url} — reconciliation cannot determine whether a redacted endpoint is already ours, so it will not create a new one (which could duplicate it). Falling back to GRANOLA_WEBHOOK_SECRET if set.",
    { url: targetUrl },
  );
}

/**
 * Reconciles the hub's Granola webhook-endpoint registration against the
 * Granola API and returns the secret to mount the local webhook route with.
 *
 * Returns `undefined` when there is nothing to mount with: no `publicUrl`
 * and no `envSecret`, or an API failure with no `envSecret` to fall back to.
 */
export async function ensureGranolaWebhook(
  options: EnsureGranolaWebhookOptions,
): Promise<string | undefined> {
  const { apiKey, baseUrl, publicUrl, bindingStore, envSecret } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (publicUrl === undefined) {
    log.info(
      "GRANOLA_PUBLIC_URL/SCOUT_PORTAL_ORIGIN unset — cannot reconcile the Granola webhook endpoint; falling back to GRANOLA_WEBHOOK_SECRET if set",
    );
    return envSecret;
  }

  const bindings = await bindingStore.list();
  const folderIds = bindings.map((bucket) => bucket.folderId);
  const targetUrl = `${publicUrl}${WEBHOOK_PATH}`;

  try {
    const endpoints = await listWebhookEndpoints(fetchImpl, apiKey, baseUrl);
    const existing = endpoints.find((endpoint) => endpoint.url === targetUrl);

    if (existing !== undefined && envSecret !== undefined) {
      const foldersDrifted = !sameIdSet(existing.folder_ids, folderIds);
      const eventsDrifted = !sameIdSet(existing.events ?? [], ALL_NOTE_EVENTS);
      if (foldersDrifted || eventsDrifted) {
        log.info(
          "Granola webhook endpoint drifted from expected config ({drift}) — updating {url}",
          {
            drift: [foldersDrifted && "folder_ids", eventsDrifted && "events"]
              .filter(Boolean)
              .join(", "),
            url: targetUrl,
          },
        );
        await updateWebhookEndpoint(fetchImpl, apiKey, baseUrl, existing.id, {
          ...(foldersDrifted ? { folder_ids: folderIds } : {}),
          ...(eventsDrifted ? { events: ALL_NOTE_EVENTS } : {}),
        });
      }
      return envSecret;
    }

    if (existing !== undefined) {
      logUnrecoverableSecretError(targetUrl, existing.id);
      return undefined;
    }

    if (endpoints.some((endpoint) => endpoint.url_redacted === true)) {
      logRedactedStateUnknown(targetUrl);
      return envSecret;
    }

    const created = await createWebhookEndpoint(fetchImpl, apiKey, baseUrl, {
      url: targetUrl,
      folderIds,
    });
    logFreshSecretWarning(targetUrl);
    // Deliberately at warn level, not the info-level default for this
    // module: the secret is recoverable only from this one log line, this
    // one time, so it is logged plainly rather than redacted.
    log.warn(
      "Granola webhook signing_secret (persist as GRANOLA_WEBHOOK_SECRET): {secret}",
      {
        secret: created.secret,
      },
    );
    return created.secret;
  } catch (cause) {
    log.error("Granola webhook-endpoint reconciliation failed: {error}", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return envSecret;
  }
}

/**
 * Updates only the existing webhook endpoint's `folder_ids` to match
 * `folderIds` — the narrow slice of `ensureGranolaWebhook`'s reconciliation
 * this needs after a binding change: unlike boot, there is always already an
 * endpoint by this point (or reconciliation was never possible), so there is
 * nothing to create and no signing secret to mint or return. No-ops (logged)
 * when no matching endpoint exists to update, or a redacted entry makes
 * "is this ours?" undecidable — mirrors `ensureGranolaWebhook`'s same
 * fail-safe reasoning for those cases. Never throws: an API failure here
 * leaves the endpoint's folder_ids stale until the next boot or explicit
 * re-reconcile, which is safe (over-permissive at worst until it converges),
 * unlike a crash.
 */
export async function reconcileGranolaWebhookFolders(options: {
  apiKey: string;
  baseUrl: string;
  publicUrl: string;
  folderIds: string[];
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { apiKey, baseUrl, publicUrl, folderIds } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const targetUrl = `${publicUrl}${WEBHOOK_PATH}`;

  try {
    const endpoints = await listWebhookEndpoints(fetchImpl, apiKey, baseUrl);
    const existing = endpoints.find((endpoint) => endpoint.url === targetUrl);

    if (existing === undefined) {
      if (endpoints.some((endpoint) => endpoint.url_redacted === true)) {
        logRedactedStateUnknown(targetUrl);
      } else {
        log.info(
          "No Granola webhook endpoint at {url} to update folder_ids for — reconciliation skipped",
          { url: targetUrl },
        );
      }
      return;
    }

    if (sameIdSet(existing.folder_ids, folderIds)) return;

    log.info(
      "Granola webhook endpoint folder_ids drifted from bindings — updating {url}",
      {
        url: targetUrl,
      },
    );
    await updateWebhookEndpoint(fetchImpl, apiKey, baseUrl, existing.id, {
      folder_ids: folderIds,
    });
  } catch (cause) {
    log.error("Granola webhook folder_ids re-reconciliation failed: {error}", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
