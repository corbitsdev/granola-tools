# @corbits/granola

Granola meeting-notes client and agent tools for Corbits hosts, plus an optional
webhook ingress extension. The base entry point is a plain REST client
(`getNote` / `listNotes` / `listFolders`) and two grantable tool definitions;
the `/ingress` entry point receives Granola webhooks, verifies signatures,
keeps the Granola-side webhook registration converged, and dispatches note
events to your handlers.

## Two entry points, one dependency direction

| Entry point | What it is | Depends on |
| --- | --- | --- |
| `@corbits/granola` | Granola API client, note/folder types, agent tool definitions | nothing hub-shaped |
| `@corbits/granola/ingress` | Webhook mount, signature verification, folder-binding store, webhook registration | `@corbits/granola`, `hono` (peer) |

The tools are usable standalone. The ingress extension depends on the tools,
never the reverse — enforced structurally, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Install

```bash
bun add github:corbitsdev/corbits-granola
# or pin a commit:
bun add github:corbitsdev/corbits-granola#<sha>
```

Not on npm yet; consume from git or an `npm pack` tarball. The repository root
*is* the package. `@corbits/granola/ingress` additionally requires `hono` ^4 as
a peer dependency.

## Configuration

The package takes explicit options — it never reads `process.env` itself. A
host supplies:

| Option | Meaning | Typical env var (host-defined) |
| --- | --- | --- |
| `apiKey` | Granola API key, sent as `Authorization: Bearer` | `GRANOLA_API_KEY` |
| `baseUrl` | Granola REST base URL; defaults to `https://public-api.granola.ai/v1` | `GRANOLA_API_BASE_URL` |
| `publicUrl` | Public HTTPS origin your host is reachable at; used to compute the webhook delivery URL. `undefined` disables webhook registration/reconciliation | `GRANOLA_PUBLIC_URL` |
| `envSecret` (ingress) | Pre-provisioned webhook signing secret, if you have one; otherwise `ensureGranolaWebhook` provisions one | `GRANOLA_WEBHOOK_SECRET` |
| seed bindings (ingress) | Initial folder → bucket-type → channel bindings, `[{folderId, type, channel}]` with `type` one of `"diligence" | "internal"` | `GRANOLA_BUCKETS` (JSON) |

## Quickstart: client and tools (no webhook)

```ts
import {
  createGranolaClient,
  transcriptText,
  GRANOLA_TOOL_DEFINITIONS,
} from "@corbits/granola";

const client = createGranolaClient({ apiKey: process.env.GRANOLA_API_KEY! });

const { notes } = await client.listNotes({ limit: 10 });
const note = await client.getNote(notes[0].id);
console.log(note.title, transcriptText(note));

// Grant to any agent like any other Interchange tool — no hub required.
// Tool names: granola_fetch_note, granola_search_notes.
for (const tool of GRANOLA_TOOL_DEFINITIONS) grant(tool);
```

## Quickstart: webhook ingress

Mounting is three steps: build a binding store, converge the Granola-side
webhook registration, then mount the webhook route on a Hono app. This is the
pattern Scout uses in production, simplified:

```ts
import { Hono } from "hono";
import { createGranolaClient } from "@corbits/granola";
import {
  createGranolaBindingStore,
  ensureGranolaWebhook,
  mountGranolaWebhook,
  reconcileGranolaWebhookFolders,
} from "@corbits/granola/ingress";

const apiKey = process.env.GRANOLA_API_KEY!;
const baseUrl = "https://public-api.granola.ai/v1";
const publicUrl = process.env.GRANOLA_PUBLIC_URL; // https:// origin, or undefined

// 1. Durable folder -> bucket-type -> channel bindings. `port` is your
//    persistence adapter (implement GranolaBindingsPort over your own store).
const bindingStore = createGranolaBindingStore({
  port: myBindingsPort,
  tenantId,
  principalId,
  seedBindings: [], // or parsed GRANOLA_BUCKETS
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

// 2. Register (or verify) the webhook endpoint with Granola. Returns the
//    signing secret; undefined means registration could not happen (e.g. no
//    publicUrl and no envSecret) — skip mounting in that case.
const secret = await ensureGranolaWebhook({
  apiKey,
  baseUrl,
  publicUrl,
  bindingStore,
  envSecret: process.env.GRANOLA_WEBHOOK_SECRET,
});
if (secret === undefined) return;

// 3. Mount. POSTs land at /api/granola/webhook; signatures are verified
//    before your handler runs, and events are acked before dispatch.
const app = new Hono();
mountGranolaWebhook(app, {
  secret,
  onEvent: async (payload) => {
    const note = await createGranolaClient({ apiKey, baseUrl }).getNote(payload.noteId);
    // route by bindingStore lookup on the note's folder…
  },
});
```

The webhook route is `POST /api/granola/webhook` on whatever app you pass in.
A failed `onEvent` after ack is not redelivered by Granola; a later event for
the same note (or a manual re-drop) is the recovery path.

## API surface

`@corbits/granola`

- `createGranolaClient(options)` → `{ getNote, listNotes, listFolders }`
- `transcriptText(note)` / `speakerLabel(speaker)` — transcript helpers
- `GranolaNote`, `GranolaBucket`, `GranolaBucketType`, `GranolaBucketsArray` — validated data shapes (arktype)
- `fetchNoteTool`, `searchNotesTool`, `GRANOLA_TOOL_DEFINITIONS` — agent tool definitions
- `GranolaApiError` — thrown on non-2xx API responses

`@corbits/granola/ingress`

- `mountGranolaWebhook(app, {secret, onEvent})` — mounts `POST /api/granola/webhook`
- `ensureGranolaWebhook(options)` — registers/verifies the webhook with Granola, returns the signing secret
- `reconcileGranolaWebhookFolders(options)` — keeps the registration's `folder_ids` matching your bindings
- `createGranolaBindingStore(options)` — durable folder bindings over a host-supplied `GranolaBindingsPort`
- `verifyGranolaSignature` / `signGranolaPayload` / `parseGranolaPayload` — signature primitives, if you mount by hand

## Used in production

Scout mounts this package end to end — client construction, binding store,
webhook registration, and event dispatch — in
`packages/scout/src/granola/mount.ts` and reads its env in
`packages/scout/src/granola/config.ts` of the Scout repository. That wiring is
the reference consumer for everything above.

## Working on it

```sh
bun install
bun run typecheck
bun run test
bun run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
