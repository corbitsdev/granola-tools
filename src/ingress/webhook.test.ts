import { describe, expect, test } from "bun:test";

import {
  decodeSigningSecret,
  parseGranolaPayload,
  signGranolaPayload,
  verifyGranolaSignature,
} from "./webhook";

const SECRET = "whsec_c3VwZXJzZWNyZXR2YWx1ZQ==";
const EVENT_ID = "evt_123";

function samplePayload(): string {
  return JSON.stringify({
    event_id: EVENT_ID,
    event_type: "note.generated",
    note_id: "note_1",
    occurred_at: "2026-07-31T00:00:00Z",
  });
}

describe("verifyGranolaSignature", () => {
  test("accepts a correctly signed payload", () => {
    const rawBody = samplePayload();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const webhookTimestamp = String(nowSeconds);
    const signature = signGranolaPayload({
      secret: SECRET,
      webhookId: EVENT_ID,
      webhookTimestamp,
      rawBody,
    });

    const result = verifyGranolaSignature({
      secret: SECRET,
      rawBody,
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": signature,
      },
    });

    expect(result).toEqual({ ok: true });
  });

  test("accepts a bare (non whsec_-prefixed) secret the same way", () => {
    const bareSecret = SECRET.slice("whsec_".length);
    const rawBody = samplePayload();
    const webhookTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = signGranolaPayload({
      secret: bareSecret,
      webhookId: EVENT_ID,
      webhookTimestamp,
      rawBody,
    });

    const result = verifyGranolaSignature({
      secret: bareSecret,
      rawBody,
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": signature,
      },
    });

    expect(result).toEqual({ ok: true });
  });

  test("rejects a tampered body", () => {
    const rawBody = samplePayload();
    const webhookTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = signGranolaPayload({
      secret: SECRET,
      webhookId: EVENT_ID,
      webhookTimestamp,
      rawBody,
    });

    const tamperedBody = samplePayload().replace("note_1", "note_evil");
    const result = verifyGranolaSignature({
      secret: SECRET,
      rawBody: tamperedBody,
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": signature,
      },
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a stale timestamp", () => {
    const rawBody = samplePayload();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const signature = signGranolaPayload({
      secret: SECRET,
      webhookId: EVENT_ID,
      webhookTimestamp: staleTimestamp,
      rawBody,
    });

    const result = verifyGranolaSignature({
      secret: SECRET,
      rawBody,
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": staleTimestamp,
        "webhook-signature": signature,
      },
    });

    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  test("rejects a future timestamp beyond tolerance", () => {
    const rawBody = samplePayload();
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 10 * 60);
    const signature = signGranolaPayload({
      secret: SECRET,
      webhookId: EVENT_ID,
      webhookTimestamp: futureTimestamp,
      rawBody,
    });

    const result = verifyGranolaSignature({
      secret: SECRET,
      rawBody,
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": futureTimestamp,
        "webhook-signature": signature,
      },
    });

    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  test("rejects missing headers", () => {
    const result = verifyGranolaSignature({
      secret: SECRET,
      rawBody: samplePayload(),
      headers: {},
    });

    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  test("reports invalid_timestamp (not missing_headers) for a present but non-numeric webhook-timestamp", () => {
    const result = verifyGranolaSignature({
      secret: SECRET,
      rawBody: samplePayload(),
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": "not-a-number",
        "webhook-signature": "v1,doesnotmatter",
      },
    });

    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  test("fails closed for a secret that base64-decodes to zero bytes", () => {
    const rawBody = samplePayload();
    const webhookTimestamp = String(Math.floor(Date.now() / 1000));

    const result = verifyGranolaSignature({
      secret: "whsec_",
      rawBody,
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": webhookTimestamp,
        // An empty-string-keyed HMAC of the exact signed content, base64-encoded.
        // Even a signature an attacker could trivially compute (since the "key" is
        // empty and thus known) must still be rejected.
        "webhook-signature": "v1,anything",
      },
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("fails closed for a secret decoding to fewer than 16 bytes", () => {
    const rawBody = samplePayload();
    const webhookTimestamp = String(Math.floor(Date.now() / 1000));

    const result = verifyGranolaSignature({
      secret: "whsec_@@@@",
      rawBody,
      headers: {
        "webhook-id": EVENT_ID,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": "v1,anything",
      },
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("decodeSigningSecret", () => {
  test("accepts a secret decoding to at least 16 bytes", () => {
    const key = decodeSigningSecret(SECRET);
    expect(key instanceof Error).toBe(false);
  });

  test("rejects a secret that decodes to zero bytes", () => {
    const key = decodeSigningSecret("whsec_");
    expect(key instanceof Error).toBe(true);
  });

  test("rejects a secret shorter than the 16-byte minimum", () => {
    const key = decodeSigningSecret("whsec_c2hvcnQ=");
    expect(key instanceof Error).toBe(true);
  });

  test("rejects a secret containing characters outside the base64/base64url alphabet", () => {
    const key = decodeSigningSecret("whsec_@@@@");
    expect(key instanceof Error).toBe(true);
  });
});

describe("parseGranolaPayload", () => {
  test("parses a valid note.generated payload", () => {
    const parsed = parseGranolaPayload(samplePayload());
    expect(parsed instanceof Error).toBe(false);
    if (!(parsed instanceof Error)) {
      expect(parsed.event_id).toBe(EVENT_ID);
      expect(parsed.event_type).toBe("note.generated");
    }
  });

  test("parses a note.edited payload with changed_fields", () => {
    const rawBody = JSON.stringify({
      event_id: EVENT_ID,
      event_type: "note.edited",
      note_id: "note_1",
      occurred_at: "2026-07-31T00:00:00Z",
      data: { changed_fields: ["title", "summary"] },
    });

    const parsed = parseGranolaPayload(rawBody);
    expect(parsed instanceof Error).toBe(false);
    if (!(parsed instanceof Error)) {
      expect(parsed.event_type).toBe("note.edited");
      expect(parsed.data?.changed_fields).toEqual(["title", "summary"]);
    }
  });

  test("rejects malformed JSON", () => {
    const parsed = parseGranolaPayload("{not json");
    expect(parsed instanceof Error).toBe(true);
  });

  test("rejects a payload missing required fields", () => {
    const parsed = parseGranolaPayload(JSON.stringify({ event_id: EVENT_ID }));
    expect(parsed instanceof Error).toBe(true);
  });

  test("accepts an unknown event_type — downstream processing is event-type-agnostic", () => {
    const rawBody = JSON.stringify({
      event_id: EVENT_ID,
      event_type: "note.deleted",
      note_id: "note_1",
      occurred_at: "2026-07-31T00:00:00Z",
    });
    const parsed = parseGranolaPayload(rawBody);
    expect(parsed instanceof Error).toBe(false);
    if (!(parsed instanceof Error)) {
      expect(parsed.event_type).toBe("note.deleted");
    }
  });
});
