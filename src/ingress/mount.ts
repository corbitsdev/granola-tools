/**
 * Mount the Granola inbound webhook onto a host's Hono app.
 *
 * Signature verification (`verifyGranolaSignature`) is the only
 * authentication — Granola is not a principal. Absent a secret is a valid
 * configuration, not an error: the host runs fine without a Granola webhook
 * and the route simply is not mounted.
 *
 * Granola gives the endpoint 15 seconds to respond and retries a delivery
 * (same `event_id`) for up to 24 hours only when the response is NOT a 2xx.
 * This route acks fast (202) before `onEvent` resolves — processing can take
 * minutes — which means Granola will not redeliver an event we acked: a
 * failure inside `onEvent` is logged, not retried by the vendor. The
 * event-id dedupe is still remembered only on `onEvent` success, but that
 * guards against Granola's at-least-once duplicate deliveries (which can
 * race the ack), not against our own post-ack failures. This mount does not
 * know what processing `onEvent` performs; callers inject it.
 *
 * The `app` is a plain constructor parameter — this file owns no host
 * concretion. Headers, body-size limits, and HTTP status codes are the
 * route's job; verification/parsing stays in `./webhook.ts`.
 */
import type { Hono } from "hono";
import { getLogger } from "@intx/log";

import {
  decodeSigningSecret,
  parseGranolaPayload,
  verifyGranolaSignature,
  type GranolaWebhookPayload,
} from "./webhook.js";

const log = getLogger(["corbits", "granola", "mount"]);

const GRANOLA_WEBHOOK_PATH = "/api/granola/webhook";
const DEFAULT_DEDUPE_CAPACITY = 1000;
/** Bun's default request-body cap is 128MiB; an unauthenticated route needs a much tighter one. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export type OnGranolaEvent = (payload: GranolaWebhookPayload) => Promise<void>;

export type MountGranolaWebhookOptions = {
  secret: string;
  onEvent: OnGranolaEvent;
  /** Max remembered event ids before the oldest are evicted. Defaults to 1000. */
  dedupeCapacity?: number;
};

export type MountedGranolaWebhook = { mounted: boolean; path?: string };

/**
 * Bounded FIFO set of seen event ids. A `Set` preserves insertion order, so
 * eviction of the oldest entry on overflow is a plain iterator `.next()` —
 * no separate ordering structure needed for a cap this small.
 */
function createEventIdDedupe(capacity: number) {
  const seen = new Set<string>();
  return {
    hasSeen(eventId: string): boolean {
      return seen.has(eventId);
    },
    remember(eventId: string): void {
      if (seen.has(eventId)) return;
      if (seen.size >= capacity) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.add(eventId);
    },
  };
}

export function mountGranolaWebhook(
  app: Hono,
  options: MountGranolaWebhookOptions,
): MountedGranolaWebhook {
  const { secret, onEvent } = options;
  if (!secret) {
    log.info("Granola webhook not mounted — no secret provided");
    return { mounted: false };
  }

  const key = decodeSigningSecret(secret);
  if (key instanceof Error) {
    log.error(
      "Granola webhook not mounted — secret is unusable: {message}",
      { message: key.message },
    );
    return { mounted: false };
  }

  const dedupe = createEventIdDedupe(options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY);

  app.post(GRANOLA_WEBHOOK_PATH, async (c) => {
    const headers = {
      "webhook-id": c.req.header("webhook-id"),
      "webhook-timestamp": c.req.header("webhook-timestamp"),
      "webhook-signature": c.req.header("webhook-signature"),
    };
    if (!headers["webhook-id"] || !headers["webhook-timestamp"] || !headers["webhook-signature"]) {
      log.info("Granola webhook rejected: missing_headers");
      return c.json({ error: "missing_headers" }, 401);
    }

    const contentLength = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      log.info("Granola webhook rejected: body exceeds {maxBytes} bytes", {
        maxBytes: MAX_BODY_BYTES,
      });
      return c.json({ error: "payload_too_large" }, 413);
    }

    // Best-effort cap: a chunked request with no content-length is only
    // caught here, after the body has been buffered — Bun's own
    // maxRequestBodySize (default 128 MiB) is the hard ceiling before that.
    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      log.info("Granola webhook rejected: body exceeds {maxBytes} bytes", {
        maxBytes: MAX_BODY_BYTES,
      });
      return c.json({ error: "payload_too_large" }, 413);
    }

    const verification = verifyGranolaSignature({ secret, headers, rawBody });

    if (!verification.ok) {
      log.info("Granola webhook rejected: {reason}", { reason: verification.reason });
      return c.json({ error: verification.reason }, 401);
    }

    const payload = parseGranolaPayload(rawBody);
    if (payload instanceof Error) {
      // 202 (not 400) here: both are terminal for Granola (neither triggers a
      // retry), so the choice is purely about observability. A malformed body
      // from a verified sender is unusual enough that we'd rather see it in
      // logs than have Granola record it as a delivery failure.
      log.error("Granola webhook payload rejected after valid signature: {message}", {
        message: payload.message,
      });
      return c.json({ ok: true }, 202);
    }

    if (dedupe.hasSeen(payload.event_id)) {
      log.info("Granola webhook duplicate event_id {eventId} — no-op", {
        eventId: payload.event_id,
      });
      return c.json({ ok: true }, 202);
    }

    const response = c.json({ ok: true }, 202);
    void onEvent(payload)
      .then(() => {
        dedupe.remember(payload.event_id);
      })
      .catch((cause: unknown) => {
        log.error(
          "Granola onEvent handler failed for {eventId} after ack — the vendor will not redeliver an acked event; a later event for the same note (or a manual re-drop) is the recovery path: {error}",
          {
            eventId: payload.event_id,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        );
      });
    return response;
  });

  log.info("Granola webhook mounted at {path}", { path: GRANOLA_WEBHOOK_PATH });
  return { mounted: true, path: GRANOLA_WEBHOOK_PATH };
}
