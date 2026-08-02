# Architecture

## Two faces, one dependency direction

This package has two independent faces, each with its own source directory:

- `src/tools/` — the Granola API client and the tools an agent calls (fetch a note,
  search notes). Published as the package root, `@corbits/granola`.
- `src/ingress/` — the extension that receives Granola webhooks, verifies signatures,
  and dispatches notes to handlers. Published as the subpath export
  `@corbits/granola/ingress`.

`src/ingress` depends on `src/tools` for the client. `src/tools` must never depend on
`src/ingress`, or on any hub, mounting, extension or webhook machinery at all — the
operator requirement is that someone can import the tools and grant them to any agent
like any other plain Interchange tool, and nothing hub-shaped comes along for the ride.

## The rule is enforced, not just documented

A convention nobody checks gets violated. `scripts/check-deps.ts` greps `src/tools` for
any reference to `ingress` and fails the build if it finds one. It runs in CI as its own
job, separate from typecheck and test, so a dependency-direction leak fails loudly and
specifically rather than getting buried in an unrelated job's log.

Reviewing a change to `src/tools/`: if it needs anything from `src/ingress/`, that is a
sign the boundary is wrong, not a reason to import across it.

## Why subpath exports, not two packages

The tools and the ingress extension version and release together — a Granola API
surface change affects both. Two `package.json` files (as some sibling repositories use
for genuinely independent packages) would let them drift out of sync for no benefit
here. One package with two `exports` entries keeps them versioned together while still
letting a consumer install `@corbits/granola` alone and get nothing from `src/ingress/`
in their dependency graph.

## What's not here yet

This is a skeleton. `src/tools/client.ts` and `src/tools/tools.ts` have no real Granola
API calls; `src/ingress/webhook.ts` has no real signature verification or dispatch. That
extraction is scoped and lands separately — this repository establishes the structure
and the CI gate it has to pass.
