# @corbits/granola

Granola meeting-notes client and agent tool definitions for Interchange hosts, plus optional webhook ingress and ingest. `@corbits/granola` is a REST client (`getNote` / `listNotes` / `listFolders`) and two grantable tool definitions. `@corbits/granola/ingress` verifies Granola webhooks and keeps registration converged. `@corbits/granola/ingest` turns an acked event into a persisted transcript and a bucket handler.

## Runtime support

Node >= 24 consumes built `dist/`. Bun loads TypeScript source via the `bun` export condition. `@corbits/granola/ingress` also needs `hono` ^4 as a peer. The host supplies `apiKey`, `baseUrl`, and (for ingress) a public origin and signing secret.

## Quickstart

```sh
npm add @corbits/granola
pnpm add @corbits/granola
yarn add @corbits/granola
bun add @corbits/granola
```

```ts
import {
  createGranolaClient,
  transcriptText,
  GRANOLA_TOOL_DEFINITIONS,
} from "@corbits/granola";

const client = createGranolaClient({ apiKey: process.env.GRANOLA_API_KEY! });

const { folders } = await client.listFolders();
const folderId = folders[0]?.id;
if (folderId === undefined) throw new Error("no folders");

const { notes } = await client.listNotes({ folderId, pageSize: 10 });
const note = await client.getNote(notes[0]!.id, { includeTranscript: true });
console.log(note.title, transcriptText(note));

for (const tool of GRANOLA_TOOL_DEFINITIONS) {
  void tool.name;
}
```

Tool names: `granola_fetch_note`, `granola_search_notes`. Handlers on those definitions are placeholders.

Ingress mounts `POST /api/granola/webhook`. Ingest is everything after ack.

```ts
import { Hono } from "hono";
import { createGranolaClient } from "@corbits/granola";
import {
  createGranolaBindingStore,
  ensureGranolaWebhook,
  mountGranolaWebhook,
  reconcileGranolaWebhookFolders,
} from "@corbits/granola/ingress";
import { createGranolaIngest } from "@corbits/granola/ingest";

const apiKey = process.env.GRANOLA_API_KEY!;
const baseUrl = "https://public-api.granola.ai/v1";
const publicUrl = process.env.GRANOLA_PUBLIC_URL;
const app = new Hono();

const bindingStore = createGranolaBindingStore({
  port: myBindingsPort,
  tenantId,
  principalId,
  seedBindings: [],
  onChange: (bindings) =>
    publicUrl === undefined
      ? undefined
      : reconcileGranolaWebhookFolders({
          apiKey,
          baseUrl,
          publicUrl,
          folderIds: bindings.map((b) => b.folderId),
        }),
});

const secret = await ensureGranolaWebhook({
  apiKey,
  baseUrl,
  publicUrl,
  bindingStore,
  envSecret: process.env.GRANOLA_WEBHOOK_SECRET,
});
if (secret === undefined) throw new Error("granola webhook not registered");

const ingest = createGranolaIngest({
  client: createGranolaClient({ apiKey, baseUrl }),
  bindingStore,
  transcripts: myTranscriptStore,
  captureKnowledge: myKnowledgeCapture,
  lifecycle: myLifecycle,
  handlers: { diligence: myDiligenceHandler, internal: myInternalHandler },
});

mountGranolaWebhook(app, { secret, onEvent: ingest });
await ingest.reprocess(noteId);
```

## How it works

Three entry points, one dependency direction: ingress and ingest build on tools. `/ingress` verifies signatures, acks, and converges Granola-side `folder_ids`. `/ingest` is generic over the host's transcript ref and lifecycle anchor. A failed `onEvent` after ack is not redelivered; a later event or `ingest.reprocess(noteId)` is the recovery path.

## Development

```sh
git clone https://github.com/corbitsdev/granola-tools.git
cd granola-tools
bun install
bun run typecheck
bun run test
bun run test:tools
bun run test:ingress
bun run test:ingest
bun run check-deps
bun run build
```

`src/tools/` must not import `src/ingress/` — `bun run check-deps` enforces that. See CONTRIBUTING.md and ARCHITECTURE.md.

## License

LGPL-2.1-only.
