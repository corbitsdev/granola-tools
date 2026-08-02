# @corbits/granola

Granola meeting-notes tools for Corbits agents, plus an optional webhook ingress
extension. Skeleton package — no Granola API calls are implemented yet; this is the
foundation the real client and dispatch logic land into.

## Two entry points, one dependency direction

| Entry point | What it is | Depends on |
| --- | --- | --- |
| `@corbits/granola` | The Granola API client and the tools an agent calls (fetch a note, search notes) | nothing hub-shaped |
| `@corbits/granola/ingress` | The extension that receives Granola webhooks, verifies signatures, and dispatches notes to handlers | `@corbits/granola` |

**The tools are usable standalone, without the ingress extension.** `@corbits/granola`
carries zero dependency on any hub, mounting, extension or webhook machinery — import it
and grant its tools to any agent exactly like any other plain Interchange tool, and
nothing hub-shaped comes along for the ride. `@corbits/granola/ingress` is the one
direction of coupling: it depends on the tools to do its job. The tools never depend on
it, and that direction is enforced structurally, not just by convention — see
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Install

```bash
# From git (Bun)
bun add github:corbitsdev/corbits-granola

# npm / pack
npm install @corbits/granola
```

> **Not on npm yet.** Until the first release, consume it from git or an `npm pack`
> tarball. This repository root *is* the package, so git installs resolve cleanly.

## Use

```ts
import { GranolaClient, GRANOLA_TOOL_DEFINITIONS } from "@corbits/granola";

const client = new GranolaClient({ apiKey: process.env.GRANOLA_API_KEY! });
// Grant GRANOLA_TOOL_DEFINITIONS to any agent, no hub required.
```

```ts
// Only if you also want the webhook extension.
import { verifyGranolaSignature } from "@corbits/granola/ingress";
```

## Working on it

```sh
bun install
bun run typecheck
bun run test
bun run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dependency rule and test conventions,
and [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
