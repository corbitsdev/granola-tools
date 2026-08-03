/**
 * Granola webhook verification and payload codec.
 *
 * Pure, unit-testable functions — no Hono, no network, no side effects.
 * `./mount.ts` wires these into the actual Hono route.
 *
 * Standard Webhooks (docs.granola.ai/webhooks): the signed content is
 * `{webhook-id}.{webhook-timestamp}.{raw body}`, HMAC-SHA256 keyed with the
 * signing secret. The secret is transported base64-encoded, commonly
 * prefixed `whsec_`; the key used for HMAC is the base64-DECODED bytes.
 * `webhook-signature` can carry multiple space-separated `v1,<base64>`
 * values (for secret rotation) — any one matching is a valid signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const WHSEC_PREFIX = "whsec_";
/** HMAC-SHA256 keyed on fewer bytes than this is forgeable; reject at both decode and mount time. */
export const MIN_SIGNING_KEY_BYTES = 16;
const BASE64_ALPHABET_PATTERN = /^[A-Za-z0-9+/_-]*=*$/;

/**
 * Known Granola note-lifecycle event names. `GranolaWebhookPayload.event_type`
 * itself accepts any string — downstream processing (`ingest.ts`) is
 * event-type-agnostic and idempotent, so an event type Granola adds in the
 * future should still process rather than fail closed-union validation.
 */
export const KNOWN_GRANOLA_EVENT_TYPES = [
  "note.generated",
  "note.regenerated",
  "note.edited",
  "note.access_granted",
] as const;
export type GranolaEventType = (typeof KNOWN_GRANOLA_EVENT_TYPES)[number];

export const GranolaWebhookPayload = type({
  event_id: "string",
  event_type: "string",
  note_id: "string",
  occurred_at: "string",
  "data?": {
    "changed_fields?": "string[]",
  },
});
export type GranolaWebhookPayload = typeof GranolaWebhookPayload.infer;

export type GranolaWebhookHeaders = {
  "webhook-id"?: string | undefined;
  "webhook-timestamp"?: string | undefined;
  "webhook-signature"?: string | undefined;
};

export type VerifyGranolaSignatureArgs = {
  secret: string;
  headers: GranolaWebhookHeaders;
  rawBody: string;
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: () => number;
};

export type SignatureVerificationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_headers" | "invalid_timestamp" | "stale_timestamp" | "bad_signature";
    };

/**
 * Strips an optional `whsec_` prefix and base64-decodes to the raw HMAC key.
 * Returns an `Error` (never throws) when the secret contains characters
 * outside the base64/base64url alphabet, or when the decoded key is shorter
 * than `MIN_SIGNING_KEY_BYTES` — an HMAC keyed on a near-empty string is
 * forgeable, so callers must fail closed rather than proceed.
 */
export function decodeSigningSecret(secret: string): Buffer | Error {
  const stripped = secret.startsWith(WHSEC_PREFIX)
    ? secret.slice(WHSEC_PREFIX.length)
    : secret;

  if (!BASE64_ALPHABET_PATTERN.test(stripped)) {
    return new Error(
      "Granola webhook secret contains characters outside the base64/base64url alphabet",
    );
  }

  const key = Buffer.from(stripped, "base64");
  if (key.length < MIN_SIGNING_KEY_BYTES) {
    return new Error(
      `Granola webhook secret decodes to ${String(key.length)} bytes, fewer than the required ${String(MIN_SIGNING_KEY_BYTES)}`,
    );
  }
  return key;
}

function computeSignature(key: Buffer, signedContent: string): string {
  return createHmac("sha256", key).update(signedContent).digest("base64");
}

function isTimestampFresh(timestampSeconds: number, nowSeconds: number): boolean {
  return Math.abs(nowSeconds - timestampSeconds) <= SIGNATURE_TOLERANCE_SECONDS;
}

/** Constant-time compare of two base64 signature strings of possibly-differing length. */
function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a Granola Standard-Webhooks signature over the raw request body.
 * Must run BEFORE JSON parsing — the signature covers the exact bytes sent.
 */
export function verifyGranolaSignature(
  args: VerifyGranolaSignatureArgs,
): SignatureVerificationResult {
  const { secret, headers, rawBody } = args;
  const now = args.now ?? (() => Date.now());

  const webhookId = headers["webhook-id"];
  const webhookTimestamp = headers["webhook-timestamp"];
  const webhookSignature = headers["webhook-signature"];
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: "missing_headers" };
  }

  const timestampSeconds = Number(webhookTimestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (!isTimestampFresh(timestampSeconds, Math.floor(now() / 1000))) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const key = decodeSigningSecret(secret);
  if (key instanceof Error) {
    return { ok: false, reason: "bad_signature" };
  }
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expected = computeSignature(key, signedContent);

  const presented = webhookSignature
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of presented) {
    const [scheme, value] = entry.split(",", 2);
    if (scheme !== "v1" || value === undefined) continue;
    if (signaturesMatch(value, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

/**
 * Signs a Granola-shaped payload the same way Granola would, for use by the
 * local sim harness and by signature-verification tests.
 */
export function signGranolaPayload(args: {
  secret: string;
  webhookId: string;
  webhookTimestamp: string;
  rawBody: string;
}): string {
  const key = decodeSigningSecret(args.secret);
  if (key instanceof Error) {
    throw new Error("Cannot sign a test payload with an invalid secret", { cause: key });
  }
  const signedContent = `${args.webhookId}.${args.webhookTimestamp}.${args.rawBody}`;
  return `v1,${computeSignature(key, signedContent)}`;
}

export function parseGranolaPayload(rawBody: string): GranolaWebhookPayload | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (cause) {
    return new Error("Granola webhook body is not valid JSON", { cause });
  }
  const validated = GranolaWebhookPayload(parsed);
  if (validated instanceof type.errors) {
    return new Error(`Granola webhook payload failed validation: ${validated.summary}`);
  }
  return validated;
}
