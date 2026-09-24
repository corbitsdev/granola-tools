# Changelog

All notable changes to `@corbits/granola` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0, a minor bump may contain a breaking change; breaking changes are always
called out under their own heading.

## [Unreleased]

### 0.1.0 — skeleton

Initial scaffold. No Granola implementation yet — that extraction is scoped and lands
separately.

- Package structure with two entry points: `@corbits/granola` (client + tools,
  `src/tools/`) and `@corbits/granola/ingress` (the webhook extension, `src/ingress/`).
- The tools carry zero dependency on any hub, mounting, extension or webhook machinery;
  the ingress extension depends on the tools, never the reverse. Enforced by
  `scripts/check-deps.ts`, run as its own CI job.
- `GranolaClient` and placeholder tool definitions (`fetchNoteTool`, `searchNotesTool`).
- Placeholder webhook signature verification in `src/ingress`.
- CI: dependency check, typecheck, tools tests, ingress tests and build each run as
  separate jobs.

[Unreleased]: https://github.com/corbitsdev/granola-tools
