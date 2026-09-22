# @corbits/granola

Granola meeting-notes tools for Interchange hosts: a REST client and agent
tool definitions at the package root, a webhook receiver at `/ingress`, and a
host-agnostic processing pipeline at `/ingest`. `/ingress` and `/ingest`
depend on the root export; the root export depends on neither — see
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Runtime support

Node >= 24 consumes built `dist/`. Bun loads TypeScript source directly via
the `bun` export condition. `@corbits/granola/ingress` additionally needs
`hono` ^4 as a peer. Nothing in the package reads `process.env` itself — every
credential, base URL, and store is a constructor argument the host supplies.

## Install

```sh
npm add @corbits/granola
pnpm add @corbits/granola
yarn add @corbits/granola
bun add @corbits/granola
```

Not on npm yet — install from git (`bun add github:corbitsdev/corbits-granola`,
ideally pinned to a commit) until it is.

## Quickstart

Scout mounts Granola end to end this way, in
`packages/scout/src/granola/mount.ts`: build the folder-binding store,
converge the Granola-side webhook registration, wire the ingest pipeline, and
mount the webhook route on the host's Hono app. The host supplies persistence
(`bindingsPort`, `transcripts`), enrichment (`captureKnowledge`), and how to
render each pipeline event (`lifecycle`) — this package never touches storage
or chat itself.

```ts
import type { Hono } from "hono";
import { createGranolaClient, type GranolaBucket } from "@corbits/granola";
import {
  createGranolaBindingStore,
  ensureGranolaWebhook,
  mountGranolaWebhook,
  reconcileGranolaWebhookFolders,
  type GranolaBindingsPort,
} from "@corbits/granola/ingress";
import {
  createGranolaIngest,
  type GranolaTranscriptStore,
  type GranolaKnowledgeCapture,
  type GranolaIngestLifecycle,
} from "@corbits/granola/ingest";

export async function installGranolaIngestion(
  app: Hono,
  config: {
    apiKey: string;
    baseUrl: string;
    publicUrl: string | undefined; // undefined disables webhook registration
    envSecret: string | undefined; // GRANOLA_WEBHOOK_SECRET, if already provisioned
    tenantId: string;
    principalId: string;
    bindingsPort: GranolaBindingsPort<GranolaBucket>; // host's own storage
    seedBindings: GranolaBucket[];
    transcripts: GranolaTranscriptStore; // host's transcript persistence
    captureKnowledge: GranolaKnowledgeCapture; // host's enrichment step
    lifecycle: GranolaIngestLifecycle; // host renders each pipeline event
  },
): Promise<void> {
  const { apiKey, baseUrl, publicUrl } = config;

  const bindingStore = createGranolaBindingStore({
    port: config.bindingsPort,
    tenantId: config.tenantId,
    principalId: config.principalId,
    seedBindings: config.seedBindings,
    onChange: (bindings) =>
      publicUrl === undefined
        ? undefined
        : reconcileGranolaWebhookFolders({
            apiKey,
            baseUrl,
            publicUrl,
            folderIds: bindings.map((bucket) => bucket.folderId),
          }),
  });

  // Registers (or verifies) the webhook endpoint with Granola and returns
  // its signing secret. undefined means nothing to mount with (no publicUrl
  // and no envSecret, or reconciliation failed with no fallback secret).
  const secret = await ensureGranolaWebhook({
    apiKey,
    baseUrl,
    publicUrl,
    bindingStore,
    envSecret: config.envSecret,
  });
  if (secret === undefined) return;

  const ingest = createGranolaIngest({
    client: createGranolaClient({ apiKey, baseUrl }),
    bindingStore,
    transcripts: config.transcripts,
    captureKnowledge: config.captureKnowledge,
    lifecycle: config.lifecycle,
  });

  // Mounts POST /api/granola/webhook. Signatures are verified and the
  // request is acked before `ingest` runs; a failed `ingest` after ack is
  // not redelivered by Granola — a later event for the same note (or
  // `ingest.reprocess(noteId)`) is the recovery path.
  mountGranolaWebhook(app, { secret, onEvent: ingest });
}
```

Per-bucket-type behavior (e.g. what happens once a note is persisted) is
injected through `createGranolaIngest`'s `handlers` option — one
`GranolaBucketHandler` per `GranolaBucketType` — not shown above.

## Lower-level: client and tool definitions

The package root has no dependency on `/ingress` or `/ingest` — it can be
imported and its tools granted to any agent standalone, with nothing
hub-shaped attached.

```ts
import {
  createGranolaClient,
  transcriptText,
  GRANOLA_TOOL_DEFINITIONS,
} from "@corbits/granola";

const client = createGranolaClient({ apiKey: process.env["GRANOLA_API_KEY"]! });

const { folders } = await client.listFolders();
const folderId = folders[0]?.id;
if (folderId === undefined) throw new Error("no folders");

const { notes } = await client.listNotes({ folderId, pageSize: 10 });
const note = await client.getNote(notes[0]!.id, { includeTranscript: true });
console.log(note.title, transcriptText(note));

for (const tool of GRANOLA_TOOL_DEFINITIONS) {
  console.log(tool.name, "-", tool.description);
}
```

`GRANOLA_TOOL_DEFINITIONS` currently holds `granola_fetch_note` and
`granola_search_notes`; both handlers throw `not implemented` today —
grantable shape, no working body yet.

## How it works

`src/tools` is the client and tool shapes — no hub, mounting, extension, or
webhook dependency, enforced by `bun run check-deps`. `src/ingress` verifies
and mounts the webhook and keeps the Granola-side registration converged.
`src/ingest` is everything after ack: fetch the note, resolve which bucket
its folder is bound to, persist the transcript, capture knowledge, then
dispatch to that bucket type's handler — generic over the host's transcript
ref and lifecycle anchor types, so it never assumes a specific chat client or
storage schema.

## Development

```sh
git clone https://github.com/corbitsdev/granola-tools.git
cd granola-tools
bun install
bun run typecheck
bun run test
bun run check-deps
bun run build
```

`bun run test:tools` / `test:ingress` / `test:ingest` run each face's tests
independently. See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[ARCHITECTURE.md](./ARCHITECTURE.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
