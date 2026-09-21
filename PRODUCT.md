# @corbits/granola — Product

## What it is

Granola meeting-notes for Interchange hosts: a REST client and two grantable
tool definitions, plus optional webhook ingress and an ingest pipeline. The
host imports what it needs. Agents that only fetch notes never take webhook
or ingest machinery with them.

`@corbits/granola` is the client (`getNote` / `listNotes` / `listFolders`)
and the tool names `granola_fetch_note` and `granola_search_notes`.
`@corbits/granola/ingress` verifies Granola webhooks and keeps the vendor
subscription converged. `@corbits/granola/ingest` turns an acked event into
a persisted transcript and a bucket-type handler.

## Why it exists

Hosts that want Granola notes in an agent or a workflow still have to talk
to Granola's public API, verify Standard Webhooks, and decide what a folder
means in their product. This package owns the Granola-shaped work — client,
signature, registration, and the after-ack pipeline — so each host supplies
storage, rendering, and behavior instead of copying the vendor protocol.

## Who it is for

Interchange host operators who already have a Granola API key and, if they
want inbound notes, a public HTTPS origin. Typical consumers grant the tools
to an agent, or mount the webhook on a Hono app and inject transcript
storage, knowledge capture, lifecycle rendering, and per-bucket handlers.

There is nothing here for a Granola end user. The Granola app and dashboard
stay Granola's.

## What users can do

- Import a client, pass `apiKey` (and optional `baseUrl`), and list folders,
  list notes in a folder, or fetch a note with its transcript.
- Grant `granola_fetch_note` and `granola_search_notes` as named tool
  definitions. Handlers on those definitions are placeholders; they throw
  until a later change fills them in.
- Bind Granola folders to a workflow type (`diligence` or `internal`) and a
  chat channel, persist that set through a host port, and keep Granola's
  webhook `folder_ids` in sync when the set changes.
- Mount `POST /api/granola/webhook`, ack fast, and run host logic after the
  ack. A failed `onEvent` is not redelivered by Granola; a later event for
  the same note or `ingest.reprocess(noteId)` is the recovery path.
- Ask a human whether to re-run a note that already has a transcript, then
  re-enter with `reprocess` or `reprocessPinned`.

## Non-goals

- The package never reads `process.env`. The host passes `apiKey`, `baseUrl`,
  public origin, and signing secret.
- It does not persist transcripts, bindings, or knowledge. Those are host
  ports.
- It does not render chat UI. Lifecycle hooks carry structured events; the
  host chooses wording and destination.
- It is not a Granola dashboard, a folder manager, or a general webhook
  framework.
- Tool handlers are not a working agent API yet. Do not grant them expecting
  a fetch or search to succeed.

## License

LGPL-2.1-only.
