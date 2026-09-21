# @corbits/granola — Implementation

## Package

- Name: `@corbits/granola` `0.1.0`
- License: LGPL-2.1-only
- Engines: Node `>= 24` consumes built `dist/`. Bun loads TypeScript source
  via the `bun` export condition.
- Public exports:

  | Subpath | Bun | Node / types |
  | --- | --- | --- |
  | `.` | `src/tools/index.ts` | `dist/tools/index.js` + `.d.ts` |
  | `./ingress` | `src/ingress/index.ts` | `dist/ingress/index.js` + `.d.ts` |
  | `./ingest` | `src/ingest/index.ts` | `dist/ingest/index.js` + `.d.ts` |

- npm tarball: `dist/`, `src/` (tests excluded), `LICENSE`, `README.md`.
  These design docs live at the repository root and are not in `files`.
- `sideEffects: false`. The package never reads `process.env`.

## Runtime dependencies

- `arktype` — response, payload, and binding validation
- `@intx/log` — ingress mount, registration, binding store, ingest
- `hono` `^4` — **peer**, required only for `@corbits/granola/ingress`
- `node:crypto` — HMAC-SHA256 and `timingSafeEqual` in webhook verify

## Install

```sh
npm add @corbits/granola
pnpm add @corbits/granola
yarn add @corbits/granola
bun add @corbits/granola
```

Ingress also needs `hono` in the host.

## Public surface

From `@corbits/granola`:

- `createGranolaClient({ apiKey, baseUrl?, fetchImpl? })` —
  `{ getNote, listNotes, listFolders }`
- `transcriptText`, `speakerLabel`, `GranolaApiError`, `GranolaNote`
- `GranolaBucketType`, `GranolaBucketsArray`
- `fetchNoteTool`, `searchNotesTool`, `GRANOLA_TOOL_DEFINITIONS`

From `@corbits/granola/ingress`:

- `verifyGranolaSignature`, `decodeSigningSecret`, `signGranolaPayload`,
  `parseGranolaPayload`, `MIN_SIGNING_KEY_BYTES`, `KNOWN_GRANOLA_EVENT_TYPES`
- `createGranolaBindingStore`
- `ensureGranolaWebhook`, `reconcileGranolaWebhookFolders`
- `mountGranolaWebhook`

From `@corbits/granola/ingest`:

- `createGranolaIngest` — callable `onEvent` plus `reprocess` /
  `reprocessPinned`

## Client

Default `baseUrl`: `https://public-api.granola.ai/v1`. Docs:
https://docs.granola.ai (OpenAPI at
https://docs.granola.ai/api-reference/openapi.json).

| Method | HTTP |
| --- | --- |
| `getNote(id, { includeTranscript? })` | `GET /notes/:id` (`include=transcript`) |
| `listNotes({ folderId, cursor?, pageSize? })` | `GET /notes?folder_id&page_size&cursor` |
| `listFolders({ cursor?, pageSize? })` | `GET /folders?page_size&cursor` |

Auth: `Authorization: Bearer <apiKey>`. Also sends `Accept` and
`Content-Type: application/json` on GET (Granola otherwise answers
non-JSON on some routes). Never sets `User-Agent`.

Timeout: `AbortSignal.timeout(30_000)` on every client request. Non-2xx
throws `GranolaApiError` with `status` and raw `body`. `null` cursors
normalize to absent. Default `pageSize` is 30. Folder API `name` maps to
public `title`.

## Tools

| Name | Args (intended) | Handler today |
| --- | --- | --- |
| `granola_fetch_note` | `{ noteId }` | throws `not implemented` |
| `granola_search_notes` | `{ query }` | throws `not implemented` |

## Webhook protocol

Standard Webhooks (https://docs.granola.ai/webhooks). Signed content:
`{webhook-id}.{webhook-timestamp}.{raw body}`. Secret is base64, commonly
prefixed `whsec_`; HMAC key is the decoded bytes. Reject if decoded key is
shorter than `MIN_SIGNING_KEY_BYTES` (16). Timestamp skew:
`SIGNATURE_TOLERANCE_SECONDS` = 300.

Payload (arktype): `event_id`, `event_type` (any string), `note_id`,
`occurred_at`, optional `data.changed_fields`. Known event names (not a
closed union on the wire): `note.generated`, `note.regenerated`,
`note.edited`, `note.access_granted`.

## Mount

Absolute route: `POST /api/granola/webhook`. Body cap: 1 MiB (413
`payload_too_large`). Missing/bad signature: 401 with `missing_headers` /
`invalid_timestamp` / `stale_timestamp` / `bad_signature`. Verified but
malformed JSON: 202 (terminal for Granola; logged). Duplicate `event_id`:
202. Success: 202, then `onEvent` in the background. Default dedupe
capacity: 1000.

## Registration

Granola REST, 10s timeout, no `User-Agent`.

| | |
| --- | --- |
| List | `GET /webhook-endpoints` |
| Create | `POST /webhook-endpoints` (`url`, `scopes: ["public"]`, `events`, `folder_ids`) |
| Update | `PATCH /webhook-endpoints/:id` |

Create is the only call that returns `signing_secret`. Target URL is
`{publicUrl}/api/granola/webhook`. Host env names in comments/logs:
`GRANOLA_WEBHOOK_SECRET`, `GRANOLA_PUBLIC_URL` (or a portal origin) — the
library still takes them as function arguments.

## Bindings

`GranolaBucket`: `{ folderId, type: "diligence" \| "internal", channel }`.
Port: `load({ tenantId })` → `{ bindings, version } | undefined`;
`save({ tenantId, principalId, bindings })`.

## Ingest

Default not-ready retry: 60s, once, via `setTimeout` (overridable
`retryDelayMs`). Persist text is transcript lines (`Speaker: text`), else
`summary_markdown`, else `summary_text`. Synthetic event types for
operator re-entry: `operator.reprocess`, `operator.pinned-diligence`.

## Development

```sh
bun install
bun run typecheck
bun run test
bun run test:tools
bun run test:ingress
bun run test:ingest
bun run check-deps
bun run build
```

CI (`.github/workflows/test.yml`): `check-deps`, `typecheck`, `test-tools`,
`test-ingress`, `test-ingest`, `build` as separate jobs; a Node 24 job
runs `npm install`, `typecheck`, and `build`. Bun in CI is `1.3.14`.
