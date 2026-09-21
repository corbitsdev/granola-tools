# @corbits/granola — Architecture

## Shape

Three faces, one dependency direction.

```
host
  │
  ├─ grant tools ──▶  @corbits/granola          src/tools
  │                         ▲
  │                         │ client + note/bucket shapes
  ├─ mount webhook ─▶  @corbits/granola/ingress  src/ingress
  │                         ▲
  │                         │ binding store + webhook payload
  └─ after ack ─────▶  @corbits/granola/ingest   src/ingest
```

- `src/tools/` — Granola REST client and the two grantable tool definitions.
  Published as the package root, `@corbits/granola`.
- `src/ingress/` — signature verification, Hono mount, durable folder
  bindings, and webhook-endpoint reconciliation. Published as
  `@corbits/granola/ingress`.
- `src/ingest/` — host-agnostic pipeline after ack: fetch note, resolve
  bucket, persist transcript, capture knowledge, dispatch handler.
  Published as `@corbits/granola/ingest`.

`src/ingress` depends on `src/tools` for the client and bucket shapes.
`src/ingest` depends on both — `src/tools` for the client and note shapes,
`src/ingress` for the binding store and the webhook payload it processes.
`src/tools` must never depend on `src/ingress` or `src/ingest`, or on any
hub, mounting, extension, or webhook machinery. Someone can import the
tools and grant them like any other Interchange tool; nothing hub-shaped
comes along.

## The rule is enforced, not just documented

`scripts/check-deps.ts` greps `src/tools` for any import of `ingress` and
fails the build if it finds one. It runs in CI as its own job, separate
from typecheck and test.

The intended rule is stronger: tools must not import ingest either.
`check-deps` does not yet grep for `ingest`. Reviewing a change to
`src/tools/`: if it needs anything from `src/ingress/` or `src/ingest/`,
the boundary is wrong, not a reason to import across it.

## Why subpath exports, not three packages

The client, the webhook, and the pipeline version and release together — a
Granola API surface change affects all three. Separate packages would let
them drift for no benefit here. One package with three `exports` entries
keeps them versioned together while still letting a consumer install
`@corbits/granola` and pull nothing from ingress or ingest into the import
graph until they ask for those subpaths.

## Tools

The client is Bearer-auth `fetch` against Granola's public API. Responses
are arktype-validated. Folder `name` from the API is published as `title`
so notes, summaries, and folders share field names. `folder_membership` is
left `unknown`; ingest, not the client, interprets it.

Tool definitions are plain `{ name, description, handler }`. Handlers are
placeholders (`not implemented`). The catalog is `GRANOLA_TOOL_DEFINITIONS`;
callers dispatch on `name`.

## Ingress

Verification is pure: Standard Webhooks HMAC-SHA256 over
`{webhook-id}.{webhook-timestamp}.{raw body}`, keyed on the base64-decoded
signing secret (`whsec_` prefix stripped). Multiple space-separated `v1,`
signatures are accepted (rotation). Stale timestamps and short keys fail
closed.

`mountGranolaWebhook` is the only Hono concretion. Granola is not a
principal; the signature is the only authentication. No secret, or an
unusable secret, means the route is not mounted — that is a valid
configuration, not an error.

Granola gives the endpoint 15 seconds and retries only on non-2xx. The
route acks `202` before `onEvent` resolves. A post-ack failure is logged,
not retried by the vendor. In-memory `event_id` dedupe (bounded FIFO)
guards Granola's at-least-once duplicates; it remembers an id only after
`onEvent` succeeds. A host restart forgets the set.

`GranolaBindingsPort` is the persistence seam. `createGranolaBindingStore`
is seed-on-first-write: `list()` never writes; seed bindings remain until
an explicit `replaceAll`. Cache is process-local — a binding edit on one
replica is invisible to others until restart.

`ensureGranolaWebhook` reconciles the vendor subscription at boot.
`signing_secret` is returned only on create and cannot be fetched later.
A matching endpoint with no env secret leaves the webhook unmounted rather
than delete-and-recreate (which would loop every restart). A redacted URL
in the list with no exact match does not create (duplicate risk) and falls
back to the env secret. API failures never crash host boot.

`reconcileGranolaWebhookFolders` is the `onChange` target so a binding
edit can converge `folder_ids` without a reboot.

## Ingest

`createGranolaIngest` returns the `onEvent` function the mount calls after
verify, dedupe, and ack. The pipeline is generic over the host:

| Seam | Role |
| --- | --- |
| `client` | Fetch the note (with transcript). |
| `bindingStore` | Folder id → `{ type, channel }`. |
| `transcripts` | `hasTranscript` / `persist`; `TRef` is opaque. |
| `captureKnowledge` | Enrichment after persist; failures are swallowed. |
| `lifecycle` | One hook per human-visible event; `TAnchor` is opaque. |
| `handlers` | Per-bucket-type behavior (`diligence` / `internal`). |

```
event ─▶ fetch note ─▶ resolve bucket ─▶ already-processed?
                                      │ no
                                      ▼
                         onProcessingStarted (anchor)
                                      │
                         not ready? ──retry once ── give up
                                      │ ready
                                      ▼
                         persist ─▶ capture ─▶ handler
```

A note with no bound folder is ignored (nowhere to notify). Multiple
folder matches take the first. `folder_membership` is tolerated as an id,
a list of ids, or objects with `folderId` / `id`; unexpected shapes become
"no bucket" rather than a crash.

The durable already-processed gate is a persisted transcript, not the
in-flight map. A re-added note does not silently skip or blindly rerun;
`onAlreadyProcessed` asks the human. `reprocess` / `reprocessPinned`
bypass that gate. Concurrent events for the same `note_id` drop with
`onDuplicateEvent` rather than queue.

In-flight state and the not-ready retry timer are process-local. A restart
inside the retry window loses the timer; the next webhook event starts
from scratch.

## Failure modes

- Hung Granola HTTP must not hold ingest's in-flight guard forever (client
  timeout) or wedge host boot (registration timeout).
- `note.access_granted` + 404 means the note is not generated yet, not a
  fetch failure. Recovery is `note.generated` after a human generates
  notes in Granola.
- Knowledge-capture errors must not skip the bucket handler.
- Handler errors are reported through `onHandlerFailed`; they do not
  un-ack the webhook.
- Lifecycle hooks that throw are logged; they do not rewrite pipeline
  control flow except `onProcessingStarted`, which aborts the run if it
  cannot establish an anchor.

## What is still placeholder

Tool handlers. The client, webhook verification, registration, binding
store, and ingest pipeline are real.
