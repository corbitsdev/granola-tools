# Contributing

A small, deliberately boring codebase: strict TypeScript, no magic.

Setup and the commands are in the [README](./README.md#development). `bun run
typecheck` must be clean — it is its own CI step, and `any` is not a way past it.

## Dependency rule

`src/tools/` may never import from `src/ingress/` — the tools must stay usable by any
agent with zero hub, mounting, extension or webhook dependency, and the ingress
extension depends on the tools, not the other way around. Checked by
`scripts/check-deps.ts`, which runs as its own CI job. See
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Tests

- **Red first.** A bug fix starts with a test that fails for the reason you believe, and
  you should watch it fail.
- Assert **behavior a consumer can observe** over internal call shapes.
- Tools tests live under `src/tools`; ingress tests live under `src/ingress`; ingest
  pipeline tests live under `src/ingest`. Keep that split — it is what lets
  `test:tools`, `test:ingress`, and `test:ingest` run and fail independently in CI.

## Pull requests

- Keep commits focused, and keep the diff to the change you are describing.
- Explain *why* in the commit message; the code already says what.
- CI must be green: dependency check, typecheck, tools tests, ingress tests, ingest
  tests, and build.
- Contributions are accepted under the repository's LGPL-2.1-only licence.
