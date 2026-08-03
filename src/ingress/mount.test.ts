import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { signGranolaPayload } from "./webhook.js";
import { mountGranolaWebhook } from "./mount.js";

const SECRET = "whsec_dGVzdHNlY3JldHZhbHVlMTIz";

function samplePayload(eventId: string): string {
  return JSON.stringify({
    event_id: eventId,
    event_type: "note.generated",
    note_id: "note_1",
    occurred_at: "2026-07-31T00:00:00Z",
  });
}

function signedHeaders(eventId: string, rawBody: string): Record<string, string> {
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const signature = signGranolaPayload({
    secret: SECRET,
    webhookId: eventId,
    webhookTimestamp,
    rawBody,
  });
  return {
    "content-type": "application/json",
    "webhook-id": eventId,
    "webhook-timestamp": webhookTimestamp,
    "webhook-signature": signature,
  };
}

describe("mountGranolaWebhook", () => {
  test("does not mount without a secret", () => {
    const app = new Hono();
    const result = mountGranolaWebhook(app, { secret: "", onEvent: async () => undefined });
    expect(result.mounted).toBe(false);
  });

  test("acks a validly signed request with 202 and invokes onEvent", async () => {
    const app = new Hono();
    const received: string[] = [];
    let resolveOnEvent: (() => void) | undefined;
    const onEventStarted = new Promise<void>((resolve) => {
      resolveOnEvent = resolve;
    });

    mountGranolaWebhook(app, {
      secret: SECRET,
      onEvent: async (payload) => {
        received.push(payload.event_id);
        resolveOnEvent?.();
      },
    });

    const rawBody = samplePayload("evt_ack");
    const res = await app.request("/api/granola/webhook", {
      method: "POST",
      headers: signedHeaders("evt_ack", rawBody),
      body: rawBody,
    });

    expect(res.status).toBe(202);
    await onEventStarted;
    expect(received).toEqual(["evt_ack"]);
  });

  test("rejects an unsigned request with 401", async () => {
    const app = new Hono();
    mountGranolaWebhook(app, { secret: SECRET, onEvent: async () => undefined });

    const rawBody = samplePayload("evt_unsigned");
    const res = await app.request("/api/granola/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });

    expect(res.status).toBe(401);
  });

  test("rejects a tampered body with 401", async () => {
    const app = new Hono();
    mountGranolaWebhook(app, { secret: SECRET, onEvent: async () => undefined });

    const rawBody = samplePayload("evt_tamper");
    const headers = signedHeaders("evt_tamper", rawBody);
    const res = await app.request("/api/granola/webhook", {
      method: "POST",
      headers,
      body: samplePayload("evt_tamper").replace("note_1", "note_evil"),
    });

    expect(res.status).toBe(401);
  });

  test("duplicate event_id is a no-op the second time", async () => {
    const app = new Hono();
    let callCount = 0;
    mountGranolaWebhook(app, {
      secret: SECRET,
      onEvent: async () => {
        callCount += 1;
      },
    });

    const rawBody = samplePayload("evt_dupe");
    const headers = signedHeaders("evt_dupe", rawBody);

    const first = await app.request("/api/granola/webhook", {
      method: "POST",
      headers,
      body: rawBody,
    });
    const second = await app.request("/api/granola/webhook", {
      method: "POST",
      headers,
      body: rawBody,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);
  });

  test("responds before the onEvent handler resolves (fast ack)", async () => {
    const app = new Hono();
    let handlerResolved = false;
    mountGranolaWebhook(app, {
      secret: SECRET,
      onEvent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        handlerResolved = true;
      },
    });

    const rawBody = samplePayload("evt_fastack");
    const res = await app.request("/api/granola/webhook", {
      method: "POST",
      headers: signedHeaders("evt_fastack", rawBody),
      body: rawBody,
    });

    expect(res.status).toBe(202);
    expect(handlerResolved).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(handlerResolved).toBe(true);
  });

  test("does not mount and logs an error for a secret whose decoded key is unusably short", () => {
    const app = new Hono();
    const result = mountGranolaWebhook(app, {
      secret: "whsec_",
      onEvent: async () => undefined,
    });
    expect(result.mounted).toBe(false);
  });

  test("a redelivery after a failing onEvent is reprocessed (event_id is only remembered on success)", async () => {
    const app = new Hono();
    let callCount = 0;
    mountGranolaWebhook(app, {
      secret: SECRET,
      onEvent: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("transient failure");
      },
    });

    const rawBody = samplePayload("evt_retry");
    const headers = signedHeaders("evt_retry", rawBody);

    const first = await app.request("/api/granola/webhook", { method: "POST", headers, body: rawBody });
    expect(first.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);

    const second = await app.request("/api/granola/webhook", { method: "POST", headers, body: rawBody });
    expect(second.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(2);
  });

  test("rejects a request whose Content-Length exceeds the 1 MiB cap with 413, without invoking onEvent", async () => {
    const app = new Hono();
    let onEventCalled = false;
    mountGranolaWebhook(app, {
      secret: SECRET,
      onEvent: async () => {
        onEventCalled = true;
      },
    });

    const oversizedBody = "x".repeat(2 * 1024 * 1024);
    const res = await app.request("/api/granola/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(oversizedBody.length),
        "webhook-id": "evt_big",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,doesnotmatter",
      },
      body: oversizedBody,
    });

    expect(res.status).toBe(413);
    expect(onEventCalled).toBe(false);
  });

  test("rejects a request missing required headers before reading the body", async () => {
    const app = new Hono();
    mountGranolaWebhook(app, { secret: SECRET, onEvent: async () => undefined });

    const res = await app.request("/api/granola/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: samplePayload("evt_noheaders"),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_headers");
  });
});
